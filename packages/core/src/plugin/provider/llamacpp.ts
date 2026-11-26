import { Effect, Schema } from "effect"
import { createLocalProviderPlugin } from "./local.js"

const RemoteModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  engine: Schema.String.pipe(Schema.optional),
  output_modalities: Schema.Array(Schema.String).pipe(Schema.optional),
  context_length: Schema.Int.pipe(Schema.optional),
  max_context_length: Schema.Int.pipe(Schema.optional),
  tool_call: Schema.Boolean.pipe(Schema.optional),
  has_vision: Schema.Boolean.pipe(Schema.optional),
  capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
  sd_role: Schema.String.pipe(Schema.optional),
})

const Response = Schema.Struct({ data: Schema.Array(RemoteModel) })

export const make = createLocalProviderPlugin({
  id: "opencode.provider.llamacpp",
  providerID: "llamacpp",
  name: "LlamaCPP",
  origin: "http://127.0.0.1:29999",
  // The proxy walks its model directory on every /v1/models; query on demand, not on a timer.
  demand: true,
  discover: (client) =>
    Effect.gen(function* () {
      const response = yield* client.getJson("/v1/models", Response)
      return response.data.filter((model) => model.id.length > 0).toSorted((a, b) => a.id.localeCompare(b.id))
    }),
  model: (item) => {
    // sd-encoder entries are chat models served by the resident sd backend (shared memory
    // with image generation); they must stay in the chat listing, not the image one.
    const encoderChat = item.sd_role === "encoder" || item.capabilities?.includes("chat")
    // The sd engine (stable-diffusion.cpp) generates and edits images; the proxy routes both
    // /v1/images/generations and /v1/images/edits, taking a single source image for edits.
    if (!encoderChat && (item.engine === "sd" || item.output_modalities?.includes("image")))
      return { id: item.id, name: item.name || item.id, type: "image", vision: true }
    // Decision-only models answer through /v1/systemone; granite-switch hybrids stay chat.
    const modalities = item.output_modalities ?? []
    const decision = modalities.includes("decisions") && !modalities.includes("text")
    return {
      id: item.id,
      name: item.name || item.id,
      type: decision ? "decision" : "chat",
      tools: item.tool_call,
      vision: item.has_vision,
      context: item.context_length ?? item.max_context_length,
    }
  },
})

export const LlamaCppPlugin = make()
