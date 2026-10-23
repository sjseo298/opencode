import { Plugin as OpenCodePlugin } from "@opencode/plugin"
import { Schema } from "effect"

export type SecondaryObjectiveStatus =
  | "pending"
  | "exploring"
  | "blocked"
  | "resolved"
  | "discarded"
  | "cancelled"

export type PrimaryObjectiveStatus = "pending" | "exploring" | "resolved"

export interface TertiaryObjective {
  id: string // "SO-1-T2" etc. — hierarchical child of its parent Secondary Objective
  title: string
  status: SecondaryObjectiveStatus
  rationale: string // Why this tertiary sub-objective is necessary to close its parent SO
  blocker?: string // Concrete symptom, obstacle, or root cause if blocked
  validationProof?: string // Verifiable test output, exit code, or command evidence
  createdAt: number
  updatedAt: number
}

export interface SecondaryObjective {
  id: string // "SO-1", "SO-2", etc.
  title: string
  status: SecondaryObjectiveStatus
  rationale: string // Why this SO is necessary to advance or unblock the PO
  blocker?: string // Concrete symptom, obstacle, or root cause if blocked
  validationProof?: string // Verifiable test output, exit code, or command evidence
  children?: TertiaryObjective[] // Nested tertiary sub-objectives; present only when the SO was decomposed because it proved too large
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
  var __OPENCODE_POST_COMPACTION_SESSIONS__: Set<string> | undefined
}
export const sessionObjectives: Map<string, PrimaryObjective> =
  globalThis.__OPENCODE_OBJECTIVES__ ?? new Map<string, PrimaryObjective>()
globalThis.__OPENCODE_OBJECTIVES__ = sessionObjectives

export const postCompactionSessions: Set<string> =
  globalThis.__OPENCODE_POST_COMPACTION_SESSIONS__ ?? new Set<string>()
globalThis.__OPENCODE_POST_COMPACTION_SESSIONS__ = postCompactionSessions

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

// Static normative instructions for Protocolo de Objetivos.
// MUST BE 100% INVARIANT across all turns to preserve llama.cpp / LLM KV cache prefix caching.
export const PROTOCOLO_OBJETIVOS_INSTRUCTIONS = [
  "## Protocolo de Objetivos (Objectives Protocol)",
  "You are equipped with the **Protocolo de Objetivos** (also referred to as 'Objectives Protocol' or 'Hierarchical Objectives Protocol').",
  "MANDATORY TRIGGER: You MUST strictly follow this exact framework whenever the user instructs you to follow, execute, or apply the 'protocolo de objetivos', 'protocolo de objetivos jerárquicos', 'objectives protocol' (or 'protocolo de investigacion'), OR WHENEVER any task requires planning (multi-step execution, non-trivial analysis, debugging, refactoring, or implementation). The requirement of planning is, in and of itself, sufficient to mandate the Protocolo de Objetivos.",
  "ORDER OF OPERATIONS (PLAN FIRST, EXECUTE SECOND): You MUST construct the objective plan FIRST via `objective_manage` before executing code modifications, running mutating tasks, or attempting fixes. Never execute first and document objectives after the fact.",
  "1. Identify and establish the **Primary Objective** and its concrete, verifiable **Definition of Done**.",
  "2. Decompose the task into initial **Secondary Objectives (SO-N)** with the **Rationale** explaining why each subtask or blocker resolution is necessary.",
  "3. Call `objective_manage` with `action: 'set_primary'`, `title`, `definitionOfDone`, and `secondaries: [{ title: '...', rationale: '...' }, ...]` to register the complete initial plan immediately before taking action.",
  "4. Dynamic Secondary Objective Discovery & Immediate Re-Planning: As you analyze, research, or execute secondary objectives, whenever you discover unforeseen subtasks, blockers, edge cases, or dependencies that were not anticipated in the initial plan, smoothly add them to the plan via `objective_manage` (`action: 'add_secondary'`). The plan evolves dynamically as findings emerge. This obligation holds even AFTER execution has started: when new secondary or tertiary objectives are discovered, WHENEVER the user intervenes and changes or corrects direction, scope, or approach, OR when you yourself realize a required step is missing from the plan, IMMEDIATELY update the objective list via `objective_manage` (`action: 'add_secondary'` / `action: 'update_secondary'`) before continuing work. A stale plan is prohibited.",
  "5. Tertiary Objectives (Conditional Decomposition): A Secondary Objective may be decomposed into tertiary sub-objectives ONLY when it proves too large to execute as a single unit (broad scope, multiple independent steps, or high context cost). Do NOT pre-create tertiary objectives for small secondaries. They are FIRST-CLASS children of their parent SO: register them with `objective_manage` (`action: 'add_tertiary'`, passing the parent SO id in `id`, e.g., `SO-2`, plus title and rationale) and manage them with `action: 'update_tertiary'` using each tertiary's own id (e.g., `SO-2-T1`). They inherit every protocol rule: rationale, Done-means-Done validation proof, reconciliation, and subagent candidacy. CLOSURE RULE (NO SHORTCUTS): a secondary objective can only be resolved when ALL of its tertiary objectives are closed (resolved/discarded/cancelled), and the Primary Objective can only be completed when EVERY secondary objective — including all of their tertiary objectives — is closed; the tool rejects both shortcuts.",
  "6. Mandatory Documentation Update Objective: When ANY Primary or Secondary objective makes relevant modifications to the repository (changes affecting public behavior, APIs, configuration schemas, user-facing features, or plugin/SDK surfaces), you MUST create a dedicated Secondary Objective that updates the affected documentation (READMEs, API docs, specification/methodology documents, changelogs) and resolve it with concrete proof. The Primary Objective MUST NOT be closed while relevant repository modifications remain undocumented.",
  "7. Enforce 'Done means Done': NEVER conclude or mark any objective resolved without executing real commands and attaching concrete proof (`validationProof`).",
  "8. Continuously keep objectives updated: when new blockers, sub-tasks, or progress occur, call `objective_manage` (`action: 'add_secondary'` or `action: 'update_secondary'`) to register them before concluding your turn. Do not leave stale in_progress or pending items if you already completed their work.",
  "9. Mandatory Objective Reconciliation Before Final Response: Before presenting your final result or concluding your final response to the user, your FIRST action MUST be to update and reconcile all objectives via `objective_manage`. You MUST NOT leave objectives open, in-progress, or pending if their work has been done. Once every secondary objective — including all of their tertiary sub-objectives — and the Definition of Done are verified, call `objective_manage` with `action: 'complete_primary'` (or `action: 'resolve_primary'`) to formally resolve and close the Primary Objective.",
  "10. Subagent Delegation & Task Sizing: You may leverage the `subagent` tool to offload focused, deep investigations or isolated diagnostics. DELEGATION CANDIDACY RULE: every secondary and tertiary objective is a candidate to be resolved by a subagent; before executing each one, validate whether delegation pays off given slot availability (`max_subagents = total_slots - 1`)—delegate when the work is isolated, context-heavy (many files/logs), and a free slot exists, which protects your primary session's context; execute it in the main thread instead when the task is small or tightly coupled with other objectives, or when no subagent slot is available. CONCURRENCY RULE (`max_subagents = total_slots - 1`): One slot is occupied by your active primary session, so you may enable at most `total_slots - 1` concurrent subagents as reported by the server's `/props` context API (defaulting to strictly ONE subagent at a time when 2 slots are active, 2 subagents for 3 slots, or 3 subagents for 4 slots). TASK SIZING RULE: Do NOT delegate overly large tasks to subagents or they will run out of available context; always assign medium-sized, achievable tasks. If a task is large, split it into several smaller subagent tasks whenever possible; only as a last resort, when a task cannot be divided, delegate it to the subagent so it does what it needs to do.",
  "11. Post-Compaction Resumption: Immediately after compaction finishes, when resuming the session, you MUST first review what has been accomplished in the objectives (read the preserved objective tree/snapshot from the compaction summary under ## Objective and ## Work State) and call `objective_manage` to synchronize and update the active objectives before taking any other action. Do not re-investigate resolved items.",
].join("\n")

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
  initialSecondaries?: SecondaryObjective[],
): PrimaryObjective {
  const existing = sessionObjectives.get(sessionID)
  const now = Date.now()
  const po: PrimaryObjective = {
    title: title.trim(),
    status: existing?.status ?? "exploring",
    definitionOfDone: definitionOfDone.trim(),
    secondaries: initialSecondaries !== undefined ? initialSecondaries : (existing?.secondaries ?? []),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  sessionObjectives.set(sessionID, po)
  return po
}

export function updatePrimaryObjective(
  sessionID: string,
  updates: {
    status?: PrimaryObjectiveStatus
    title?: string
    definitionOfDone?: string
    validationProof?: string
  },
): { success: boolean; error?: string; po?: PrimaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }

  if (updates.status === "resolved") {
    // No-shortcuts closure rule: an SO counts as closed only when the SO itself AND every one of its tertiary sub-objectives are closed.
    const isClosed = (status: SecondaryObjectiveStatus) => status === "resolved" || status === "discarded" || status === "cancelled"
    const openSecondaries = po.secondaries.filter(
      (s) => !isClosed(s.status) || (s.children ?? []).some((t) => !isClosed(t.status)),
    )
    if (openSecondaries.length > 0) {
      return {
        success: false,
        error: `Cannot resolve Primary Objective while there are still open secondary objectives: ${openSecondaries.map((s) => s.id).join(", ")}. Resolve or discard all secondary objectives and their tertiary sub-objectives first.`,
      }
    }
  }

  if (updates.status !== undefined) po.status = updates.status
  if (updates.title !== undefined) po.title = updates.title.trim()
  if (updates.definitionOfDone !== undefined) po.definitionOfDone = updates.definitionOfDone.trim()

  const now = Date.now()
  po.updatedAt = now

  return { success: true, po }
}

export function addSecondaryObjective(
  sessionID: string,
  title: string,
  rationale: string,
  explicitId?: string,
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

  const cleanId = explicitId?.trim()
  if (cleanId) {
    const existing = po.secondaries.find((s) => s.id.toLowerCase() === cleanId.toLowerCase())
    if (existing) {
      if (title.trim()) existing.title = title.trim()
      if (rationale.trim()) existing.rationale = rationale.trim()
      existing.updatedAt = now
      return existing
    }
  }

  const existingByTitle = po.secondaries.find(
    (s) => s.title.toLowerCase() === title.trim().toLowerCase(),
  )
  if (existingByTitle) {
    if (rationale.trim()) existingByTitle.rationale = rationale.trim()
    existingByTitle.updatedAt = now
    return existingByTitle
  }

  let id = cleanId
  if (!id) {
    let maxIdx = 0
    for (const s of po.secondaries) {
      const match = s.id.match(/^SO-(\d+)$/i)
      if (match) {
        const num = parseInt(match[1], 10)
        if (num > maxIdx) maxIdx = num
      }
    }
    id = `SO-${Math.max(maxIdx, po.secondaries.length) + 1}`
  }

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

  // No-shortcuts closure rule: an SO cannot be resolved while any of its tertiary sub-objectives remain open — the sum of its children is what closes it.
  if (updates.status === "resolved") {
    const isClosed = (status: SecondaryObjectiveStatus) => status === "resolved" || status === "discarded" || status === "cancelled"
    const openTertiaries = (target.children ?? []).filter((t) => !isClosed(t.status))
    if (openTertiaries.length > 0) {
      return {
        success: false,
        error: `Cannot mark ${id} as resolved while it has open tertiary objectives: ${openTertiaries.map((t) => t.id).join(", ")}. Resolve or discard each tertiary objective first.`,
      }
    }
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
  if (updates.blocker !== undefined) target.blocker = updates.blocker?.trim() || undefined
  if (updates.validationProof !== undefined && updates.status !== "resolved") {
    target.validationProof = updates.validationProof?.trim() || undefined
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

export function addTertiaryObjective(
  sessionID: string,
  parentSOId: string,
  title: string,
  rationale: string,
  explicitId?: string,
): { success: boolean; error?: string; objective?: TertiaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}. Call 'set_primary' first.` }
  }

  const parent = po.secondaries.find((s) => s.id.toLowerCase() === parentSOId.trim().toLowerCase())
  if (!parent) {
    return {
      success: false,
      error: `Parent secondary objective '${parentSOId}' not found. Register it with action 'add_secondary' before adding tertiary objectives under it.`,
    }
  }

  const now = Date.now()
  parent.children ??= []

  const cleanId = explicitId?.trim()
  if (cleanId) {
    const existing = parent.children.find((t) => t.id.toLowerCase() === cleanId.toLowerCase())
    if (existing) {
      if (title.trim()) existing.title = title.trim()
      if (rationale.trim()) existing.rationale = rationale.trim()
      existing.updatedAt = now
      return { success: true, objective: existing }
    }
  }

  const existingByTitle = parent.children.find((t) => t.title.toLowerCase() === title.trim().toLowerCase())
  if (existingByTitle) {
    if (rationale.trim()) existingByTitle.rationale = rationale.trim()
    existingByTitle.updatedAt = now
    return { success: true, objective: existingByTitle }
  }

  const parentNum = parent.id.match(/^SO-(\d+)/i)?.[1] ?? "0"
  let id = cleanId
  if (!id) {
    let maxIdx = 0
    for (const t of parent.children) {
      const match = t.id.match(new RegExp(`^SO-${parentNum}-T(\\d+)$`, "i"))
      if (match) {
        const num = parseInt(match[1], 10)
        if (num > maxIdx) maxIdx = num
      }
    }
    id = `SO-${parentNum}-T${maxIdx + 1}`
  }

  const tertiary: TertiaryObjective = {
    id,
    title: title.trim(),
    status: "pending",
    rationale: rationale.trim(),
    createdAt: now,
    updatedAt: now,
  }
  parent.children.push(tertiary)
  po.updatedAt = now
  return { success: true, objective: tertiary }
}

export function updateTertiaryObjective(
  sessionID: string,
  id: string,
  updates: {
    status?: SecondaryObjectiveStatus
    title?: string
    rationale?: string
    blocker?: string
    validationProof?: string
  },
): { success: boolean; error?: string; objective?: TertiaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }

  let target: TertiaryObjective | undefined
  for (const so of po.secondaries) {
    target = (so.children ?? []).find((t) => t.id.toLowerCase() === id.trim().toLowerCase())
    if (target) break
  }
  if (!target) {
    return { success: false, error: `Tertiary objective ${id} not found.` }
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
  if (updates.blocker !== undefined) target.blocker = updates.blocker?.trim() || undefined
  if (updates.validationProof !== undefined && updates.status !== "resolved") {
    target.validationProof = updates.validationProof?.trim() || undefined
  }

  const now = Date.now()
  target.updatedAt = now
  po.updatedAt = now
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
      // Tertiary sub-objectives render as children of their parent SO, mirroring how SOs nest under the PO.
      for (const t of so.children ?? []) {
        const tertiaryBadge = `[${t.status.toUpperCase()}]`
        lines.push(`  - **${t.id}** ${tertiaryBadge} ${t.title}`)
        lines.push(`    - *Rationale:* ${t.rationale}`)
        if (t.blocker) {
          lines.push(`    - ⚠️ *Blocker:* ${t.blocker}`)
        }
        if (t.validationProof) {
          lines.push(`    - ✅ *Validation Proof:* ${t.validationProof}`)
        }
      }
    }
  }

  return lines.join("\n")
}

export function formatCompactionObjectivesInput(po: PrimaryObjective): string {
  const completed = po.secondaries.filter((s) => s.status === "resolved")
  const active = po.secondaries.filter((s) => s.status === "exploring")
  const blocked = po.secondaries.filter((s) => s.status === "blocked")
  const pending = po.secondaries.filter((s) => s.status === "pending")

  // Tertiary sub-objectives ride under their parent SO line in every category section.
  const objectiveLines = (line: string, s: SecondaryObjective): string[] => [
    line,
    ...(s.children ?? []).map(
      (t) => `  - [${t.id}] [${t.status.toUpperCase()}] ${t.title}${t.validationProof ? ` (Proof: ${t.validationProof})` : ""}`,
    ),
  ]

  const lines: string[] = [
    "## Protocolo de Objetivos - Mandatory Objective Snapshot (Compacted History) (Insumo de Compactación)",
    "CRITICAL INSTRUCTION FOR COMPACTION SUMMARY:",
    "You MUST preserve this active Objective Tree in the generated summary under ## Objective and ## Work State so that the next session can resume without loss of context.",
    "- In '## Objective' and '## Requirements', summarize the Primary Objective and Definition of Done.",
    "- Under '## Work State > ### Completed', preserve all completed secondary objectives with their IDs and validation proofs.",
    "- Under '## Work State > ### Active', preserve all active or exploring secondary objectives with their IDs and rationales.",
    "- Under '## Work State > ### Blocked', preserve all blocked secondary objectives with their IDs, blockers, and rationales.",
    "- In '## Next Move', state the immediate active or pending secondary objective to be resumed.",
    "",
    "CRITICAL MANDATORY INSTRUCTION FOR POST-COMPACTION RESUMPTION:",
    "Immediately after compaction finishes, when the session resumes, the VERY FIRST action the agent must perform is to read what has been accomplished so far in the objectives from this summary and call `objective_manage` to synchronize and update the active objectives before continuing execution.",
    "",
    `[PO] ${po.title} [${po.status.toUpperCase()}]`,
    `Definition of Done: ${po.definitionOfDone || "Verified"}`,
    "",
    "### Completed Objectives",
    ...(completed.length > 0
      ? completed.flatMap((s) => objectiveLines(`- [${s.id}] [RESOLVED] ${s.title}${s.validationProof ? ` (Proof: ${s.validationProof})` : ""}`, s))
      : ["- (none)"]),
    "",
    "### Active / Exploring Objectives",
    ...(active.length > 0
      ? active.flatMap((s) => objectiveLines(`- [${s.id}] [EXPLORING] ${s.title} (Rationale: ${s.rationale})`, s))
      : ["- (none)"]),
    "",
    "### Blocked Objectives",
    ...(blocked.length > 0
      ? blocked.flatMap((s) => objectiveLines(`- [${s.id}] [BLOCKED] ${s.title} (Blocker: ${s.blocker || "Unspecified"}; Rationale: ${s.rationale})`, s))
      : ["- (none)"]),
    "",
    "### Pending Objectives",
    ...(pending.length > 0
      ? pending.flatMap((s) => objectiveLines(`- [${s.id}] [PENDING] ${s.title} (Rationale: ${s.rationale})`, s))
      : ["- (none)"]),
    "",
    renderObjectiveTree(po),
  ]
  return lines.join("\n")
}

export function reconstructObjectivesFromMessages(
  sessionID: string,
  messages?: readonly any[],
): PrimaryObjective | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined

  let po: PrimaryObjective | undefined = undefined

  // 1. Scan assistant tool calls if present
  for (const msg of messages) {
    if (msg.role !== "assistant" && msg.type !== "assistant") continue
    const parts = Array.isArray(msg.content) ? msg.content : []
    for (const part of parts) {
      if (part.type !== "tool") continue
      const name = (part.name || part.tool || "").toLowerCase()
      if (name !== "objective_manage") continue
      let input = part.state && "input" in part.state ? part.state.input : part.input
      if (typeof input === "string") {
        try {
          input = JSON.parse(input)
        } catch {
          continue
        }
      }
      if (!input || typeof input !== "object") continue

      const action = String(input.action || "").toLowerCase()
      if (action === "set_primary" || action === "init" || action === "set_objectives") {
        if (input.title && input.definitionOfDone) {
          const initialSecondaries = Array.isArray(input.secondaries) ? [] : undefined
          po = setPrimaryObjective(sessionID, input.title, input.definitionOfDone, initialSecondaries)
          if (Array.isArray(input.secondaries)) {
            for (let i = 0; i < input.secondaries.length; i++) {
              const s = input.secondaries[i]
              const explicitId = (typeof s?.id === "string" && s.id.trim()) ? s.id.trim() : `SO-${i + 1}`
              const sTitle = s?.title?.trim() || s?.rationale?.trim() || explicitId || `Subtask ${i + 1}`
              const sRationale = s?.rationale?.trim() || s?.title?.trim() || "Planned subtask"
              const so = addSecondaryObjective(sessionID, sTitle, sRationale, explicitId)
              if (s.status && s.status !== "pending") {
                updateSecondaryObjective(sessionID, so.id, {
                  status: s.status,
                  blocker: s.blocker || undefined,
                  validationProof: s.validationProof || undefined,
                })
              }
            }
          }
        }
      } else if (action === "add_secondary" || action === "add_secondaries") {
        const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
          ? input.secondaries
          : (input.title || input.rationale ? [{ id: input.id, title: input.title, rationale: input.rationale, status: input.status, blocker: input.blocker, validationProof: input.validationProof }] : [])
        for (const item of items) {
          const explicitId = (typeof item?.id === "string" && item.id.trim()) ? item.id.trim() : undefined
          const sTitle = item?.title?.trim() || item?.rationale?.trim() || explicitId || "Subtask"
          const sRationale = item?.rationale?.trim() || item?.title?.trim() || "Planned subtask"
          const so = addSecondaryObjective(sessionID, sTitle, sRationale, explicitId)
          if (item.status && item.status !== "pending") {
            updateSecondaryObjective(sessionID, so.id, {
              status: item.status,
              blocker: item.blocker || undefined,
              validationProof: item.validationProof || undefined,
            })
          }
        }
      } else if (action === "update_secondary" || action === "update_secondaries") {
        const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
          ? input.secondaries
          : (input.id ? [{ id: input.id, status: input.status, title: input.title, rationale: input.rationale, blocker: input.blocker, validationProof: input.validationProof }] : [])
        for (const item of items) {
          if (item?.id) {
            updateSecondaryObjective(sessionID, item.id, {
              status: item.status,
              title: item.title,
              rationale: item.rationale,
              blocker: item.blocker,
              validationProof: item.validationProof,
            })
          }
        }
      } else if (action === "add_tertiary" || action === "add_tertaries") {
        const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
          ? input.secondaries
          : (input.id || input.title ? [{ id: input.id, title: input.title, rationale: input.rationale, status: input.status, blocker: input.blocker, validationProof: input.validationProof }] : [])
        for (const item of items) {
          const parentId = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : ""
          if (!parentId) continue
          const tTitle = item?.title?.trim() || item?.rationale?.trim() || "Tertiary sub-objective"
          const tRationale = item?.rationale?.trim() || item?.title?.trim() || "Planned tertiary subtask"
          const added = addTertiaryObjective(sessionID, parentId, tTitle, tRationale)
          if (!added.success || !added.objective) continue
          if (item.status && item.status !== "pending") {
            updateTertiaryObjective(sessionID, added.objective.id, {
              status: item.status,
              blocker: item.blocker || undefined,
              validationProof: item.validationProof || undefined,
            })
          }
        }
      } else if (action === "update_tertiary" || action === "update_tertaries") {
        const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
          ? input.secondaries
          : (input.id ? [{ id: input.id, status: input.status, title: input.title, rationale: input.rationale, blocker: input.blocker, validationProof: input.validationProof }] : [])
        for (const item of items) {
          const tertiaryId = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : ""
          if (!tertiaryId) continue
          updateTertiaryObjective(sessionID, tertiaryId, {
            status: item.status as SecondaryObjectiveStatus | undefined,
            title: typeof item.title === "string" ? item.title : undefined,
            rationale: typeof item.rationale === "string" ? item.rationale : undefined,
            blocker: item.blocker || undefined,
            validationProof: item.validationProof || undefined,
          })
        }
      } else if (action === "complete_primary" || action === "resolve_primary" || action === "close_primary") {
        if (po) {
          updatePrimaryObjective(sessionID, { status: "resolved", validationProof: input.validationProof })
        }
      } else if (action === "update_primary") {
        if (po) {
          updatePrimaryObjective(sessionID, {
            status: input.status,
            title: input.title,
            definitionOfDone: input.definitionOfDone,
            validationProof: input.validationProof,
          })
        }
      }
    }
  }

  if (po) return po

  // 2. Scan checkpoint/compaction messages
  for (const msg of messages) {
    const text =
      typeof msg?.content === "string"
        ? msg.content
        : Array.isArray(msg?.content)
          ? msg.content.map((c: any) => c.text || "").join("\n")
          : typeof msg?.summary === "string"
            ? msg.summary
            : ""
    if (!text || (!text.includes("<conversation-checkpoint>") && !text.includes("## Objective") && !text.includes("[PO]"))) {
      continue
    }

    let poTitle = ""
    let dod = "Complete all tasks and verify requirements."
    const poMatch = text.match(/\[PO\]\s+([^\n\[]+)/i)
    if (poMatch) {
      poTitle = poMatch[1].trim()
    } else {
      const objMatch = text.match(/## Objective\s*\n+-\s*([^\n]+)/i)
      if (objMatch) {
        poTitle = objMatch[1].trim()
      }
    }

    const dodMatch = text.match(/Definition of Done:\s*([^\n]+)/i)
    if (dodMatch) {
      dod = dodMatch[1].trim()
    }

    if (poTitle) {
      po = setPrimaryObjective(sessionID, poTitle, dod)

      // Supports both secondary (SO-N) and tertiary sub-objective ids (SO-N-TM, e.g. SO-2-T1)
      const soRegex = /-\s*\[(SO-\d+(?:-T\d+)?)\]\s*\[([A-Z_]+)\]\s*([^(\n]+)(?:\(([^)]+)\))?/gi
      // Two-pass recovery: plain SO-N lines register their parent first (keeping the checkpoint id),
      // tertiary sub-objective lines (SO-N-TM) attach under that parent afterwards.
      const validStatuses: SecondaryObjectiveStatus[] = [
        "pending", "exploring", "blocked", "resolved", "discarded", "cancelled",
      ]
      const pendingTertiaries: { id: string; title: string; rationale: string; blocker?: string; proof?: string; status: SecondaryObjectiveStatus }[] = []

      let match: RegExpExecArray | null
      while ((match = soRegex.exec(text)) !== null) {
        const rawId = match[1]
        const title = match[3].trim()
        const extra = match[4] || ""

        let rationale = "Preserved from session checkpoint"
        let blocker: string | undefined
        let proof: string | undefined

        const rMatch = extra.match(/Rationale:\s*([^;]+)/i)
        if (rMatch) rationale = rMatch[1].trim()

        const bMatch = extra.match(/Blocker:\s*([^;]+)/i)
        if (bMatch) blocker = bMatch[1].trim()

        const pMatch = extra.match(/(?:Proof|Validation Proof):\s*([^;]+)/i)
        if (pMatch) proof = pMatch[1].trim()

        const rawStatus = match[2].toLowerCase()
        const status: SecondaryObjectiveStatus = validStatuses.includes(rawStatus as any)
          ? (rawStatus as SecondaryObjectiveStatus)
          : "pending"

        if (!/-T\d+$/i.test(rawId)) {
          addSecondaryObjective(sessionID, title, rationale, rawId)
          updateSecondaryObjective(sessionID, rawId, {
            status,
            blocker,
            validationProof: proof,
          })
        } else {
          pendingTertiaries.push({ id: rawId, title, rationale, blocker, proof, status })
        }
      }

      for (const entry of pendingTertiaries) {
        const parentId = entry.id.replace(/-T\d+$/i, "")
        if (!po.secondaries.some((s) => s.id.toLowerCase() === parentId.toLowerCase())) {
          addSecondaryObjective(sessionID, `Recovered parent ${parentId}`, "Reconstructed from compaction checkpoint", parentId)
        }
        const added = addTertiaryObjective(sessionID, parentId, entry.title, entry.rationale, entry.id)
        if (added.success && added.objective) {
          updateTertiaryObjective(sessionID, added.objective.id, {
            status: entry.status,
            blocker: entry.blocker,
            validationProof: entry.proof,
          })
        }
      }

      if (po.secondaries.length > 0) {
        return po
      }
    }
  }

  return po
}

// Tool Input Schema using Effect Schema
const ObjectiveActionSchema = Schema.Union([
  Schema.Literal("set_primary"),
  Schema.Literal("init"),
  Schema.Literal("set_objectives"),
  Schema.Literal("complete_primary"),
  Schema.Literal("resolve_primary"),
  Schema.Literal("close_primary"),
  Schema.Literal("update_primary"),
  Schema.Literal("add_secondary"),
  Schema.Literal("add_secondaries"),
  Schema.Literal("update_secondary"),
  Schema.Literal("update_secondaries"),
  Schema.Literal("add_tertiary"),
  Schema.Literal("update_tertiary"),
  Schema.Literal("list"),
])
const SecondaryStatusSchema = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("exploring"),
  Schema.Literal("blocked"),
  Schema.Literal("resolved"),
  Schema.Literal("discarded"),
  Schema.Literal("cancelled"),
])

export const SecondaryInputItemSchema = Schema.Struct({
  id: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "Identifier if updating existing SO (e.g. 'SO-1')" })),
  ),
  title: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "Title of the secondary objective / subtask" })),
  ),
  rationale: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "Why this SO is necessary to advance or unblock the PO" })),
  ),
  status: Schema.optional(
    Schema.NullOr(SecondaryStatusSchema).pipe(
      Schema.annotate({
        description: "Status: 'pending', 'exploring', 'blocked', 'resolved', 'discarded', 'cancelled'",
      }),
    ),
  ),
  blocker: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "Concrete blocker, error symptom, or obstacle if blocked" })),
  ),
  validationProof: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "Concrete test/command output proof. Mandatory when status='resolved'" })),
  ),
})

export const ObjectiveInputSchema = Schema.Struct({
  action: ObjectiveActionSchema.pipe(
    Schema.annotate({
      description:
        "Action to perform: 'set_primary' (establish Primary Objective and optional initial secondaries), 'complete_primary' (close resolved Primary Objective), 'add_secondary' (add one or multiple secondaries), 'update_secondary' (update status/rationale/proof of SOs), 'add_tertiary' (add a tertiary sub-objective under an SO: 'id' is the PARENT SO id, e.g. 'SO-2'), 'update_tertiary' (update status/rationale/proof of TOs: 'id' is the TO's own id, e.g. 'SO-2-T1'), or 'list'. An SO cannot be resolved while any of its tertiary sub-objectives is open.",
    }),
  ),
  title: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description:
          "Title of the Primary Objective (when action='set_primary') or single Secondary Objective (when action='add_secondary')",
      }),
    ),
  ),
  definitionOfDone: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description:
          "Verifiable Definition of Done / acceptance criteria for the Primary Objective (required for 'set_primary')",
      }),
    ),
  ),
  id: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description:
          "Identifier of the secondary objective to update, e.g. 'SO-1' (required for single 'update_secondary'). In 'add_tertiary' it is the PARENT secondary objective id; in 'update_tertiary' it is the tertiary's own id (e.g., 'SO-2-T1')",
      }),
    ),
  ),
  status: Schema.optional(
    Schema.NullOr(SecondaryStatusSchema).pipe(
      Schema.annotate({
        description:
          "New status for secondary objective: 'pending', 'exploring', 'blocked', 'resolved', 'discarded', 'cancelled'",
      }),
    ),
  ),
  rationale: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description:
          "Mandatory rationale explaining why this secondary objective is necessary to unblock or complete the PO",
      }),
    ),
  ),
  blocker: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description: "Concrete obstacle, symptom, or error message if status is 'blocked'",
      }),
    ),
  ),
  validationProof: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description:
          "Concrete verification proof (command run, test output, exit code). MANDATORY when status='resolved'",
      }),
    ),
  ),
  secondaries: Schema.optional(
    Schema.NullOr(Schema.Array(SecondaryInputItemSchema)).pipe(
      Schema.annotate({
        description:
          "List of secondary objectives. Use in 'set_primary' to establish the complete plan in a single call, or in 'add_secondary' to add multiple subtasks, or in 'update_secondary' to batch-update. Also used as the item list for 'add_tertiary' (each item's 'id' is the parent SO id) and 'update_tertiary' (each item's 'id' is the tertiary id).",
      }),
    ),
  ),
})

export const ObjectiveOutputSchema = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
  tree: Schema.String,
})

export const HierarchicalObjectivesPlugin: OpenCodePlugin.Plugin = OpenCodePlugin.define({
  id: "hierarchical-objectives",
  async setup(ctx) {
    // 1. Register the objective_manage tool via transform
    if (typeof ctx.tool?.transform === "function") {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "objective_manage",
          options: { codemode: false },
          description:
            "Manage the hierarchical objective tree for the Protocolo de Objetivos (Objectives Protocol): define the Primary Objective, register Secondary Objectives (SO-N) with rationale, record blockers, and attach concrete validation proof before resolving. Supports registering secondaries together with set_primary in a single call. Tertiary sub-objectives are first-class children of a secondary objective (only when an SO proves too large): add them with action 'add_tertiary' ('id' = parent SO, e.g. 'SO-2') and manage them with 'update_tertiary' ('id' = TO id, e.g. 'SO-2-T1'); no SO can be resolved while any of its tertiary sub-objectives is open, and the PO cannot close until every SO and TO is closed (no shortcuts). Update the objective list immediately—even mid-execution—whenever new objectives emerge, the user intervenes or corrects direction, or a required step turns out missing. Also register a documentation-update secondary objective whenever any objective makes relevant repository modifications. Mandatory: call to update and reconcile objectives before delivering the final response to the user, and immediately after compaction.",
          input: ObjectiveInputSchema,
          output: ObjectiveOutputSchema,
          execute: async (input: any, toolCtx: any) => {
            const sessionID = (toolCtx as any)?.sessionID || "default-session"
            const rawAction = String(input.action || "").toLowerCase()

            if (rawAction === "set_primary" || rawAction === "init" || rawAction === "set_objectives") {
              const title = input.title?.trim()
              const dod = input.definitionOfDone?.trim()
              if (!title || !dod) {
                return {
                  output: {
                    success: false,
                    message: "Both 'title' and 'definitionOfDone' are required for action 'set_primary'.",
                    tree: "",
                  },
                  content: "Missing required parameters for set_primary (title and definitionOfDone are mandatory).",
                }
              }
              const initialSecondaries = Array.isArray(input.secondaries) ? [] : undefined
              const po = setPrimaryObjective(sessionID, title, dod, initialSecondaries)

              // If secondary objectives were supplied in the same call, register them immediately
              if (Array.isArray(input.secondaries) && input.secondaries.length > 0) {
                for (let i = 0; i < input.secondaries.length; i++) {
                  const item = input.secondaries[i]
                  const explicitId = (typeof item?.id === "string" && item.id.trim()) ? item.id.trim() : `SO-${i + 1}`
                  const sTitle = item?.title?.trim() || item?.rationale?.trim() || explicitId || `Subtask ${i + 1}`
                  const sRationale = item?.rationale?.trim() || item?.title?.trim() || "Planned subtask for primary objective"
                  const so = addSecondaryObjective(sessionID, sTitle, sRationale, explicitId)
                  if (item.status && item.status !== "pending") {
                    updateSecondaryObjective(sessionID, so.id, {
                      status: item.status,
                      blocker: item.blocker || undefined,
                      validationProof: item.validationProof || undefined,
                    })
                  }
                }
              }

              const tree = renderObjectiveTree(po)
              return {
                output: { success: true, message: `Primary Objective and secondaries established.`, tree },
                content: tree,
              }
            }

            if (
              rawAction === "complete_primary" ||
              rawAction === "resolve_primary" ||
              rawAction === "close_primary" ||
              rawAction === "update_primary"
            ) {
              const po = sessionObjectives.get(sessionID)
              if (!po) {
                return {
                  output: {
                    success: false,
                    message: "No active objective tree found. Call 'set_primary' first.",
                    tree: "",
                  },
                  content: "No active objective tree found. Call 'set_primary' first.",
                }
              }

              const targetStatus =
                rawAction === "complete_primary" || rawAction === "resolve_primary" || rawAction === "close_primary"
                  ? "resolved"
                  : (input.status || "resolved")

              const result = updatePrimaryObjective(sessionID, {
                status: targetStatus,
                title: input.title,
                definitionOfDone: input.definitionOfDone,
                validationProof: input.validationProof,
              })

              if (!result.success) {
                const tree = renderObjectiveTree(po)
                return {
                  output: { success: false, message: result.error || "Failed to update Primary Objective.", tree },
                  content: `Error updating Primary Objective: ${result.error}`,
                }
              }

              const tree = renderObjectiveTree(po)
              return {
                output: {
                  success: true,
                  message: `Primary Objective successfully marked as ${po.status.toUpperCase()}.`,
                  tree,
                },
                content: tree,
              }
            }

            if (rawAction === "add_secondary" || rawAction === "add_secondaries") {
              const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
                ? input.secondaries
                : (input.title || input.rationale ? [{ id: input.id, title: input.title, rationale: input.rationale, status: input.status, blocker: input.blocker, validationProof: input.validationProof }] : [])

              if (items.length === 0) {
                return {
                  output: {
                    success: false,
                    message: "At least one secondary objective is required for action 'add_secondary'.",
                    tree: "",
                  },
                  content: "Missing required parameters for add_secondary.",
                }
              }

              const addedIds: string[] = []
              for (const item of items) {
                const explicitId = (typeof item?.id === "string" && item.id.trim()) ? item.id.trim() : undefined
                const sTitle = item?.title?.trim() || item?.rationale?.trim() || explicitId || "Subtask"
                const sRationale = item?.rationale?.trim() || item?.title?.trim() || "Planned subtask for primary objective"
                const so = addSecondaryObjective(sessionID, sTitle, sRationale, explicitId)
                addedIds.push(so.id)
                if (item.status && item.status !== "pending") {
                  updateSecondaryObjective(sessionID, so.id, {
                    status: item.status,
                    blocker: item.blocker || undefined,
                    validationProof: item.validationProof || undefined,
                  })
                }
              }

              const po = sessionObjectives.get(sessionID)!
              const tree = renderObjectiveTree(po)
              return {
                output: { success: true, message: `Added secondary objective(s): ${addedIds.join(", ")}.`, tree },
                content: tree,
              }
            }

            if (rawAction === "update_secondary" || rawAction === "update_secondaries") {
              const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
                ? input.secondaries
                : (input.id ? [{ id: input.id, status: input.status, title: input.title, rationale: input.rationale, blocker: input.blocker, validationProof: input.validationProof }] : [])

              if (items.length === 0) {
                return {
                  output: {
                    success: false,
                    message: "'id' (or 'secondaries' array with ids) is required for action 'update_secondary'.",
                    tree: "",
                  },
                  content: "Missing id for update_secondary.",
                }
              }

              for (const item of items) {
                const id = item?.id?.trim()
                if (!id) {
                  return {
                    output: { success: false, message: "Missing 'id' in update item.", tree: "" },
                    content: "Missing id in update item.",
                  }
                }
                const result = updateSecondaryObjective(sessionID, id, {
                  status: item.status || undefined,
                  title: item.title?.trim() || undefined,
                  rationale: item.rationale?.trim() || undefined,
                  blocker: item.blocker || undefined,
                  validationProof: item.validationProof || undefined,
                })
                if (!result.success) {
                  const po = sessionObjectives.get(sessionID)
                  const tree = po ? renderObjectiveTree(po) : ""
                  return {
                    output: { success: false, message: result.error || `Update failed for ${id}.`, tree },
                    content: `Error updating ${id}: ${result.error}`,
                  }
                }
              }

              const po = sessionObjectives.get(sessionID)
              const tree = po ? renderObjectiveTree(po) : ""
              const isClosedStatus = (status: SecondaryObjectiveStatus) => status === "resolved" || status === "discarded" || status === "cancelled"
              // No-shortcuts closure rule: an SO only counts when its tertiary sub-objectives are closed too.
              const allResolvedOrDiscarded =
                po &&
                po.secondaries.length > 0 &&
                po.secondaries.every(
                  (s) => isClosedStatus(s.status) && (s.children ?? []).every((t) => isClosedStatus(t.status)),
                )

              const completionNotice =
                allResolvedOrDiscarded && po.status !== "resolved"
                  ? " All secondary objectives are resolved! Call objective_manage with action: 'complete_primary' to formally close the Primary Objective before presenting your final response."
                  : ""

              return {
                output: {
                  success: true,
                  message: `Secondary objective(s) successfully updated.${completionNotice}`,
                  tree,
                },
                content: tree,
              }
            }

            if (rawAction === "add_tertiary" || rawAction === "add_tertaries") {
              const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
                ? input.secondaries
                : (input.id && (input.title || input.rationale)
                    ? [{ id: input.id, title: input.title, rationale: input.rationale, status: input.status, blocker: input.blocker, validationProof: input.validationProof }]
                    : [])

              if (items.length === 0) {
                return {
                  output: { success: false, message: "add_tertiary requires a parent secondary objective id ('id', e.g. 'SO-2') and a title.", tree: "" },
                  content: "Missing required parameters for add_tertiary (parent SO id + title).",
                }
              }

              const addedIds: string[] = []
              for (const item of items) {
                const parentId = typeof item?.id === "string" ? item.id.trim() : ""
                if (!parentId) {
                  return { output: { success: false, message: "Missing parent SO id in add_tertiary item.", tree: "" }, content: "Missing parent SO id for tertiary objective." }
                }
                const tTitle = item?.title?.trim() || item?.rationale?.trim() || "Tertiary sub-objective"
                const tRationale = item?.rationale?.trim() || item?.title?.trim() || "Planned tertiary subtask"
                const added = addTertiaryObjective(sessionID, parentId, tTitle, tRationale)
                if (!added.success || !added.objective) {
                  return { output: { success: false, message: added.error || `Failed to add tertiary objective under ${parentId}.`, tree: "" }, content: added.error || "Failed to add tertiary objective." }
                }
                addedIds.push(added.objective.id)
                if (item.status && item.status !== "pending") {
                  updateTertiaryObjective(sessionID, added.objective.id, {
                    status: item.status,
                    blocker: item.blocker || undefined,
                    validationProof: item.validationProof || undefined,
                  })
                }
              }

              const po = sessionObjectives.get(sessionID)!
              const tree = renderObjectiveTree(po)
              return { output: { success: true, message: `Added tertiary objective(s): ${addedIds.join(", ")}.`, tree }, content: tree }
            }

            if (rawAction === "update_tertiary" || rawAction === "update_tertaries") {
              const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
                ? input.secondaries
                : (input.id ? [{ id: input.id, status: input.status, title: input.title, rationale: input.rationale, blocker: input.blocker, validationProof: input.validationProof }] : [])

              if (items.length === 0) {
                return { output: { success: false, message: "'id' (tertiary objective id, e.g. 'SO-2-T1') is required for action 'update_tertiary'.", tree: "" }, content: "Missing id for update_tertiary." }
              }

              for (const item of items) {
                const tertiaryId = typeof item?.id === "string" ? item.id.trim() : ""
                if (!tertiaryId) {
                  return { output: { success: false, message: "Missing 'id' in update_tertiary item.", tree: "" }, content: "Missing id in update_tertiary item." }
                }
                const result = updateTertiaryObjective(sessionID, tertiaryId, {
                  status: item.status || undefined,
                  title: item.title?.trim() || undefined,
                  rationale: item.rationale?.trim() || undefined,
                  blocker: item.blocker || undefined,
                  validationProof: item.validationProof || undefined,
                })
                if (!result.success) {
                  const po = sessionObjectives.get(sessionID)
                  const tree = po ? renderObjectiveTree(po) : ""
                  return { output: { success: false, message: result.error || `Update failed for ${tertiaryId}.`, tree }, content: `Error updating ${tertiaryId}: ${result.error}` }
                }
              }

              const po = sessionObjectives.get(sessionID)
              const tree = po ? renderObjectiveTree(po) : ""
              // Nudge when an SO's entire tertiary set just closed: that is the moment its parent can be resolved.
              const isClosedStatus = (status: SecondaryObjectiveStatus) => status === "resolved" || status === "discarded" || status === "cancelled"
              const closureNudges: string[] = []
              for (const so of po?.secondaries ?? []) {
                if (!so.children || so.children.length === 0) continue
                if (isClosedStatus(so.status)) continue
                if (so.children.every((t) => isClosedStatus(t.status))) {
                  closureNudges.push(`All tertiary objectives under ${so.id} are closed — mark ${so.id} as resolved with validation proof to close it.`)
                }
              }

              return { output: { success: true, message: `Tertiary objective(s) successfully updated.${closureNudges.join(" ")}`, tree }, content: tree }
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
      if (!po && Array.isArray(event.messages)) {
        po = reconstructObjectivesFromMessages(sessionID, event.messages)
      }

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

      postCompactionSessions.add(sessionID)
      event.system.push({
        type: "text",
        text: formatCompactionObjectivesInput(po),
      })
    })

    // 3. Context Hook: Inject Active Objectives and Alignment Enforcer
    await ctx.session.hook("context", async (event) => {
      const sessionID = event.sessionID
      if (!sessionID) return

      let po = sessionObjectives.get(sessionID)
      if (!po && Array.isArray(event.messages)) {
        po = reconstructObjectivesFromMessages(sessionID, event.messages)
      }

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

      // PREFIX CACHE INVARIANCE:
      // In local inference engines (llama.cpp, etc.), prefix caching (Longest Common Prefix)
      // depends on the system prompt being 100% IDENTICAL across all turns.
      // Dynamic objective trees, changing statuses, active target reminders, and oscillating
      // dirty warnings must NEVER be injected into event.system!
      // The static Protocolo de Objetivos framework is invariant across turns.
      if (!event.system.some((part) => (part.text ?? "").includes("Protocolo de Objetivos (Objectives Protocol)"))) {
        event.system.push({
          type: "text",
          text: PROTOCOLO_OBJETIVOS_INSTRUCTIONS,
        })
      }
    })

    // 4. Tool Execution Hooks: Anti-Loop & Evidence Capture
    await ctx.tool.hook("execute.before", (event) => {
      const sessionID = event.sessionID
      if (!sessionID) return

      if (READONLY_TOOLS.has(event.tool)) {
        const currentCount = (consecutiveReadCounts.get(sessionID) ?? 0) + 1
        consecutiveReadCounts.set(sessionID, currentCount)

        if (currentCount >= MAX_CONSECUTIVE_READS) {
          throw new Error(
            `⚠️ Anti-Loop Warning: You have executed ${currentCount} consecutive inspection/read-only operations without taking action or updating objectives. Synthesize your findings and focus your next step on concrete validation or execution.`,
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

export const Plugin = HierarchicalObjectivesPlugin
export default HierarchicalObjectivesPlugin
