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

export function endpointUrl(base: unknown, endpoint: string): string | undefined {
  if (typeof base !== "string" || !base) return undefined
  try {
    const url = new URL(base)
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts[parts.length - 1] === "v1") parts.pop()
    parts.push(endpoint)
    url.pathname = `/${parts.join("/")}`
    return url.toString()
  } catch {
    return undefined
  }
}

export function propsUrl(base: unknown): string | undefined {
  return endpointUrl(base, "props")
}

export function statusUrl(base: unknown): string | undefined {
  return endpointUrl(base, "status")
}

export type StatusResponse = {
  kv_ctx?: {
    total_tokens?: unknown
  }
  slots?: {
    items?: Array<{
      total_tokens?: unknown
    }>
  }
  model?: {
    context_effective?: unknown
  }
}

export async function fetchContextLimit(baseURL: string, timeoutMs = 3_000): Promise<number | undefined> {
  const pUrl = propsUrl(baseURL)
  if (pUrl) {
    try {
      const res = await fetch(pUrl, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) {
        const body = (await res.json()) as PropsResponse
        const value = body.default_generation_settings?.n_ctx ?? body.n_ctx
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          return value
        }
      }
    } catch {
      // Fallback to /status
    }
  }

  const sUrl = statusUrl(baseURL)
  if (sUrl) {
    try {
      const res = await fetch(sUrl, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) {
        const body = (await res.json()) as StatusResponse
        const slotTokens = body.slots?.items?.[0]?.total_tokens
        const kvTokens = body.kv_ctx?.total_tokens
        const modelTokens = body.model?.context_effective
        const value =
          typeof slotTokens === "number" && Number.isFinite(slotTokens) && slotTokens > 0
            ? slotTokens
            : typeof kvTokens === "number" && Number.isFinite(kvTokens) && kvTokens > 0
              ? kvTokens
              : typeof modelTokens === "number" && Number.isFinite(modelTokens) && modelTokens > 0
                ? modelTokens
                : undefined
        if (value !== undefined) {
          return value
        }
      }
    } catch {
      return undefined
    }
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
        : (process.env.OPENCODE_LLAMACPP_CONTEXT_PROVIDERS ?? "llamacpp,mlx,splash,esca,lmstudio")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
    const targetProviders = new Set(providersList)

    const ttlMs = typeof ctx.options?.ttl_ms === "number" ? ctx.options.ttl_ms : 3_000
    const timeoutMs = typeof ctx.options?.timeout_ms === "number" ? ctx.options.timeout_ms : 3_000
    const autoApply = typeof ctx.options?.auto_apply === "boolean" ? ctx.options.auto_apply : true

    const dynamicContexts = new Map<string, number>()
    const cache = new Map<string, CacheEntry>()
    const providerBaseUrls = new Map<string, string>()

    // Seed provider base URLs from OPENCODE_CONFIG_CONTENT if available
    try {
      const configStr = process.env.OPENCODE_CONFIG_CONTENT
      if (configStr) {
        const parsed = JSON.parse(configStr)
        if (parsed?.providers && typeof parsed.providers === "object") {
          for (const [pId, pCfg] of Object.entries(parsed.providers) as [string, any][]) {
            const bUrl = pCfg?.settings?.baseURL ?? pCfg?.options?.baseURL
            if (typeof bUrl === "string") {
              providerBaseUrls.set(pId, bUrl)
            }
          }
        }
      }
    } catch {
      // Ignore parse errors from env config
    }

    await ctx.model.transform((editor) => {
      for (const providerID of targetProviders) {
        const record = editor.provider.get(providerID)
        const baseURL =
          record?.provider.settings?.baseURL ??
          (record?.provider as any)?.options?.baseURL ??
          (record as any)?.settings?.baseURL
        if (typeof baseURL === "string") {
          providerBaseUrls.set(providerID, baseURL)
        }
      }

      for (const [key, nCtx] of dynamicContexts) {
        const firstSlash = key.indexOf("/")
        if (firstSlash === -1) continue
        const providerID = key.slice(0, firstSlash)
        const modelID = key.slice(firstSlash + 1)
        if (!providerID || !modelID) continue

        const model = editor.get(providerID, modelID)
        if (model) {
          editor.update(providerID, modelID, (draft) => {
            draft.limit.context = nCtx
          })
        }
        if (typeof editor.list === "function") {
          for (const m of editor.list(providerID)) {
            if (m.id === modelID || m.id.endsWith(modelID) || modelID.endsWith(m.id)) {
              editor.update(providerID, m.id, (draft) => {
                draft.limit.context = nCtx
              })
            }
          }
        }
      }
    })

    async function checkModelContext(input: {
      providerID?: string
      modelID?: string
      baseURL?: string
      force?: boolean
      sessionID?: string
    }): Promise<{ updated: boolean; nCtx?: number; previous?: number; error?: boolean }> {
      let pID = input.providerID
      let mID = input.modelID

      if ((!pID || !mID) && input.sessionID) {
        const session = await ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
        if (session?.model) {
          pID = session.model.providerID
          mID = session.model.id
        }
      }

      if (!pID || !mID || !targetProviders.has(pID)) return { updated: false }
      const key = `${pID}/${mID}`
      const now = Date.now()
      const cached = cache.get(key)
      if (!input.force && cached && now - cached.checkedAt < ttlMs) {
        return { updated: false, nCtx: cached.nCtx }
      }

      const baseURL =
        input.baseURL ??
        providerBaseUrls.get(pID) ??
        process.env.OPENCODE_LLAMACPP_BASE_URL ??
        (pID === "lmstudio" ? "http://127.0.0.1:1234" : "http://127.0.0.1:8080")

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

    // Check upon user prompt
    await ctx.session.hook("prompt", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
      if (!session?.model) return
      await checkModelContext({
        providerID: session.model.providerID,
        modelID: session.model.id,
        sessionID: event.sessionID,
      })
    })

    // Check before model request
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

    // Check on multi-step generate / context assembly
    await ctx.session.hook("generate", async (event) => {
      if (event.sessionID) {
        await checkModelContext({ sessionID: event.sessionID })
      }
    })

    await ctx.session.hook("context", async (event) => {
      if (event.sessionID) {
        await checkModelContext({ sessionID: event.sessionID })
      }
    })

    // Check after each tool call as the agent works through tasks
    if (typeof ctx.tool?.hook === "function") {
      await ctx.tool.hook("execute.after", async (event) => {
        if (event.sessionID) {
          await checkModelContext({ sessionID: event.sessionID })
        }
      })
    }

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
