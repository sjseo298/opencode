import { describe, test, expect, beforeEach } from "bun:test"
import {
  HierarchicalObjectivesPlugin,
  setPrimaryObjective,
  addSecondaryObjective,
  updateSecondaryObjective,
  renderObjectiveTree,
  getObjectives,
  clearSessionObjectives,
  MAX_CONSECUTIVE_READS,
  postCompactionSessions,
  formatCompactionObjectivesInput,
  reconstructObjectivesFromMessages,
} from "../../../src/plugin/builtin/hierarchical-objectives.js"

let testCounter = 0
function uniqueSessionID(prefix: string) {
  return `${prefix}-${++testCounter}-${Date.now()}`
}

describe("hierarchical-objectives plugin", () => {
  beforeEach(() => {
    // Fresh run
  })

  describe("Core Objective State & Methodology Rules", () => {
    test("creates primary objective with title and Definition of Done", () => {
      const sid = uniqueSessionID("po-create")
      const po = setPrimaryObjective(sid, "Migrate Database Schema", "All migrations run and tests pass")
      expect(po.title).toBe("Migrate Database Schema")
      expect(po.definitionOfDone).toBe("All migrations run and tests pass")
      expect(po.status).toBe("exploring")
      expect(po.secondaries.length).toBe(0)
    })

    test("adds secondary objectives with sequential IDs and rationale", () => {
      const sid = uniqueSessionID("so-add")
      setPrimaryObjective(sid, "Fix Auth Issue", "User can log in successfully")

      const so1 = addSecondaryObjective(sid, "Inspect session cookie parsing", "Verify cookie headers from client")
      expect(so1.id).toBe("SO-1")
      expect(so1.status).toBe("pending")
      expect(so1.rationale).toBe("Verify cookie headers from client")

      const so2 = addSecondaryObjective(sid, "Patch token validation logic", "Prevent premature expiry error")
      expect(so2.id).toBe("SO-2")
      expect(so2.status).toBe("pending")

      const po = getObjectives(sid)!
      expect(po.secondaries.length).toBe(2)
      expect(po.secondaries[0].id).toBe("SO-1")
      expect(po.secondaries[1].id).toBe("SO-2")
    })

    test("enforces Validation-Before-Conclusion: fails to mark resolved without proof", () => {
      const sid = uniqueSessionID("validation-guard")
      setPrimaryObjective(sid, "Bugfix Task", "Bug is resolved")
      addSecondaryObjective(sid, "Investigate NullPointer", "Required to prevent crash")

      // Attempt to resolve without validation proof
      const failResult = updateSecondaryObjective(sid, "SO-1", {
        status: "resolved",
      })

      expect(failResult.success).toBe(false)
      expect(failResult.error).toContain("Cannot mark SO-1 as resolved without concrete validation proof")

      const po = getObjectives(sid)!
      expect(po.secondaries[0].status).toBe("pending")
    })

    test("succeeds marking resolved when concrete validation proof is provided", () => {
      const sid = uniqueSessionID("validation-success")
      setPrimaryObjective(sid, "Bugfix Task", "Bug is resolved")
      addSecondaryObjective(sid, "Fix NullPointer", "Required to prevent crash")

      const successResult = updateSecondaryObjective(sid, "SO-1", {
        status: "resolved",
        validationProof: "Ran 'bun test auth.test.ts' -> 12 passed, 0 failed. Exit code 0.",
      })

      expect(successResult.success).toBe(true)
      expect(successResult.objective?.status).toBe("resolved")
      expect(successResult.objective?.validationProof).toContain("12 passed, 0 failed")
    })

    test("renders formatted objective tree with statuses, rationales, and proofs", () => {
      const sid = uniqueSessionID("render-tree")
      setPrimaryObjective(sid, "Core Platform Upgrade", "Zero regression in test suite")
      addSecondaryObjective(sid, "Upgrade Bun runtime", "Required for performance improvements")
      updateSecondaryObjective(sid, "SO-1", {
        status: "blocked",
        blocker: "Missing binary dependency libssl3",
      })

      const po = getObjectives(sid)!
      const tree = renderObjectiveTree(po)
      expect(tree).toContain("Core Platform Upgrade")
      expect(tree).toContain("Zero regression in test suite")
      expect(tree).toContain("[BLOCKED]")
      expect(tree).toContain("⚠️ *Blocker:* Missing binary dependency libssl3")
    })
  })

  describe("Plugin Hooks and Integration", () => {
    async function setupPluginInstance() {
      const sessionHooks: Record<string, ((event: any) => Promise<void> | void)[]> = {}
      const toolHooks: Record<string, ((event: any) => Promise<void> | void)[]> = {}
      let registeredTool: any = null

      const mockCtx = {
        options: {},
        session: {
          todo: async () => [],
          hook: async (name: string, handler: any) => {
            sessionHooks[name] = sessionHooks[name] ?? []
            sessionHooks[name].push(handler)
          },
        },
        tool: {
          transform: async (callback: (editor: any) => void) => {
            const editor = {
              add: (tool: any) => {
                registeredTool = tool
              },
            }
            callback(editor)
          },
          hook: async (name: string, handler: any) => {
            toolHooks[name] = toolHooks[name] ?? []
            toolHooks[name].push(handler)
          },
        },
      }

      await HierarchicalObjectivesPlugin.setup(mockCtx as any)
      return { sessionHooks, toolHooks, getRegisteredTool: () => registeredTool }
    }

    test("registers objective_manage tool via transform", async () => {
      const { getRegisteredTool } = await setupPluginInstance()
      const tool = getRegisteredTool()
      expect(tool).not.toBeNull()
      expect(tool.name).toBe("objective_manage")
      expect(tool.description).toContain("Protocolo de Objetivos (Objectives Protocol)")
      expect(typeof tool.execute).toBe("function")
    })

    test("registers objective_manage with all actions and statuses in JSON schema enum", async () => {
      const { getRegisteredTool } = await setupPluginInstance()
      const tool = getRegisteredTool()
      expect(tool.input).toBeDefined()

      const { Schema } = await import("effect")
      const doc = Schema.toJsonSchemaDocument(tool.input) as any
      const actionEnum = doc.schema.properties.action.enum
      expect(actionEnum).toContain("set_primary")
      expect(actionEnum).toContain("complete_primary")
      expect(actionEnum).toContain("resolve_primary")
      expect(actionEnum).toContain("update_primary")
      expect(actionEnum).toContain("add_secondary")
      expect(actionEnum).toContain("update_secondary")
      expect(actionEnum).toContain("list")

      const statusEnum = doc.schema.properties.status.anyOf[0].enum
      expect(statusEnum).toContain("pending")
      expect(statusEnum).toContain("exploring")
      expect(statusEnum).toContain("blocked")
      expect(statusEnum).toContain("resolved")
      expect(statusEnum).toContain("discarded")
      expect(statusEnum).toContain("cancelled")
    })

    test("executes objective_manage tool to create and update objectives", async () => {
      const { getRegisteredTool } = await setupPluginInstance()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("tool-exec")

      // 1. set_primary
      const r1 = await tool.execute(
        { action: "set_primary", title: "API Refactor", definitionOfDone: "All endpoints return 200 OK" },
        { sessionID: sid },
      )
      expect(r1.output.success).toBe(true)
      expect(r1.output.tree).toContain("API Refactor")

      // 2. add_secondary
      const r2 = await tool.execute(
        { action: "add_secondary", title: "Update Auth Route", rationale: "Support JWT v2" },
        { sessionID: sid },
      )
      expect(r2.output.success).toBe(true)
      expect(r2.output.tree).toContain("SO-1")

      // 3. update_secondary without proof -> fails
      const r3 = await tool.execute(
        { action: "update_secondary", id: "SO-1", status: "resolved" },
        { sessionID: sid },
      )
      expect(r3.output.success).toBe(false)
      expect(r3.output.message).toContain("validation proof")

      // 4. update_secondary with proof -> succeeds
      const r4 = await tool.execute(
        {
          action: "update_secondary",
          id: "SO-1",
          status: "resolved",
          validationProof: "curl -I http://localhost:3000/auth returned HTTP 200 OK",
        },
        { sessionID: sid },
      )
      expect(r4.output.success).toBe(true)
      expect(r4.output.tree).toContain("✅ *Validation Proof:*")
      expect(r4.output.message).toContain("All secondary objectives are resolved")

      // 4b. complete_primary formally marks PO resolved
      const rComplete = await tool.execute(
        { action: "complete_primary", validationProof: "Integration suite passed 100%" },
        { sessionID: sid },
      )
      expect(rComplete.output.success).toBe(true)
      expect(rComplete.output.tree).toContain("Primary Objective [RESOLVED]:")
      expect(rComplete.output.message).toContain("RESOLVED")

      // 4c. complete_primary fails if open secondaries exist
      const sidOpen = uniqueSessionID("tool-open")
      setPrimaryObjective(sidOpen, "Open Task", "DoD")
      addSecondaryObjective(sidOpen, "Open Subtask", "Rationale")
      const rFail = await tool.execute(
        { action: "complete_primary" },
        { sessionID: sidOpen },
      )
      expect(rFail.output.success).toBe(false)
      expect(rFail.output.message).toContain("open secondary objectives")

      // 5. set_primary with initial secondaries in single call
      const sidBatch = uniqueSessionID("tool-batch")
      const r5 = await tool.execute(
        {
          action: "set_primary",
          title: "Batch Objective Setup",
          definitionOfDone: "All batch tasks completed",
          secondaries: [
            { title: "First batch item", rationale: "Rationale 1" },
            { title: "Second batch item", rationale: "Rationale 2", status: "exploring" },
          ],
        },
        { sessionID: sidBatch },
      )
      expect(r5.output.success).toBe(true)
      expect(r5.output.tree).toContain("First batch item")
      expect(r5.output.tree).toContain("Second batch item")
      expect(r5.output.tree).toContain("[EXPLORING]")

      // 6. batch add_secondaries
      const r6 = await tool.execute(
        {
          action: "add_secondaries",
          secondaries: [
            { title: "Third item", rationale: "Rationale 3" },
            { title: "Fourth item", rationale: "Rationale 4" },
          ],
        },
        { sessionID: sidBatch },
      )
      expect(r6.output.success).toBe(true)
      expect(r6.output.tree).toContain("Third item")
      expect(r6.output.tree).toContain("Fourth item")
    })

    test("compaction hook preserves full objective snapshot", async () => {
      const { sessionHooks } = await setupPluginInstance()
      const sid = uniqueSessionID("compaction-snap")
      setPrimaryObjective(sid, "Compaction Preserved Task", "Ensure no loss of objectives")
      addSecondaryObjective(sid, "Critical Subtask", "Must survive compaction")

      const event = { sessionID: sid, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["compaction"] ?? []) {
        await h(event)
      }

      expect(event.system.length).toBeGreaterThan(0)
      const text = event.system[0].text
      expect(text).toContain("Mandatory Objective Snapshot (Compacted History)")
      expect(text).toContain("Compaction Preserved Task")
      expect(text).toContain("Critical Subtask")
    })

    test("context hook injects Protocolo de Objetivos instructions and maintains prefix invariance", async () => {
      const { sessionHooks } = await setupPluginInstance()
      const sid = uniqueSessionID("context-target")
      setPrimaryObjective(sid, "Feature Implementation", "Passes end-to-end suite")
      addSecondaryObjective(sid, "Write unit tests", "Ensure regression prevention")

      const event = { sessionID: sid, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["context"] ?? []) {
        await h(event)
      }

      expect(event.system.length).toBeGreaterThan(0)
      const text = event.system[0].text
      expect(text).toContain("Protocolo de Objetivos (Objectives Protocol)")
      expect(text).toContain("objective_manage")
      expect(text).toContain("Secondary Objectives (SO-N)")
      expect(text).toContain("Mandatory Objective Reconciliation Before Final Response")
      expect(text).toContain("Before presenting your final result or concluding your final response to the user, your FIRST action MUST be to update and reconcile all objectives")
      expect(text).toContain("You MUST NOT leave objectives open, in-progress, or pending")
      expect(text).toContain("Post-Compaction Resumption")
      expect(text).toContain("Immediately after compaction finishes, when resuming the session, you MUST first review what has been accomplished in the objectives")
    })

    test("context hook maintains strict system prompt prefix invariance across turns and state transitions", async () => {
      const { sessionHooks } = await setupPluginInstance()
      const sid = uniqueSessionID("prefix-invariance")

      // Turn 1: No PO registered yet
      const event1 = { sessionID: sid, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["context"] ?? []) {
        await h(event1)
      }
      expect(event1.system.length).toBeGreaterThan(0)
      const text1 = event1.system[0].text
      expect(text1).toContain("Protocolo de Objetivos (Objectives Protocol)")

      // Turn 2: PO registered with secondaries
      setPrimaryObjective(sid, "Invariance Task", "All tests pass")
      const so1 = addSecondaryObjective(sid, "First subtask", "Needed for PO")
      const event2 = { sessionID: sid, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["context"] ?? []) {
        await h(event2)
      }
      const text2 = event2.system[0].text

      // Turn 3: SO-1 status transitions to resolved with proof
      so1.status = "resolved"
      so1.validationProof = "Verified via bun test"
      const event3 = { sessionID: sid, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["context"] ?? []) {
        await h(event3)
      }
      const text3 = event3.system[0].text

      // Strict prefix invariance: the system prompt must be 100% IDENTICAL across all turns
      // to preserve the KV cache prefix in llama.cpp / local LLMs!
      expect(text2).toBe(text1)
      expect(text3).toBe(text1)
    })

    test("context hook injects Protocolo de Objetivos instructions when no PO exists yet", async () => {
      const { sessionHooks } = await setupPluginInstance()
      const sid = uniqueSessionID("context-initial")

      const event = { sessionID: sid, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["context"] ?? []) {
        await h(event)
      }

      expect(event.system.length).toBeGreaterThan(0)
      const text = event.system[0].text
      expect(text).toContain("Protocolo de Objetivos (Objectives Protocol)")
      expect(text).toContain("protocolo de objetivos")
      expect(text).toContain("protocolo de investigacion")
      expect(text).toContain("objective_manage")
    })

    test("anti-loop protocol rejects execution after consecutive read-only operations to protect prefix cache", async () => {
      const { toolHooks } = await setupPluginInstance()
      const sid = uniqueSessionID("anti-loop")
      setPrimaryObjective(sid, "Codebase Audit", "Audit finished")

      const hook = toolHooks["execute.before"]?.[0]
      expect(hook).toBeDefined()

      // Execute MAX_CONSECUTIVE_READS - 1 calls (should pass)
      for (let i = 0; i < MAX_CONSECUTIVE_READS - 1; i++) {
        await hook({ sessionID: sid, tool: "read" })
      }

      // The MAX_CONSECUTIVE_READS-th call must reject to prevent loop without mutating event.system
      expect(() => hook({ sessionID: sid, tool: "read" })).toThrow("Anti-Loop Warning")
    })

    test("legacy todowrite compatibility maps todos into secondary objectives", async () => {
      const { toolHooks } = await setupPluginInstance()
      const sid = uniqueSessionID("todowrite-compat")

      for (const h of toolHooks["execute.after"] ?? []) {
        await h({
          sessionID: sid,
          tool: "todowrite",
          input: {
            todos: [
              { content: "Legacy task 1", status: "pending" },
              { content: "Legacy task 2", status: "completed" },
            ],
          },
        })
      }

      const po = getObjectives(sid)
      expect(po).toBeDefined()
      expect(po?.secondaries.length).toBe(2)
      expect(po?.secondaries[0].title).toBe("Legacy task 1")
      expect(po?.secondaries[0].status).toBe("pending")
      expect(po?.secondaries[1].title).toBe("Legacy task 2")
      expect(po?.secondaries[1].status).toBe("resolved")
    })

    test("delivers full objective tree as input upon compaction and maintains invariant post-compaction instructions", async () => {
      const { sessionHooks } = await setupPluginInstance()
      const sid = uniqueSessionID("post-compaction-resumption")
      setPrimaryObjective(sid, "System Architecture Upgrade", "Deploy to production without downtime")
      addSecondaryObjective(sid, "Migrate DB driver", "Support connection pooling")
      updateSecondaryObjective(sid, "SO-1", {
        status: "resolved",
        validationProof: "Pool test completed with 100 concurrent workers",
      })
      addSecondaryObjective(sid, "Update API endpoints", "Use connection pool from driver")

      // 1. Compaction hook fires
      const compactionEvent = { sessionID: sid, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["compaction"] ?? []) {
        await h(compactionEvent)
      }

      expect(compactionEvent.system.length).toBe(1)
      expect(compactionEvent.system[0].text).toContain("Insumo de Compactación")
      expect(compactionEvent.system[0].text).toContain("System Architecture Upgrade")
      expect(compactionEvent.system[0].text).toContain("Pool test completed with 100 concurrent workers")
      expect(compactionEvent.system[0].text).toContain("Migrate DB driver")
      expect(compactionEvent.system[0].text).toContain("Update API endpoints")
      expect(compactionEvent.system[0].text).toContain("SO-2")
      expect(compactionEvent.system[0].text).toContain("CRITICAL MANDATORY INSTRUCTION FOR POST-COMPACTION RESUMPTION")
      expect(compactionEvent.system[0].text).toContain("Immediately after compaction finishes, when the session resumes, the VERY FIRST action the agent must perform is to read what has been accomplished so far in the objectives")

      // 2. Next session starts / context hook fires
      const contextEvent = { sessionID: sid, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["context"] ?? []) {
        await h(contextEvent)
      }

      const postCompactionText = contextEvent.system.map((s) => s.text).join("\n")
      expect(postCompactionText).toContain("Protocolo de Objetivos (Objectives Protocol)")
      expect(postCompactionText).toContain("Post-Compaction Resumption")
      expect(postCompactionText).toContain("Immediately after compaction finishes, when resuming the session, you MUST first review what has been accomplished in the objectives")
      expect(postCompactionText).toContain("objective_manage")
      expect(postCompactionText).toContain("Do not re-investigate resolved items")
    })

    test("reconstructs objectives from session message tool calls or compaction checkpoint when in-memory state is missing", async () => {
      const { sessionHooks } = await setupPluginInstance()
      const sid = uniqueSessionID("checkpoint-reconstruction")

      // Ensure no in-memory state exists
      clearSessionObjectives(sid)

      const checkpointMessage = {
        role: "user",
        content: [
          "<conversation-checkpoint>",
          "<summary>",
          "## Protocolo de Objetivos - Resumen de Objetivos (Insumo de Compactación)",
          "[PO] Fork Synchronization Protocol [EXPLORING]",
          "Definition of Done: Clean merge with upstream without regressions",
          "",
          "### Completed Objectives",
          "- [SO-1] [RESOLVED] Fetch upstream branches (Proof: git fetch origin dev returned exit 0)",
          "",
          "### Active / Exploring Objectives",
          "- [SO-2] [EXPLORING] Resolve conflicts in package.json (Rationale: Required for lockfile integrity)",
          "</summary>",
          "</conversation-checkpoint>",
        ].join("\n"),
      }

      const event = {
        sessionID: sid,
        system: [] as { type: string; text: string }[],
        messages: [checkpointMessage],
      }

      for (const h of sessionHooks["context"] ?? []) {
        await h(event)
      }

      // Check that objectives were reconstructed into memory
      const po = getObjectives(sid)
      expect(po).toBeDefined()
      expect(po?.title).toBe("Fork Synchronization Protocol")
      expect(po?.definitionOfDone).toBe("Clean merge with upstream without regressions")
      expect(po?.secondaries.length).toBe(2)
      expect(po?.secondaries[0].id).toBe("SO-1")
      expect(po?.secondaries[0].status).toBe("resolved")
      expect(po?.secondaries[1].id).toBe("SO-2")
      expect(po?.secondaries[1].status).toBe("exploring")

      // Verify that invariant methodology instructions are present
      const text = event.system.map((s) => s.text).join("\n")
      expect(text).toContain("Protocolo de Objetivos (Objectives Protocol)")
      expect(text).toContain("Post-Compaction Resumption")
      expect(text).toContain("objective_manage")
    })
  })
})
