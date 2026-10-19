import { Plugin } from "@opencode/plugin"

export type PropsResponse = {
  default_generation_settings?: {
    n_ctx?: unknown
  }
  n_ctx?: unknown
}

export type CacheEntry = {
  checkedAt: number
  nCtx?: number
}

export function propsUrl(base: unknown): string | undefined {
  if (typeof base !== "string" || !base) return undefined
  try {
    const url = new URL(base)
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts[parts.length - 1] === "v1") parts.pop()
    parts.push("props")
    url.pathname = `/${parts.join("/")}`
    return url.toString()
  } catch {
    return undefined
  }
}

export async function fetchContextLimit(baseURL: string, timeoutMs = 15_000): Promise<number | undefined> {
  const url = propsUrl(baseURL)
  if (!url) return undefined
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    const body = (await res.json()) as PropsResponse
    const value = body.default_generation_settings?.n_ctx ?? body.n_ctx
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value
    }
  } catch {
    return undefined
  }
  return undefined
}

export default Plugin.define({
  id: "llamacpp-context",
  async setup(ctx) {
    const disabled =
      (process.env.OPENCODE_LLAMACPP_CONTEXT ?? process.env.OPENCODE_LLMACPP_CONTEXT ?? "").trim().toLowerCase() === "off"
    if (disabled) return

    const providersList =
      Array.isArray(ctx.options?.providers)
        ? (ctx.options.providers as string[])
        : (process.env.OPENCODE_LLAMACPP_CONTEXT_PROVIDERS ?? "llamacpp")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
    const targetProviders = new Set(providersList)

    const ttlMs = typeof ctx.options?.ttl_ms === "number" ? ctx.options.ttl_ms : 15_000
    const timeoutMs = typeof ctx.options?.timeout_ms === "number" ? ctx.options.timeout_ms : 15_000
    const autoApply = typeof ctx.options?.auto_apply === "boolean" ? ctx.options.auto_apply : true

    const dynamicContexts = new Map<string, number>()
    const cache = new Map<string, CacheEntry>()
    const providerBaseUrls = new Map<string, string>()

    await ctx.model.transform((editor) => {
      for (const providerID of targetProviders) {
        const record = editor.provider.get(providerID)
        const baseURL = record?.provider.settings?.baseURL
        if (typeof baseURL === "string") {
          providerBaseUrls.set(providerID, baseURL)
        }
      }

      for (const [key, nCtx] of dynamicContexts) {
        const [providerID, modelID] = key.split("/")
        if (!providerID || !modelID) continue
        const model = editor.get(providerID, modelID)
        if (model) {
          editor.update(providerID, modelID, (draft) => {
            draft.limit.context = nCtx
          })
        }
      }
    })

    async function checkModelContext(input: {
      providerID: string
      modelID: string
      baseURL?: string
      force?: boolean
      sessionID?: string
    }): Promise<{ updated: boolean; nCtx?: number; previous?: number; error?: boolean }> {
      if (!targetProviders.has(input.providerID)) return { updated: false }
      const key = `${input.providerID}/${input.modelID}`
      const now = Date.now()
      const cached = cache.get(key)
      if (!input.force && cached && now - cached.checkedAt < ttlMs) {
        return { updated: false, nCtx: cached.nCtx }
      }

      const baseURL =
        input.baseURL ??
        providerBaseUrls.get(input.providerID) ??
        (input.providerID === "lmstudio" ? "http://127.0.0.1:1234" : "http://127.0.0.1:8080")

      const detected = await fetchContextLimit(baseURL, timeoutMs)
      cache.set(key, { checkedAt: now, nCtx: detected })

      if (detected === undefined) {
        return { updated: false, error: true }
      }

      const previous = dynamicContexts.get(key)
      if (previous === detected) {
        return { updated: false, nCtx: detected, previous }
      }

      if (autoApply || input.force) {
        dynamicContexts.set(key, detected)
        await ctx.model.reload()
        return { updated: true, nCtx: detected, previous }
      }

      return { updated: false, nCtx: detected, previous }
    }

    await ctx.session.hook("prompt", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
      if (!session?.model) return
      await checkModelContext({
        providerID: session.model.providerID,
        modelID: session.model.id,
        sessionID: event.sessionID,
      })
    })

    await ctx.session.hook("model.request", async (req) => {
      if (req.baseURL) {
        providerBaseUrls.set(req.model.providerID, req.baseURL)
      }
      await checkModelContext({
        providerID: req.model.providerID,
        modelID: req.model.id,
        baseURL: req.baseURL,
        sessionID: req.sessionID,
      })
    })

    const handleRefresh = async (invocation: { sessionID: string }) => {
      const session = await ctx.session.get({ sessionID: invocation.sessionID }).catch(() => undefined)
      if (!session?.model) {
        await ctx.session
          .synthetic({
            sessionID: invocation.sessionID,
            text: "⚠ No model is currently selected for this session.",
            resume: false,
          })
          .catch(() => undefined)
        return
      }

      const result = await checkModelContext({
        providerID: session.model.providerID,
        modelID: session.model.id,
        force: true,
        sessionID: invocation.sessionID,
      })

      if (result.error) {
        const baseURL = providerBaseUrls.get(session.model.providerID) ?? "http://127.0.0.1:8080"
        await ctx.session
          .synthetic({
            sessionID: invocation.sessionID,
            text: `⚠ Failed to connect to llama.cpp /props at ${propsUrl(baseURL) ?? baseURL}. Is the server running?`,
            resume: false,
          })
          .catch(() => undefined)
        return
      }

      if (result.updated && result.nCtx !== undefined) {
        const fromText = result.previous ? ` from ${result.previous.toLocaleString()}` : ""
        await ctx.session
          .synthetic({
            sessionID: invocation.sessionID,
            text: `✓ Context limit updated${fromText} to ${result.nCtx.toLocaleString()} tokens for ${session.model.id}.`,
            resume: false,
          })
          .catch(() => undefined)
        return
      }

      if (result.nCtx !== undefined) {
        await ctx.session
          .synthetic({
            sessionID: invocation.sessionID,
            text: `ℹ Context limit is already up-to-date (${result.nCtx.toLocaleString()} tokens) for ${session.model.id}.`,
            resume: false,
          })
          .catch(() => undefined)
        return
      }
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "context",
        description: "Refresh dynamic model context from llama.cpp /props",
        execute: handleRefresh,
      })
      editor.add({
        name: "refresh-context",
        description: "Refresh dynamic model context from llama.cpp /props",
        execute: handleRefresh,
      })
    })
  },
})
