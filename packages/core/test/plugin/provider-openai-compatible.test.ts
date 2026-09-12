import { AISDK } from "@opencode-ai/core/aisdk"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { OpenAICompatiblePlugin } from "@opencode-ai/core/plugin/provider/openai-compatible"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenAICompatiblePlugin.effect(host)
})

describe("OpenAICompatiblePlugin", () => {
  it.live("updates model context with llama.cpp /props runtime context", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const calls = { props: 0, models: 0 }
        const server = Bun.serve({
          port: 0,
          fetch(request) {
            const pathname = new URL(request.url).pathname
            if (pathname === "/props") {
              calls.props += 1
              return Response.json({
                default_generation_settings: { n_ctx: 196_608 },
                model_alias: "qwen-3.8-model",
              })
            }
            if (pathname === "/slots") {
              return new Response("missing", { status: 404 })
            }
            if (pathname === "/v1/models") {
              calls.models += 1
              return Response.json({
                data: [{ id: "qwen-3.8-model", limit: { context: 131_072, output: 4096 } }],
              })
            }
            return new Response("missing", { status: 404 })
          },
        })
        return {
          calls,
          server,
          baseURL: `${new URL(server.url).origin}/v1`,
        }
      }),
      ({ calls, baseURL }) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const providerID = ProviderV2.ID.make("llamacpp")
          const modelID = ModelV2.ID.make("qwen-runtime")
          yield* catalog.transform((draft) => {
            draft.provider.update(providerID, (provider) => {
              provider.api = {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: baseURL,
              }
            })
            draft.model.update(providerID, modelID, (model) => {
              model.api = {
                id: ModelV2.ID.make("qwen-runtime"),
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: baseURL,
              }
              model.limit = { context: 8_192, output: 4096 }
            })
          })
          yield* addPlugin()
          expect((yield* catalog.model.get(providerID, modelID))?.limit.context).toBe(196_608)
          expect(calls).toEqual({ props: 1, models: 0 })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("falls back to /v1/models when /props does not expose n_ctx", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const calls = { props: 0, models: 0 }
        const server = Bun.serve({
          port: 0,
          fetch(request) {
            const pathname = new URL(request.url).pathname
            if (pathname === "/props") {
              calls.props += 1
              return Response.json({
                default_generation_settings: { params: {} },
                model_alias: "qwen-3.8-model",
              })
            }
            if (pathname === "/slots") {
              return new Response("missing", { status: 404 })
            }
            if (pathname === "/v1/models") {
              calls.models += 1
              return Response.json({
                data: [
                  { id: "other-model", limit: { context: 8_192, output: 4096 } },
                  { id: "Qwen 3.8 Model", limit: { context: 131_072, output: 4096 } },
                ],
              })
            }
            return new Response("missing", { status: 404 })
          },
        })
        return {
          calls,
          server,
          baseURL: `${new URL(server.url).origin}/v1`,
        }
      }),
      ({ calls, baseURL }) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const providerID = ProviderV2.ID.make("llamacpp")
          const modelID = ModelV2.ID.make("qwen-runtime")
          yield* catalog.transform((draft) => {
            draft.provider.update(providerID, (provider) => {
              provider.api = {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: baseURL,
              }
            })
            draft.model.update(providerID, modelID, (model) => {
              model.api = {
                id: ModelV2.ID.make("qwen-runtime"),
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: baseURL,
              }
              model.limit = { context: 8_192, output: 4096 }
            })
          })
          yield* addPlugin()
          expect((yield* catalog.model.get(providerID, modelID))?.limit.context).toBe(131_072)
          expect(calls).toEqual({ props: 1, models: 1 })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("preserves explicit includeUsage false and defaults it to true", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const defaulted = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom" },
      })
      const disabled = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom", includeUsage: false },
      })
      expect(defaulted.options.includeUsage).toBe(true)
      expect(disabled.options.includeUsage).toBe(false)
    }),
  )

  it.effect("defaults includeUsage for OpenAI-compatible package matches", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "file:///tmp/@ai-sdk/openai-compatible-provider.js",
        options: { name: "custom" },
      })
      expect(result.options.includeUsage).toBe(true)
    }),
  )

  it.effect("uses the provider ID as the OpenAI-compatible provider name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const observed: string[] = []
      yield* addPlugin()
      yield* aisdk.hook.sdk((event) =>
        Effect.sync(() => {
          observed.push(event.sdk.languageModel("model").provider)
        }),
      )
      yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom-provider"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom-provider", baseURL: "https://example.com/v1" },
      })
      expect(observed).toEqual(["custom-provider.chat"])
    }),
  )

  it.effect("does not overwrite an SDK created by an earlier provider-specific plugin", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const sentinel = { languageModel: (modelID: string) => ({ modelID }) }
      yield* aisdk.hook.sdk((event) => {
        event.sdk = sentinel
      })
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("cloudflare-workers-ai"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "cloudflare-workers-ai" },
      })
      expect(result.sdk).toBe(sentinel)
    }),
  )
})
