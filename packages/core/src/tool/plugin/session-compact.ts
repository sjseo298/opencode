/**
 * ============================================================================
 * Session Compact Tool: Voluntary Compaction with Agent-Provided Notes
 * ============================================================================
 */

export * as SessionCompactTool from "./session-compact.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Database } from "../../database/database.js"
import { Model } from "../../model.js"
import { getObjectivesConfig } from "../../plugin/builtin/objectives-model.js"
import { getEffectiveContextLimit } from "../../plugin/builtin/subagent-mandatory-instruction.js"
import { Session } from "../../session.js"
import { SessionHistory } from "../../session/history.js"
import { UnifiedKV } from "../../session/unified-kv.js"

export const name = "session_compact"

export const Input = Schema.Struct({
  summaryNotes: Schema.optionalKey(Schema.String).annotate({
    description:
      "Optional summary notes, key decisions, files changed, and unfinished work that MUST be explicitly preserved across compaction.",
  }),
  force: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Only set to true when explicitly instructed by the user to compact immediately regardless of current context usage.",
  }),
})

export const Output = Schema.Struct({
  status: Schema.String,
  message: Schema.String,
  notesPreserved: Schema.String,
  contextUsedPercent: Schema.optionalKey(Schema.Number),
  ceilingUsedPercent: Schema.optionalKey(Schema.Number),
  availableHeadroom: Schema.optionalKey(Schema.Number),
})
export type Output = typeof Output.Type

export const description = [
  "Voluntarily triggers a clean session compaction to reclaim context space ONLY when the context window is genuinely near exhaustion.",
  "STRICT USAGE RULE: Invoke this tool ONLY when you receive the system's [CRITICAL PRE-COMPACTION ADVISORY] (at 85% of context ceiling) or when `context_budget` explicitly reports `canDelegate: false` (DELEGATION_BLOCKED).",
  "Do NOT invoke this tool speculatively, after routine milestones, or in reaction to `[Objective Sync Warning]` messages. Never guess your context usage—if no Pre-Compaction Advisory has been injected, you have ample headroom and must continue executing your objectives directly.",
  "You can supply `summaryNotes` with critical state, decisions, or unfinished tasks to guarantee they are preserved in the new context checkpoint.",
  "Compaction is scheduled for the end of the current step.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.session_compact",
  effect: Effect.fn("SessionCompactTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const models = yield* Model.Service
    const database = yield* Database.Service
    const db = database.db

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: false },
        description,
        input: Input,
        output: Output,
        execute: (input, context) =>
          Effect.gen(function* () {
            const notes = input.summaryNotes?.trim() ?? ""

            const session = yield* sessions
              .get(context.sessionID)
              .pipe(Effect.orElseSucceed(() => undefined))

            const messages = yield* SessionHistory.load(db, context.sessionID, "latest").pipe(
              Effect.orElseSucceed(() => []),
            )

            let contextUsedPercent: number | undefined
            let ceilingUsedPercent: number | undefined
            let availableHeadroom: number | undefined

            if (session && messages.length > 0) {
              let contextLimit = getEffectiveContextLimit(session.model)
              if (session.model) {
                const available = yield* models.available().pipe(Effect.orElseSucceed(() => []))
                const found = available.find(
                  (m) => m.providerID === session.model?.providerID && m.id === session.model?.id,
                )
                if (found?.limit?.context && found.limit.context > 0) {
                  contextLimit = found.limit.context
                }
              }

              const currentSessionTokens = UnifiedKV.estimateSessionTokens(messages)
              const isUnified = UnifiedKV.isUnifiedKv(undefined, session.model)
              const otherTreeTokens = isUnified ? yield* UnifiedKV.resolveTreeOtherTokens(db, session) : 0
              const cfg = getObjectivesConfig(context.sessionID)

              const safetyBuffer = Math.min(15_000, Math.floor(contextLimit * 0.15))
              const ceiling = UnifiedKV.calculateAdjustedCeiling(
                Math.max(10_000, contextLimit - safetyBuffer),
                otherTreeTokens,
              )

              const safetyReserveTokens = Math.max(cfg.minSubagentBudget, Math.floor(contextLimit * 0.15))
              const delegationCeiling = UnifiedKV.calculateAdjustedCeiling(
                contextLimit - safetyReserveTokens,
                otherTreeTokens,
              )
              availableHeadroom = Math.max(0, delegationCeiling - currentSessionTokens)

              contextUsedPercent = Math.round(((currentSessionTokens + otherTreeTokens) / Math.max(1, contextLimit)) * 100)
              ceilingUsedPercent = Math.round((currentSessionTokens / Math.max(1, ceiling)) * 100)

              const isSubagent = typeof session.parentID === "string" && session.parentID.length > 0
              const advisoryThreshold = isSubagent
                ? cfg.subagentPreCompactionThreshold
                : cfg.primaryPreCompactionThreshold
              const minCeilingThreshold = Math.max(50, advisoryThreshold - 10)
              const isDelegationBlocked = availableHeadroom < cfg.minSubagentBudget

              if (
                !input.force &&
                ceilingUsedPercent < minCeilingThreshold &&
                contextUsedPercent < minCeilingThreshold &&
                !isDelegationBlocked
              ) {
                const freePercent = Math.max(0, 100 - contextUsedPercent)
                const skipped: Output = {
                  status: "compaction_skipped_sufficient_headroom",
                  message: `PREMATURE COMPACTION BLOCKED: Your current context consumption is only ${contextUsedPercent}% of the total window (${currentSessionTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens; ${freePercent}% free headroom, ${availableHeadroom.toLocaleString()} delegable tokens available), which is well below the ${advisoryThreshold}% Pre-Compaction Advisory threshold (minimum ${minCeilingThreshold}% ceiling required). Do NOT compact when ample context headroom is available—compacting prematurely wastes tokens and discards exact working memory. Continue executing your active objectives directly without calling session_compact.`,
                  notesPreserved: notes.length > 0 ? notes : "(none)",
                  contextUsedPercent,
                  ceilingUsedPercent,
                  availableHeadroom,
                }
                return {
                  output: skipped,
                  content: JSON.stringify(skipped, null, 2),
                }
              }
            }

            // Enqueue compaction in the session
            yield* sessions
              .compact({ sessionID: context.sessionID })
              .pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Failed to enqueue compaction: ${error}`, error }),
                ),
              )

            const output: Output = {
              status: "compaction_enqueued",
              message:
                "Session compaction has been enqueued. Your conversation history will be compacted cleanly at the boundary of this turn. Wrap up this step cleanly.",
              notesPreserved: notes.length > 0 ? notes : "(none)",
              ...(contextUsedPercent === undefined ? {} : { contextUsedPercent }),
              ...(ceilingUsedPercent === undefined ? {} : { ceilingUsedPercent }),
              ...(availableHeadroom === undefined ? {} : { availableHeadroom }),
            }

            return {
              output,
              content: JSON.stringify(output, null, 2),
            }
          }),
      }),
    )
  }),
}
