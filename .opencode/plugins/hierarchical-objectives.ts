import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

export type SecondaryObjectiveStatus =
  | "pending"
  | "exploring"
  | "blocked"
  | "resolved"
  | "discarded"
  | "cancelled"

export type PrimaryObjectiveStatus = "pending" | "exploring" | "resolved"

export interface SecondaryObjective {
  id: string // "SO-1", "SO-2", etc.
  title: string
  status: SecondaryObjectiveStatus
  rationale: string // Why this SO is necessary to advance or unblock the PO
  blocker?: string // Concrete symptom, obstacle, or root cause if blocked
  validationProof?: string // Verifiable test output, exit code, or command evidence
  createdAt: number
  updatedAt: number
}

export interface PrimaryObjective {
  title: string
  status: PrimaryObjectiveStatus
  definitionOfDone: string // Acceptance criteria
  secondaries: SecondaryObjective[]
  createdAt: number
  updatedAt: number
}

// In-memory objective state per session (attached to globalThis for TUI sidebar access)
declare global {
  var __OPENCODE_OBJECTIVES__: Map<string, PrimaryObjective> | undefined
}
export const sessionObjectives: Map<string, PrimaryObjective> =
  globalThis.__OPENCODE_OBJECTIVES__ ?? new Map<string, PrimaryObjective>()
globalThis.__OPENCODE_OBJECTIVES__ = sessionObjectives

// Inspection tracking for anti-loop protocol per session
export const consecutiveReadCounts = new Map<string, number>()
export const antiLoopWarnings = new Map<string, string>()

export const READONLY_TOOLS = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "question",
])

export const MAX_CONSECUTIVE_READS = 5

export function clearSessionObjectives(sessionID: string) {
  sessionObjectives.delete(sessionID)
  consecutiveReadCounts.delete(sessionID)
  antiLoopWarnings.delete(sessionID)
}

export function getObjectives(sessionID: string): PrimaryObjective | undefined {
  return sessionObjectives.get(sessionID)
}

export function setPrimaryObjective(
  sessionID: string,
  title: string,
  definitionOfDone: string,
): PrimaryObjective {
  const existing = sessionObjectives.get(sessionID)
  const now = Date.now()
  const po: PrimaryObjective = {
    title: title.trim(),
    status: existing?.status ?? "exploring",
    definitionOfDone: definitionOfDone.trim(),
    secondaries: existing?.secondaries ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  sessionObjectives.set(sessionID, po)
  return po
}

export function addSecondaryObjective(
  sessionID: string,
  title: string,
  rationale: string,
): SecondaryObjective {
  let po = sessionObjectives.get(sessionID)
  const now = Date.now()
  if (!po) {
    po = {
      title: "Main Task Investigation",
      status: "exploring",
      definitionOfDone: "Resolve all blockers and verify requirements.",
      secondaries: [],
      createdAt: now,
      updatedAt: now,
    }
    sessionObjectives.set(sessionID, po)
  }

  const nextIndex = po.secondaries.length + 1
  const id = `SO-${nextIndex}`
  const so: SecondaryObjective = {
    id,
    title: title.trim(),
    status: "pending",
    rationale: rationale.trim(),
    createdAt: now,
    updatedAt: now,
  }
  po.secondaries.push(so)
  po.updatedAt = now
  return so
}

export function updateSecondaryObjective(
  sessionID: string,
  id: string,
  updates: {
    status?: SecondaryObjectiveStatus
    title?: string
    rationale?: string
    blocker?: string
    validationProof?: string
  },
): { success: boolean; error?: string; objective?: SecondaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }

  const target = po.secondaries.find((s) => s.id.toLowerCase() === id.trim().toLowerCase())
  if (!target) {
    return { success: false, error: `Secondary objective ${id} not found.` }
  }

  // Strict Done-means-Done Rule: validation proof is mandatory for "resolved"
  if (updates.status === "resolved") {
    const proof = updates.validationProof?.trim() || target.validationProof?.trim()
    if (!proof) {
      return {
        success: false,
        error: `Cannot mark ${id} as resolved without concrete validation proof. Deduction alone is a hypothesis, not proof. Run the test/command and attach the observed output.`,
      }
    }
    target.validationProof = proof
  }

  if (updates.status !== undefined) target.status = updates.status
  if (updates.title !== undefined) target.title = updates.title.trim()
  if (updates.rationale !== undefined) target.rationale = updates.rationale.trim()
  if (updates.blocker !== undefined) target.blocker = updates.blocker.trim()
  if (updates.validationProof !== undefined && updates.status !== "resolved") {
    target.validationProof = updates.validationProof.trim()
  }

  const now = Date.now()
  target.updatedAt = now
  po.updatedAt = now

  // Check if all secondaries are completed/discarded to evaluate PO
  const allResolvedOrDiscarded =
    po.secondaries.length > 0 &&
    po.secondaries.every((s) => s.status === "resolved" || s.status === "discarded" || s.status === "cancelled")

  if (allResolvedOrDiscarded && po.status === "exploring") {
    // Keep po exploring unless explicitly marked resolved or confirmed
  }

  return { success: true, objective: target }
}

export function renderObjectiveTree(po: PrimaryObjective): string {
  const lines: string[] = [
    `### Active Objective Tree (Methodology Enforced)`,
    `**Primary Objective [${po.status.toUpperCase()}]:** ${po.title}`,
    `**Definition of Done:** ${po.definitionOfDone}`,
    ``,
    `**Secondary Objectives:**`,
  ]

  if (po.secondaries.length === 0) {
    lines.push(`*(No secondary objectives defined yet. Define sub-objectives as tasks/blockers are discovered.)*`)
  } else {
    for (const so of po.secondaries) {
      const statusBadge = `[${so.status.toUpperCase()}]`
      lines.push(`- **${so.id}** ${statusBadge} ${so.title}`)
      lines.push(`  - *Rationale:* ${so.rationale}`)
      if (so.blocker) {
        lines.push(`  - ⚠️ *Blocker:* ${so.blocker}`)
      }
      if (so.validationProof) {
        lines.push(`  - ✅ *Validation Proof:* ${so.validationProof}`)
      }
    }
  }

  return lines.join("\n")
}

// Tool Input Schema using Effect Schema
const ObjectiveActionSchema = Schema.Literal("set_primary", "add_secondary", "update_secondary", "list")
const SecondaryStatusSchema = Schema.Literal(
  "pending",
  "exploring",
  "blocked",
  "resolved",
  "discarded",
  "cancelled",
)

export const ObjectiveInputSchema = Schema.Struct({
  action: ObjectiveActionSchema,
  title: Schema.optional(Schema.String),
  definitionOfDone: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  status: Schema.optional(SecondaryStatusSchema),
  rationale: Schema.optional(Schema.String),
  blocker: Schema.optional(Schema.String),
  validationProof: Schema.optional(Schema.String),
})

export const ObjectiveOutputSchema = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
  tree: Schema.String,
})

export const HierarchicalObjectivesPlugin: Plugin = Plugin.define({
  id: "hierarchical-objectives",
  async setup(ctx) {
    // 1. Register the objective_manage tool via transform
    if (typeof ctx.tool?.transform === "function") {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "objective_manage",
          options: { codemode: false },
          description:
            "Manage the hierarchical objective tree: define the Primary Objective, register Secondary Objectives (SO-N) with rationale, record blockers, and attach concrete validation proof before resolving.",
          input: ObjectiveInputSchema,
          output: ObjectiveOutputSchema,
          execute: async (input: any, toolCtx: any) => {
            const sessionID = (toolCtx as any)?.sessionID || "default-session"
            const action = input.action

            if (action === "set_primary") {
              const title = input.title?.trim()
              const dod = input.definitionOfDone?.trim()
              if (!title || !dod) {
                return {
                  output: {
                    success: false,
                    message: "Both 'title' and 'definitionOfDone' are required for action 'set_primary'.",
                    tree: "",
                  },
                  content: "Missing required parameters for set_primary.",
                }
              }
              const po = setPrimaryObjective(sessionID, title, dod)
              const tree = renderObjectiveTree(po)
              return {
                output: { success: true, message: `Primary Objective established.`, tree },
                content: tree,
              }
            }

            if (action === "add_secondary") {
              const title = input.title?.trim()
              const rationale = input.rationale?.trim()
              if (!title || !rationale) {
                return {
                  output: {
                    success: false,
                    message: "Both 'title' and 'rationale' are required for action 'add_secondary'.",
                    tree: "",
                  },
                  content: "Missing required parameters for add_secondary.",
                }
              }
              const so = addSecondaryObjective(sessionID, title, rationale)
              const po = sessionObjectives.get(sessionID)!
              const tree = renderObjectiveTree(po)
              return {
                output: { success: true, message: `Added secondary objective ${so.id}.`, tree },
                content: tree,
              }
            }

            if (action === "update_secondary") {
              const id = input.id?.trim()
              if (!id) {
                return {
                  output: {
                    success: false,
                    message: "'id' is required for action 'update_secondary'.",
                    tree: "",
                  },
                  content: "Missing id for update_secondary.",
                }
              }
              const result = updateSecondaryObjective(sessionID, id, {
                status: input.status,
                title: input.title,
                rationale: input.rationale,
                blocker: input.blocker,
                validationProof: input.validationProof,
              })

              const po = sessionObjectives.get(sessionID)
              const tree = po ? renderObjectiveTree(po) : ""

              if (!result.success) {
                return {
                  output: { success: false, message: result.error || "Update failed.", tree },
                  content: `Error updating ${id}: ${result.error}`,
                }
              }

              return {
                output: {
                  success: true,
                  message: `Secondary objective ${id} updated to status '${result.objective?.status}'.`,
                  tree,
                },
                content: tree,
              }
            }

            // Default: list
            const po = sessionObjectives.get(sessionID)
            const tree = po
              ? renderObjectiveTree(po)
              : "No objective tree defined yet. Call objective_manage with action 'set_primary' first."
            return {
              output: { success: true, message: "Objective tree retrieved.", tree },
              content: tree,
            }
          },
        })
      })
    }

    // 2. Compaction Hook: Preserve the Objective Tree across compaction
    await ctx.session.hook("compaction", async (event) => {
      const sessionID = event.sessionID
      if (!sessionID) return

      let po = sessionObjectives.get(sessionID)

      // Backward compatibility: If no objective tree exists, check if legacy todos exist
      if (!po) {
        const todos = await (ctx.session as any).todo?.({ sessionID }).catch(() => [])
        if (Array.isArray(todos) && todos.length > 0) {
          po = setPrimaryObjective(
            sessionID,
            "Primary Task Session",
            "Complete all open tasks and verify requirements.",
          )
          for (const t of todos) {
            const content = typeof t?.content === "string" ? t.content.trim() : "Task item"
            const status = t?.status === "completed" ? "resolved" : "pending"
            const so = addSecondaryObjective(sessionID, content, "Imported from session task list")
            if (status === "resolved") {
              so.status = "resolved"
              so.validationProof = "Completed in prior session step"
            }
          }
        }
      }

      if (!po) return

      const tree = renderObjectiveTree(po)
      event.system.push({
        type: "text",
        text: [
          "## Mandatory Objective Snapshot (Compacted History)",
          "You MUST preserve this Objective Tree across compaction.",
          "Do NOT restart completed objectives or re-investigate resolved findings.",
          "Keep your next action strictly aligned with active exploring or pending Secondary Objectives.",
          "",
          tree,
        ].join("\n"),
      })
    })

    // 3. Context Hook: Inject Active Objectives and Alignment Enforcer
    await ctx.session.hook("context", async (event) => {
      const sessionID = event.sessionID
      if (!sessionID) return

      let po = sessionObjectives.get(sessionID)

      // Backward compatibility check
      if (!po) {
        const todos = await (ctx.session as any).todo?.({ sessionID }).catch(() => [])
        if (Array.isArray(todos) && todos.length > 0) {
          po = setPrimaryObjective(
            sessionID,
            "Primary Task Session",
            "Complete all open tasks and verify requirements.",
          )
          for (const t of todos) {
            const content = typeof t?.content === "string" ? t.content.trim() : "Task item"
            const status = t?.status === "completed" ? "resolved" : "pending"
            const so = addSecondaryObjective(sessionID, content, "Imported from session task list")
            if (status === "resolved") {
              so.status = "resolved"
              so.validationProof = "Completed in prior session step"
            }
          }
        }
      }

      const reminders: string[] = []

      // Anti-loop reminder if triggered
      const warning = antiLoopWarnings.get(sessionID)
      if (warning) {
        reminders.push(warning)
        antiLoopWarnings.delete(sessionID)
      }

      if (po) {
        const tree = renderObjectiveTree(po)
        const activeSO = po.secondaries.find((s) => s.status === "exploring" || s.status === "pending")

        reminders.push(
          [
            "## Mandatory Agent Objective Alignment",
            "Every step you take must serve an active objective in the tree below.",
            "NEVER declare an objective resolved based on deduction or reasoning alone.",
            "Run actual commands and verify output before concluding any step.",
            activeSO
              ? `🎯 **Current Target:** Work on ${activeSO.id}: "${activeSO.title}". Focus your immediate tool call on advancing this objective.`
              : "All current secondary objectives are resolved or discarded. If the Primary Objective is satisfied, conclude with evidence. Otherwise, define the next SO.",
            "",
            tree,
          ].join("\n"),
        )
      } else {
        reminders.push(
          [
            "## Methodological Instruction: Establish Objectives",
            "Before commencing deep investigation or modifications, identify and define:",
            "1. The **Primary Objective** and its concrete **Definition of Done**.",
            "2. The initial **Secondary Objectives (SO-N)** with the **Rationale** of why each is needed.",
            "Use the `objective_manage` tool to register them.",
          ].join("\n"),
        )
      }

      event.system.push({
        type: "text",
        text: reminders.join("\n\n"),
      })
    })

    // 4. Tool Execution Hooks: Anti-Loop & Evidence Capture
    await ctx.tool.hook("execute.before", (event) => {
      const sessionID = event.sessionID
      if (!sessionID) return

      if (READONLY_TOOLS.has(event.tool)) {
        const currentCount = (consecutiveReadCounts.get(sessionID) ?? 0) + 1
        consecutiveReadCounts.set(sessionID, currentCount)

        if (currentCount >= MAX_CONSECUTIVE_READS) {
          antiLoopWarnings.set(
            sessionID,
            `⚠️ **Anti-Loop Warning**: You have executed ${currentCount} consecutive inspection/read-only operations without taking action or updating objectives. Synthesize your findings and focus your next step on concrete validation or execution.`,
          )
        }
      } else {
        // Reset consecutive read count upon executing a modifying or action tool
        consecutiveReadCounts.delete(sessionID)
      }
    })

    await ctx.tool.hook("execute.after", async (event) => {
      const sessionID = event.sessionID
      if (!sessionID) return

      // Compatibility: If legacy todowrite tool is called, sync with secondary objectives
      if (event.tool === "todowrite") {
        const input = event.input as any
        const todos = Array.isArray(input?.todos) ? input.todos : []
        let po = sessionObjectives.get(sessionID)
        if (!po) {
          po = setPrimaryObjective(
            sessionID,
            "Primary Task Session",
            "Complete all open tasks and verify requirements.",
          )
        }

        for (const t of todos) {
          const content = typeof t?.content === "string" ? t.content.trim() : ""
          if (!content) continue
          const existingSO = po.secondaries.find(
            (s) => s.title.toLowerCase() === content.toLowerCase(),
          )
          if (!existingSO) {
            const so = addSecondaryObjective(sessionID, content, "Synced from todowrite tool")
            if (t.status === "completed") {
              so.status = "resolved"
              so.validationProof = "Marked completed via todowrite"
            }
          } else {
            if (t.status === "completed" && existingSO.status !== "resolved") {
              existingSO.status = "resolved"
              existingSO.validationProof = existingSO.validationProof || "Marked completed via todowrite"
            }
          }
        }
      }
    })
  },
})

export default HierarchicalObjectivesPlugin
