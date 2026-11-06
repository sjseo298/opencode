/**
 * ============================================================================
 * Session Compact Tool: Voluntary Compaction with Agent-Provided Notes
 * ============================================================================
 */

export * as SessionCompactTool from "./session-compact.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Session } from "../../session.js"

export const name = "session_compact"

export const Input = Schema.Struct({
  summaryNotes: Schema.optionalKey(Schema.String).annotate({
    description:
      "Optional summary notes, key decisions, files changed, and unfinished work that MUST be explicitly preserved across compaction.",
  }),
})

export const Output = Schema.Struct({
  status: Schema.String,
  message: Schema.String,
  notesPreserved: Schema.String,
})
export type Output = typeof Output.Type

export const description = [
  "Voluntarily triggers a clean session compaction to reclaim context space.",
  "Invoke this tool when you receive the Pre-Compaction Advisory (85% context used) or after completing a major task milestone.",
  "You can supply `summaryNotes` with critical state, decisions, or unfinished tasks to guarantee they are preserved in the new context checkpoint.",
  "Compaction is scheduled for the end of the current step.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.session_compact",
  effect: Effect.fn("SessionCompactTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service

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
