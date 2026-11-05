/**
 * ============================================================================
 * FORK COMPONENT: Unified KV Cache Tracking for Multi-Agent Local Sessions
 * ============================================================================
 *
 * Conflict Resolution Instructions for AI Agents & Developers:
 * -------------------------------------------------------------
 * When merging or rebasing against upstream `opencode`:
 * 1. This file is a self-contained extension module. ALWAYS KEEP THIS FILE.
 * 2. In `packages/core/src/session/compaction.ts`, the touch points are minimal
 *    hooks marked with `// FORK: Unified KV context integration`.
 * 3. Do not discard this module during conflict resolution. It allows subagents
 *    and root sessions to share unified KV cache bounds, ensuring subagents
 *    compact on time when running on local backends (llama.cpp, MLX, LM Studio)
 *    that use unified memory or shared context buffers.
 * ============================================================================
 */

export * as UnifiedKV from "./unified-kv.js"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { Token } from "../util/token.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SessionTable } from "./sql.js"
import { SessionHistory } from "./history.js"

export type Settings = {
  unified_kv?: boolean
}

/**
 * Checks if the unified KV mode is active.
 * Defaults to true. Can be explicitly disabled via session compaction settings
 * ({ unified_kv: false }) or environment variables (OPENCODE_UNIFIED_KV=false or OPENCODE_KV_UNIFIED=false).
 */
export const isUnifiedKv = (settings?: Partial<Settings>): boolean => {
  if (settings?.unified_kv !== undefined) return settings.unified_kv
  if (process.env.OPENCODE_UNIFIED_KV !== undefined) {
    return process.env.OPENCODE_UNIFIED_KV !== "false" && process.env.OPENCODE_UNIFIED_KV !== "0"
  }
  if (process.env.OPENCODE_KV_UNIFIED !== undefined) {
    return process.env.OPENCODE_KV_UNIFIED !== "false" && process.env.OPENCODE_KV_UNIFIED !== "0"
  }
  return true
}

/**
 * Counts text tokens within a single SessionMessage.
 */
const countMessageTextTokens = (msg: SessionMessage.Info): number => {
  if (!("content" in msg) || !Array.isArray(msg.content)) return 0
  let count = 0
  for (const part of msg.content) {
    if (part.type === "text" && typeof part.text === "string") {
      count += Token.estimate(part.text)
    }
  }
  return count
}

/**
 * Accurately estimates tokens occupied by a session's history:
 * - Uses the last assistant message's measured provider usage if available.
 * - Adds text token estimates for any subsequent messages since the anchor.
 */
export const estimateSessionTokens = (messages: ReadonlyArray<SessionMessage.Info>): number => {
  const anchorIndex = messages.findLastIndex((m) => m.type === "assistant" && m.tokens)
  if (anchorIndex === -1) {
    return messages.reduce((sum, msg) => sum + countMessageTextTokens(msg), 0)
  }
  const anchor = messages[anchorIndex]
  const anchorTokens =
    anchor?.type === "assistant" && anchor.tokens
      ? (anchor.tokens.input ?? 0) +
        (anchor.tokens.cache?.read ?? 0) +
        (anchor.tokens.cache?.write ?? 0) +
        (anchor.tokens.output ?? 0) +
        (anchor.tokens.reasoning ?? 0)
      : 0
  const after = messages.slice(anchorIndex + 1)
  const afterTokens = after.reduce((sum, msg) => sum + countMessageTextTokens(msg), 0)
  return anchorTokens + afterTokens
}

/**
 * Resolves all session IDs belonging to the same hierarchical tree (root parent + all child subagents).
 */
export const resolveTreeSessionIDs = (
  db: Database.Interface["db"],
  currentSession: SessionSchema.Info | { id: SessionSchema.ID; parentID?: SessionSchema.ID | null },
) =>
  Effect.gen(function* () {
    let rootID: SessionSchema.ID = currentSession.id
    let currParentID: SessionSchema.ID | null = currentSession.parentID ?? null
    while (currParentID) {
      rootID = currParentID
      const [parent] = yield* db
        .select({ id: SessionTable.id, parent_id: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, rootID))
        .limit(1)
        .pipe(Effect.orDie)
      currParentID = parent?.parent_id ?? null
    }

    const allIDs = new Set<SessionSchema.ID>([rootID])
    const queue: SessionSchema.ID[] = [rootID]
    while (queue.length > 0) {
      const parentID = queue.shift()!
      const children = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, parentID))
        .pipe(Effect.orDie)
      for (const child of children) {
        if (!allIDs.has(child.id)) {
          allIDs.add(child.id)
          queue.push(child.id)
        }
      }
    }
    return Array.from(allIDs)
  })

/**
 * Determines whether a subagent session has completed its execution and delivered
 * its result back to the parent session. Completed subagents have released their KV cache slot.
 */
export const isSubagentCompleted = (
  parentMessages: ReadonlyArray<SessionMessage.Info>,
  subagentID: string,
): boolean => {
  return parentMessages.some((msg) => {
    // Check synthetic subagent completion notification messages
    if (msg.type === "synthetic") {
      const text = (msg as any).text ?? (msg as any).payload?.text ?? ""
      if (
        typeof text === "string" &&
        text.includes(`sessionID="${subagentID}"`) &&
        (text.includes('state="completed"') || text.includes('state="error"') || text.includes('state="cancelled"'))
      ) {
        return true
      }
    }
    // Also check assistant message tool completion metadata
    if (msg.type === "assistant" && Array.isArray((msg as any).content)) {
      for (const part of (msg as any).content) {
        if (
          part.type === "tool" &&
          part.name === "subagent" &&
          part.state?.metadata?.sessionID === subagentID &&
          part.state?.status === "completed"
        ) {
          return true
        }
      }
    }
    return false
  })
}

/**
 * Calculates the total context tokens used by all OTHER sessions in the tree (parent + active sibling subagents),
 * excluding the currently executing session and any subagents that have already finished (freed from KV cache).
 */
export const resolveTreeOtherTokens = (
  db: Database.Interface["db"],
  currentSession: SessionSchema.Info | { id: SessionSchema.ID; parentID?: SessionSchema.ID | null },
) =>
  Effect.gen(function* () {
    const allIDs = yield* resolveTreeSessionIDs(db, currentSession)
    // Find the root session id
    let rootID: SessionSchema.ID = currentSession.id
    let currParentID: SessionSchema.ID | null = currentSession.parentID ?? null
    while (currParentID) {
      rootID = currParentID
      const [parent] = yield* db
        .select({ id: SessionTable.id, parent_id: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, rootID))
        .limit(1)
        .pipe(Effect.orDie)
      currParentID = parent?.parent_id ?? null
    }

    // Load parent messages once to detect completed subagents
    const parentMessages = yield* SessionHistory.load(db, rootID, "latest").pipe(Effect.orDie)

    let totalOther = 0
    for (const sid of allIDs) {
      if (sid === currentSession.id) continue
      // If sid is a child subagent and it already completed and delivered back to parent,
      // its KV cache slot has been freed by the local inference engine.
      if (sid !== rootID && isSubagentCompleted(parentMessages, sid)) {
        continue
      }
      const messages = yield* SessionHistory.load(db, sid, "latest").pipe(Effect.orDie)
      totalOther += estimateSessionTokens(messages)
    }
    return totalOther
  })

/**
 * Adjusts the compaction ceiling by subtracting the tokens occupied by other sessions in the unified KV pool.
 */
export const calculateAdjustedCeiling = (baseCeiling: number, otherTreeTokens = 0): number => {
  if (otherTreeTokens <= 0) return baseCeiling
  return Math.max(0, baseCeiling - otherTreeTokens)
}
