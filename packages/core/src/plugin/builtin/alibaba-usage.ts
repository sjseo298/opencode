/**
 * Builtin cross-surface plugin `opencode.alibaba.usage` for the Alibaba Cloud Model Studio
 * international Token Plan. It exposes two slash commands on both TUI and Web/Desktop:
 *
 * - `/alibabaUsage` — monthly quota usage with estimated daily/weekly consumption and
 *   pace verdicts derived statelessly from the monthly percentage, and cutoff date.
 * - `/alibabaDiscounts` — the Token Plan models currently running a promotion.
 * - `/alibabaLogin` — agent-driven console login through the user's real browser (browse
 *   tools), implementing spec `alibaba_token_plan_login_v2` rev 2. It starts the same local
 *   callback login, then hands the session precise instructions (see `alibaba-login.txt`):
 *   open the console-login URL, ensure the account is logged in FIRST (handoff for MFA),
 *   install the fetch/XHR interceptor only after login and immediately before the consent
 *   click (a document reload during sign-in would wipe it), then poll the captured token
 *   with bounded retries (10 × 1.5 s) instead of waiting for the unreliable "CLI Login
 *   successful!" page text. Extraction is field-driven (`extractCapturedToken`, spec §4.2)
 *   with a state-mismatch guard; when this server is remote and the browser's loopback POST
 *   cannot reach it, the agent submits the captured token via `completeLogin`. Both the
 *   automatic (agent click) and manual (user paste) modes converge on `completeLogin` +
 *   `tokenPlan` refresh verification, and every exit path releases the attempt
 *   (`cancelLogin`) and closes the `alibaba-login` tab group. In remote mode the token
 *   transits the agent's tool calls (browse eval results are not redacted), unlike local
 *   mode where it goes straight to the callback server; the instructions require keeping it
 *   out of visible responses, logs, and files.
 *
 * Data is read natively from the console gateway (`IntlBroadScopeAspnGateway`, product
 * `sfm_bailian`) with the OAuth console session token captured by the local `console-login`
 * callback and stored under `console-session`. The usage/discounts reads themselves need no
 * browser automation or `bl` CLI.
 *
 * Discounts come from `listTokenPlanModels` with `edition: "PERSONAL"`; each promoted model
 * carries `badgeLabel`/`badgeDescription`. `AlibabaUsage.parseBadgeDiscount` derives the real
 * percent-off from the Chinese "N折" notation (2折 = 80% off, 5折 = 50% off) and flags night-only
 * promotions, which apply during `NIGHT_WINDOW_LABEL` (22:00–08:00 UTC+8).
 */
export * as AlibabaUsagePlugin from "./alibaba-usage.js"

import { randomBytes } from "node:crypto"
import http from "node:http"
import { define } from "@opencode/plugin/effect/plugin"
import { AlibabaUsage, AlibabaUsageRpc } from "@opencode/schema/alibaba-usage"
import { Clock, Effect, Option, Schema } from "effect"
import PROMPT_ALIBABA_LOGIN from "./alibaba-login.txt"

export const CONSOLE_ORIGIN = "https://modelstudio.console.alibabacloud.com"
export const GATEWAY_BASE = "https://bailian-singapore-cs.alibabacloud.com"
export const GATEWAY_ACTION = "IntlBroadScopeAspnGateway"
export const GATEWAY_PRODUCT = "sfm_bailian"
export const GATEWAY_REGION = "ap-southeast-1"
export const GATEWAY_SITE = "international"
export const TOKEN_PLAN_USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"
export const TOKEN_PLAN_MODELS_API = "zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listTokenPlanModels"

const CACHE_TTL_MS = 60_000
const HTTP_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 15 * 60_000
const STORAGE_KEY = "console-session"

const StoredSessionSchema = Schema.Struct({
  accessToken: Schema.String,
  region: Schema.optionalKey(Schema.String),
  switchAgent: optionalNumber(),
})

function optionalNumber() {
  return Schema.optionalKey(Schema.Number)
}

export type StoredSession = typeof StoredSessionSchema.Type

const decodeStoredSession = Schema.decodeUnknownOption(StoredSessionSchema)

const UsageFieldsSchema = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  errorCode: Schema.optionalKey(Schema.Unknown),
  errorMsg: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  per1MonthPercentage: Schema.optionalKey(Schema.Number),
  per1MonthResetTime: Schema.optionalKey(Schema.Number),
})

const DataV2InnerSchema = Schema.Struct({
  ...UsageFieldsSchema.fields,
  data: Schema.optionalKey(UsageFieldsSchema),
})

const GatewayResponseSchema = Schema.Struct({
  ...UsageFieldsSchema.fields,
  data: Schema.optionalKey(
    Schema.Struct({
      ...UsageFieldsSchema.fields,
      data: Schema.optionalKey(UsageFieldsSchema),
      DataV2: Schema.optionalKey(
        Schema.Struct({
          ...UsageFieldsSchema.fields,
          data: Schema.optionalKey(DataV2InnerSchema),
        }),
      ),
    }),
  ),
})

const decodeGatewayResponse = Schema.decodeUnknownOption(Schema.fromJsonString(GatewayResponseSchema))

const ModelItemSchema = Schema.Struct({
  modelId: Schema.String,
  provider: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
  isNew: Schema.optionalKey(Schema.Boolean),
  badgeLabel: Schema.optionalKey(Schema.String),
  badgeDescription: Schema.optionalKey(Schema.String),
})

const ModelsListSchema = Schema.Struct({
  ...UsageFieldsSchema.fields,
  total: Schema.optionalKey(Schema.Number),
  list: Schema.optionalKey(Schema.Array(ModelItemSchema)),
})

const ModelsGatewayResponseSchema = Schema.Struct({
  ...UsageFieldsSchema.fields,
  data: Schema.optionalKey(
    Schema.Struct({
      ...UsageFieldsSchema.fields,
      data: Schema.optionalKey(ModelsListSchema),
      DataV2: Schema.optionalKey(
        Schema.Struct({
          ...UsageFieldsSchema.fields,
          data: Schema.optionalKey(
            Schema.Struct({
              ...UsageFieldsSchema.fields,
              data: Schema.optionalKey(ModelsListSchema),
            }),
          ),
        }),
      ),
    }),
  ),
})

const decodeModelsGatewayResponse = Schema.decodeUnknownOption(Schema.fromJsonString(ModelsGatewayResponseSchema))

const LocaleNameSchema = Schema.Struct({
  "en-US": Schema.optionalKey(Schema.String),
  "zh-CN": Schema.optionalKey(Schema.String),
})

const decodeLocaleName = Schema.decodeUnknownOption(Schema.fromJsonString(LocaleNameSchema))

function buildCornerstoneParam(switchAgent?: number) {
  return {
    protocol: "V2",
    console: "ONE_CONSOLE",
    productCode: "p_efm",
    switchUserType: 3,
    consoleSite: "BAILIAN_ALIYUN",
    ...(switchAgent !== undefined ? { switchAgent } : {}),
  }
}

export function buildGatewayParams(switchAgent?: number): string {
  return JSON.stringify({
    Api: TOKEN_PLAN_USAGE_API,
    V: "1.0",
    Data: {
      cornerstoneParam: buildCornerstoneParam(switchAgent),
    },
  })
}

export function buildGatewayEndpoint(): string {
  return `${GATEWAY_BASE}/cli/api.json?action=${GATEWAY_ACTION}&product=${GATEWAY_PRODUCT}&api=${encodeURIComponent(TOKEN_PLAN_USAGE_API)}`
}

export function buildModelsGatewayParams(switchAgent?: number): string {
  return JSON.stringify({
    Api: TOKEN_PLAN_MODELS_API,
    V: "1.0",
    Data: {
      input: { pageNo: 1, pageSize: 100, edition: "PERSONAL" },
      cornerstoneParam: buildCornerstoneParam(switchAgent),
    },
  })
}

export function buildModelsGatewayEndpoint(): string {
  return `${GATEWAY_BASE}/cli/api.json?action=${GATEWAY_ACTION}&product=${GATEWAY_PRODUCT}&api=${encodeURIComponent(TOKEN_PLAN_MODELS_API)}`
}

function unwrapGatewayUsage(parsed: typeof GatewayResponseSchema.Type) {
  const data = parsed.data
  if (!data) return parsed
  const dataV2 = data.DataV2
  if (dataV2) {
    const inner = dataV2.data
    return inner?.data ?? inner ?? dataV2
  }
  return data.data ?? data
}

export function parseGatewayUsageResponse(
  raw: string,
  checkedAt: number,
  region = GATEWAY_REGION,
): AlibabaUsage.TokenPlan {
  const parsed = Option.getOrUndefined(decodeGatewayResponse(raw))
  if (!parsed) {
    return {
      ok: false,
      hasQuotaData: false,
      usedPercent: 0,
      remainingPercent: 100,
      region,
      site: GATEWAY_SITE,
      checkedAt,
      error: "Unexpected response from Alibaba Model Studio gateway.",
    }
  }

  const topData = parsed.data
  if (topData?.success === false && topData.errorCode !== undefined) {
    const code = typeof topData.errorCode === "string" ? topData.errorCode : JSON.stringify(topData.errorCode)
    const notLoggedIn = code.includes("NotLogined")
    return {
      ok: false,
      hasQuotaData: false,
      needsAuth: notLoggedIn,
      usedPercent: 0,
      remainingPercent: 100,
      region,
      site: GATEWAY_SITE,
      checkedAt,
      error: notLoggedIn
        ? "Alibaba Cloud console session expired or is not connected."
        : topData.errorMsg || topData.message || `Gateway error (${code})`,
      hint: notLoggedIn ? "Connect your Alibaba Cloud international account to continue." : undefined,
    }
  }

  const inner = unwrapGatewayUsage(parsed)
  if (inner.success === false && inner.errorCode !== undefined) {
    const code = typeof inner.errorCode === "string" ? inner.errorCode : JSON.stringify(inner.errorCode)
    const notLoggedIn = code.includes("NotLogined")
    return {
      ok: false,
      hasQuotaData: false,
      needsAuth: notLoggedIn,
      usedPercent: 0,
      remainingPercent: 100,
      region,
      site: GATEWAY_SITE,
      checkedAt,
      error: notLoggedIn
        ? "Alibaba Cloud console session expired or is not connected."
        : inner.errorMsg || inner.message || `Gateway error (${code})`,
      hint: notLoggedIn ? "Connect your Alibaba Cloud international account to continue." : undefined,
    }
  }

  if (inner.per1MonthPercentage !== undefined) {
    const usedPercent = Math.min(100, Math.max(0, inner.per1MonthPercentage))
    return {
      ok: true,
      hasQuotaData: true,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      ...(inner.per1MonthResetTime !== undefined ? { resetAt: inner.per1MonthResetTime } : {}),
      region,
      site: GATEWAY_SITE,
      checkedAt,
    }
  }

  return {
    ok: false,
    hasQuotaData: false,
    usedPercent: 0,
    remainingPercent: 100,
    region,
    site: GATEWAY_SITE,
    checkedAt,
    error: "No monthly quota data returned for this account.",
    hint: "Verify that your Token Plan subscription is active in the international Model Studio console.",
  }
}

export interface ParsedCallbackInput {
  readonly accessToken: string
  readonly region?: string
  readonly switchAgent?: number
  readonly state?: string
}

const NumberOrStringSchema = Schema.Union([Schema.Number, Schema.String])

const JsonCallbackSchema = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  accessToken: Schema.optionalKey(Schema.String),
  console_region: Schema.optionalKey(Schema.String),
  consoleRegion: Schema.optionalKey(Schema.String),
  console_switch_agent: Schema.optionalKey(NumberOrStringSchema),
  switchAgent: Schema.optionalKey(NumberOrStringSchema),
  state: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(
    Schema.Struct({
      access_token: Schema.optionalKey(Schema.String),
      accessToken: Schema.optionalKey(Schema.String),
      console_region: Schema.optionalKey(Schema.String),
      consoleRegion: Schema.optionalKey(Schema.String),
      console_switch_agent: Schema.optionalKey(NumberOrStringSchema),
      switchAgent: Schema.optionalKey(NumberOrStringSchema),
    }),
  ),
})

const decodeJsonCallback = Schema.decodeUnknownOption(Schema.fromJsonString(JsonCallbackSchema))

function parseAgentNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  const num = typeof value === "number" ? value : Number(value)
  return Number.isFinite(num) && num > 0 ? num : undefined
}

function parseSearchParamsCallback(params: URLSearchParams): ParsedCallbackInput | undefined {
  const token = (params.get("access_token") ?? params.get("accessToken") ?? "").trim()
  if (!token) return undefined
  const region = (params.get("console_region") ?? params.get("consoleRegion") ?? "").trim() || undefined
  const switchAgent = parseAgentNumber(params.get("console_switch_agent") ?? params.get("switchAgent") ?? undefined)
  const state = params.get("state")?.trim() || undefined
  return { accessToken: token, region, switchAgent, state }
}

/** Extracts an access token from a pasted redirect URL, query string, JSON payload, or raw token. */
export function parseManualLoginInput(raw: string): ParsedCallbackInput | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = Option.getOrUndefined(
      Option.fromNullishOr(
        (() => {
          const url = new URL(trimmed)
          const hashParams = url.hash.startsWith("#") ? new URLSearchParams(url.hash.slice(1)) : undefined
          return (
            parseSearchParamsCallback(url.searchParams) ??
            (hashParams ? parseSearchParamsCallback(hashParams) : undefined)
          )
        })(),
      ),
    )
    if (parsed) return parsed
    return undefined
  }

  const fromJson = Option.getOrUndefined(decodeJsonCallback(trimmed))
  if (fromJson) {
    const token = (
      fromJson.access_token ??
      fromJson.accessToken ??
      fromJson.data?.access_token ??
      fromJson.data?.accessToken ??
      ""
    ).trim()
    if (token) {
      return {
        accessToken: token,
        region: fromJson.console_region ?? fromJson.consoleRegion ?? fromJson.data?.console_region ?? fromJson.data?.consoleRegion,
        switchAgent: parseAgentNumber(
          fromJson.console_switch_agent ??
            fromJson.switchAgent ??
            fromJson.data?.console_switch_agent ??
            fromJson.data?.switchAgent,
        ),
        state: fromJson.state,
      }
    }
  }

  if (trimmed.includes("access_token=") || trimmed.includes("accessToken=")) {
    const query = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed
    const parsed = parseSearchParamsCallback(new URLSearchParams(query))
    if (parsed) return parsed
  }

  // Raw token string fallback
  if (!/\s/.test(trimmed) && trimmed.length >= 12) {
    return { accessToken: trimmed }
  }
  return undefined
}

/**
 * Shape of the page-side capture object installed by the login interceptor
 * (`window.__ocAlibabaLogin`). The console page can mutate it into an array-like
 * object with spurious numeric keys, so consumers must extract by field, never
 * by object shape.
 */
export interface LoginCapture {
  readonly authorize?: string | null
  readonly callback?: ReadonlyArray<{ readonly url?: string; readonly body?: string }>
}

export interface CapturedToken {
  readonly token: string
  /** True when a captured payload carries a state that differs from the active attempt. */
  readonly mismatch: boolean
}

const CAPTURE_TOKEN_REGEX = /access_token["\:=]+["]?([A-Za-z0-9-_]+)/

function captureStateFromUrl(url: string): string | undefined {
  const match = /[?&]state=([^&#]+)/.exec(url)
  return match?.[1] ? decodeURIComponent(match[1]).trim() : undefined
}

/**
 * Extracts an access token from the interceptor capture by field precedence
 * (spec alibaba_token_plan_login_v2 §4.2): authorize JSON → callback body JSON →
 * regex over authorize/callback url/body. Flags a state mismatch when any
 * captured callback URL or payload state differs from `expectedState`; callers
 * must abort and cancel the attempt on mismatch. Never logs the token.
 */
export function extractCapturedToken(capture: LoginCapture, expectedState: string): CapturedToken | undefined {
  const callbacks = Array.isArray(capture.callback) ? capture.callback : []
  const mismatch = callbacks.some((entry) => {
    const urlState = typeof entry.url === "string" ? captureStateFromUrl(entry.url) : undefined
    if (urlState && urlState !== expectedState) return true
    if (typeof entry.body !== "string") return false
    const parsed = Option.getOrUndefined(decodeJsonCallback(entry.body))
    return parsed?.state !== undefined && parsed.state !== expectedState
  })

  const authorize = typeof capture.authorize === "string" ? capture.authorize : undefined
  if (authorize) {
    const parsed = Option.getOrUndefined(decodeJsonCallback(authorize))
    const token = (parsed?.data?.access_token ?? parsed?.data?.accessToken ?? parsed?.access_token ?? parsed?.accessToken ?? "").trim()
    if (token) return { token, mismatch }
  }

  for (const entry of callbacks) {
    if (typeof entry.body !== "string") continue
    const parsed = Option.getOrUndefined(decodeJsonCallback(entry.body))
    const token = (parsed?.access_token ?? parsed?.accessToken ?? parsed?.data?.access_token ?? parsed?.data?.accessToken ?? "").trim()
    if (token) return { token, mismatch }
  }

  const sources = [authorize, ...callbacks.flatMap((entry) => [entry.url, entry.body])].filter(
    (value): value is string => typeof value === "string",
  )
  for (const source of sources) {
    const match = CAPTURE_TOKEN_REGEX.exec(source)
    if (match?.[1]) return { token: match[1], mismatch }
  }

  return mismatch ? { token: "", mismatch } : undefined
}

async function callTokenPlanGateway(
  session: StoredSession,
  endpoint = buildGatewayEndpoint(),
): Promise<AlibabaUsage.TokenPlan> {
  const region = session.region || GATEWAY_REGION
  const body = new URLSearchParams({
    params: buildGatewayParams(session.switchAgent),
    region,
  })
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const raw = await res.text()
  if (!res.ok) {
    return {
      ok: false,
      hasQuotaData: false,
      needsAuth: res.status === 401 || res.status === 403,
      usedPercent: 0,
      remainingPercent: 100,
      region,
      site: GATEWAY_SITE,
      checkedAt: Date.now(),
      error: `Alibaba gateway returned HTTP ${res.status} ${res.statusText}`,
    }
  }
  return parseGatewayUsageResponse(raw, Date.now(), region)
}

function modelsErrorResult(
  fields: typeof UsageFieldsSchema.Type,
  region: string,
  checkedAt: number,
): AlibabaUsage.DiscountedModels | undefined {
  if (fields.success !== false || fields.errorCode === undefined) return undefined
  const code = typeof fields.errorCode === "string" ? fields.errorCode : JSON.stringify(fields.errorCode)
  const notLoggedIn = code.includes("NotLogined")
  return {
    ok: false,
    models: [],
    needsAuth: notLoggedIn,
    region,
    site: GATEWAY_SITE,
    checkedAt,
    error: notLoggedIn
      ? "Alibaba Cloud console session expired or is not connected."
      : fields.errorMsg || fields.message || `Gateway error (${code})`,
    hint: notLoggedIn ? "Connect your Alibaba Cloud international account to continue." : undefined,
  }
}

function modelDisplayName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const parsed = Option.getOrUndefined(decodeLocaleName(name))
  if (!parsed) return name
  return parsed["en-US"] ?? parsed["zh-CN"]
}

export function parseGatewayModelsResponse(
  raw: string,
  checkedAt: number,
  region = GATEWAY_REGION,
): AlibabaUsage.DiscountedModels {
  const parsed = Option.getOrUndefined(decodeModelsGatewayResponse(raw))
  if (!parsed) {
    return {
      ok: false,
      models: [],
      region,
      site: GATEWAY_SITE,
      checkedAt,
      error: "Unexpected response from Alibaba Model Studio gateway.",
    }
  }

  const topData = parsed.data
  const topError = topData ? modelsErrorResult(topData, region, checkedAt) : undefined
  if (topError) return topError
  const inner = topData?.DataV2?.data
  const innerError = inner ? modelsErrorResult(inner, region, checkedAt) : undefined
  if (innerError) return innerError
  const listData = inner?.data ?? topData?.data
  const listError = listData ? modelsErrorResult(listData, region, checkedAt) : undefined
  if (listError) return listError

  if (!listData?.list) {
    return {
      ok: false,
      models: [],
      region,
      site: GATEWAY_SITE,
      checkedAt,
      error: "No Token Plan model list returned for this account.",
      hint: "Verify that your Token Plan subscription is active in the international Model Studio console.",
    }
  }

  const models = listData.list.flatMap((item) => {
    if (!item.badgeLabel) return []
    const badge = AlibabaUsage.parseBadgeDiscount(item.badgeLabel, item.badgeDescription)
    const name = modelDisplayName(item.name)
    return [
      {
        provider: item.provider ?? "unknown",
        modelId: item.modelId,
        ...(name ? { name } : {}),
        ...(item.capabilities ? { capabilities: item.capabilities } : {}),
        ...(item.isNew !== undefined ? { isNew: item.isNew } : {}),
        badgeLabel: item.badgeLabel,
        ...(item.badgeDescription ? { badgeDescription: item.badgeDescription } : {}),
        ...(badge.percentOff !== undefined ? { percentOff: badge.percentOff } : {}),
        nightOnly: badge.nightOnly,
      },
    ]
  })

  return {
    ok: true,
    models,
    ...(listData.total !== undefined ? { total: listData.total } : {}),
    region,
    site: GATEWAY_SITE,
    checkedAt,
  }
}

async function callTokenPlanModelsGateway(
  session: StoredSession,
  endpoint = buildModelsGatewayEndpoint(),
): Promise<AlibabaUsage.DiscountedModels> {
  const region = session.region || GATEWAY_REGION
  const body = new URLSearchParams({
    params: buildModelsGatewayParams(session.switchAgent),
    region,
  })
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const raw = await res.text()
  if (!res.ok) {
    return {
      ok: false,
      models: [],
      needsAuth: res.status === 401 || res.status === 403,
      region,
      site: GATEWAY_SITE,
      checkedAt: Date.now(),
      error: `Alibaba gateway returned HTTP ${res.status} ${res.statusText}`,
    }
  }
  return parseGatewayModelsResponse(raw, Date.now(), region)
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error("Callback payload too large"))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function parseMultipartField(raw: string, contentType: string, name: string): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary) return undefined
  for (const segment of raw.split(`--${boundary}`)) {
    if (!new RegExp(`name\\s*=\\s*["']${name}["']`, "i").test(segment)) continue
    const sep = /\r?\n\r?\n/.exec(segment)
    if (!sep || sep.index === undefined) continue
    const value = segment.slice(sep.index + sep[0].length).replace(/(?:\r?\n)+$/g, "").trim()
    if (value) return value
  }
  return undefined
}

type PendingLogin = {
  state: string
  status: "pending" | "complete" | "expired" | "error"
  message?: string
  server: http.Server
  timer: ReturnType<typeof setTimeout>
  close: () => void
}

export const Plugin = define({
  id: "opencode.alibaba.usage",
  effect: Effect.fn(function* (ctx) {
    let cached: AlibabaUsage.TokenPlan | undefined
    let cachedModels: AlibabaUsage.DiscountedModels | undefined
    const pendingLogins = new Map<string, PendingLogin>()

    const readSession = Effect.fn("AlibabaUsagePlugin.readSession")(function* () {
      return Option.getOrUndefined(decodeStoredSession(yield* ctx.storage.get(STORAGE_KEY)))
    })

    const saveSession = Effect.fn("AlibabaUsagePlugin.saveSession")(function* (session: StoredSession) {
      yield* ctx.storage.set(STORAGE_KEY, session)
      cached = undefined
      cachedModels = undefined
    })

    const fetchUsage = Effect.fn("AlibabaUsagePlugin.fetch")(function* (refresh?: boolean) {
      const now = yield* Clock.currentTimeMillis
      if (!refresh && cached?.ok && now - cached.checkedAt < CACHE_TTL_MS) {
        return cached
      }
      const session = yield* readSession()
      if (!session?.accessToken) {
        return {
          ok: false,
          hasQuotaData: false,
          needsAuth: true,
          usedPercent: 0,
          remainingPercent: 100,
          region: GATEWAY_REGION,
          site: GATEWAY_SITE,
          checkedAt: now,
          error: "Alibaba Cloud console session is not connected.",
          hint: "Connect your Alibaba Cloud international account to view Token Plan usage.",
        } satisfies AlibabaUsage.TokenPlan
      }

      const result = yield* Effect.tryPromise({
        try: () => callTokenPlanGateway(session),
        catch: (error) =>
          ({
            ok: false,
            hasQuotaData: false,
            usedPercent: 0,
            remainingPercent: 100,
            region: session.region ?? GATEWAY_REGION,
            site: GATEWAY_SITE,
            checkedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          }) satisfies AlibabaUsage.TokenPlan,
      }).pipe(Effect.catch((err) => Effect.succeed(err)))

      if (result.ok) cached = result
      return result
    })

    const fetchDiscountedModels = Effect.fn("AlibabaUsagePlugin.fetchDiscountedModels")(function* (refresh?: boolean) {
      const now = yield* Clock.currentTimeMillis
      if (!refresh && cachedModels?.ok && now - cachedModels.checkedAt < CACHE_TTL_MS) {
        return cachedModels
      }
      const session = yield* readSession()
      if (!session?.accessToken) {
        return {
          ok: false,
          models: [],
          needsAuth: true,
          region: GATEWAY_REGION,
          site: GATEWAY_SITE,
          checkedAt: now,
          error: "Alibaba Cloud console session is not connected.",
          hint: "Connect your Alibaba Cloud international account to view Token Plan discounts.",
        } satisfies AlibabaUsage.DiscountedModels
      }

      const result = yield* Effect.tryPromise({
        try: () => callTokenPlanModelsGateway(session),
        catch: (error) =>
          ({
            ok: false,
            models: [],
            region: session.region ?? GATEWAY_REGION,
            site: GATEWAY_SITE,
            checkedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          }) satisfies AlibabaUsage.DiscountedModels,
      }).pipe(Effect.catch((err) => Effect.succeed(err)))

      if (result.ok) cachedModels = result
      return result
    })

    const startLogin = Effect.fn("AlibabaUsagePlugin.startLogin")(function* () {
      for (const existing of pendingLogins.values()) existing.close()
      pendingLogins.clear()

      const state = randomBytes(16).toString("hex")

      const isAllowedOrigin = (origin: string | undefined) => {
        if (!origin) return true
        return origin === CONSOLE_ORIGIN || /^https:\/\/[a-z0-9-]+\.alibabacloud\.com$/i.test(origin)
      }

      const server = http.createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store")
        res.setHeader("Vary", "Origin, Access-Control-Request-Private-Network")
        const origin = req.headers.origin
        if (!isAllowedOrigin(origin)) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
          res.end("Origin not allowed")
          return
        }
        if (origin) {
          res.setHeader("Access-Control-Allow-Origin", origin)
        }
        if (req.method === "OPTIONS") {
          if (origin && req.headers["access-control-request-private-network"] === "true") {
            res.setHeader("Access-Control-Allow-Private-Network", "true")
          }
          res.writeHead(204, {
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          })
          res.end()
          return
        }

        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        if (url.searchParams.get("state") !== state) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
          res.end("Invalid state")
          return
        }

        const rawBody =
          req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
            ? await readRequestBody(req).catch(() => "")
            : ""
        const contentType = String(req.headers["content-type"] ?? "")
        const parsed =
          parseSearchParamsCallback(url.searchParams) ??
          parseManualLoginInput(rawBody) ??
          (() => {
            const mpToken =
              parseMultipartField(rawBody, contentType, "access_token") ??
              parseMultipartField(rawBody, contentType, "accessToken")
            if (!mpToken) return undefined
            const mpAgent =
              parseMultipartField(rawBody, contentType, "console_switch_agent") ??
              parseMultipartField(rawBody, contentType, "switchAgent")
            return {
              accessToken: mpToken,
              region:
                parseMultipartField(rawBody, contentType, "console_region") ??
                parseMultipartField(rawBody, contentType, "consoleRegion"),
              switchAgent: parseAgentNumber(mpAgent),
            }
          })()

        if (!parsed?.accessToken) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
          res.end("Missing access token")
          return
        }

        const sessionToSave: StoredSession = {
          accessToken: parsed.accessToken,
          region: parsed.region || GATEWAY_REGION,
          ...(parsed.switchAgent !== undefined ? { switchAgent: parsed.switchAgent } : {}),
        }
        await Effect.runPromise(saveSession(sessionToSave))

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end("<html><body><h3>Alibaba Cloud connected to OpenCode. You can close this window.</h3></body></html>")

        const entry = pendingLogins.get(state)
        if (entry) {
          entry.status = "complete"
          clearTimeout(entry.timer)
          setTimeout(() => {
            server.close()
            server.closeAllConnections()
          }, 250)
        }
      })

      const port = yield* Effect.tryPromise({
        try: () =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject)
            server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
              const addr = server.address()
              if (!addr || typeof addr === "string") {
                reject(new Error("Failed to bind local login callback server"))
                return
              }
              resolve(addr.port)
            })
          }),
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.orDie)

      const entry: PendingLogin = {
        state,
        status: "pending",
        server,
        timer: setTimeout(() => {
          if (entry.status === "pending") entry.status = "expired"
          entry.close()
        }, LOGIN_TIMEOUT_MS),
        close: () => {
          clearTimeout(entry.timer)
          server.close()
          server.closeAllConnections()
        },
      }
      pendingLogins.set(state, entry)

      const url = `${CONSOLE_ORIGIN}/console-login?notice=127.0.0.1:${port}?state=${encodeURIComponent(state)}`
      return { url, state, port }
    })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of pendingLogins.values()) entry.close()
        pendingLogins.clear()
      }),
    )

    yield* ctx.rpc
      .register(AlibabaUsageRpc, {
        tokenPlan: (input) => fetchUsage(input.refresh),
        discountedModels: (input) => fetchDiscountedModels(input.refresh),
        startLogin: () => startLogin(),
        loginStatus: (input) =>
          Effect.sync(() => {
            const entry = pendingLogins.get(input.state)
            if (!entry) return { status: "expired" as const }
            return {
              status: entry.status,
              ...(entry.message ? { message: entry.message } : {}),
            }
          }),
        completeLogin: (input) =>
          Effect.gen(function* () {
            // A failed completion releases the pending attempt so the caller can
            // start fresh without a stale callback server (spec §8 failure matrix).
            const releaseAttempt = () => {
              const entry = pendingLogins.get(input.state)
              if (!entry) return
              entry.close()
              pendingLogins.delete(input.state)
            }
            const parsed = parseManualLoginInput(input.input)
            if (!parsed?.accessToken) {
              releaseAttempt()
              return { ok: false, message: "Could not find an access token in the pasted URL or value." }
            }
            if (parsed.state && parsed.state !== input.state) {
              releaseAttempt()
              return { ok: false, message: "Callback state does not match this login attempt." }
            }
            const candidate: StoredSession = {
              accessToken: parsed.accessToken,
              region: parsed.region || GATEWAY_REGION,
              ...(parsed.switchAgent !== undefined ? { switchAgent: parsed.switchAgent } : {}),
            }
            const check = yield* Effect.tryPromise({
              try: () => callTokenPlanGateway(candidate),
              catch: (error): AlibabaUsage.TokenPlan => ({
                ok: false,
                hasQuotaData: false,
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: Date.now(),
                error: error instanceof Error ? error.message : String(error),
              }),
            }).pipe(Effect.catch((err) => Effect.succeed(err)))

            if (!check.ok && check.needsAuth) {
              releaseAttempt()
              return { ok: false, message: check.error ?? "Invalid or expired Alibaba Cloud access token." }
            }

            yield* saveSession(candidate)
            cached = check.ok ? check : undefined
            cachedModels = undefined
            const entry = pendingLogins.get(input.state)
            if (entry) {
              entry.status = "complete"
              entry.close()
              pendingLogins.delete(input.state)
            }
            return { ok: true }
          }),
        cancelLogin: (input) =>
          Effect.sync(() => {
            const entry = pendingLogins.get(input.state)
            if (entry) {
              entry.close()
              pendingLogins.delete(input.state)
            }
            return { ok: true }
          }),
        logout: () =>
          ctx.storage.remove(STORAGE_KEY).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                cached = undefined
                cachedModels = undefined
              }),
            ),
            Effect.as({ ok: true }),
          ),
      })
      .pipe(Effect.orDie)

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "alibabaLogin",
        description: "connect Alibaba Cloud Token Plan via automatic agent-driven browser login (manual paste fallback)",
        execute: (input) =>
          Effect.gen(function* () {
            // Fresh attempt: startLogin closes any pending callback server and mints a new state.
            const started = yield* startLogin()
            yield* ctx.session.prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: buildAgentLoginPrompt(started, input.prompt.text),
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })
    })
  }),
})

export function buildAgentLoginPrompt(started: { url: string; state: string }, userText: string) {
  const template = PROMPT_ALIBABA_LOGIN.replaceAll("${url}", () => started.url).replaceAll(
    "${state}",
    () => started.state,
  )
  const extra = userText.trim()
  return extra ? `${template}\n\nAdditional instruction from the user: ${extra}` : template
}
