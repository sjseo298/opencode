/**
 * ============================================================================
 * Context Budget Tool: Dynamic Headroom & Task Sizing for Subagent Delegation
 * ============================================================================
 */

export * as ContextBudgetTool from "./context-budget.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Database } from "../../database/database.js"
import { Model } from "../../model.js"
import { Session } from "../../session.js"
import { SessionHistory } from "../../session/history.js"
import { UnifiedKV } from "../../session/unified-kv.js"
import { getDetectedSubagentCapacity } from "../../plugin/builtin/subagent-mandatory-instruction.js"

export const name = "context_budget"

export const Input = Schema.Struct({
  targetAgent: Schema.optionalKey(Schema.String).annotate({
    description: "Optional subagent agent ID to calculate budget for (defaults to current session model).",
  }),
})

export const Output = Schema.Struct({
  contextLimit: Schema.Number,
  currentSessionTokens: Schema.Number,
  otherTreeTokens: Schema.Number,
  unifiedKvTreeTokens: Schema.Number,
  availableHeadroom: Schema.Number,
  maxSubagents: Schema.Number,
  totalSlots: Schema.Number,
  parentReserveTokens: Schema.Number,
  maxRecommendedSubagentBudget: Schema.Number,
  recommendation: Schema.String,
})
export type Output = typeof Output.Type

export const description = [
  "Measures the current context consumption across the session tree and computes the dynamic safe budget for subagent tasks.",
  "MANDATORY REQUIREMENT: You MUST invoke this tool before delegating work to any subagent.",
  "The returned availableHeadroom MUST be passed to the subagent tool under contextBudget.availableHeadroom.",
  "If the task you intend to delegate exceeds maxRecommendedSubagentBudget, decompose the objective into smaller tertiary subtasks (SO-N-TM) first.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.context_budget",
  effect: Effect.fn("ContextBudgetTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const models = yield* Model.Service
    const db = (yield* Database.Service).db

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (_input, context) =>
            Effect.gen(function* () {
              const session = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Session not found: ${context.sessionID}`, error }),
                  ),
                )

              // Determine context limit from current model or available models
              let contextLimit = 128_000
              if (session.model) {
                const available = yield* models.available().pipe(Effect.orElseSucceed(() => []))
                const found = available.find(
                  (m) => m.providerID === session.model?.providerID && m.id === session.model?.id,
                )
                if (found?.limit?.context && found.limit.context > 0) {
                  contextLimit = found.limit.context
                }
              }

              // Calculate current session tokens
              const messages = yield* SessionHistory.load(db, context.sessionID, "latest").pipe(Effect.orDie)
              const currentSessionTokens = UnifiedKV.estimateSessionTokens(messages)

              // Calculate other tokens in unified tree
              const otherTreeTokens = yield* UnifiedKV.resolveTreeOtherTokens(db, session)
              const unifiedKvTreeTokens = currentSessionTokens + otherTreeTokens

              // Available headroom calculation
              // Buffer preserves 15% (minimum 16k) of context window as safety margin
              const safetyReserveTokens = Math.max(16_000, Math.floor(contextLimit * 0.15))
              const ceiling = UnifiedKV.calculateAdjustedCeiling(contextLimit - safetyReserveTokens, otherTreeTokens)
              const availableHeadroom = Math.max(0, ceiling - currentSessionTokens)

              // Slot capacity & concurrency
              const { totalSlots, maxSubagents } = getDetectedSubagentCapacity()

              // Dynamic budget calculation:
              // availableHeadroom already protects the safety reserve.
              // We divide availableHeadroom across available subagent slots.
              const maxRecommendedSubagentBudget = Math.max(
                1_024,
                Math.floor(availableHeadroom / Math.max(1, maxSubagents)),
              )

              const isTight = availableHeadroom <= 8_192
              const recommendation = isTight
                ? `CRITICAL: Remaining context headroom is critically tight (${availableHeadroom} tokens). Delegating large tasks will trigger immediate overflow or compaction. Split into minimal atomic subtasks or compact parent first.`
                : `Verified: ${availableHeadroom} tokens available in unified tree. With ${maxSubagents} subagent slot(s) and a safety reserve of ${safetyReserveTokens} tokens, the max recommended budget per subagent task is ${maxRecommendedSubagentBudget} tokens. If your intended task exceeds this, decompose it into tertiary subtasks (SO-N-TM) before delegating.`

              const result = {
                contextLimit,
                currentSessionTokens,
                otherTreeTokens,
                unifiedKvTreeTokens,
                availableHeadroom,
                maxSubagents,
                totalSlots,
                parentReserveTokens: safetyReserveTokens,
                maxRecommendedSubagentBudget,
                recommendation,
              }

              return {
                output: result,
                content: JSON.stringify(result, null, 2),
              }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
