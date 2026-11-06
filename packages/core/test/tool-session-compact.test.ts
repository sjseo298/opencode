import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { SessionMessage } from "@opencode/schema/session-message"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { Tool } from "@opencode/core/tool"
import * as SessionCompactTool from "@opencode/core/tool/plugin/session-compact"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const testModel = Model.Ref.make({ id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") })
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Session.node,
  Model.node,
  Tool.node,
  LocationServiceMap.node,
])

const replacements = [
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements

const it = testEffect(AppNodeBuilder.build(nodes, replacements))

describe("SessionCompactTool", () => {
  it.live("enqueues compaction and preserves agent summary notes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            model: testModel,
            title: "Compact test session",
          })

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(session.location)))
          yield* registerToolPlugin(SessionCompactTool.Plugin).pipe(Effect.provide(locations.get(session.location)))

          // 1. Call session_compact with summaryNotes
          const resultWithNotes = yield* executeTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-compact-1",
              name: "session_compact",
              input: {
                summaryNotes: "Completed phase 1. Verified backend fix in compaction.ts. Next: run checks.",
              },
            },
          })

          expect(resultWithNotes.output).toBeDefined()
          const output1 = resultWithNotes.output as SessionCompactTool.Output
          expect(output1.status).toBe("compaction_enqueued")
          expect(output1.notesPreserved).toContain("Completed phase 1")
          expect(output1.message).toContain("Session compaction has been enqueued")

          // 2. Call session_compact without summaryNotes
          const resultNoNotes = yield* executeTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-compact-2",
              name: "session_compact",
              input: {},
            },
          })

          expect(resultNoNotes.output).toBeDefined()
          const output2 = resultNoNotes.output as SessionCompactTool.Output
          expect(output2.status).toBe("compaction_enqueued")
          expect(output2.notesPreserved).toBe("(none)")

          // 3. Verify that compaction was indeed admitted into session inbox
          const db = (yield* Database.Service).db
          const inboxItems = yield* SessionInbox.listWithRefs(db, session.id)
          expect(inboxItems.some((item) => item.type === "compaction")).toBe(true)
        }),
      ),
    ),
  )

  it.live("blocks premature voluntary compaction at 56% context usage and allows compaction at >= threshold or force: true", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            model: testModel,
            title: "Premature compaction guard test",
          })

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(session.location)))
          yield* registerToolPlugin(SessionCompactTool.Plugin).pipe(Effect.provide(locations.get(session.location)))

          const db = (yield* Database.Service).db
          const now = Date.UTC(2026, 0, 2, 10)

          // Insert an assistant message with ~56% of 128,000 tokens (71,680 tokens)
          const msg56 = encodeMessage(
            SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_56_pct"),
              type: "assistant",
              agent: Agent.ID.make("build"),
              model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
              content: [],
              cost: Money.USD.make(0.1),
              tokens: {
                input: 70_000,
                output: 1_680,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              time: { created: DateTime.makeUnsafe(now), completed: DateTime.makeUnsafe(now + 1000) },
            }),
          )
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make(msg56.id),
              session_id: session.id,
              type: msg56.type,
              seq: 1,
              time_created: msg56.time.created,
              data: msg56,
            })
            .run()
            .pipe(Effect.orDie)

          // 1. Attempt voluntary compaction at 56% context -> MUST BE BLOCKED
          const blockedRes = yield* executeTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-compact-premature",
              name: "session_compact",
              input: {
                summaryNotes: "Speculative compaction at 56%",
              },
            },
          })

          const blockedOut = blockedRes.output as SessionCompactTool.Output
          expect(blockedOut.status).toBe("compaction_skipped_sufficient_headroom")
          expect(blockedOut.contextUsedPercent).toBe(56)
          expect(blockedOut.message).toContain("PREMATURE COMPACTION BLOCKED")
          expect(blockedOut.message).toContain("56%")

          const inboxBefore = yield* SessionInbox.listWithRefs(db, session.id)
          expect(inboxBefore.some((item) => item.type === "compaction")).toBe(false)

          // 2. When context reaches high usage (e.g. 98,000 / 128,000 tokens => > 85% of ceiling), compaction is allowed
          const msgHigh = encodeMessage(
            SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_87_pct"),
              type: "assistant",
              agent: Agent.ID.make("build"),
              model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
              content: [],
              cost: Money.USD.make(0.2),
              tokens: {
                input: 96_000,
                output: 2_000,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              time: { created: DateTime.makeUnsafe(now + 2000), completed: DateTime.makeUnsafe(now + 3000) },
            }),
          )
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make(msgHigh.id),
              session_id: session.id,
              type: msgHigh.type,
              seq: 2,
              time_created: msgHigh.time.created,
              data: msgHigh,
            })
            .run()
            .pipe(Effect.orDie)

          const allowedRes = yield* executeTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-compact-high",
              name: "session_compact",
              input: {
                summaryNotes: "High context compaction at 87% ceiling",
              },
            },
          })

          const allowedOut = allowedRes.output as SessionCompactTool.Output
          expect(allowedOut.status).toBe("compaction_enqueued")

          const inboxAfter = yield* SessionInbox.listWithRefs(db, session.id)
          expect(inboxAfter.some((item) => item.type === "compaction")).toBe(true)
        }),
      ),
    ),
  )
})
