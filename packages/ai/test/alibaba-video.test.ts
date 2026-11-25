import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth, Media, VideoClient, ai } from "../src/effect.js"
import { AlibabaVideo } from "../src/protocols/alibaba-video.js"
import { it } from "./lib/effect.js"
import { dynamicResponse, json, observe, type Call } from "./lib/http.js"

const layer = (handler: Parameters<typeof dynamicResponse>[0]) =>
  VideoClient.layer.pipe(Layer.provideMerge(dynamicResponse(handler)))

const configure = (id: string) =>
  AlibabaVideo.model({ id, auth: Auth.bearer("test"), baseURL: "https://dashscope.test" })
const t2v = configure("happyhorse-1.1-t2v")
const i2v = configure("happyhorse-1.1-i2v")
const r2v = configure("happyhorse-1.1-r2v")
const id = "task_1"

const submitted = { output: { task_id: "task_1", task_status: "PENDING" }, request_id: "req_1" }
const task = (fields: Record<string, unknown>) => ({ output: { task_id: "task_1", ...fields }, request_id: "req_1" })
const succeeded = {
  ...task({ task_status: "SUCCEEDED", video_url: "https://cdn.dashscope.test/out.mp4" }),
  usage: { video_duration: 5, video_count: 1, video_ratio: "16:9" },
}

/** The calls and parsed bodies DashScope receives for each submitted request. */
const sent = (requests: ReadonlyArray<Omit<Parameters<typeof ai.video.start>[0], "prompt">>) =>
  Effect.gen(function* () {
    const calls: Array<Call> = []
    yield* Effect.forEach(requests, (request) => ai.video.start({ prompt: "test", ...request })).pipe(
      Effect.provide(
        layer((input) => observe(calls, input).pipe(Effect.map(() => json(input, submitted)))),
      ),
    )
    return calls.map((call) => ({ url: call.url, body: JSON.parse(call.body) }))
  })

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

describe("Alibaba Video / start", () => {
  it.effect("maps every shared field onto the synthesis body and returns the job without polling", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = []
      const job = yield* ai.video
        .start({
          model: t2v,
          prompt: "Make the water crash down",
          duration: "5 seconds",
          aspect: "16:9",
          resolution: "720p",
          sound: true,
          providerOptions: { watermark: false, seed: 42, future_option: true },
          headers: { "x-request": "yes" },
          http: { query: { trace: "1" } },
        })
        .pipe(
          Effect.provide(
            layer((input) =>
              Effect.gen(function* () {
                const { call } = yield* observe(calls, input)
                expect(call.headers.get("authorization")).toBe("Bearer test")
                expect(call.headers.get("x-dashscope-async")).toBe("enable")
                expect(call.headers.get("x-request")).toBe("yes")
                return json(input, submitted)
              }),
            ),
          ),
        )
      expect(job).toEqual({ id: "task_1" })
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        "POST https://dashscope.test/api/v1/services/aigc/video-generation/video-synthesis?trace=1",
      ])
      expect(JSON.parse(calls[0].body)).toEqual({
        model: "happyhorse-1.1-t2v",
        input: { prompt: "Make the water crash down" },
        parameters: { resolution: "720P", ratio: "16:9", duration: 5, watermark: false, seed: 42, future_option: true },
      })
    }),
  )

  it.effect("omits ratio for auto and unset, and passes unknown resolutions through uppercased", () =>
    Effect.gen(function* () {
      const requests = yield* sent([{ model: t2v }, { model: t2v, aspect: "auto", resolution: "2k" }])
      expect(requests.map((request) => request.body)).toEqual([
        { model: "happyhorse-1.1-t2v", input: { prompt: "test" } },
        { model: "happyhorse-1.1-t2v", input: { prompt: "test" }, parameters: { resolution: "2K" } },
      ])
    }),
  )

  it.effect("sends the i2v first frame as media and never a ratio", () =>
    Effect.gen(function* () {
      const requests = yield* sent([
        {
          model: i2v,
          start: Media.fromDataUrl("data:image/png;base64,AQID"),
          aspect: "auto",
          resolution: "720p",
          duration: "5 seconds",
        },
      ])
      expect(requests[0].body).toEqual({
        model: "happyhorse-1.1-i2v",
        input: { prompt: "test", media: [{ type: "first_frame", url: "data:image/png;base64,AQID" }] },
        parameters: { resolution: "720P", duration: 5 },
      })
    }),
  )

  it.effect("sends r2v reference images as media, with a ratio", () =>
    Effect.gen(function* () {
      const requests = yield* sent([
        {
          model: r2v,
          references: ["https://example.test/face.png", Media.fromDataUrl("data:image/png;base64,AQID")],
          aspect: "9:16",
        },
      ])
      expect(requests[0].body).toEqual({
        model: "happyhorse-1.1-r2v",
        input: {
          prompt: "test",
          media: [
            { type: "reference_image", url: "https://example.test/face.png" },
            { type: "reference_image", url: "data:image/png;base64,AQID" },
          ],
        },
        parameters: { ratio: "9:16" },
      })
    }),
  )

  it.effect("defaults unknown model IDs to the text-to-video shape", () =>
    Effect.gen(function* () {
      const requests = yield* sent([{ model: configure("happyhorse-9.9") }])
      expect(requests[0].body).toEqual({ model: "happyhorse-9.9", input: { prompt: "test" } })
    }),
  )

  it.effect("merges the http body overlay into parameters", () =>
    Effect.gen(function* () {
      const requests = yield* sent([
        { model: t2v, providerOptions: { watermark: false }, http: { body: { parameters: { watermark: true } } } },
      ])
      expect(requests[0].body.parameters).toEqual({ watermark: true })
    }),
  )

  it.effect("sends nothing for sound, which the API has no field for", () =>
    Effect.gen(function* () {
      const requests = yield* sent([
        { model: t2v, sound: true },
        { model: i2v, start: "https://example.test/first.png", sound: false },
      ])
      expect(requests.map((request) => JSON.stringify(request.body).includes("sound"))).toEqual([false, false])
    }),
  )

  for (const rejected of [
    {
      name: "a last frame",
      request: { model: t2v, end: "https://example.test/last.png" },
      tag: "UnsupportedOperation",
      operation: "video.end",
    },
    {
      name: "a first frame on t2v",
      request: { model: t2v, start: "https://example.test/first.png" },
      tag: "UnsupportedOperation",
      operation: "video.start",
    },
    {
      name: "references on t2v",
      request: { model: t2v, references: ["https://example.test/face.png"] },
      tag: "UnsupportedOperation",
      operation: "video.references",
    },
    {
      name: "references on i2v",
      request: { model: i2v, start: "https://example.test/first.png", references: ["https://example.test/face.png"] },
      tag: "UnsupportedOperation",
      operation: "video.references",
    },
    {
      name: "an aspect ratio on i2v",
      request: { model: i2v, start: "https://example.test/first.png", aspect: "16:9" as const },
      tag: "UnsupportedOperation",
      operation: "video.aspect",
    },
    { name: "i2v without a first frame", request: { model: i2v }, tag: "InvalidRequest", operation: undefined },
    {
      name: "a first frame on r2v",
      request: { model: r2v, start: "https://example.test/first.png", references: ["https://example.test/face.png"] },
      tag: "UnsupportedOperation",
      operation: "video.start",
    },
    { name: "r2v without references", request: { model: r2v }, tag: "InvalidRequest", operation: undefined },
    {
      name: "r2v with ten references",
      request: {
        model: r2v,
        references: Array.from({ length: 10 }, (_, index) => `https://example.test/ref${index}.png`),
      },
      tag: "InvalidRequest",
      operation: undefined,
    },
    {
      name: "a reference video",
      request: { model: r2v, references: [Media.url("https://example.test/m.mp4", { mediaType: "video/mp4" })] },
      tag: "UnsupportedOperation",
      operation: "video.references",
    },
  ]) {
    it.effect(`rejects ${rejected.name} before sending`, () =>
      Effect.gen(function* () {
        const error = yield* ai.video.start({ prompt: "x", ...rejected.request }).pipe(Effect.flip)
        expect(error.reason._tag).toBe(rejected.tag)
        if (rejected.operation !== undefined) expect(error.reason).toMatchObject({ operation: rejected.operation })
      }).pipe(Effect.provide(layer(() => Effect.die("an unsupported request reached the network")))),
    )
  }

  for (const failure of [
    { code: "InvalidApiKey", tag: "Authentication" },
    { code: "Throttling", tag: "RateLimit" },
    { code: "Throttling.RateQuota", tag: "RateLimit" },
    { code: "InvalidParameter", tag: "InvalidRequest" },
    { code: "DataInspectionFailed", tag: "ContentPolicy" },
    { code: "SomethingNew", tag: "ProviderInternal" },
  ]) {
    it.effect(`maps a submit error body with ${failure.code} to ${failure.tag}`, () =>
      Effect.gen(function* () {
        const error = yield* ai.video
          .start({ model: t2v, prompt: "x" })
          .pipe(
            Effect.flip,
            Effect.provide(
              layer((input) =>
                Effect.succeed(json(input, { code: failure.code, message: "the detail", request_id: "req_1" })),
              ),
            ),
          )
        expect(error.reason._tag).toBe(failure.tag)
        expect(error.message).toBe(`Alibaba Video generation failed (${failure.code}): the detail`)
      }),
    )
  }

  it.effect("returns DashScope's HTTP errors typed", () =>
    Effect.gen(function* () {
      const error = yield* ai.video
        .start({ model: t2v, prompt: "x" })
        .pipe(
          Effect.flip,
          Effect.provide(
            layer((input) =>
              Effect.succeed(
                json(input, { code: "InvalidApiKey", message: "Invalid API-key provided.", request_id: "req_1" }, { status: 401 }),
              ),
            ),
          ),
        )
      expect(error.reason._tag).toBe("Authentication")
    }),
  )

  it.effect("fails a submit that returns no task_id", () =>
    Effect.gen(function* () {
      const error = yield* ai.video
        .start({ model: t2v, prompt: "x" })
        .pipe(Effect.flip, Effect.provide(layer((input) => Effect.succeed(json(input, { output: {} })))))
      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toBe("Alibaba Video returned no task_id")
    }),
  )
})

// ---------------------------------------------------------------------------
// Status, result, cancel
// ---------------------------------------------------------------------------

describe("Alibaba Video / status, result and cancel", () => {
  it.effect("reads statuses from a JSON round-tripped token and keeps unknown ones running", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = []
      const raw: unknown = id
      const statuses = yield* Effect.forEach(
        ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN", "SOMETHING_NEW"],
        (task_status) =>
          ai.video
            .status(t2v, raw)
            .pipe(
              Effect.provide(
                layer((input) => observe(calls, input).pipe(Effect.map(() => json(input, task({ task_status }))))),
              ),
            ),
      )
      expect(statuses).toEqual([
        { status: "running" },
        { status: "running" },
        { status: "completed" },
        { status: "error", reason: "failed" },
        { status: "error", reason: "cancelled" },
        { status: "error", reason: "failed" },
        { status: "running" },
      ])
      expect(calls[0].url).toBe("https://dashscope.test/api/v1/tasks/task_1")
      // The async flag is submit-only: DashScope rejects task reads that carry it.
      for (const call of calls) {
        expect(call.method).toBe("GET")
        expect(call.headers.get("x-dashscope-async")).toBe(null)
      }
    }),
  )

  it.effect("returns the finished video with a 24-hour URL, usage and metadata", () =>
    Effect.gen(function* () {
      const response = yield* ai.video.result(t2v, id)
      expect(response.video.source).toEqual({
        type: "url",
        url: "https://cdn.dashscope.test/out.mp4",
        mediaType: "video/mp4",
        expiresAt: 24 * 60 * 60 * 1000,
      })
      expect(response.video.info).toEqual({ durationSeconds: 5 })
      expect(response.usage).toEqual({ type: "seconds", seconds: 5 })
      expect(response.providerMetadata?.alibaba).toMatchObject({
        taskID: "task_1",
        requestID: "req_1",
        output: { task_status: "SUCCEEDED", video_url: "https://cdn.dashscope.test/out.mp4" },
        usage: { video_duration: 5, video_count: 1, video_ratio: "16:9" },
      })
    }).pipe(Effect.provide(layer((input) => Effect.succeed(json(input, succeeded))))),
  )

  it.effect("omits usage when the task reports no numeric video duration", () =>
    Effect.gen(function* () {
      const response = yield* ai.video.result(t2v, id)
      expect(response.usage).toBeUndefined()
      expect(response.video.info).toBeUndefined()
    }).pipe(
      Effect.provide(
        layer((input) =>
          Effect.succeed(json(input, task({ task_status: "SUCCEEDED", video_url: "https://cdn.dashscope.test/out.mp4" }))),
        ),
      ),
    ),
  )

  it.effect("fails a result read before the task finishes", () =>
    Effect.gen(function* () {
      const error = yield* ai.video.result(t2v, id).pipe(Effect.flip)
      expect(error.reason._tag).toBe("InvalidRequest")
      expect(error.message).toContain("has not finished")
    }).pipe(Effect.provide(layer((input) => Effect.succeed(json(input, task({ task_status: "RUNNING" })))))),
  )

  for (const terminal of [
    {
      body: task({ task_status: "FAILED", code: "InvalidParameter", message: "invalid params" }),
      tag: "InvalidRequest",
      message: "Alibaba Video generation failed (InvalidParameter): invalid params",
    },
    {
      body: task({ task_status: "FAILED", code: "DataInspectionFailed", message: "output sensitive" }),
      tag: "ContentPolicy",
      message: "Alibaba Video generation failed (DataInspectionFailed): output sensitive",
    },
    {
      body: task({ task_status: "FAILED", code: "SomethingNew", message: "future" }),
      tag: "ProviderInternal",
      message: "Alibaba Video generation failed (SomethingNew): future",
    },
    {
      body: task({ task_status: "FAILED" }),
      tag: "ProviderInternal",
      message: "Alibaba Video generation failed",
    },
    {
      body: task({ task_status: "CANCELED" }),
      tag: "InvalidRequest",
      message: "Alibaba Video task task_1 was cancelled",
    },
    {
      body: task({ task_status: "UNKNOWN" }),
      tag: "ProviderInternal",
      message: "Alibaba Video generation failed",
    },
    {
      body: task({ task_status: "SUCCEEDED" }),
      tag: "InvalidProviderOutput",
      message: "Alibaba Video completed without a video URL",
    },
  ]) {
    it.effect(`fails the result of ${terminal.message} with the provider body`, () =>
      Effect.gen(function* () {
        const error = yield* ai.video.result(t2v, id).pipe(Effect.flip)
        expect(error.reason._tag).toBe(terminal.tag)
        expect(error.message).toBe(terminal.message)
        expect(error.reason.body).toBe(JSON.stringify(terminal.body))
      }).pipe(Effect.provide(layer((input) => Effect.succeed(json(input, terminal.body))))),
    )
  }

  it.effect("fails cancel as unsupported without sending a request, since the API has no cancel endpoint", () =>
    Effect.gen(function* () {
      const error = yield* ai.video.cancel(t2v, id).pipe(Effect.flip)
      expect(error.reason._tag).toBe("UnsupportedOperation")
      expect(error.message).toContain("cancel")
    }).pipe(Effect.provide(layer(() => Effect.die("cancel reached the network")))),
  )
})
