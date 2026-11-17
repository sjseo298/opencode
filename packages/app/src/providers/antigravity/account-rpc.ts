import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"

const QuotaSummarySchema = Schema.Struct({
  remainingFraction: Schema.Number,
  resetTime: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.Number),
})

export const AccountSummarySchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  enabled: Schema.Boolean,
  current: Schema.Boolean,
  verificationRequired: Schema.Boolean,
  lastUsed: Schema.Number,
  quota: Schema.optional(QuotaSummarySchema),
})

export type AccountSummary = typeof AccountSummarySchema.Type

export const AntigravitySettingsSchema = Schema.Struct({
  connection_timeout_seconds: Schema.Number,
  stream_idle_timeout_seconds: Schema.Number,
  max_capacity_retries: Schema.Number,
  max_capacity_delay_seconds: Schema.Number,
  split_system_instruction: Schema.Boolean,
})

export type AntigravitySettings = typeof AntigravitySettingsSchema.Type

export const AntigravitySettingsUpdateSchema = Schema.Struct({
  connection_timeout_seconds: Schema.optional(Schema.Number),
  stream_idle_timeout_seconds: Schema.optional(Schema.Number),
  max_capacity_retries: Schema.optional(Schema.Number),
  max_capacity_delay_seconds: Schema.optional(Schema.Number),
  split_system_instruction: Schema.optional(Schema.Boolean),
})

export type AntigravitySettingsUpdate = typeof AntigravitySettingsUpdateSchema.Type

export const DEFAULT_ANTIGRAVITY_SETTINGS: AntigravitySettings = {
  connection_timeout_seconds: 120,
  stream_idle_timeout_seconds: 180,
  max_capacity_retries: 4,
  max_capacity_delay_seconds: 30,
  split_system_instruction: true,
}

const EmptyInput = Schema.toStandardSchemaV1(Schema.Struct({}))

const QuotaAccountReportSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  disabled: Schema.Boolean,
  report: Schema.String,
})

export type QuotaAccountReport = typeof QuotaAccountReportSchema.Type

export const AntigravityAccountsRpc = Rpc.define({
  id: "antigravity.accounts",
  methods: {
    list: {
      input: EmptyInput,
      output: Schema.toStandardSchemaV1(Schema.Array(AccountSummarySchema)),
    },
    connections: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ ids: Schema.Array(Schema.String) })),
    },
    quotas: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.optional(Schema.String) })),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          report: Schema.String,
          accounts: Schema.Array(QuotaAccountReportSchema),
        }),
      ),
    },
    update: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.String,
          action: Schema.Literals(["enable", "disable", "select", "delete"]),
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Struct({ message: Schema.String })),
    },
    models: {
      input: EmptyInput,
      output: Schema.toStandardSchemaV1(Schema.Struct({ count: Schema.Number })),
    },
    getConfig: {
      input: EmptyInput,
      output: Schema.toStandardSchemaV1(AntigravitySettingsSchema),
    },
    updateConfig: {
      input: Schema.toStandardSchemaV1(AntigravitySettingsUpdateSchema),
      output: Schema.toStandardSchemaV1(AntigravitySettingsSchema),
    },
  },
  events: {},
})

export function formatQuotaSummary(quota: AccountSummary["quota"], now = Date.now()): string {
  if (!quota) return ""
  const percent = Math.round(quota.remainingFraction * 100)
  const base = `${percent}%`

  if (percent >= 100 || !quota.resetTime) return base

  const resetAt = Date.parse(quota.resetTime)

  if (!Number.isFinite(resetAt)) return base
  const minutes = Math.ceil((resetAt - now) / 60_000)

  if (minutes <= 0) return `${base} · reset due`

  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor(minutes / 60) % 24
  const duration = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`

  return `${base} · resets in ${duration}`
}

export function stripAnsiCodes(text: string): string {
  // Strips terminal ANSI escape sequences from RPC quota reports so they render cleanly in Web UI.
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}
