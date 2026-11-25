import { describe, expect } from "bun:test"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { ImageProgressTool } from "@opencode/core/tool/plugin/image-progress"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const fakeProxy = (progress: unknown) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const server = Bun.serve({
        port: 0,
        fetch: (raw) => {
          const url = new URL(raw.url)
          if (url.pathname === "/v1/images/progress") return Response.json(progress)
          return new Response("not found", { status: 404 })
        },
      })
      return { baseURL: `http://127.0.0.1:${server.port}/v1`, server }
    }),
    ({ server }) => Effect.sync(() => server.stop(true)),
  )

const setup = (baseURL: string) =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    yield* providers.transform((editor) =>
      editor.update(Provider.ID.make("llamacpp"), (provider) => {
        provider.activation = "enabled"
        provider.settings = { baseURL }
      }),
    )
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "test")
    yield* ImageProgressTool.Plugin.effect(host)
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: location.directory }),
      model: Model.Ref.make({ providerID: Provider.ID.make("llamacpp"), id: Model.ID.make("chat") }),
    })
    const registry = yield* Tool.Service
    const run = () =>
      executeTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-progress", name: ImageProgressTool.name, input: {} },
      })
    return { run }
  })

describe("experimental_image_progress", () => {
  it.effect("reports the running local job's progress and ETA from the proxy", () =>
    Effect.gen(function* () {
      const fake = yield* fakeProxy({
        active: true,
        job: { id: "j1", kind: "txt2img", model: "sd/x.json", width: 768, height: 768 },
        progress: { step: 3, total_steps: 20, fraction: 0.15, seconds_per_step: 12.5, eta_s: 212 },
      })
      const { run } = yield* setup(fake.baseURL)
      const result = yield* run()
      expect(result.output.active).toBe(true)
      expect(result.output.progress).toMatchObject({ step: 3, total_steps: 20, eta_s: 212 })
      expect(JSON.stringify(result.content)).toContain("ETA")
    }),
  )

  it.effect("reports no active job when the proxy is idle", () =>
    Effect.gen(function* () {
      const fake = yield* fakeProxy({ active: false })
      const { run } = yield* setup(fake.baseURL)
      const result = yield* run()
      expect(result.output.active).toBe(false)
      expect(JSON.stringify(result.content)).toContain("No local image job")
    }),
  )
})
