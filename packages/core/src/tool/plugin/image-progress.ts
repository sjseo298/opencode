export * as ImageProgressTool from "./image-progress.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Provider } from "../../provider.js"
import { toolFailure } from "../runtime.js"

export const name = "experimental_image_progress"

export const description = [
  "Checks the progress and ETA of the image job currently running on the local llamacpp provider.",
  "Use this while a local image generation or edit is running in the background to see how far along it is (step, fraction, seconds per step, estimated time remaining) instead of waiting blindly. Local images can take many minutes at large sizes.",
  "Returns active=false when no local image job is running. This does not poll the saved file; it reads the proxy's live job progress.",
].join("\n")

const Progress = Schema.Struct({
  active: Schema.Boolean,
  job: Schema.optional(Schema.Unknown),
  progress: Schema.optional(Schema.Unknown),
})

export const Plugin = {
  id: "opencode.tool.image-progress",
  effect: Effect.fn("ImageProgressTool.Plugin")(function* (ctx: Context) {
    const http = yield* HttpClient.HttpClient
    const providers = yield* Provider.Service

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name,
        options: { codemode: false },
        description,
        input: Schema.Struct({}),
        output: Progress,
        execute: () =>
          Effect.gen(function* () {
            const provider = yield* providers.get(Provider.ID.make("llamacpp"))
            const baseURL = typeof provider?.settings?.baseURL === "string" ? provider.settings.baseURL : undefined
            if (!baseURL)
              return yield* new ToolFailure({ message: "The llamacpp provider is not configured with a baseURL." })
            const body = yield* http
              .execute(HttpClientRequest.get(`${baseURL.replace(/\/+$/, "")}/images/progress`))
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(Progress)),
                Effect.mapError(toolFailure("Unable to read local image progress")),
              )
            const progress = body.progress as { fraction?: number; eta_s?: number; step?: number; total_steps?: number } | undefined
            const summary = body.active
              ? `Local image job running${progress?.step !== undefined ? `: step ${progress.step}/${progress.total_steps}` : ""}${progress?.fraction !== undefined ? ` (${Math.round(progress.fraction * 100)}%)` : ""}${progress?.eta_s !== undefined ? `, ETA ~${Math.round(progress.eta_s)}s` : ""}.`
              : "No local image job is currently running."
            return { output: body, content: summary, metadata: { active: body.active } }
          }).pipe(Effect.mapError(toolFailure("Unable to read local image progress"))),
      })
    })
  }),
}
