import { Effect } from "effect"
import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import { LlamaRuntimeContext } from "../../llama-runtime-context"

const CONCURRENCY = 8

export const OpenAICompatiblePlugin = define({
  id: "openai-compatible",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const models = catalog.provider
          .list()
          .flatMap((record) => {
            const providerFetch = fetchOption(record.provider.request.body.fetch)
            return Array.from(record.models.values()).flatMap((model) => {
              if (model.api.type !== "aisdk") return []
              if (model.api.package !== "@ai-sdk/openai-compatible") return []
              const baseURL = resolveBaseURL(model.api.url ?? record.provider.api.url)
              if (!baseURL) return []
              if (!LlamaRuntimeContext.shouldResolve({ baseURL, providerID: record.provider.id })) return []
              return [
                {
                  model,
                  providerID: record.provider.id,
                  baseURL,
                  fetch: fetchOption(model.request.body.fetch) ?? providerFetch,
                },
              ]
            })
          })

        yield* Effect.forEach(
          models,
          Effect.fn(function* (item) {
            const context = yield* Effect.promise(() =>
              LlamaRuntimeContext.resolve({
                baseURL: item.baseURL,
                providerID: item.providerID,
                modelIDs: [item.model.api.id, item.model.id],
                fetch: item.fetch,
              }),
            ).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (context === undefined || item.model.limit.context === context) return
            item.model.limit.context = context
          }),
          { concurrency: CONCURRENCY, discard: true },
        )
      }),
    )

    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.sdk) return
        if (!evt.package.includes("@ai-sdk/openai-compatible")) return
        if (evt.options.includeUsage !== false) evt.options.includeUsage = true
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
        evt.sdk = mod.createOpenAICompatible(evt.options as any)
      }),
    )
  }),
})

function fetchOption(value: unknown) {
  if (typeof value !== "function") return
  return value as typeof fetch
}

function resolveBaseURL(value: string | undefined) {
  if (!value) return
  return value.replace(/\$\{([^}]+)\}/g, (source, key) => {
    const env = process.env[String(key)]
    if (!env) return source
    return env
  })
}
