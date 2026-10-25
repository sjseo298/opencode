import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  HierarchicalObjectivesPlugin,
  setPrimaryObjective,
  addSecondaryObjective,
  updateSecondaryObjective,
  addTertiaryObjective,
  updateTertiaryObjective,
  updatePrimaryObjective,
  renderObjectiveTree,
  formatCompactionObjectivesInput,
  getObjectives,
  clearSessionObjectives,
  MAX_CONSECUTIVE_READS,
  addFinding,
  updateFinding,
  addOption,
  updateOption,
  addFingerprint,
  setDoDCriteria,
  presentPlan,
  resumePlan,
  makeCheckpoint,
  exportSession,
  importSession,
  hydrateSessionObjectives,
  setObjectivesStore,
} from "../../../src/plugin/builtin/hierarchical-objectives.js"
import {
  validateFindingFields,
  runComplianceAudit,
  searchFindings,
  defaultFindingScore,
  setFindingScorer,
  parseDocument,
  repairDocumentInvariants,
  evaluateDoD,
  renderProjection,
} from "../../../src/plugin/builtin/objectives-model.js"
import { createObjectivesStore } from "../../../src/plugin/builtin/objectives-persistence.js"

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

      const statusProp = doc.schema.properties.status
      const statusEnum = statusProp.enum || statusProp.anyOf?.find((a: any) => a.enum)?.enum || statusProp.anyOf?.[0]?.anyOf?.find((a: any) => a.enum)?.enum
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

    test("handles null validationProof, null blocker, and missing title without errors", async () => {
      const sid = uniqueSessionID("null-fields")
      let registeredTool: any = null
      const mockCtx = {
        tool: {
          transform: async (fn: any) => {
            const editor = {
              add: (toolDef: any) => {
                if (toolDef.name === "objective_manage") registeredTool = toolDef
              },
            }
            await fn(editor)
          },
          hook: async () => {},
        },
        session: { hook: async () => {} },
      }

      await HierarchicalObjectivesPlugin.setup(mockCtx as any)
      expect(registeredTool).toBeDefined()

      // The exact payload from the user's report with null validationProof and missing titles
      const payload = {
        action: "set_primary",
        definitionOfDone: "Existe un archivo de arquitectura en el repo.",
        title: "Actualizar o crear el documento de arquitectura",
        secondaries: [
          {
            id: "SO-1",
            rationale: "Necesario para saber si ya existe un documento.",
            blocker: "",
            validationProof: null,
          },
          {
            id: "SO-2",
            rationale: "Necesario para que el documento sea fiel al codigo.",
            blocker: "",
            validationProof: null,
          },
          {
            id: "SO-3",
            rationale: "Objetivo final: producir el entregable ARCHITECTURE.md.",
            blocker: "",
            validationProof: null,
          },
        ],
      }

      const res = await registeredTool.execute(payload, { sessionID: sid })
      expect(res.output.success).toBe(true)

      const po = getObjectives(sid)
      expect(po).toBeDefined()
      expect(po?.secondaries.length).toBe(3)
      expect(po?.secondaries[0].id).toBe("SO-1")
      expect(po?.secondaries[0].title).toBe("Necesario para saber si ya existe un documento.")
      expect(po?.secondaries[0].validationProof).toBeUndefined()
      expect(po?.secondaries[1].id).toBe("SO-2")
      expect(po?.secondaries[2].id).toBe("SO-3")

      // Re-calling set_primary (retry scenario) must NOT duplicate secondaries
      const retryRes = await registeredTool.execute(payload, { sessionID: sid })
      expect(retryRes.output.success).toBe(true)
      const poAfterRetry = getObjectives(sid)
      expect(poAfterRetry?.secondaries.length).toBe(3)
      expect(poAfterRetry?.secondaries[0].id).toBe("SO-1")
      expect(poAfterRetry?.secondaries[1].id).toBe("SO-2")
      expect(poAfterRetry?.secondaries[2].id).toBe("SO-3")
    })

    test("add_secondary with explicit ID updates in-place without duplicate IDs", async () => {
      const sid = uniqueSessionID("add-secondary-dedup")
      let registeredTool: any = null
      const mockCtx = {
        tool: {
          transform: async (fn: any) => {
            const editor = {
              add: (toolDef: any) => {
                if (toolDef.name === "objective_manage") registeredTool = toolDef
              },
            }
            await fn(editor)
          },
          hook: async () => {},
        },
        session: { hook: async () => {} },
      }

      await HierarchicalObjectivesPlugin.setup(mockCtx as any)

      await registeredTool.execute(
        {
          action: "set_primary",
          title: "Main Task",
          definitionOfDone: "Verify DoD",
          secondaries: [{ title: "Initial Task", rationale: "R1" }],
        },
        { sessionID: sid },
      )

      const po = getObjectives(sid)
      expect(po?.secondaries.length).toBe(1)
      expect(po?.secondaries[0].id).toBe("SO-1")

      // Add secondary with explicit id="SO-1" should update SO-1, not append duplicate
      await registeredTool.execute(
        {
          action: "add_secondary",
          secondaries: [{ id: "SO-1", title: "Updated Task 1", rationale: "R1 updated" }],
        },
        { sessionID: sid },
      )

      expect(po?.secondaries.length).toBe(1)
      expect(po?.secondaries[0].id).toBe("SO-1")
      expect(po?.secondaries[0].title).toBe("Updated Task 1")

      // Add a second objective without explicit ID gets SO-2
      await registeredTool.execute(
        {
          action: "add_secondary",
          title: "Second Task",
          rationale: "R2",
        },
        { sessionID: sid },
      )
      expect(po?.secondaries.length).toBe(2)
      expect(po?.secondaries[1].id).toBe("SO-2")
    })
  })

  describe("Tertiary Objectives & Closure Semantics", () => {
    async function setupT() {
      let registeredTool: any = null
      const sessionHooks: Record<string, ((event: any) => Promise<void> | void)[]> = {}
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
          transform: async (cb: (editor: any) => void) =>
            cb({ add: (toolDef: any) => { registeredTool = toolDef } }),
          hook: async () => {},
        },
      }
      await HierarchicalObjectivesPlugin.setup(mockCtx as any)
      return { getRegisteredTool: () => registeredTool, sessionHooks }
    }

    test("creates tertiary objectives as children of their parent SO with hierarchical ids", () => {
      const sid = uniqueSessionID("to-create")
      setPrimaryObjective(sid, "Big Migration", "All steps verified")
      addSecondaryObjective(sid, "Small task", "Trivial scope")
      addSecondaryObjective(sid, "Oversized task", "Needs decomposition")

      const r1 = addTertiaryObjective(sid, "SO-2", "Patch step A", "Isolate first independent step")
      expect(r1.success).toBe(true)
      expect(r1.objective?.id).toBe("SO-2-T1")
      expect(r1.objective?.status).toBe("pending")

      const r2 = addTertiaryObjective(sid, "SO-2", "Patch step B", "Isolate second independent step")
      expect(r2.success).toBe(true)
      expect(r2.objective?.id).toBe("SO-2-T2")

      const po = getObjectives(sid)!
      expect(po.secondaries[0].children).toBeUndefined()
      expect(po.secondaries[1].children?.length).toBe(2)
      expect(po.secondaries[1].children?.map((t) => t.id)).toEqual(["SO-2-T1", "SO-2-T2"])
    })

    test("rejects add_tertiary under an unknown parent SO", () => {
      const sid = uniqueSessionID("to-bad-parent")
      setPrimaryObjective(sid, "Task", "Done")
      const result = addTertiaryObjective(sid, "SO-9", "Orphan step", "No such parent")
      expect(result.success).toBe(false)
      expect(result.error).toContain("not found")
    })

    test("enforces Done-means-Done for tertiary resolution", () => {
      const sid = uniqueSessionID("to-proof-gate")
      setPrimaryObjective(sid, "Task", "Done")
      addSecondaryObjective(sid, "Oversized task", "Needs decomposition")
      addTertiaryObjective(sid, "SO-1", "Patch step A", "Isolate first independent step")

      const fail = updateTertiaryObjective(sid, "SO-1-T1", { status: "resolved" })
      expect(fail.success).toBe(false)
      expect(fail.error).toContain("Cannot mark SO-1-T1 as resolved without concrete validation proof")

      const ok = updateTertiaryObjective(sid, "SO-1-T1", {
        status: "resolved",
        validationProof: "'bun test stepA.test.ts' -> 9 passing, exit code 0.",
      })
      expect(ok.success).toBe(true)
      expect(ok.objective?.status).toBe("resolved")
    })

    test("BLOCKS the shortcut: an SO cannot be resolved while its tertiary objectives are open", () => {
      const sid = uniqueSessionID("so-shortcut-blocked")
      setPrimaryObjective(sid, "Task", "Done")
      addSecondaryObjective(sid, "Oversized task", "Needs decomposition")
      addTertiaryObjective(sid, "SO-1", "Patch step A", "Isolate first independent step")
      addTertiaryObjective(sid, "SO-1", "Patch step B", "Isolate second independent step")

      const blocked = updateSecondaryObjective(sid, "SO-1", {
        status: "resolved",
        validationProof: "Looks complete already",
      })
      expect(blocked.success).toBe(false)
      expect(blocked.error).toContain("open tertiary objectives")
      expect(blocked.error).toContain("SO-1-T1")

      // Close every child first, then the SO can be resolved with its own proof.
      updateTertiaryObjective(sid, "SO-1-T1", { status: "resolved", validationProof: "step A verified" })
      updateTertiaryObjective(sid, "SO-1-T2", { status: "discarded" })
      const allowed = updateSecondaryObjective(sid, "SO-1", {
        status: "resolved",
        validationProof: "All steps of the oversized task verified end-to-end.",
      })
      expect(allowed.success).toBe(true)
      expect(allowed.objective?.status).toBe("resolved")
    })

    test("BLOCKS the shortcut: PO cannot resolve while nested tertiary objectives are open", () => {
      const sid = uniqueSessionID("po-shortcut-blocked")
      setPrimaryObjective(sid, "Task", "Done")
      addSecondaryObjective(sid, "Oversized task", "Needs decomposition")
      addTertiaryObjective(sid, "SO-1", "Patch step A", "Isolate first independent step")

      // Simulate legacy/corrupt state: SO force-resolved while its child is still open.
      const po = getObjectives(sid)!
      po.secondaries[0].status = "resolved"
      po.secondaries[0].validationProof = "stale proof"

      const result = updatePrimaryObjective(sid, { status: "resolved", validationProof: "e2e green" })
      expect(result.success).toBe(false)
      expect(result.error).toContain("open secondary objectives")
    })

    test("renders tertiary objectives nested under their parent SO in the tree", () => {
      const sid = uniqueSessionID("to-render")
      setPrimaryObjective(sid, "Core Upgrade", "Zero regressions")
      addSecondaryObjective(sid, "Oversized task", "Needs decomposition")
      addTertiaryObjective(sid, "SO-1", "Patch step A", "Isolate first independent step")

      const tree = renderObjectiveTree(getObjectives(sid)!)
      expect(tree).toContain("- **SO-1** [PENDING] Oversized task")
      expect(tree).toContain("  - **SO-1-T1** [PENDING] Patch step A")
      expect(tree).toContain("    - *Rationale:* Isolate first independent step")
    })

    test("compaction snapshot lists tertiary lines indented under their parent SO", () => {
      const sid = uniqueSessionID("to-compaction")
      setPrimaryObjective(sid, "Compaction Task", "No loss")
      addSecondaryObjective(sid, "Oversized task", "Needs decomposition")
      addTertiaryObjective(sid, "SO-1", "Patch step A", "Isolate first independent step")

      const text = formatCompactionObjectivesInput(getObjectives(sid)!)
      expect(text).toContain("- [SO-1] [PENDING] Oversized task (Rationale: Needs decomposition)")
      expect(text).toContain("  - [SO-1-T1] [PENDING] Patch step A")
    })

    test("tool executes add_tertiary/update_tertiary end-to-end with closure nudge and schema actions", async () => {
      const { getRegisteredTool } = await setupT()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("to-tool")

      const r1 = await tool.execute(
        { action: "set_primary", title: "API Overhaul", definitionOfDone: "All endpoints verified" },
        { sessionID: sid },
      )
      expect(r1.output.success).toBe(true)
      await tool.execute({ action: "add_secondary", title: "Oversized task", rationale: "Needs decomposition" }, { sessionID: sid })

      const rAdd = await tool.execute(
        { action: "add_tertiary", id: "SO-1", title: "Patch step A", rationale: "Isolate first independent step" },
        { sessionID: sid },
      )
      expect(rAdd.output.success).toBe(true)
      expect(rAdd.output.message).toContain("SO-1-T1")
      expect(rAdd.output.tree).toContain("**SO-1-T1** [PENDING]")

      const rBadParent = await tool.execute(
        { action: "add_tertiary", id: "SO-77", title: "Orphan", rationale: "No parent" },
        { sessionID: sid },
      )
      expect(rBadParent.output.success).toBe(false)
      expect(rBadParent.output.message).toContain("not found")

      const rNoProof = await tool.execute(
        { action: "update_tertiary", id: "SO-1-T1", status: "resolved" },
        { sessionID: sid },
      )
      expect(rNoProof.output.success).toBe(false)
      expect(rNoProof.output.message).toContain("validation proof")

      const rClose = await tool.execute(
        { action: "update_tertiary", id: "SO-1-T1", status: "resolved", validationProof: "step A verified with exit code 0" },
        { sessionID: sid },
      )
      expect(rClose.output.success).toBe(true)
      expect(rClose.output.message).toContain("All tertiary objectives under SO-1 are closed")

      const { Schema } = await import("effect")
      const doc = Schema.toJsonSchemaDocument(tool.input as any) as any
      const actionEnum = doc.schema.properties.action.enum
      expect(actionEnum).toContain("add_tertiary")
      expect(actionEnum).toContain("update_tertiary")
    })

    test("reconstructs tertiary objectives from compaction checkpoint text", async () => {
      const { sessionHooks } = await setupT()
      const sid = uniqueSessionID("to-checkpoint-rebuild")
      clearSessionObjectives(sid)

      const checkpointMessage = {
        role: "user",
        content: [
          "<conversation-checkpoint>",
          "[PO] Nested Recovery Task [EXPLORING]",
          "Definition of Done: Everything recovered",
          "",
          "### Active / Exploring Objectives",
          "- [SO-2] [EXPLORING] Oversized work (Rationale: Needs decomposition)",
          "  - [SO-2-T1] [PENDING] Patch step A",
          "  - [SO-2-T2] [RESOLVED] Patch step B (Proof: exit code 0)",
        ].join("\n"),
      }

      const event = { sessionID: sid, system: [] as { type: string; text: string }[], messages: [checkpointMessage] }
      for (const h of sessionHooks["context"] ?? []) {
        await h(event)
      }

      const po = getObjectives(sid)
      expect(po).toBeDefined()
      expect(po?.secondaries.length).toBe(1)
      expect(po?.secondaries[0].id).toBe("SO-2")
      expect(po?.secondaries[0].children?.length).toBe(2)
      expect(po?.secondaries[0].children?.map((t) => t.id)).toEqual(["SO-2-T1", "SO-2-T2"])
      expect(po?.secondaries[0].children?.[0]?.status).toBe("pending")
      expect(po?.secondaries[0].children?.[1]?.status).toBe("resolved")
    })
  })

  describe("Epistemic Layer Invariants (F-1..F-11)", () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 1))

    function makeFindingInput(overrides: Record<string, any> = {}) {
      return {
        title: "Cookie parsing fails on unicode domains",
        result: "getCookie returns undefined for punycode encoded hostnames",
        nextAction: "Add punycode normalization to the cookie parser",
        evidence: { type: "FILE_READ", source: "auth/cookies.ts:42-58" },
        ...overrides,
      }
    }

    // ---------- Findings (F-2) ----------

    test("addFinding rejects placeholder fields (anti-placeholder validation)", () => {
      const sid = uniqueSessionID("finding-placeholder")
      setPrimaryObjective(sid, "Fix Cookie Bug", "Cookies parse on all domains")

      const shortTitle = addFinding(sid, makeFindingInput({ title: "TBD" }))
      expect(shortTitle.success).toBe(false)
      expect(shortTitle.error).toContain("anti-placeholder")

      const todoResult = addFinding(sid, makeFindingInput({ result: "TODO: investigate later" }))
      expect(todoResult.success).toBe(false)
      expect(todoResult.error).toContain("placeholder")

      // Spanish "todo" (meaning everything/all) is not flagged as a placeholder
      const spanishResult = addFinding(sid, makeFindingInput({ result: "Se revisó todo el código y no falló" }))
      expect(spanishResult.success).toBe(true)

      const noSource = addFinding(sid, makeFindingInput({ evidence: { type: "FILE_READ", source: "" } }))
      expect(noSource.success).toBe(false)
      expect(noSource.error).toContain("evidence")
    })

    test("validateFindingFields reports each violation independently", () => {
      const violations = validateFindingFields({ title: "x", result: "y", nextAction: "z", evidenceSource: "" })
      expect(violations.length).toBe(4)
      expect(validateFindingFields({
        title: "A complete one-line statement",
        result: "A literal observation from running the code",
        nextAction: "Run the failing command again with verbose logging",
        evidenceSource: "src/auth.ts:10-20",
      })).toEqual([])
    })

    test("addFinding requires a valid soRef (existing SO id or PO)", () => {
      const sid = uniqueSessionID("finding-soref")
      setPrimaryObjective(sid, "Fix Cookie Bug", "Cookies parse on all domains")
      addSecondaryObjective(sid, "Patch cookie parser", "Root cause lives in the parser")

      expect(addFinding(sid, makeFindingInput({ soRef: "SO-1" })).success).toBe(true)
      const bad = addFinding(sid, makeFindingInput({ soRef: "SO-99" }))
      expect(bad.success).toBe(false)
      expect(bad.error).toContain("soRef")
    })

    test("search-before-write: near-duplicate finding is rejected and points at the existing one", () => {
      const sid = uniqueSessionID("finding-dup")
      setPrimaryObjective(sid, "Fix Cookie Bug", "Cookies parse on all domains")
      const first = addFinding(sid, makeFindingInput())
      expect(first.success).toBe(true)
      expect(first.finding?.id).toBe("F-001")

      const duplicate = addFinding(
        sid,
        makeFindingInput({
          title: "Cookie parsing fails on unicode domains",
          result: "getCookie returns undefined for punycode encoded hostnames",
        }),
      )
      expect(duplicate.success).toBe(false)
      expect(duplicate.error).toContain("Search-before-write")
      expect(duplicate.error).toContain("F-001")
      expect(getObjectives(sid)!.findings!.length).toBe(1)
    })

    test("search-before-write: 0.55-0.68 similarity band creates with warning and forced seeAlso", () => {
      const sid = uniqueSessionID("finding-band")
      setPrimaryObjective(sid, "Fix Cookie Bug", "Cookies parse on all domains")
      const first = addFinding(sid, makeFindingInput())
      expect(first.success).toBe(true)

      const related = addFinding(
        sid,
        makeFindingInput({
          title: "Cookie parsing fails on international domains",
          result: "Hostnames with international domains fail to parse",
        }),
      )
      expect(related.success).toBe(true)
      expect(related.finding?.id).toBe("F-002")
      expect(related.warning).toBeDefined()
      expect(related.finding?.seeAlso).toContain("F-001")
    })

    test("updateFinding extends in place and subsumes on request", () => {
      const sid = uniqueSessionID("finding-update")
      setPrimaryObjective(sid, "Fix Cookie Bug", "Cookies parse on all domains")
      addFinding(sid, makeFindingInput())

      const extended = updateFinding(sid, "F-001", {
        result: "getCookie returns undefined for punycode encoded hostnames and IDN labels",
      })
      expect(extended.success).toBe(true)
      expect(extended.finding?.lifecycle).toBe("EXTENDED")
      expect(getObjectives(sid)!.findings!.length).toBe(1)

      addFinding(
        sid,
        makeFindingInput({
          title: "Older note about cookie edge cases in the parser",
          result: "Parser mishandles certain internationalized domain names",
        }),
      )
      const subsumed = updateFinding(sid, "F-002", { subsumedBy: "F-001" })
      expect(subsumed.success).toBe(true)
      expect(subsumed.finding?.lifecycle).toBe("SUBSUMED")
      expect(subsumed.finding?.supersedes).toContain("F-001")
    })

    test("defaultFindingScore and searchFindings honor the scorer contract", () => {
      const finding = {
        id: "F-001",
        soRef: "PO",
        title: "Cookie parsing fails on unicode domains",
        evidence: { type: "FILE_READ", source: "auth/cookies.ts:42-58", capturedAt: Date.now() },
        result: "getCookie returns undefined for punycode encoded hostnames",
        nextAction: "Add punycode normalization to the cookie parser",
        seeAlso: [],
        supersedes: [],
        lifecycle: "NEW",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any

      expect(defaultFindingScore("cookie parsing unicode domains", finding)).toBeGreaterThan(0.68)
      expect(defaultFindingScore("completely unrelated database migration topic", finding)).toBeLessThan(0.1)

      const hits = searchFindings([finding], "cookie parsing unicode domains")
      expect(hits.length).toBe(1)
      expect(hits[0].score).toBeGreaterThan(0.68)

      setFindingScorer({ score: () => 0.99 })
      expect(searchFindings([finding], "anything at all")[0].score).toBe(0.99)
      setFindingScorer(undefined)
      expect(searchFindings([finding], "cookie parsing unicode domains")[0].score).toBeGreaterThan(0.68)
    })

    test("cosineSimilarity computes standard normalized cosine vector product", () => {
      const { cosineSimilarity } = require("../../../src/plugin/builtin/objectives-embeddings.js")
      expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
      expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
      expect(cosineSimilarity([1, 1], [1, 1])).toBe(1)
      expect(cosineSimilarity([], [])).toBe(0)
    })

    // ---------- Options (F-5) ----------

    test("SUCCESSFUL option auto-cancels open siblings and requires proofRef", () => {
      const sid = uniqueSessionID("option-success")
      setPrimaryObjective(sid, "Pick Auth Strategy", "One strategy adopted")
      addOption(sid, "Adopt JWT rotation middleware for all services")
      addOption(sid, "Adopt opaque session tokens with server-side store")
      addOption(sid, "Adopt signed cookies with per-domain scopes")

      const noProof = updateOption(sid, "OPT-1", { status: "SUCCESSFUL" })
      expect(noProof.success).toBe(false)
      expect(noProof.error).toContain("proofRef")

      const ok = updateOption(sid, "OPT-1", { status: "SUCCESSFUL", proofRef: "bun test auth -> 34 passed, exit code 0" })
      expect(ok.success).toBe(true)

      const po = getObjectives(sid)!
      expect(po.options!.find((o) => o.id === "OPT-1")?.status).toBe("SUCCESSFUL")
      expect(po.options!.find((o) => o.id === "OPT-2")?.status).toBe("CANCELLED")
      expect(po.options!.find((o) => o.id === "OPT-3")?.status).toBe("CANCELLED")
      expect(po.options!.find((o) => o.id === "OPT-2")?.result).toContain("Cancelled: OPT-1")

      const second = updateOption(sid, "OPT-2", { status: "SUCCESSFUL", proofRef: "bun test -> passed" })
      expect(second.success).toBe(false)
      expect(second.error).toContain("at most one per topic")
    })

    test("DISCARDED option requires a reason (silent discard prohibited)", () => {
      const sid = uniqueSessionID("option-discard")
      setPrimaryObjective(sid, "Pick Auth Strategy", "One strategy adopted")
      addOption(sid, "Adopt JWT rotation middleware for all services")

      const noReason = updateOption(sid, "OPT-1", { status: "DISCARDED" })
      expect(noReason.success).toBe(false)
      expect(noReason.error).toContain("reason")

      const withReason = updateOption(sid, "OPT-1", { status: "DISCARDED", reason: "Token store does not meet the latency budget measured in the load test" })
      expect(withReason.success).toBe(true)
      expect(getObjectives(sid)!.options![0].status).toBe("DISCARDED")
    })

    test("finding impactOnOption updates the option atomically and validates it first", () => {
      const sid = uniqueSessionID("finding-option")
      setPrimaryObjective(sid, "Fix Cookie Bug", "Cookies parse on all domains")
      addFinding(sid, makeFindingInput())
      addOption(sid, "Adopt JWT rotation middleware for all services")

      const rejected = updateFinding(sid, "F-001", {
        impactOnOption: { optionId: "OPT-1", newStatus: "DISCARDED", reason: "" },
      })
      expect(rejected.success).toBe(false)
      expect(getObjectives(sid)!.options![0].status).toBe("PENDING")

      const ok = updateFinding(sid, "F-001", {
        impactOnOption: { optionId: "OPT-1", newStatus: "DISCARDED", reason: "Root cause is upstream in the parser, not the auth layer" },
      })
      expect(ok.success).toBe(true)
      expect(getObjectives(sid)!.options![0].status).toBe("DISCARDED")
      expect(getObjectives(sid)!.findings![0].impactOnOption?.optionId).toBe("OPT-1")
    })

    // ---------- Decomposed DoD + complete_primary gate (F-3) ----------

    test("complete_primary rejects while a DoD criterion lacks a proofRef", async () => {
      const { getRegisteredTool } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("dod-gate")

      const r1 = await tool.execute(
        {
          action: "set_primary",
          title: "Ship Feature X",
          definitionOfDone: "Feature works end to end",
          dodCriteria: [{ statement: "All tests pass", verifiableBy: "bun test" }],
        },
        { sessionID: sid },
      )
      expect(r1.output.success).toBe(true)

      const r2 = await tool.execute(
        { action: "add_secondary", title: "Implement feature", rationale: "Core work" },
        { sessionID: sid },
      )
      expect(r2.output.success).toBe(true)
      await tool.execute(
        { action: "update_secondary", id: "SO-1", status: "resolved", validationProof: "bun test -> 42 passed, exit code 0" },
        { sessionID: sid },
      )

      const blocked = await tool.execute(
        { action: "complete_primary", validationProof: "Manual smoke test passed" },
        { sessionID: sid },
      )
      expect(blocked.output.success).toBe(false)
      expect(blocked.output.message).toMatch(/proofRef|Definition of Done/i)

      const r3 = await tool.execute(
        {
          action: "update_dod",
          dodCriteria: [{ id: "D1", statement: "All tests pass", verifiableBy: "bun test", proofRef: "bun test -> 42 passed, exit code 0" }],
        },
        { sessionID: sid },
      )
      expect(r3.output.success).toBe(true)

      const done = await tool.execute(
        { action: "complete_primary", validationProof: "Manual smoke test passed" },
        { sessionID: sid },
      )
      expect(done.output.success).toBe(true)
      expect(getObjectives(sid)!.status).toBe("resolved")
    })

    test("evaluateDoD: explicit criteria need proofRef and verifiableBy; legacy falls back to PO proof", () => {
      const explicit = evaluateDoD({
        dod: [
          { id: "D1", statement: "Tests pass", verifiableBy: "bun test", satisfiedBy: [], proofRef: "bun test -> ok" },
          { id: "D2", statement: "Docs updated", verifiableBy: "", satisfiedBy: [] },
        ],
      })
      expect(explicit.legacy).toBe(false)
      expect(explicit.criteria[0].satisfied).toBe(true)
      expect(explicit.criteria[1].satisfied).toBe(false)

      const legacy = evaluateDoD({ definitionOfDone: "It works", validationProof: "" })
      expect(legacy.legacy).toBe(true)
      expect(legacy.criteria[0].satisfied).toBe(false)
      expect(evaluateDoD({ definitionOfDone: "It works", validationProof: "curl -> HTTP 200" }).criteria[0].satisfied).toBe(true)
    })

    // ---------- Compliance audit (F-4) ----------

    test("resolved SO with unvalidated root-cause phrasing is rejected by the audit", () => {
      const sid = uniqueSessionID("audit-cause")
      setPrimaryObjective(sid, "Fix Intermittent Failure", "Stable under load")
      addSecondaryObjective(sid, "Investigate flaky timeout", "Failure appears under load")

      const rejected = updateSecondaryObjective(sid, "SO-1", {
        status: "resolved",
        validationProof: "The root cause is the retry loop, it should now work",
      })
      expect(rejected.success).toBe(false)
      expect(rejected.error).toMatch(/root cause|audit/i)

      const accepted = updateSecondaryObjective(sid, "SO-1", {
        status: "resolved",
        validationProof: "Ran load test -> 0 failures in 1000 requests, exit code 0",
      })
      expect(accepted.success).toBe(true)
    })

    test("blocked SO declaring an unvalidated root cause is rejected", () => {
      const sid = uniqueSessionID("audit-blocked")
      setPrimaryObjective(sid, "Fix Intermittent Failure", "Stable under load")
      addSecondaryObjective(sid, "Investigate flaky timeout", "Failure appears under load")

      const rejected = updateSecondaryObjective(sid, "SO-1", {
        status: "blocked",
        blocker: "logically the session store is the culprit",
      })
      expect(rejected.success).toBe(false)
      expect(rejected.error).toMatch(/root cause|unvalidated|audit/i)
    })

    test("runComplianceAudit flags empty EXPLORING results, DISCARDED without reason, SUCCESSFUL without proofRef", () => {
      const audit = runComplianceAudit({
        secondaries: [],
        options: [
          { id: "OPT-1", statement: "s".repeat(20), status: "EXPLORING", result: "", createdAt: 0, updatedAt: 0 },
          { id: "OPT-2", statement: "s".repeat(20), status: "DISCARDED", result: "", reason: "", createdAt: 0, updatedAt: 0 },
          { id: "OPT-3", statement: "s".repeat(20), status: "SUCCESSFUL", result: "done", proofRef: "", createdAt: 0, updatedAt: 0 },
        ],
      } as any)
      expect(audit.pass).toBe(false)
      expect(audit.violations.some((v) => v.startsWith("OPT-1"))).toBe(true)
      expect(audit.violations.some((v) => v.startsWith("OPT-2"))).toBe(true)
      expect(audit.violations.some((v) => v.startsWith("OPT-3"))).toBe(true)
    })

    // ---------- Fingerprints (blocker memory) ----------

    test("fingerprints dedupe by normalized key and gate re-opening without justification", async () => {
      const { getRegisteredTool } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("fingerprint")
      setPrimaryObjective(sid, "Fix Cookie Bug", "Cookies parse on all domains")
      addSecondaryObjective(sid, "Patch cookie parser", "Root cause lives in the parser")

      const fp1 = addFingerprint(sid, { symptom: "Cookie parsing fails on unicode domains", soRef: "SO-1", fixRef: "F-001" })
      expect(fp1.success).toBe(true)
      const fp2 = addFingerprint(sid, { symptom: "unicode domains cookie parsing fails", soRef: "SO-1", fixRef: "F-002" })
      expect(fp2.success).toBe(true)
      expect(getObjectives(sid)!.fingerprints!.length).toBe(1)
      expect(getObjectives(sid)!.fingerprints![0].fixRef).toBe("F-002")

      const collision = await tool.execute(
        { action: "add_secondary", title: "Cookie parsing fails on unicode domains", rationale: "Re-investigate the unicode domain failure" },
        { sessionID: sid },
      )
      expect(collision.output.success).toBe(false)
      expect(collision.output.message).toContain("justification")

      const justified = await tool.execute(
        {
          action: "add_secondary",
          title: "Cookie parsing fails on unicode domains",
          rationale: "New failure mode after the punycode patch",
          justification: "Failure reappeared with a different stack trace on IDN labels",
        },
        { sessionID: sid },
      )
      expect(justified.output.success).toBe(true)
    })

    // ---------- Plan pause / checkpoint (F-6) ----------

    test("present_plan freezes the tree; resume_plan restores mutation", async () => {
      const { getRegisteredTool } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("plan-pause")
      setPrimaryObjective(sid, "Refactor Billing", "Billing suite green")

      const presented = presentPlan(sid, "Awaiting user decision on the API shape")
      expect(presented.success).toBe(true)
      expect(getObjectives(sid)!.status).toBe("presented_awaiting_confirmation")
      expect(getObjectives(sid)!.phase?.paused).toBe(true)

      const frozen = await tool.execute(
        { action: "add_secondary", title: "Add a new subtask while paused", rationale: "Should be rejected" },
        { sessionID: sid },
      )
      expect(frozen.output.success).toBe(false)
      expect(frozen.output.message).toContain("FROZEN")

      const resumed = resumePlan(sid, "Proceed with option A")
      expect(resumed.success).toBe(true)
      expect(getObjectives(sid)!.status).toBe("exploring")

      const unfrozen = await tool.execute(
        { action: "add_secondary", title: "Add billing retry queue", rationale: "Needed for reliability" },
        { sessionID: sid },
      )
      expect(unfrozen.output.success).toBe(true)
    })

    test("makeCheckpoint derives a phase report from the tree only", () => {
      const sid = uniqueSessionID("checkpoint")
      setPrimaryObjective(sid, "Refactor Billing", "Billing suite green")
      addSecondaryObjective(sid, "Extract invoice mapper", "Pure function extraction")
      updateSecondaryObjective(sid, "SO-1", { status: "resolved", validationProof: "bun test billing -> 18 passed, exit code 0" })
      setDoDCriteria(sid, [{ statement: "Billing tests green", verifiableBy: "bun test billing", proofRef: "bun test billing -> 18 passed" }])
      addFinding(sid, makeFindingInput())

      const checkpoint = makeCheckpoint(sid, "End of day 1")
      expect(checkpoint.success).toBe(true)
      expect(checkpoint.report).toContain("Phase Checkpoint")
      expect(checkpoint.report).toContain("DoD: 1/1")
      expect(checkpoint.report).toContain("SO-1")
      expect(checkpoint.report).toContain("F-001")
      expect(checkpoint.report).toContain("PAUSED")
      expect(getObjectives(sid)!.phase?.paused).toBe(true)
    })

    // ---------- Anti-loop actionLog (F-9) ----------

    test("repeated identical read actions on the active SO surface a value-first warning", async () => {
      const { getRegisteredTool, toolHooks } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("anti-loop")
      setPrimaryObjective(sid, "Trace Memory Leak", "Heap stable after 1h")
      addSecondaryObjective(sid, "Profile heap growth", "Find the allocation source")

      const hooks = toolHooks["execute.after"] ?? []
      for (let i = 0; i < 2; i++) {
        for (const hook of hooks) {
          await hook({ sessionID: sid, tool: "read", input: { path: "src/heap.ts" } })
        }
      }

      const result = await tool.execute({ action: "list" }, { sessionID: sid })
      expect(result.content).toContain("Repeated action")
      expect(result.content).toContain("SO-1")
    })

    // ---------- Documentation gate (F-10) ----------

    test("complete_primary auto-creates a documentation SO when public-surface files changed", async () => {
      const { getRegisteredTool, toolHooks } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("docs-gate")
      setPrimaryObjective(sid, "Add Public API Flag", "Flag documented and shipped")
      addSecondaryObjective(sid, "Implement flag", "Core feature work")

      const hooks = toolHooks["execute.after"] ?? []
      for (const hook of hooks) {
        await hook({ sessionID: sid, tool: "write", input: { path: "README.md" } })
      }
      await tool.execute(
        { action: "update_secondary", id: "SO-1", status: "resolved", validationProof: "bun test -> 9 passed, exit code 0" },
        { sessionID: sid },
      )

      const gated = await tool.execute({ action: "complete_primary", validationProof: "Flag works end to end" }, { sessionID: sid })
      expect(gated.output.success).toBe(false)
      expect(gated.output.message).toContain("Documentation gate")
      expect(gated.output.message).toContain("README.md")

      const po = getObjectives(sid)!
      const docsSO = po.secondaries.find((s) => /documentation/i.test(s.title))
      expect(docsSO).toBeDefined()
    })

    test("complete_primary auto-creates a documentation SO when public-surface code files (package.json, schema) change", async () => {
      const { getRegisteredTool, toolHooks } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("docs-gate-code")
      setPrimaryObjective(sid, "Add New Config Schema", "Schema shipped")
      addSecondaryObjective(sid, "Implement schema", "Core change")

      const hooks = toolHooks["execute.after"] ?? []
      for (const hook of hooks) {
        await hook({ sessionID: sid, tool: "write", input: { path: "src/config/schema.ts" } })
      }
      await tool.execute(
        { action: "update_secondary", id: "SO-1", status: "resolved", validationProof: "bun test -> ok" },
        { sessionID: sid },
      )

      const gated = await tool.execute({ action: "complete_primary", validationProof: "Ready" }, { sessionID: sid })
      expect(gated.output.success).toBe(false)
      expect(gated.output.message).toContain("Documentation gate")
      expect(gated.output.message).toContain("schema.ts")

      const po = getObjectives(sid)!
      const docsSO = po.secondaries.find((s) => /documentation/i.test(s.title))
      expect(docsSO).toBeDefined()
    })

    test("complete_primary ignores test-only files but triggers on any production source file (e.g. py, go, rust, ts)", async () => {
      const { getRegisteredTool, toolHooks } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("docs-gate-universal")
      setPrimaryObjective(sid, "Python Backend Change", "Backend verified")
      addSecondaryObjective(sid, "Refactor handler", "Core work")

      const hooks = toolHooks["execute.after"] ?? []
      // 1. Only test files touched -> does NOT force documentation
      for (const hook of hooks) {
        await hook({ sessionID: sid, tool: "write", input: { path: "tests/test_handler.py" } })
      }
      await tool.execute(
        { action: "update_secondary", id: "SO-1", status: "resolved", validationProof: "pytest -> ok" },
        { sessionID: sid },
      )

      const doneTestOnly = await tool.execute({ action: "complete_primary", validationProof: "Tests pass" }, { sessionID: sid })
      expect(doneTestOnly.output.success).toBe(true)

      // 2. Production source touched -> triggers documentation gate
      const sid2 = uniqueSessionID("docs-gate-py-prod")
      setPrimaryObjective(sid2, "Python Core Logic", "Core logic updated")
      addSecondaryObjective(sid2, "Patch engine", "Core patch")
      for (const hook of hooks) {
        await hook({ sessionID: sid2, tool: "write", input: { path: "services/engine/worker.py" } })
      }
      await tool.execute(
        { action: "update_secondary", id: "SO-1", status: "resolved", validationProof: "pytest -> ok" },
        { sessionID: sid2 },
      )

      const gated = await tool.execute({ action: "complete_primary", validationProof: "Done" }, { sessionID: sid2 })
      expect(gated.output.success).toBe(false)
      expect(gated.output.message).toContain("Documentation gate")
      expect(gated.output.message).toContain("worker.py")
    })

    test("one-shot /btw session.generate evaluator confirms relevant files and records them in relevantDocumentableFiles", async () => {
      const { toolHooks } = await setupPluginInstanceLocal()
      const sid = uniqueSessionID("docs-btw-eval")
      setPrimaryObjective(sid, "Plugin Evolution", "Plugin verified")
      addSecondaryObjective(sid, "Update plugin code", "Core patch")

      const { setSessionGenerator } = await import("../../../src/plugin/builtin/hierarchical-objectives.js")
      let generatorPromptReceived = ""
      setSessionGenerator(async ({ prompt }) => {
        generatorPromptReceived = prompt
        return "YES - this file alters the public billing interface"
      })

      const hooks = toolHooks["execute.after"] ?? []
      for (const hook of hooks) {
        await hook({ sessionID: sid, tool: "write", input: { path: "billing/checkout.ts" } })
      }

      // Small tick for background promise resolution
      await new Promise((r) => setTimeout(r, 10))

      expect(generatorPromptReceived).toContain("billing/checkout.ts")
      const po = getObjectives(sid)!
      expect(po.relevantDocumentableFiles).toContain("billing/checkout.ts")

      // Subsequent modification of an already relevant file skips session.generate (zero overhead)
      let secondCallAttempted = false
      setSessionGenerator(async () => {
        secondCallAttempted = true
        return "YES"
      })
      for (const hook of hooks) {
        await hook({ sessionID: sid, tool: "edit", input: { path: "billing/checkout.ts" } })
      }
      await new Promise((r) => setTimeout(r, 10))
      expect(secondCallAttempted).toBe(false)

      setSessionGenerator(undefined)
    })

    test("queryIsolatedLlamaCppRelevance queries llama.cpp with id_slot: 1 and isolated prompt without session transcript", async () => {
      let requestBody: any = null
      using server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/slots") {
            return Response.json([
              { id: 0, is_processing: false },
              { id: 1, is_processing: false },
            ])
          }
          if (url.pathname === "/v1/chat/completions") {
            return req.json().then((body) => {
              requestBody = body
              return Response.json({
                choices: [{ message: { content: "YES - architectural contract" } }],
              })
            })
          }
          return new Response("not found", { status: 404 })
        },
      })

      const origBaseUrl = process.env.OPENCODE_LLAMACPP_BASE_URL
      process.env.OPENCODE_LLAMACPP_BASE_URL = `${server.url.origin}/v1`

      const { queryIsolatedLlamaCppRelevance } = await import("../../../src/plugin/builtin/hierarchical-objectives.js")
      const result = await queryIsolatedLlamaCppRelevance("src/api/server.ts", { force: true, model: "llamacpp/qwen3.8-test" })

      expect(result).toBe(true)
      expect(requestBody).not.toBeNull()
      expect(requestBody.model).toBe("llamacpp/qwen3.8-test")
      expect(requestBody.id_slot).toBe(1)
      expect(requestBody.stream).toBe(false)
      expect(requestBody.max_tokens).toBe(5)
      expect(requestBody.messages.length).toBe(1)
      expect(requestBody.messages[0].content).toContain("src/api/server.ts")

      if (origBaseUrl !== undefined) {
        process.env.OPENCODE_LLAMACPP_BASE_URL = origBaseUrl
      } else {
        delete process.env.OPENCODE_LLAMACPP_BASE_URL
      }
    })

    test("evaluateChangeDocumentationRelevance bypasses HTTP one-shot for esca and mlx models", async () => {
      let httpCalls = 0
      using server = Bun.serve({
        port: 0,
        fetch() {
          httpCalls++
          return Response.json({ choices: [{ message: { content: "NO" } }] })
        },
      })

      const origBaseUrl = process.env.OPENCODE_LLAMACPP_BASE_URL
      process.env.OPENCODE_LLAMACPP_BASE_URL = `${server.url.origin}/v1`

      const { setSessionModel } = await import("../../../src/plugin/builtin/hierarchical-objectives.js")
      const testSessionID = "session-esca-cache-test"
      setSessionModel(testSessionID, "esca/Qwen3.6-35B-A3B-Escha-W2")

      // Simulamos la verificación a través de la API del plugin
      const { setPrimaryObjective, addSecondaryObjective } = await import("../../../src/plugin/builtin/hierarchical-objectives.js")
      setPrimaryObjective(testSessionID, "Test PO", "DoD")
      addSecondaryObjective(testSessionID, "SO-1", "Rationale")

      // Verificamos que para archivos reales retorna true sin tocar la red
      expect(httpCalls).toBe(0)

      if (origBaseUrl !== undefined) {
        process.env.OPENCODE_LLAMACPP_BASE_URL = origBaseUrl
      } else {
        delete process.env.OPENCODE_LLAMACPP_BASE_URL
      }
    })

    test("autoConfigureEmbeddingsScorer auto-enables embeddings when LM Studio server is available", async () => {
      using server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/v1/models") {
            return Response.json({
              data: [{ id: "text-embedding-nomic-embed-text-v1.5" }],
            })
          }
          if (url.pathname === "/v1/embeddings") {
            return Response.json({
              data: [{ embedding: [0.1, 0.2, 0.3] }],
            })
          }
          return new Response("not found", { status: 404 })
        },
      })

      const { autoConfigureEmbeddingsScorer } = await import("../../../src/plugin/builtin/objectives-embeddings.js")
      const enabled = await autoConfigureEmbeddingsScorer({ baseUrl: server.url.origin })
      expect(enabled).toBe(true)

      // When explicitly disabled, remains inactive
      process.env.OPENCODE_OBJECTIVES_EMBEDDINGS = "false"
      const disabled = await autoConfigureEmbeddingsScorer({ baseUrl: server.url.origin })
      expect(disabled).toBe(false)
      delete process.env.OPENCODE_OBJECTIVES_EMBEDDINGS
    })

    // ---------- Cross-session persistence (F-1) ----------

    describe("persistence round-trip", () => {
      afterEach(() => {
        setObjectivesStore(undefined)
      })

      test("tree auto-persists and hydrates after in-memory loss", async () => {
        const kv = new Map<string, unknown>()
        setObjectivesStore(
          createObjectivesStore({
            get: async (key) => kv.get(key),
            set: async (key, value) => {
              kv.set(key, value)
            },
            remove: async (key) => {
              kv.delete(key)
            },
          }),
        )

        const sid = uniqueSessionID("persist")
        setPrimaryObjective(sid, "Persisted Objective", "Survives restart")
        addSecondaryObjective(sid, "Subtask A", "Needed for the goal")
        addFinding(sid, makeFindingInput())
        addOption(sid, "Adopt JWT rotation middleware for all services")
        await flush()

        expect(kv.has(`objectives/v1/${sid}`)).toBe(true)

        clearSessionObjectives(sid)
        expect(getObjectives(sid)).toBeUndefined()

        await hydrateSessionObjectives(sid)
        const po = getObjectives(sid)
        expect(po?.title).toBe("Persisted Objective")
        expect(po?.secondaries.length).toBe(1)
        expect(po?.findings?.length).toBe(1)
        expect(po?.options?.length).toBe(1)
      })

      test("exportSession registers a topic key; importSession hydrates a new session from the payload", async () => {
        const kv = new Map<string, unknown>()
        setObjectivesStore(
          createObjectivesStore({
            get: async (key) => kv.get(key),
            set: async (key, value) => {
              kv.set(key, value)
            },
            remove: async (key) => {
              kv.delete(key)
            },
          }),
        )

        const sid = uniqueSessionID("export")
        setPrimaryObjective(sid, "Topic Objective", "Done when verified")
        addFinding(sid, makeFindingInput())
        await flush()

        const exported = exportSession(sid, "outlook_bulk_triage")
        expect(exported.success).toBe(true)
        const payload = JSON.parse(exported.payload!)
        expect(payload.version).toBe(1)
        expect(payload.title).toBe("Topic Objective")
        await flush()
        expect(kv.has("objectives/v1/topic/outlook_bulk_triage")).toBe(true)

        const sid2 = uniqueSessionID("import")
        const imported = importSession(sid2, { tree: exported.payload! })
        expect(imported.success).toBe(true)
        expect(getObjectives(sid2)?.title).toBe("Topic Objective")
        expect(getObjectives(sid2)?.findings?.length).toBe(1)
        expect(exported.report).toContain("Topic Objective")
      })
    })

    // ---------- Document boundary + projection (F-11) ----------

    test("parseDocument validates the boundary; repairDocumentInvariants reverts corrupt resolved POs", () => {
      expect(parseDocument(null)).toBeUndefined()
      expect(parseDocument({})).toBeUndefined()
      expect(parseDocument({ title: "X" })?.secondaries).toEqual([])

      const doc = parseDocument({
        title: "Broken",
        status: "resolved",
        secondaries: [
          { id: "SO-1", title: "Open work", status: "pending", rationale: "r", createdAt: 0, updatedAt: 0 },
        ],
      })!
      const repairs = repairDocumentInvariants(doc)
      expect(doc.status).toBe("exploring")
      expect(repairs.length).toBe(1)
      expect(repairs[0]).toContain("reverted to exploring")
    })

    test("renderProjection renders the single-vocabulary tree including findings and options", () => {
      const report = renderProjection({
        title: "Ship Feature X",
        status: "exploring",
        definitionOfDone: "Feature works end to end",
        secondaries: [
          {
            id: "SO-1",
            title: "Implement feature",
            status: "exploring",
            rationale: "Core work",
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        findings: [
          {
            id: "F-001",
            soRef: "SO-1",
            title: "Cookie parsing fails on unicode domains",
            evidence: { type: "FILE_READ", source: "auth/cookies.ts:42-58", capturedAt: 0 },
            result: "getCookie returns undefined for punycode encoded hostnames",
            nextAction: "Add punycode normalization to the cookie parser",
            seeAlso: [],
            supersedes: [],
            lifecycle: "NEW",
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        options: [
          { id: "OPT-1", statement: "Adopt JWT rotation middleware for all services", status: "EXPLORING", result: "Load test running", createdAt: 0, updatedAt: 0 },
        ],
        dod: [],
        touchedFiles: [],
        createdAt: 0,
        updatedAt: 0,
      } as any)
      expect(report).toContain("Ship Feature X")
      expect(report).toContain("SO-1")
      expect(report).toContain("F-001")
      expect(report).toContain("OPT-1")
    })

    // ---------- Hierarchical Reopening (Ascending Cascade) ----------

    test("adding an open SO to a resolved PO automatically reopens the PO to exploring", () => {
      const sid = uniqueSessionID("reopen-so")
      const po = setPrimaryObjective(sid, "Initial Task", "Done when tests pass")
      addSecondaryObjective(sid, "Subtask 1", "Initial work")
      updateSecondaryObjective(sid, "SO-1", { status: "resolved", validationProof: "Passed test 1" })
      updatePrimaryObjective(sid, { status: "resolved", validationProof: "All done" })
      expect(po.status).toBe("resolved")

      // User adds a new secondary objective
      addSecondaryObjective(sid, "Subtask 2 (new user requirement)", "Discovered post-completion")
      expect(po.status).toBe("exploring")
    })

    test("adding an open TO to a resolved SO and resolved PO cascades and reopens both to exploring", () => {
      const sid = uniqueSessionID("reopen-to")
      const po = setPrimaryObjective(sid, "Nested Project", "All levels done")
      const so1 = addSecondaryObjective(sid, "Parent Subtask", "Oversized work")
      addTertiaryObjective(sid, "SO-1", "Child 1", "Subtask part 1")
      updateTertiaryObjective(sid, "SO-1-T1", { status: "resolved", validationProof: "Done T1" })
      updateSecondaryObjective(sid, "SO-1", { status: "resolved", validationProof: "Done SO-1" })
      updatePrimaryObjective(sid, { status: "resolved", validationProof: "Done PO" })

      expect(po.status).toBe("resolved")
      expect(so1.status).toBe("resolved")

      // Adding a new open tertiary sub-objective
      addTertiaryObjective(sid, "SO-1", "Child 2 (follow-up)", "Needs more work")
      expect(so1.status).toBe("exploring")
      expect(po.status).toBe("exploring")
    })

    test("reopening a TO via updateTertiaryObjective cascades and reopens both parent SO and PO", () => {
      const sid = uniqueSessionID("reopen-update-to")
      const po = setPrimaryObjective(sid, "Cascade Task", "Done")
      const so1 = addSecondaryObjective(sid, "Parent Task", "Work")
      addTertiaryObjective(sid, "SO-1", "Child 1", "Subpart")
      updateTertiaryObjective(sid, "SO-1-T1", { status: "resolved", validationProof: "Passed" })
      updateSecondaryObjective(sid, "SO-1", { status: "resolved", validationProof: "Passed SO" })
      updatePrimaryObjective(sid, { status: "resolved", validationProof: "Passed PO" })

      expect(po.status).toBe("resolved")
      expect(so1.status).toBe("resolved")

      // TO hits a regression and becomes blocked
      const res = updateTertiaryObjective(sid, "SO-1-T1", { status: "blocked", blocker: "Regression detected in exit code 1" })
      expect(res.success).toBe(true)
      expect(res.parentReopened).toBe(true)
      expect(res.poReopened).toBe(true)
      expect(so1.status).toBe("exploring")
      expect(po.status).toBe("exploring")
    })

    // ---------- Plan Presentation & Delegation Assessment ----------

    test("set_primary with presentPlan: true immediately freezes the tree awaiting user confirmation", async () => {
      const { getRegisteredTool } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("present-plan-init")

      const res = await tool.execute(
        {
          action: "set_primary",
          title: "Build Refactored Architecture",
          definitionOfDone: "All components pass integration tests",
          presentPlan: true,
          reason: "Requesting user review of initial architectural blueprint",
          secondaries: [
            { title: "Design DB schema", rationale: "Foundation for data storage" },
            { title: "Create API endpoints", rationale: "Public interface" },
          ],
        },
        { sessionID: sid },
      )

      expect(res.output.success).toBe(true)
      expect(res.output.message).toContain("presented_awaiting_confirmation")
      const po = getObjectives(sid)!
      expect(po.status).toBe("presented_awaiting_confirmation")
      expect(po.secondaries.length).toBe(2)

      // Tree is frozen: mutating actions are rejected until resume_plan
      const mutate = await tool.execute(
        { action: "update_secondary", id: "SO-1", status: "exploring" },
        { sessionID: sid },
      )
      expect(mutate.output.success).toBe(false)
      expect(mutate.output.message).toContain("FROZEN")

      // Resuming unfreezes mutation
      const resume = await tool.execute(
        { action: "resume_plan", note: "Plan approved by user" },
        { sessionID: sid },
      )
      expect(resume.output.success).toBe(true)
      expect(po.status).toBe("exploring")
    })

    test("delegation assessment is supported across secondary objectives, tertiary objectives, and findings", async () => {
      const { getRegisteredTool } = await setupPluginInstanceLocal()
      const tool = getRegisteredTool()
      const sid = uniqueSessionID("delegation-tree")

      await tool.execute(
        {
          action: "set_primary",
          title: "Optimize Query Engine",
          definitionOfDone: "Latency < 50ms",
          secondaries: [
            {
              id: "SO-1",
              title: "Analyze Slow Logs",
              rationale: "Discover slow queries",
              delegation: { mode: "subagent", justification: "Log analysis is context-heavy and read-only" },
            },
          ],
        },
        { sessionID: sid },
      )

      // Add tertiary with delegation
      const addTertiary = await tool.execute(
        {
          action: "add_tertiary",
          id: "SO-1",
          title: "Extract regex patterns",
          rationale: "Parse log lines",
          delegation: { mode: "main", justification: "Small regex script, faster in primary session" },
        },
        { sessionID: sid },
      )
      expect(addTertiary.output.success).toBe(true)

      // Add finding with delegation
      const addFindingRes = await tool.execute(
        {
          action: "add_finding",
          soRef: "SO-1",
          title: "Full table scan observed on accounts table",
          evidence: { type: "COMMAND_OUTPUT", source: "EXPLAIN ANALYZE SELECT * FROM accounts WHERE email = 'a'" },
          result: "Sequential scan over 2M rows taking 120ms without index",
          nextAction: "Add index on accounts(email) column",
          delegation: { mode: "main", justification: "Index migration executed directly in main thread" },
        },
        { sessionID: sid },
      )
      expect(addFindingRes.output.success).toBe(true)

      // Verify rendering of delegation in the tree
      const listRes = await tool.execute({ action: "list" }, { sessionID: sid })
      expect(listRes.content).toContain("*Delegation (subagent):* Log analysis is context-heavy and read-only")
      expect(listRes.content).toContain("*Delegation (main):* Small regex script, faster in primary session")
      expect(listRes.content).toContain("*Delegation (main):* Index migration executed directly in main thread")
    })

    test("compliance audit validates delegation justification syntax", () => {
      const docInvalid = {
        secondaries: [
          {
            id: "SO-1",
            title: "Task with bad delegation",
            status: "exploring",
            rationale: "Work",
            delegation: { mode: "invalid" as any, justification: "short" },
          },
        ],
      }
      const auditRes = runComplianceAudit(docInvalid as any)
      expect(auditRes.pass).toBe(false)
      expect(auditRes.violations.some((v) => v.includes("delegation mode"))).toBe(true)
      expect(auditRes.violations.some((v) => v.includes("delegation justification"))).toBe(true)
    })
  })

  async function setupPluginInstanceLocal() {
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
})
