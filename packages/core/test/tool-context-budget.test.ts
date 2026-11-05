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
import { Tool } from "@opencode/core/tool"
import * as ContextBudgetTool from "@opencode/core/tool/plugin/context-budget"
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

describe("ContextBudgetTool", () => {
  it.live("computes dynamic subagent budget based on available headroom and slots", () =>
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
            title: "Budget test session",
          })

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(session.location)))
          yield* registerToolPlugin(ContextBudgetTool.Plugin).pipe(Effect.provide(locations.get(session.location)))

          // 1. Run with default 2 slots (1 subagent)
          const g = globalThis as any
          g.__OPENCODE_TOTAL_SLOTS__ = 2
          g.__OPENCODE_MAX_SUBAGENTS__ = 1

          const result1 = yield* executeTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-budget-1",
              name: "context_budget",
              input: {},
            },
          })

          expect(result1.output).toBeDefined()
          const budget1 = result1.output as ContextBudgetTool.Output
          expect(budget1.contextLimit).toBeGreaterThan(0)
          expect(budget1.maxSubagents).toBe(1)
          expect(budget1.totalSlots).toBe(2)
          expect(budget1.maxRecommendedSubagentBudget).toBeGreaterThan(0)
          // With 1 subagent slot, the recommended budget matches available headroom directly (no double deduction)
          expect(budget1.maxRecommendedSubagentBudget).toBe(budget1.availableHeadroom)
          expect(budget1.minSubagentBudget).toBe(16_000)
          expect(budget1.canDelegate).toBe(budget1.availableHeadroom >= 16_000)

          // 2. Run with 4 slots (3 subagents) -> budget per subagent should scale inversely with concurrency
          g.__OPENCODE_TOTAL_SLOTS__ = 4
          g.__OPENCODE_MAX_SUBAGENTS__ = 3

          const result2 = yield* executeTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-budget-2",
              name: "context_budget",
              input: {},
            },
          })

          const budget2 = result2.output as ContextBudgetTool.Output
          expect(budget2.maxSubagents).toBe(3)
          expect(budget2.totalSlots).toBe(4)

          // Budget per subagent with 3 slots should be floor(availableHeadroom / 3)
          expect(budget2.maxRecommendedSubagentBudget).toBe(Math.floor(budget2.availableHeadroom / 3))

          // Clean up globals
          delete g.__OPENCODE_TOTAL_SLOTS__
          delete g.__OPENCODE_MAX_SUBAGENTS__
        }),
      ),
    ),
  )
})
