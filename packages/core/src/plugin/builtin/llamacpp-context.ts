import { Plugin as OpenCodePlugin } from "@opencode/plugin"
import fs from "fs"
import path from "path"
import os from "os"

export type PropsResponse = {
  default_generation_settings?: {
    n_ctx?: unknown
  }
  n_ctx?: unknown
}

export type ContextInfo = {
  limit?: number
  used?: number
}

export type CacheEntry = {
  checkedAt: number
  nCtx?: number
  used?: number
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
    used_tokens?: unknown
  }
  slots?: {
    items?: Array<{
      total_tokens?: unknown
      used_tokens?: unknown
      context?: {
        total_tokens?: unknown
        used_tokens?: unknown
      }
    }>
  }
  model?: {
    context_effective?: unknown
  }
}

export async function fetchContextInfo(baseURL: string, timeoutMs = 3_000): Promise<ContextInfo> {
  let limit: number | undefined
  let used: number | undefined

  const pUrl = propsUrl(baseURL)
  if (pUrl) {
    try {
      const res = await fetch(pUrl, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) {
        const body = (await res.json()) as PropsResponse
        const value = body.default_generation_settings?.n_ctx ?? body.n_ctx
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          limit = value
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
        const slotItem = body.slots?.items?.[0]
        const slotTotal = slotItem?.total_tokens ?? slotItem?.context?.total_tokens
        const slotUsed = slotItem?.used_tokens ?? slotItem?.context?.used_tokens
        const kvTotal = body.kv_ctx?.total_tokens
        const kvUsed = body.kv_ctx?.used_tokens
        const modelTokens = body.model?.context_effective

        if (limit === undefined) {
          limit =
            typeof slotTotal === "number" && Number.isFinite(slotTotal) && slotTotal > 0
              ? slotTotal
              : typeof kvTotal === "number" && Number.isFinite(kvTotal) && kvTotal > 0
                ? kvTotal
                : typeof modelTokens === "number" && Number.isFinite(modelTokens) && modelTokens > 0
                  ? modelTokens
                  : undefined
        }

        const rawUsed =
          typeof slotUsed === "number" && Number.isFinite(slotUsed) && slotUsed >= 0
            ? slotUsed
            : typeof kvUsed === "number" && Number.isFinite(kvUsed) && kvUsed >= 0
              ? kvUsed
              : undefined

        if (rawUsed !== undefined) {
          used = rawUsed
        }
      }
    } catch {
      // Ignore status fetch errors
    }
  }

  return { limit, used }
}

export async function fetchContextLimit(baseURL: string, timeoutMs = 3_000): Promise<number | undefined> {
  const info = await fetchContextInfo(baseURL, timeoutMs)
  return info.limit
}

export type DynamicContextData = {
  limit?: number
  used?: number
  timestamp: number
}

export type DynamicContextStore = {
  entries: Map<string, DynamicContextData>
  listeners: Set<() => void>
  get(key: string): DynamicContextData | undefined
  getLimit(key: string): number | undefined
  getUsed(key: string): number | undefined
  set(key: string, data: { limit?: number; used?: number }): void
  subscribe(fn: () => void): () => void
}

export function getOrCreateDynamicContextStore(): DynamicContextStore {
  const g = globalThis as any
  if (!g.__OPENCODE_DYNAMIC_CONTEXT__) {
    g.__OPENCODE_DYNAMIC_CONTEXT__ = {
      entries: new Map<string, DynamicContextData>(),
      listeners: new Set<() => void>(),
      get(key: string): DynamicContextData | undefined {
        return this.entries.get(key)
      },
      getLimit(key: string): number | undefined {
        const direct = this.entries.get(key)?.limit
        if (direct) return direct
        const slash = key.indexOf("/")
        if (slash !== -1) {
          const modelID = key.slice(slash + 1)
          for (const [k, v] of this.entries) {
            if ((k === modelID || k.endsWith("/" + modelID) || modelID.endsWith(k)) && v.limit) {
              return v.limit
            }
          }
        }
        return undefined
      },
      getUsed(key: string): number | undefined {
        const direct = this.entries.get(key)?.used
        if (direct) return direct
        const slash = key.indexOf("/")
        if (slash !== -1) {
          const modelID = key.slice(slash + 1)
          for (const [k, v] of this.entries) {
            if ((k === modelID || k.endsWith("/" + modelID) || modelID.endsWith(k)) && v.used) {
              return v.used
            }
          }
        }
        return undefined
      },
      set(key: string, data: { limit?: number; used?: number }) {
        const existing = this.entries.get(key)
        const updated: DynamicContextData = {
          limit: data.limit ?? existing?.limit,
          used: data.used ?? existing?.used,
          timestamp: Date.now(),
        }
        this.entries.set(key, updated)
        const slash = key.indexOf("/")
        if (slash !== -1) {
          this.entries.set(key.slice(slash + 1), updated)
        }
        for (const fn of this.listeners) {
          try {
            fn()
          } catch {}
        }
      },
      subscribe(fn: () => void) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
    }
  }
  return g.__OPENCODE_DYNAMIC_CONTEXT__
}

export const Plugin = OpenCodePlugin.define({
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

    const dynamicStore = getOrCreateDynamicContextStore()
    const dynamicContexts = new Map<string, number>()
    const cache = new Map<string, CacheEntry>()
    const providerBaseUrls = new Map<string, string>()

    // Seed provider base URLs from files and env config
    const seedFromConfigObject = (obj: any) => {
      if (!obj || typeof obj !== "object") return
      const all = { ...(obj.providers ?? {}), ...(obj.provider ?? {}) }
      for (const [pId, pCfg] of Object.entries(all) as [string, any][]) {
        const bUrl = pCfg?.settings?.baseURL ?? pCfg?.options?.baseURL
        if (typeof bUrl === "string" && bUrl) {
          providerBaseUrls.set(pId, bUrl)
        }
      }
    }

    try {
      const configStr = process.env.OPENCODE_CONFIG_CONTENT
      if (configStr) seedFromConfigObject(JSON.parse(configStr))
    } catch {}

    const home = os.homedir?.() ?? process.env.HOME ?? ""
    const candidateFiles = [
      process.env.OPENCODE_CONFIG,
      home ? path.join(home, ".config/opencode/opencode.jsonc") : "",
      home ? path.join(home, ".config/opencode/opencode.json") : "",
      path.join(process.cwd(), "opencode.jsonc"),
      path.join(process.cwd(), "opencode.json"),
      path.join(process.cwd(), ".opencode/opencode.jsonc"),
      path.join(process.cwd(), ".opencode/opencode.json"),
    ].filter(Boolean) as string[]

    for (const f of candidateFiles) {
      try {
        if (fs.existsSync(f)) {
          const raw = fs.readFileSync(f, "utf-8")
          const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
          seedFromConfigObject(JSON.parse(stripped))
        }
      } catch {}
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
            const mid = String(m.id)
            if (mid === modelID || mid.endsWith(modelID) || modelID.endsWith(mid)) {
              editor.update(providerID, m.id as any, (draft) => {
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

      const detected = await fetchContextInfo(baseURL, timeoutMs)
      cache.set(key, { checkedAt: now, nCtx: detected.limit, used: detected.used })

      if (detected.limit !== undefined || detected.used !== undefined) {
        dynamicStore.set(key, detected)
      }

      if (detected.limit === undefined) {
        return { updated: false, error: true }
      }

      const previous = dynamicContexts.get(key)
      if (previous === detected.limit) {
        return { updated: false, nCtx: detected.limit, previous }
      }

      if (autoApply || input.force) {
        dynamicContexts.set(key, detected.limit)
        await ctx.model.reload()
        return { updated: true, nCtx: detected.limit, previous }
      }

      return { updated: false, nCtx: detected.limit, previous }
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

export default Plugin
