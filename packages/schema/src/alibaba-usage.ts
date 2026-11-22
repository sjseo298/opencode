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

/** A Token Plan model running a promotion, with the raw badge and derived savings. */
export const DiscountedModelSchema = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  name: optional(Schema.String),
  capabilities: optional(Schema.Array(Schema.String)),
  isNew: optional(Schema.Boolean),
  badgeLabel: optional(Schema.String),
  badgeDescription: optional(Schema.String),
  percentOff: optional(Schema.Number),
  nightOnly: optional(Schema.Boolean),
}).annotate({ identifier: "AlibabaUsage.DiscountedModel" })

export type DiscountedModel = typeof DiscountedModelSchema.Type

/** Result of querying the Token Plan discounted-model list (`/alibabaDiscounts`). */
export const DiscountedModelsSchema = Schema.Struct({
  ok: Schema.Boolean,
  needsAuth: optional(Schema.Boolean),
  models: Schema.Array(DiscountedModelSchema),
  total: optional(Schema.Number),
  region: optional(Schema.String),
  site: optional(Schema.String),
  checkedAt: Schema.Number,
  error: optional(Schema.String),
  hint: optional(Schema.String),
}).annotate({ identifier: "AlibabaUsage.DiscountedModels" })

export type DiscountedModels = typeof DiscountedModelsSchema.Type

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
    discountedModels: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ refresh: optional(Schema.Boolean) })),
      output: Schema.toStandardSchemaV1(DiscountedModelsSchema),
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
  readonly startLabel: string
  readonly resetLabel: string
}

export type QuotaHealth = "healthy" | "caution" | "critical"

export interface BudgetBreakdown {
  readonly cycle: CycleProgress
  readonly usedPercent: number
  readonly remainingPercent: number
  readonly baseDailyPercent: number
  readonly adjustedDailyPercent: number
  readonly maxTodayWithCushion: number
  readonly baseWeeklyPercent: number
  readonly adjustedWeeklyPercent: number
  readonly cushionPercent: number
  readonly health: QuotaHealth
}

const DAY_MS = 86_400_000

function subtractOneCalendarMonth(date: Date): Date {
  const targetYear = date.getMonth() === 0 ? date.getFullYear() - 1 : date.getFullYear()
  const targetMonth = date.getMonth() === 0 ? 11 : date.getMonth() - 1
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate()
  const clampedDay = Math.min(date.getDate(), lastDayOfTargetMonth)
  return new Date(
    targetYear,
    targetMonth,
    clampedDay,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  )
}

function formatDateTime(date: Date): string {
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
}

/** Computes where the current moment sits inside the calendar-month billing cycle ending at `resetAt`. */
export function formatCycleProgress(resetAt: number, now = Date.now()): CycleProgress {
  const remainingMs = Math.max(0, resetAt - now)
  const totalMinutes = Math.floor(remainingMs / 60_000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  const countdownLabel = remainingMs <= 0 ? "reset due" : `${days}d ${hours}h ${minutes}m`

  const cycleEnd = new Date(resetAt)
  const cycleStartDate = subtractOneCalendarMonth(cycleEnd)
  const cycleStart = cycleStartDate.getTime()
  const totalCycleMs = Math.max(DAY_MS, resetAt - cycleStart)
  const cycleDays = Math.max(1, Math.round(totalCycleMs / DAY_MS))

  const elapsedMs = Math.min(totalCycleMs, Math.max(0, now - cycleStart))
  const elapsedDays = Math.min(cycleDays, Math.max(1, Math.floor(elapsedMs / DAY_MS) + 1))
  const remainingDays = Math.max(0, Math.ceil(remainingMs / DAY_MS))
  const expectedPercent = Math.min(100, Math.max(0, (elapsedMs / totalCycleMs) * 100))

  return {
    cycleDays,
    elapsedDays,
    remainingDays,
    expectedPercent,
    countdownLabel,
    startLabel: formatDateTime(cycleStartDate),
    resetLabel: formatDateTime(cycleEnd),
  }
}

/** Computes daily/weekly budgets, accumulated cushion from unused days, and quota health. */
export function computeBudgetBreakdown(
  usedPercent: number,
  resetAt: number,
  now = Date.now(),
): BudgetBreakdown {
  const clampedUsed = Math.min(100, Math.max(0, usedPercent))
  const remainingPercent = Math.max(0, 100 - clampedUsed)
  const cycle = formatCycleProgress(resetAt, now)

  const baseDailyPercent = 100 / cycle.cycleDays
  const baseWeeklyPercent = Math.min(100, baseDailyPercent * 7)

  const effectiveRemainingDays = Math.max(1, cycle.remainingDays)
  const adjustedDailyPercent = remainingPercent / effectiveRemainingDays
  const adjustedWeeklyPercent =
    effectiveRemainingDays <= 7 ? remainingPercent : Math.min(remainingPercent, adjustedDailyPercent * 7)

  const cushionPercent = cycle.expectedPercent - clampedUsed
  const maxTodayWithCushion = Math.min(remainingPercent, baseDailyPercent + Math.max(0, cushionPercent))

  const health: QuotaHealth =
    remainingPercent <= 15 || adjustedDailyPercent < baseDailyPercent * 0.5
      ? "critical"
      : remainingPercent <= 35 || cushionPercent < -2
        ? "caution"
        : "healthy"

  return {
    cycle,
    usedPercent: clampedUsed,
    remainingPercent,
    baseDailyPercent,
    adjustedDailyPercent,
    maxTodayWithCushion,
    baseWeeklyPercent,
    adjustedWeeklyPercent,
    cushionPercent,
    health,
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

/** Night-window promotion hours used by Token Plan discounts, in UTC+8. */
export const NIGHT_WINDOW_LABEL = "22:00–08:00 (UTC+8)"

export interface BadgeDiscount {
  readonly percentOff?: number
  readonly nightOnly: boolean
}

/**
 * Derives the real percent-off and night-only flag from a Token Plan promotion badge.
 * Chinese "N折" means paying N*10% of the price (2折 = 80% off, 5折 = 50% off); the
 * English UI sometimes mislabels 4折 as "40% Off", so prefer the raw 折 value.
 */
export function parseBadgeDiscount(badgeLabel: string, badgeDescription?: string): BadgeDiscount {
  const text = `${badgeLabel} ${badgeDescription ?? ""}`
  const nightOnly = /夜间|Night|22:00/i.test(text)
  const zhe = /(\d+(?:\.\d+)?)\s*折/.exec(text)
  if (zhe) return { percentOff: Math.round(100 - Number(zhe[1]) * 10), nightOnly }
  const off = /(\d+(?:\.\d+)?)\s*%\s*off/i.exec(text)
  if (off) return { percentOff: Math.round(Number(off[1])), nightOnly }
  return { nightOnly }
}
