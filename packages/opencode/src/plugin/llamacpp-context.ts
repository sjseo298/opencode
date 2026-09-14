import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// ── FORK: dynamic context detection for llama.cpp ─────────────────
// Detects the effective context size of models served by a local
// llama.cpp server (GET /props, default_generation_settings.n_ctx) on
// every LLM request and asks the user to confirm when it differs from
// the configured limit.context. On acceptance the live provider model
// limit is updated so overflow/compaction use the new window.
//
// Env:
// - OPENCODE_LLMACPP_CONTEXT=off disables the plugin.
// - OPENCODE_LLMACPP_CONTEXT_PROVIDERS comma-separated provider IDs
//   to target (default: llamacpp).
// ──────────────────────────────────────────────────────────────────

const DISABLED = (process.env.OPENCODE_LLMACPP_CONTEXT ?? "").trim().toLowerCase() === "off"
const PROVIDERS = (process.env.OPENCODE_LLMACPP_CONTEXT_PROVIDERS ?? "llamacpp")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
const TTL_MS = 15_000
// The user's smart_model_proxy router can take ~10s to answer /props on a
// cold backend connection, so leave headroom before giving up.
const FETCH_TIMEOUT_MS = 15_000
const ASK_TIMEOUT_MS = 90_000
const HEADER = "llama.cpp context"
export const FORCE_CONTEXT_REFRESH_OPTION = "__opencode_force_context_refresh"

type Entry = {
  checkedAt: number
  nCtx?: number
  dismissed?: number
}

type PropsResponse = {
  default_generation_settings?: {
    n_ctx?: unknown
  }
}

function propsUrl(base: unknown): string | undefined {
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

export async function LlamacppContextPlugin(input: PluginInput): Promise<Hooks> {
  if (DISABLED) return {}
  const cache = new Map<string, Entry>()
  let asking = false

  async function check(params: {
    sessionID: string
    model: { id: string; providerID: string; name: string; limit: { context: number } }
    provider: { options?: Record<string, any> }
    force?: boolean
  }) {
    const model = params.model
    if (!PROVIDERS.includes(model.providerID)) return
    if (model.limit.context === 0) return
    if (asking) return
    if (!input.experimental_question) return

    const key = `${model.providerID}/${model.id}`
    let entry = cache.get(key)
    const now = Date.now()
    if (!entry || params.force || now - entry.checkedAt >= TTL_MS) {
      const url = propsUrl(params.provider.options?.baseURL)
      if (!url) return
      let nCtx: number | undefined
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (res.ok) {
          const body = (await res.json()) as PropsResponse
          const value = body.default_generation_settings?.n_ctx
          if (typeof value === "number" && Number.isFinite(value) && value > 0) nCtx = value
        }
      } catch {
        return
      }
      entry = { checkedAt: now, nCtx, dismissed: entry?.dismissed }
      cache.set(key, entry)
    }
    if (entry.nCtx === undefined) return
    if (entry.nCtx === model.limit.context) return
    if (!params.force && entry.dismissed === entry.nCtx) return

    const accept = `Use ${entry.nCtx} tokens`
    const keep = "Keep current context"
    asking = true
    try {
      const ask = input.experimental_question.ask({
        sessionID: params.sessionID,
        questions: [
          {
            header: HEADER,
            question: `The llama.cpp server reports a context of ${entry.nCtx} tokens for ${model.name}, but opencode has ${model.limit.context} configured. Use the detected context size?`,
            options: [
              { label: accept, description: "Use the context size reported by the llama.cpp server" },
              { label: keep, description: `Continue with ${model.limit.context} tokens` },
            ],
            custom: false,
          },
        ],
      })
      const answers = await Promise.race([
        ask,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ASK_TIMEOUT_MS)),
      ])
      if (answers === undefined) {
        // No answer within the timeout (e.g. non-interactive run): keep the
        // configured limit, stop asking for this value, and let the pending
        // question resolve on its own (replied/rejected or instance teardown).
        entry.dismissed = entry.nCtx
        return
      }
      if (answers[0]?.includes(accept)) {
        model.limit.context = entry.nCtx
        entry.dismissed = undefined
        input.client.tui
          .showToast({
            body: {
              title: "llama.cpp context",
              message: `Context set to ${entry.nCtx} tokens for ${model.name}`,
              variant: "success",
            },
          })
          .catch(() => undefined)
        return
      }
      entry.dismissed = entry.nCtx
    } catch {
      entry.dismissed = entry.nCtx
    } finally {
      asking = false
    }
  }

  return {
    "chat.params": (params, output) =>
      check({
        sessionID: params.sessionID,
        model: params.model,
        provider: params.provider,
        force: output.options[FORCE_CONTEXT_REFRESH_OPTION] === true,
      }),
  }
}

export * as LlamacppContext from "./llamacpp-context"
