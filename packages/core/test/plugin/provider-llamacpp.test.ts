import { describe, expect } from "bun:test"
import { Duration, Effect, Schema } from "effect"
import { Config } from "@opencode/core/config"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { make } from "@opencode/core/plugin/provider/llamacpp"
import { ProviderRefresh } from "@opencode/core/plugin/provider/refresh"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const llamacppID = Provider.ID.make("llamacpp")

// Catalog shaped like llamacppselector's ModelsCatalogBuilder: sd image recipes, conversational
// GGUF models, decision-only models and granite-switch hybrids.
const catalog = [
  {
    id: "sd/qwen-image-21-turbo-uncensored.json",
    name: "[sd] qwen-image-21-turbo-uncensored",
    engine: "sd",
    capabilities: ["image-generation"],
    output_modalities: ["image"],
    context_length: 0,
    tool_call: false,
    has_vision: false,
  },
  {
    id: "gguf/unsloth/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    name: "[gguf] Qwen3.6-35B-A3B UD-Q4_K_XL",
    engine: "gguf",
    capabilities: ["chat", "completion", "vision", "tools"],
    output_modalities: ["text"],
    context_length: 262144,
    tool_call: true,
    has_vision: true,
  },
  {
    id: "gguf/clef-clefi-1b",
    name: "[gguf] CLEF Clefi 1B",
    engine: "gguf",
    capabilities: ["decisions"],
    output_modalities: ["decisions"],
    context_length: 32768,
    tool_call: false,
    has_vision: false,
  },
  {
    id: "gguf/granite-switch-2b",
    name: "[gguf] Granite Switch 2B",
    engine: "gguf",
    capabilities: ["chat", "completion", "decisions"],
    output_modalities: ["text", "decisions"],
    context_length: 131072,
    tool_call: true,
    has_vision: false,
  },
]

const fakeLlamaCpp = (data: unknown[] | (() => unknown[])) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const requests: string[] = []
      const server = Bun.serve({
        port: 0,
        fetch: (raw) => {
          const url = new URL(raw.url)
          requests.push(url.pathname)
          if (url.pathname === "/v1/models")
            return Response.json({ object: "list", data: typeof data === "function" ? data() : data })
          return new Response("not found", { status: 404 })
        },
      })
      return { origin: `http://127.0.0.1:${server.port}`, server, requests }
    }),
    ({ server }) => Effect.sync(() => server.stop(true)),
  )

// An explicit configured baseURL, like the user's opencode.jsonc: it wins over the default origin
// and makes discovery failures visible in the plugin's warning log.
const addPlugin = (origin: string, interval?: Duration.Input) =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const host = yield* PluginHost.make(plugin, "test")
    const entries = [
      new Document({
        type: "document",
        info: Schema.decodeUnknownSync(Info)({
          providers: { llamacpp: { settings: { baseURL: `${origin}/v1` } } },
        }),
      }),
    ]
    yield* make(undefined, interval).effect(host).pipe(Effect.provide(Config.testLayer(entries)))
  })

const llamacppModels = Effect.gen(function* () {
  const models = yield* Model.Service
  // all() only offers chat models; image and decision live in per-type buckets.
  return (yield* models.available(["chat", "image", "decision"])).filter((model) => model.providerID === llamacppID)
})

// The local factory discovers over real HTTP and caches by Date.now, so these tests run on the
// live clock; a virtual clock would fire the request timeout before the real fetch completes.
const eventually = <A, R>(effect: Effect.Effect<A, never, R>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error("Timed out waiting for value"))
  })

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

describe("LlamaCppPlugin", () => {
  it.live("registers sd models as image models through the openai-compatible images entrypoint", () =>
    Effect.gen(function* () {
      const fake = yield* fakeLlamaCpp(catalog)
      yield* addPlugin(fake.origin)
      const models = yield* eventually(llamacppModels, (all) => all.length === catalog.length)
      const sd = required(models.find((model) => model.id === "sd/qwen-image-21-turbo-uncensored.json"))
      expect(sd.type).toBe("image")
      expect(sd.package).toBe("@opencode/ai/providers/openai-compatible/images")
      expect(sd.capabilities.input).toEqual(["text", "image"])
      expect(sd.capabilities.output).toEqual(["image"])

      const available = yield* Model.Service
      const images = yield* available.available(["image"])
      expect(images.some((model) => model.providerID === llamacppID && model.id === sd.id)).toBe(true)
      // Image models stay out of the chat catalog offered for sessions.
      const chat = yield* available.available()
      expect(chat.some((model) => model.id === sd.id)).toBe(false)
    }),
  )

  it.live("keeps chat and decision discovery unchanged", () =>
    Effect.gen(function* () {
      const fake = yield* fakeLlamaCpp(catalog)
      yield* addPlugin(fake.origin)
      const models = yield* eventually(llamacppModels, (all) => all.length === catalog.length)

      const chat = required(models.find((model) => model.id === "gguf/unsloth/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"))
      expect(chat.type ?? "chat").toBe("chat")
      expect(chat.package).toBe("@opencode/ai/providers/openai-compatible")
      expect(chat.capabilities.tools).toBe(true)
      expect(chat.capabilities.input).toEqual(["text", "image"])
      expect(chat.capabilities.output).toEqual(["text"])
      expect(chat.limit.context).toBe(262144)

      const decision = required(models.find((model) => model.id === "gguf/clef-clefi-1b"))
      expect(decision.type).toBe("decision")
      expect(decision.package).toBe("@opencode/ai/providers/openai-compatible/decisions")
      expect(decision.capabilities.output).toEqual(["decision"])

      // granite-switch hybrids answer chat and decisions; they stay chat models.
      const hybrid = required(models.find((model) => model.id === "gguf/granite-switch-2b"))
      expect(hybrid.type ?? "chat").toBe("chat")
      expect(hybrid.package).toBe("@opencode/ai/providers/openai-compatible")
    }),
  )

  it.live("discovers on demand instead of polling", () =>
    Effect.gen(function* () {
      let served: unknown[] = [catalog[0]]
      const fake = yield* fakeLlamaCpp(() => served)
      // A 1 ms TTL makes any periodic poll obvious; demand mode must still query only when asked.
      yield* addPlugin(fake.origin, "1 millis")
      yield* eventually(llamacppModels, (all) => all.length === 1)
      expect(fake.requests.length).toBe(1)

      yield* Effect.sleep("30 millis")
      expect(fake.requests.length).toBe(1)

      served = [...catalog]
      yield* ProviderRefresh.refreshDemand()
      const all = yield* eventually(llamacppModels, (models) => models.length === catalog.length)
      expect(all.length).toBe(catalog.length)
      expect(fake.requests.length).toBe(2)
    }),
  )
})
