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
import { getEffectiveContextLimit } from "../../plugin/builtin/subagent-mandatory-instruction.js"
import { getObjectivesConfig } from "../../plugin/builtin/objectives-model.js"

export const name = "context_budget"

export const MIN_SUBAGENT_BUDGET = 16_000

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
  minSubagentBudget: Schema.Number,
  maxRecommendedSubagentBudget: Schema.Number,
  canDelegate: Schema.Boolean,
  recommendation: Schema.String,
})
export type Output = typeof Output.Type

export const description = [
  "Measures the current context consumption across the session tree and computes the dynamic safe budget for subagent tasks.",
  "MANDATORY REQUIREMENT: You MUST invoke this tool before delegating work to any subagent.",
  "The returned availableHeadroom MUST be passed to the subagent tool under contextBudget.availableHeadroom.",
  "If availableHeadroom < minSubagentBudget (16,000 tokens), delegation is blocked (canDelegate: false); the primary session must execute the task directly in the main thread (mode: 'main') or voluntarily compact first.",
  "If the task you intend to delegate exceeds maxRecommendedSubagentBudget, decompose the objective into smaller Level-3 subtasks (SO-N-T1...SO-N-TN; create as many as needed, not limited to 3) first.",
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
              let contextLimit = getEffectiveContextLimit(session.model)
              if (session.model) {
                const available = yield* models.available().pipe(Effect.orElseSucceed(() => []))
                const found = available.find(
                  (m) => m.providerID === session.model?.providerID && m.id === session.model?.id,
                )
                if (found?.limit?.context && found.limit.context > 0) {
                  const dynamicLimit = (globalThis as any)?.__OPENCODE_DYNAMIC_CONTEXT__?.getLimit?.(
                    `${session.model.providerID}/${session.model.id}`,
                  )
                  contextLimit = dynamicLimit ?? found.limit.context
                }
              }

              // Calculate current session tokens
              const messages = yield* SessionHistory.load(db, context.sessionID, "latest").pipe(Effect.orDie)
              const currentSessionTokens = UnifiedKV.estimateSessionTokens(messages)

              // Calculate other tokens in unified tree
              const isUnified = UnifiedKV.isUnifiedKv(undefined, session.model)
              const otherTreeTokens = isUnified ? yield* UnifiedKV.resolveTreeOtherTokens(db, session) : 0
              const unifiedKvTreeTokens = isUnified ? currentSessionTokens + otherTreeTokens : currentSessionTokens

              // Available headroom calculation
              // Buffer preserves 15% (minimum minSubagentBudget) of context window as safety margin
              const minBudget = getObjectivesConfig(context.sessionID).minSubagentBudget
              const safetyReserveTokens = Math.max(minBudget, Math.floor(contextLimit * 0.15))
              const ceiling = UnifiedKV.calculateAdjustedCeiling(contextLimit - safetyReserveTokens, otherTreeTokens)
              const availableHeadroom = Math.max(0, ceiling - currentSessionTokens)

              // Slot capacity & concurrency
              const { totalSlots, maxSubagents } = getDetectedSubagentCapacity()

              // Delegation threshold & minimum budget
              const canDelegate = availableHeadroom >= minBudget

              // Dynamic budget calculation:
              // availableHeadroom already protects the safety reserve.
              // We divide availableHeadroom across available subagent slots.
              const maxRecommendedSubagentBudget = Math.max(
                1_024,
                Math.floor(availableHeadroom / Math.max(1, maxSubagents)),
              )

              const isTight = availableHeadroom < minBudget
              const recommendation = isTight
                ? `DELEGATION_BLOCKED: Context headroom (${availableHeadroom} tokens) is below the minimum viable subagent budget (${minBudget} tokens). Do NOT delegate to a subagent (canDelegate: false). Execute this task directly in the main thread (mode: 'main'), or if the primary session has extensive accumulated history that can be pruned, voluntarily trigger compaction first.`
                : `Verified: ${availableHeadroom} tokens available in unified tree. Delegation allowed (canDelegate: true). With ${maxSubagents} subagent slot(s) and a safety reserve of ${safetyReserveTokens} tokens, the max recommended budget per subagent task is ${maxRecommendedSubagentBudget} tokens. If your intended task exceeds this, decompose it into smaller Level-3 subtasks (SO-N-T1...SO-N-TN; create as many as needed, not limited to 3) before delegating.`

              const result = {
                contextLimit,
                currentSessionTokens,
                otherTreeTokens,
                unifiedKvTreeTokens,
                availableHeadroom,
                maxSubagents,
                totalSlots,
                parentReserveTokens: safetyReserveTokens,
                minSubagentBudget: minBudget,
                maxRecommendedSubagentBudget,
                canDelegate,
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
