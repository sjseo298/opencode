import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const AccountSummary = z.object({
  id: z.string(),
  email: z.string(),
  enabled: z.boolean(),
  current: z.boolean(),
  verificationRequired: z.boolean(),
  lastUsed: z.number(),
  quota: z.object({
    remainingFraction: z.number().min(0).max(1),
    resetTime: z.string().optional(),
    updatedAt: z.number().optional(),
  }).optional(),
})

export const AntigravitySettings = z.object({
  connection_timeout_seconds: z.number().min(5).max(300).default(120),
  stream_idle_timeout_seconds: z.number().min(10).max(600).default(180),
  max_capacity_retries: z.number().min(0).max(5).default(4),
  max_capacity_delay_seconds: z.number().min(1).max(60).default(30),
})
export type AntigravitySettings = z.infer<typeof AntigravitySettings>

export const AntigravityAccountsRpc = Rpc.define({
  id: "antigravity.accounts",
  methods: {
    list: { input: z.object({}), output: z.array(AccountSummary) },
    connections: { input: z.object({ id: z.string() }), output: z.object({ ids: z.array(z.string()) }) },
    quotas: {
      input: z.object({ id: z.string().optional() }),
      output: z.object({ report: z.string(), accounts: z.array(z.object({ id: z.string(), email: z.string(), disabled: z.boolean(), report: z.string() })) }),
    },
    update: {
      input: z.object({ id: z.string(), action: z.enum(["enable", "disable", "select", "delete"]) }),
      output: z.object({ message: z.string() }),
    },
    models: { input: z.object({}), output: z.object({ count: z.number() }) },
    getConfig: { input: z.object({}), output: AntigravitySettings },
    updateConfig: { input: AntigravitySettings.partial(), output: AntigravitySettings },
  },
  events: {},
})

export type AccountSummary = z.infer<typeof AccountSummary>
