import { Duration, Effect, Schema } from "effect"
import type { HttpClientResponse } from "effect/http"
import { Media } from "../media.js"
import { MediaProtocol } from "../route/media-protocol.js"
import { MediaRoute } from "../route/media.js"
import { mergeJsonRecords } from "../schema/index.js"
import { VideoModel, VideoResponse, seconds, type VideoRequest } from "../video.js"
import { JsonObject, ProviderShared, lenient, optionalNull } from "./shared.js"

// HappyHorse 1.1 runs one queued API: submit a synthesis job, then poll the task by its ID.
const route = MediaProtocol.identity({ id: "alibaba-video", name: "Alibaba Video", provider: "alibaba" })
/** The API host without a version: catalog baseURLs are host-only, so the paths carry `/api/v1`. */
export const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com"
export const PATH = "/api/v1/services/aigc/video-generation/video-synthesis"
export const STATUS_PATH = "/api/v1/tasks"
const OUTPUT_RETENTION = Duration.hours(24)

// ---------------------------------------------------------------------------
// 1. Public model input
// ---------------------------------------------------------------------------

/** Provider-native `parameters`. Common fields (`start`, `references`, `duration`, `aspect`, `resolution`) live on the request. */
export type AlibabaVideoOptions = {
  readonly watermark?: boolean
  readonly seed?: number
} & Record<string, unknown>

export type Request = VideoRequest<VideoModel<AlibabaVideoOptions>>

// ---------------------------------------------------------------------------
// 2. Token and response schemas
// ---------------------------------------------------------------------------

/** The provider's task ID; it is all a later status or result call needs. */
export const Token = Schema.String
export type Token = Schema.Schema.Type<typeof Token>

const StartResponse = Schema.Struct({
  output: optionalNull(
    Schema.Struct({
      task_id: optionalNull(Schema.String),
      task_status: optionalNull(Schema.String),
    }),
  ),
  code: optionalNull(Schema.String),
  message: optionalNull(Schema.String),
  request_id: optionalNull(Schema.String),
})

const TaskResponse = Schema.Struct({
  output: Schema.Struct({
    task_id: optionalNull(Schema.String),
    task_status: optionalNull(Schema.String),
    video_url: optionalNull(Schema.String),
    code: optionalNull(Schema.String),
    message: optionalNull(Schema.String),
  }),
  request_id: optionalNull(Schema.String),
  usage: lenient(JsonObject),
})

const STATUS = {
  PENDING: "running",
  RUNNING: "running",
  SUCCEEDED: "completed",
  FAILED: "failed",
  CANCELED: "cancelled",
  // The task is missing or expired; its result will never exist.
  UNKNOWN: "failed",
} as const satisfies Record<string, MediaProtocol.State>

// ---------------------------------------------------------------------------
// 3. Failures
// ---------------------------------------------------------------------------

// Error codes from the Model Studio video-synthesis docs; unknown codes are provider-side.
const FAILURE: Readonly<Record<string, MediaProtocol.Failure>> = {
  InvalidApiKey: "Authentication",
  Throttling: "RateLimit",
  "Throttling.RateQuota": "RateLimit",
  InvalidParameter: "InvalidRequest",
}
const CONTENT_POLICY = new Set(["DataInspectionFailed"])

type Output = Effect.Success<ReturnType<typeof route.text>>

const failed = (output: Output, code: string | undefined, detail: string | undefined) => {
  const message = `${route.name} generation failed${code === undefined ? "" : ` (${code})`}${detail === undefined ? "" : `: ${detail}`}`
  if (code !== undefined && CONTENT_POLICY.has(code)) return output.contentPolicy(message)
  return output.ended("failed", message, MediaProtocol.failure(FAILURE, code))
}

/** Model Studio bills video by the second; a malformed count is no usage. */
const usageSeconds = (usage: Record<string, unknown> | undefined) => {
  const value = usage?.video_duration ?? usage?.seconds
  return typeof value === "number" ? value : undefined
}

// ---------------------------------------------------------------------------
// 5. Request body construction
// ---------------------------------------------------------------------------

/** HappyHorse takes URLs and data URLs only; DashScope has no file handles. */
const mediaUrl = (asset: Media.Asset) =>
  ProviderShared.mediaReference(asset, undefined, route.name).pipe(Effect.map((reference) => reference.value))

/** The model family picks the input shape; unknown IDs default to text-to-video. */
const family = (modelID: string) => {
  const id = modelID.toLowerCase()
  if (id.endsWith("-i2v")) return "i2v"
  if (id.endsWith("-r2v")) return "r2v"
  return "t2v"
}

const fromRequest = Effect.fn("AlibabaVideo.fromRequest")(function* (request: Request) {
  // HappyHorse has no last-frame input, and `sound` has no field, so it isn't sent.
  if (request.end !== undefined)
    return yield* route.unsupported("video.end", `${route.name} has no last-frame input`)
  const kind = family(request.model.id)
  const references = request.references ?? []
  if (references.some((asset) => !Schema.is(Media.ImageAssetSchema)(asset)))
    return yield* route.unsupported("video.references", `${route.name} takes only image references`)
  if (kind === "t2v") {
    if (request.start !== undefined)
      return yield* route.unsupported("video.start", `${route.name} ${request.model.id} generates from text only`)
    if (references.length > 0)
      return yield* route.unsupported("video.references", `${route.name} ${request.model.id} generates from text only`)
  }
  if (kind === "i2v") {
    if (request.start === undefined)
      return yield* ProviderShared.invalidRequest(`${route.name} ${request.model.id} requires a first-frame image`)
    if (references.length > 0)
      return yield* route.unsupported("video.references", `${route.name} ${request.model.id} takes only a first frame`)
    // The output follows the first frame's shape; there is no ratio field.
    if (request.aspect !== undefined && request.aspect !== "auto")
      return yield* route.unsupported("video.aspect", `${route.name} ${request.model.id} has no aspect ratio input`)
  }
  if (kind === "r2v") {
    if (request.start !== undefined)
      return yield* route.unsupported("video.start", `${route.name} ${request.model.id} takes only reference images`)
    if (references.length === 0 || references.length > 9)
      return yield* ProviderShared.invalidRequest(`${route.name} ${request.model.id} requires 1-9 reference images`)
  }
  // The guards above leave a first frame for i2v and reference images for r2v; t2v carries neither.
  const media = [
    ...(request.start === undefined ? [] : [{ type: "first_frame", url: yield* mediaUrl(request.start) }]),
    ...(yield* Effect.forEach(references, (asset) =>
      mediaUrl(asset).pipe(Effect.map((url) => ({ type: "reference_image", url }))),
    )),
  ]
  return MediaProtocol.json(
    mergeJsonRecords(
      {
        model: request.model.id,
        input: media.length === 0 ? { prompt: request.prompt } : { prompt: request.prompt, media },
        parameters: mergeJsonRecords(
          {
            resolution: request.resolution?.toUpperCase(),
            ratio: request.aspect === undefined || request.aspect === "auto" ? undefined : request.aspect,
            duration: request.duration === undefined ? undefined : seconds(request.duration),
          },
          request.providerOptions,
        ),
      },
      request.http?.body,
    ) ?? {},
  )
})

// ---------------------------------------------------------------------------
// 6. Response decoding
// ---------------------------------------------------------------------------

const decodeStart = Effect.fn("AlibabaVideo.decodeStart")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const output = yield* route.decodeJson(StartResponse)(response)
  // A submission can answer with an error body instead of a task.
  const code = output.value.code ?? undefined
  if (code !== undefined) return yield* failed(output, code, output.value.message ?? undefined)
  const taskID = output.value.output?.task_id ?? ""
  if (taskID === "") return yield* output.invalid(`${route.name} returned no task_id`)
  return { token: taskID, snapshot: { id: taskID, status: "running" as const } }
})

const decodeTask = route.decodeJson(TaskResponse)

const decodeStatus = Effect.fn("AlibabaVideo.decodeStatus")(function* (
  response: HttpClientResponse.HttpClientResponse,
  context: MediaProtocol.PollContext<Token>,
) {
  const output = yield* decodeTask(response)
  return { id: context.token, ...MediaProtocol.status(STATUS, output.value.output.task_status ?? "") }
})

const decodeResult = Effect.fn("AlibabaVideo.decodeResult")(function* (
  response: HttpClientResponse.HttpClientResponse,
  context: MediaProtocol.PollContext<Token>,
) {
  const output = yield* decodeTask(response)
  const task = output.value.output
  const status = MediaProtocol.state(STATUS, task.task_status ?? "")
  if (status === "running") return yield* output.pending(context.token)
  if (status === "failed") return yield* failed(output, task.code ?? undefined, task.message ?? undefined)
  if (status !== "completed")
    return yield* output.ended("cancelled", `${route.name} task ${context.token} was cancelled`)
  const url = task.video_url ?? undefined
  if (url === undefined) return yield* output.invalid(`${route.name} completed without a video URL`)
  const total = usageSeconds(output.value.usage)
  return new VideoResponse({
    // The signed URL expires after 24 hours; reading the result again returns a fresh one.
    videos: [
      yield* MediaProtocol.expiringUrl(url, OUTPUT_RETENTION, {
        mediaType: "video/mp4",
        info: total === undefined ? undefined : { durationSeconds: total },
      }),
    ],
    usage: total === undefined ? undefined : { type: "seconds", seconds: total },
    providerMetadata: {
      alibaba: {
        taskID: context.token,
        requestID: output.value.request_id ?? undefined,
        output: task,
        usage: output.value.usage,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// 7. Protocol and route
// ---------------------------------------------------------------------------

const taskPath = (token: Token) => `${STATUS_PATH}/${encodeURIComponent(token)}`

export const protocol = MediaProtocol.queued<Request, VideoResponse, Token>(route, {
  token: Token,
  // Required on submit only; the task GET rejects it ("does not support asynchronous calls").
  start: { headers: { "X-DashScope-Async": "enable" }, body: { from: fromRequest }, decode: decodeStart },
  status: { path: taskPath, decode: decodeStatus },
  result: { path: taskPath, decode: decodeResult },
  // Model Studio documents no cancel call; VideoClient reports UnsupportedOperation.
})

export const model = (input: MediaRoute.ModelInput) =>
  VideoModel.fromRoute<AlibabaVideoOptions>(
    {
      protocol,
      baseURL: DEFAULT_BASE_URL,
      path: PATH,
    },
    input,
  )

export const AlibabaVideo = {
  protocol,
  model,
} as const
