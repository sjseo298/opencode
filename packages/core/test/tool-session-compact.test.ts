import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { Tool } from "@opencode/core/tool"
import * as SessionCompactTool from "@opencode/core/tool/plugin/session-compact"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const testModel = Model.Ref.make({ id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") })

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
})
