export * as AlibabaUsage from "./alibaba-usage.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const TokenPlanSchema = Schema.Struct({
  ok: Schema.Boolean,
  hasQuotaData: Schema.Boolean,
  needsAuth: optional(Schema.Boolean),
  usedPercent: Schema.Number,
  remainingPercent: Schema.Number,
  resetAt: optional(Schema.Number),
  region: optional(Schema.String),
  site: optional(Schema.String),
  checkedAt: Schema.Number,
  error: optional(Schema.String),
  hint: optional(Schema.String),
}).annotate({ identifier: "AlibabaUsage.TokenPlan" })

export type TokenPlan = typeof TokenPlanSchema.Type

export const LoginStartSchema = Schema.Struct({
  url: Schema.String,
  state: Schema.String,
  port: Schema.Number,
}).annotate({ identifier: "AlibabaUsage.LoginStart" })

export const LoginStatusSchema = Schema.Struct({
  status: Schema.Literals(["pending", "complete", "expired", "error"]),
  message: optional(Schema.String),
}).annotate({ identifier: "AlibabaUsage.LoginStatus" })

export const AlibabaUsageRpc = Rpc.define({
  id: "alibaba.usage",
  methods: {
    tokenPlan: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ refresh: optional(Schema.Boolean) })),
      output: Schema.toStandardSchemaV1(TokenPlanSchema),
    },
    startLogin: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(LoginStartSchema),
    },
    loginStatus: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ state: Schema.String })),
      output: Schema.toStandardSchemaV1(LoginStatusSchema),
    },
    completeLogin: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ state: Schema.String, input: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ ok: Schema.Boolean, message: optional(Schema.String) })),
    },
    cancelLogin: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ state: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ ok: Schema.Boolean })),
    },
    logout: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Struct({ ok: Schema.Boolean })),
    },
  },
  events: {},
})

export interface CycleProgress {
  readonly cycleDays: number
  readonly elapsedDays: number
  readonly remainingDays: number
  readonly expectedPercent: number
  readonly countdownLabel: string
  readonly resetLabel: string
}

const CYCLE_DAYS = 30
const DAY_MS = 86_400_000

/** Computes where the current moment sits inside the 30-day billing cycle ending at `resetAt`. */
export function formatCycleProgress(resetAt: number, now = Date.now()): CycleProgress {
  const remainingMs = Math.max(0, resetAt - now)
  const totalMinutes = Math.floor(remainingMs / 60_000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  const countdownLabel = remainingMs <= 0 ? "reset due" : `${days}d ${hours}h ${minutes}m`

  const cycleStart = resetAt - CYCLE_DAYS * DAY_MS
  const elapsedMs = Math.min(CYCLE_DAYS * DAY_MS, Math.max(0, now - cycleStart))
  const elapsedDays = Math.min(CYCLE_DAYS, Math.max(1, Math.floor(elapsedMs / DAY_MS) + 1))
  const remainingDays = Math.max(0, Math.ceil(remainingMs / DAY_MS))
  const expectedPercent = Math.min(100, Math.max(0, (elapsedMs / (CYCLE_DAYS * DAY_MS)) * 100))

  const resetDate = new Date(resetAt)
  const resetLabel = Number.isNaN(resetDate.getTime())
    ? "Unknown"
    : resetDate.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })

  return {
    cycleDays: CYCLE_DAYS,
    elapsedDays,
    remainingDays,
    expectedPercent,
    countdownLabel,
    resetLabel,
  }
}

/** Formats a 0-100 percentage cleanly without hiding tiny non-zero usage as 0%. */
export function formatQuotaPercent(value: number): string {
  const clamped = Math.min(100, Math.max(0, value))
  if (clamped === 0) return "0%"
  if (clamped === 100) return "100%"
  if (clamped < 0.01) return "<0.01%"
  return `${clamped.toFixed(2)}%`
}
