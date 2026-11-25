import { describe, expect } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { Auth, VideoClient, ai, type VideoModel, type VideoStatus } from "../../src/effect.js"
import { AlibabaVideo } from "../../src/protocols/alibaba-video.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"
import { recordedTests } from "../recorded-test.js"
import { queuedPoll } from "./queued-recording.js"

const model = (id: string) =>
  AlibabaVideo.model({
    id,
    auth: Auth.bearer(process.env.DASHSCOPE_API_KEY ?? "fixture"),
    baseURL: "https://dashscope-intl.aliyuncs.com",
  })

const recorded = recordedTests({
  prefix: "alibaba-video",
  provider: "alibaba",
  protocol: "alibaba-video",
  requires: ["DASHSCOPE_API_KEY"],
})

const settle = (model: VideoModel, id: string) =>
  Effect.gen(function* () {
    const observed: Array<VideoStatus> = []
    yield* ai.video.status(model, id).pipe(
      Effect.tap((status) => Effect.sync(() => observed.push(status))),
      Effect.repeat({
        schedule: Schedule.spaced(queuedPoll.interval ?? "10 millis"),
        until: (status) => status.status !== "running",
      }),
    )
    return observed
  })

describe("Alibaba Video recorded", () => {
  recorded.effect(
    "generates a t2v video",
    () =>
      Effect.gen(function* () {
        const t2v = model("happyhorse-1.1-t2v")
        const job = yield* ai.video.start({
          model: t2v,
          prompt: "A single red balloon drifting slowly upward against a clear blue sky.",
          aspect: "16:9",
          resolution: "480p",
          duration: "4 seconds",
          providerOptions: { watermark: false },
        })
        const observed = yield* settle(t2v, job.id)
        expect(observed.map((status) => status.status)).toEqual(["running", "running", "completed"])

        const response = yield* ai.video.result(t2v, job.id)
        expect(response.videos).toHaveLength(1)
        expect(response.video.source).toMatchObject({ type: "url", mediaType: "video/mp4" })
        expect(response.video.expiresAt).toBeGreaterThan(0)
        expect(response.usage).toEqual({ type: "seconds", seconds: 4 })
        expect(response.providerMetadata?.alibaba).toMatchObject({ taskID: job.id })
      }),
    { timeout: 15 * 60 * 1000 },
  )

  recorded.effect(
    "generates an i2v video from a first frame",
    () =>
      Effect.gen(function* () {
        const i2v = model("happyhorse-1.1-i2v")
        // The cassette's request body carries the first frame as `media` and no ratio; replay matches it exactly.
        const job = yield* ai.video.start({
          model: i2v,
          prompt: "The tiger slowly turns its head and looks at the camera.",
          start: "https://dashscope.oss-cn-beijing.aliyuncs.com/images/tiger.png",
          resolution: "720p",
          duration: "5 seconds",
        })
        const observed = yield* settle(i2v, job.id)
        expect(observed.at(-1)?.status).toBe("completed")

        const response = yield* ai.video.result(i2v, job.id)
        expect(response.videos).toHaveLength(1)
        expect(response.video.source.type).toBe("url")
        expect(response.usage).toEqual({ type: "seconds", seconds: 5 })
        expect(response.providerMetadata?.alibaba).toMatchObject({ taskID: job.id })
      }),
    { timeout: 15 * 60 * 1000 },
  )

  recorded.effect(
    "generates an r2v video from reference images",
    () =>
      Effect.gen(function* () {
        const r2v = model("happyhorse-1.1-r2v")
        // The cassette's request body carries the reference_image array; replay matches it exactly.
        const job = yield* ai.video.start({
          model: r2v,
          prompt: "The two characters greet each other in a sunny park.",
          references: [
            "https://dashscope.oss-cn-beijing.aliyuncs.com/images/tiger.png",
            "https://dashscope.oss-cn-beijing.aliyuncs.com/images/rabbit.png",
          ],
          aspect: "16:9",
          resolution: "720p",
          duration: "5 seconds",
        })
        const observed = yield* settle(r2v, job.id)
        expect(observed.at(-1)?.status).toBe("completed")

        const response = yield* ai.video.result(r2v, job.id)
        expect(response.videos).toHaveLength(1)
        expect(response.video.source.type).toBe("url")
        expect(response.usage).toEqual({ type: "seconds", seconds: 5 })
        expect(response.providerMetadata?.alibaba).toMatchObject({ taskID: job.id })
      }),
    { timeout: 15 * 60 * 1000 },
  )

  recorded.effect(
    "fails a task the provider rejected",
    () =>
      Effect.gen(function* () {
        const t2v = model("happyhorse-1.1-t2v")
        const job = yield* ai.video.start({
          model: t2v,
          prompt: "A scene the content inspector rejects.",
          resolution: "480p",
        })
        const observed = yield* settle(t2v, job.id)
        expect(observed.at(-1)).toEqual({ status: "error", reason: "failed" })

        const error = yield* ai.video.result(t2v, job.id).pipe(Effect.flip)
        expect(error.reason._tag).toBe("ContentPolicy")
        expect(error.message).toBe(
          "Alibaba Video generation failed (DataInspectionFailed): Input data may contain inappropriate content.",
        )
      }),
    { timeout: 15 * 60 * 1000 },
  )

  recorded.effect(
    "rejects an invalid API key",
    () =>
      Effect.gen(function* () {
        const error = yield* ai.video
          .start({
            model: model("happyhorse-1.1-t2v"),
            prompt: "A single red balloon drifting slowly upward against a clear blue sky.",
          })
          .pipe(Effect.flip)
        expect(error.reason._tag).toBe("Authentication")
      }),
    { timeout: 15 * 60 * 1000 },
  )
})

describe("Alibaba Video rejections", () => {
  const offline = VideoClient.layer.pipe(
    Layer.provideMerge(dynamicResponse(() => Effect.die("an unsupported request reached the network"))),
  )

  it.effect("rejects a last frame before sending, since HappyHorse has no end input", () =>
    Effect.gen(function* () {
      const error = yield* ai.video
        .start({
          model: model("happyhorse-1.1-i2v"),
          prompt: "x",
          start: "https://example.test/first.png",
          end: "https://example.test/last.png",
        })
        .pipe(Effect.flip)
      expect(error.reason).toMatchObject({ _tag: "UnsupportedOperation", operation: "video.end" })
    }).pipe(Effect.provide(offline)),
  )

  it.effect("fails cancel as unsupported without sending a request, since the API has no cancel endpoint", () =>
    Effect.gen(function* () {
      const error = yield* ai.video.cancel(model("happyhorse-1.1-t2v"), "hh-t2v-0001").pipe(Effect.flip)
      expect(error.reason._tag).toBe("UnsupportedOperation")
      expect(error.message).toContain("cancel")
    }).pipe(Effect.provide(offline)),
  )
})
