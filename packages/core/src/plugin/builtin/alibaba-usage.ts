export * as AlibabaUsagePlugin from "./alibaba-usage.js"

import { define } from "@opencode/plugin/effect/plugin"
import { AlibabaUsage, AlibabaUsageRpc } from "@opencode/schema/alibaba-usage"
import { Clock, Effect, Option, Schema } from "effect"

const CACHE_TTL_MS = 60_000
const CLI_TIMEOUT_MS = 15_000

const AuthStatusSchema = Schema.Struct({
  authenticated: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.String),
  console: Schema.optionalKey(
    Schema.Struct({
      region: Schema.optionalKey(Schema.String),
      site: Schema.optionalKey(Schema.String),
    }),
  ),
})

const TokenPlanOutputSchema = Schema.Struct({
  per1MonthPercentage: Schema.optionalKey(Schema.Number),
  per1MonthResetTime: Schema.optionalKey(Schema.Number),
  hasQuotaData: Schema.optionalKey(Schema.Boolean),
})

const CliErrorSchema = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.Number),
      message: Schema.optionalKey(Schema.String),
      hint: Schema.optionalKey(Schema.String),
    }),
  ),
})

const decodeAuthStatus = Schema.decodeUnknownOption(Schema.fromJsonString(AuthStatusSchema))
const decodeTokenPlanOutput = Schema.decodeUnknownOption(Schema.fromJsonString(TokenPlanOutputSchema))
const decodeCliError = Schema.decodeUnknownOption(Schema.fromJsonString(CliErrorSchema))

export type AuthStatus = typeof AuthStatusSchema.Type

export function parseAuthStatus(raw: string): AuthStatus | undefined {
  return Option.getOrUndefined(decodeAuthStatus(raw))
}

export function buildUsageCommandArgs(status?: AuthStatus): string[] {
  const args = ["usage", "token-plan", "--output", "json"]
  if (status?.config) args.push("--config", status.config)
  if (status?.console?.site) args.push("--console-site", status.console.site)
  if (status?.console?.region) args.push("--console-region", status.console.region)
  return args
}

export function parseTokenPlanResult(
  raw: string,
  checkedAt: number,
  status?: AuthStatus,
): AlibabaUsage.TokenPlan {
  const parsed = Option.getOrUndefined(decodeTokenPlanOutput(raw))
  if (parsed && parsed.per1MonthPercentage !== undefined) {
    const usedPercent = Math.min(100, Math.max(0, parsed.per1MonthPercentage))
    return {
      ok: true,
      hasQuotaData: parsed.hasQuotaData ?? true,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      ...(parsed.per1MonthResetTime !== undefined ? { resetAt: parsed.per1MonthResetTime } : {}),
      ...(status?.console?.region ? { region: status.console.region } : {}),
      ...(status?.console?.site ? { site: status.console.site } : {}),
      ...(status?.config ? { profile: status.config } : {}),
      checkedAt,
    }
  }

  const cliErr = Option.getOrUndefined(decodeCliError(raw))?.error
  return {
    ok: false,
    hasQuotaData: false,
    usedPercent: 0,
    remainingPercent: 100,
    ...(status?.console?.region ? { region: status.console.region } : {}),
    ...(status?.console?.site ? { site: status.console.site } : {}),
    ...(status?.config ? { profile: status.config } : {}),
    checkedAt,
    error: cliErr?.message || "Failed to read Alibaba Token Plan usage from Bailian CLI.",
    hint: cliErr?.hint || "Run `bl auth login --console --config token-plan --console-site international`.",
  }
}

async function runBl(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bl", ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), CLI_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function failureResult(checkedAt: number, error: string, hint?: string): AlibabaUsage.TokenPlan {
  return {
    ok: false,
    hasQuotaData: false,
    usedPercent: 0,
    remainingPercent: 100,
    checkedAt,
    error,
    ...(hint ? { hint } : {}),
  }
}

export const Plugin = define({
  id: "opencode.alibaba.usage",
  effect: Effect.fn(function* (ctx) {
    let cached: AlibabaUsage.TokenPlan | undefined

    const fetchUsage = Effect.fn("AlibabaUsagePlugin.fetch")(function* (refresh?: boolean) {
      const now = yield* Clock.currentTimeMillis
      if (!refresh && cached?.ok && now - cached.checkedAt < CACHE_TTL_MS) {
        return cached
      }
      if (!Bun.which("bl")) {
        return failureResult(
          now,
          "Bailian CLI (bl) is not installed on PATH.",
          "Install it with: npm install -g bailian-cli",
        )
      }

      const result = yield* Effect.tryPromise({
        try: async () => {
          const defaultStatus = await runBl(["auth", "status", "--output", "json"])
          let status = parseAuthStatus(defaultStatus.stdout)
          if (!status?.console) {
            const tokenPlanStatus = await runBl(["auth", "status", "--config", "token-plan", "--output", "json"])
            const parsed = parseAuthStatus(tokenPlanStatus.stdout)
            if (parsed?.console) status = parsed
          }
          const usage = await runBl(buildUsageCommandArgs(status))
          const output = usage.stdout.trim() || usage.stderr.trim()
          return parseTokenPlanResult(output, Date.now(), status)
        },
        catch: (error) =>
          failureResult(
            Date.now(),
            error instanceof Error ? error.message : String(error),
            "Run `bl usage token-plan --output json` in your terminal to verify.",
          ),
      }).pipe(Effect.catch((err) => Effect.succeed(err)))

      if (result.ok) cached = result
      return result
    })

    yield* ctx.rpc
      .register(AlibabaUsageRpc, {
        tokenPlan: (input) => fetchUsage(input.refresh),
      })
      .pipe(Effect.orDie)
  }),
})
