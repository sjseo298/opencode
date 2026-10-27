import { Plugin as OpenCodePlugin } from "@opencode/plugin"
import { Schema } from "effect"
import {
  type ActionEntry,
  type AffectedResources,
  type DoDCriterion,
  type Finding,
  type FindingEvidence,
  type Fingerprint,
  type Option,
  type OptionStatus,
  type PhaseState,
  type Precondition,
  FINDING_EVIDENCE_TYPES,
  SEARCH_ATTACH_THRESHOLD,
  SEARCH_NOVEL_THRESHOLD,
  relevantProjectFiles,
  evaluateDoD,
  isPlaceholder,
  nextConcreteAction,
  nextDoDCriterionId,
  nextFindingId,
  nextOptionId,
  normalizeFingerprintKey,
  parseDocument,
  renderProjection,
  repairDocumentInvariants,
  runComplianceAudit,
  searchFindings,
  validateFindingFields,
} from "./objectives-model.js"
import { createObjectivesStore, type ObjectivesStore } from "./objectives-persistence.js"
import { autoConfigureEmbeddingsScorer, warmUpFindingsEmbeddings } from "./objectives-embeddings.js"

// F-7: public swap point — an embeddings backend replaces the default dependency-free lexical scorer.
export { setFindingScorer } from "./objectives-model.js"
export type { FindingScorer } from "./objectives-model.js"
export {
  autoConfigureEmbeddingsScorer,
  createLmStudioFindingScorer,
  fetchEmbedding,
  cosineSimilarity,
  warmUpFindingsEmbeddings,
} from "./objectives-embeddings.js"

export type SecondaryObjectiveStatus =
  | "pending"
  | "exploring"
  | "blocked"
  | "resolved"
  | "discarded"
  | "cancelled"

export type PrimaryObjectiveStatus =
  | "pending"
  | "exploring"
  | "resolved"
  | "presented_awaiting_confirmation"

export interface DelegationAssessment {
  mode: "main" | "subagent"
  justification: string
}

export interface TertiaryObjective {
  id: string // "SO-1-T2" etc. — hierarchical child of its parent Secondary Objective
  title: string
  status: SecondaryObjectiveStatus
  rationale: string // Why this tertiary sub-objective is necessary to close its parent SO
  delegation?: DelegationAssessment // Assessment of whether this sub-objective is delegated or executed in the main thread
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
  delegation?: DelegationAssessment // Assessment of whether this SO is delegated to a subagent or executed in the main thread
  blocker?: string // Concrete symptom, obstacle, or root cause if blocked
  validationProof?: string // Verifiable test output, exit code, or command evidence
  children?: TertiaryObjective[] // Nested tertiary sub-objectives; present only when the SO was decomposed because it proved too large
  affectedResources?: AffectedResources // Blast radius: files/envs/schemas/services this SO may touch
  preconditions?: Precondition[] // Declarative gates: actionClass -> required tokens/scripts before it counts toward proof
  actionLog?: ActionEntry[] // Anti-loop: normalized actions executed while this SO was active
  touchedFiles?: string[] // Files modified via edit/write while this SO was active (docs-surface detection)
  blastRadiusViolations?: string[] // Files modified outside declared affectedResources.files
  createdAt: number
  updatedAt: number
}

export interface PrimaryObjective {
  title: string
  status: PrimaryObjectiveStatus
  definitionOfDone: string // Acceptance criteria (legacy blob; kept for compatibility and rendering)
  secondaries: SecondaryObjective[]
  validationProof?: string // Concrete proof attached to the Primary Objective itself
  topicKey?: string // Cross-session identity for export/import (e.g. "outlook_bulk_triage")
  dod?: DoDCriterion[] // Decomposed Definition of Done (F-3); empty means legacy single-criterion mode
  findings?: Finding[] // First-class knowledge units (F-2)
  options?: Option[] // Multi-candidate options with a live Result column (F-5)
  fingerprints?: Fingerprint[] // Normalized blocker fingerprints (F-7/C-4)
  phase?: PhaseState // Plan-pause / checkpoint state (F-6)
  touchedFiles?: string[] // Session-level record of files modified via edit/write
  relevantDocumentableFiles?: string[] // Files judged (via one-shot /btw or heuristic) to require documentation
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

// Per-session warnings about repeated actions (F-9), surfaced on the next tool output and cleared.
const actionWarnings = new Map<string, string[]>()

// Persistent store (F-1). Set by the plugin when the context exposes a JSON KV storage domain.
let activeStore: ObjectivesStore | undefined
export function setObjectivesStore(store: ObjectivesStore | undefined): void {
  activeStore = store
}

export function getObjectivesStore(): ObjectivesStore | undefined {
  return activeStore
}

function persistSessionObjectives(sessionID: string): void {
  if (!activeStore) return
  const po = sessionObjectives.get(sessionID)
  if (!po) return
  void activeStore.save(sessionID, po as unknown as Record<string, any>).catch(() => {})
}

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
  "3. Call `objective_manage` with `action: 'set_primary'`, `title`, `definitionOfDone`, and `secondaries: [{ title: '...', rationale: '...' }, ...]`. MANDATORY PLAN PRESENTATION & APPROVAL: You MUST present the initial plan to the user for review and refinement before executing mutating tasks (either by passing `presentPlan: true` in `set_primary` or immediately calling `action: 'present_plan'`). The tree FREEZES in status `presented_awaiting_confirmation`. Present the plan clearly in your response, pause your turn, and wait for confirmation or adjustments (this paused state is explicitly exempt from the rule against ending turns with unresolved work). Once the user approves or adjusts, call `action: 'resume_plan'` with their instructions to begin execution.",
  "4. Dynamic Secondary Objective Discovery & Immediate Re-Planning: As you analyze, research, or execute secondary objectives, whenever you discover unforeseen subtasks, blockers, edge cases, or dependencies that were not anticipated in the initial plan, smoothly add them to the plan via `objective_manage` (`action: 'add_secondary'`). The plan evolves dynamically as findings emerge. This obligation holds even AFTER execution has started: whenever you discover new secondary or tertiary objectives, WHENEVER the user intervenes and changes or corrects direction, scope, or approach, OR when you yourself realize a required step is missing from the plan, IMMEDIATELY update the objective list via `objective_manage` (`action: 'add_secondary'` / `action: 'update_secondary'`) before continuing work. A stale plan is prohibited.",
  "5. Tertiary Objectives (Conditional Decomposition): A Secondary Objective may be decomposed into tertiary sub-objectives ONLY when it proves too large to execute as a single unit (broad scope, multiple independent steps, or high context cost). Do NOT pre-create tertiary objectives for small secondaries. They are FIRST-CLASS children of their parent SO: register them with `objective_manage` (`action: 'add_tertiary'`, passing the parent SO id in `id`, e.g. `SO-2`, plus title and rationale) and manage them with `action: 'update_tertiary'` using each tertiary's own id (e.g. `SO-2-T1`). They inherit every protocol rule: rationale, Done-means-Done validation proof, reconciliation, and subagent candidacy. CLOSURE RULE (NO SHORTCUTS): a secondary objective can only be resolved when ALL of its tertiary objectives are closed (resolved/discarded/cancelled), and the Primary Objective can only be completed when EVERY secondary objective — including all of their tertiary objectives — is closed; the tool rejects both shortcuts.",
  "6. Mandatory Documentation Update Objective: When ANY Primary or Secondary objective makes relevant modifications to the repository (changes affecting public behavior, APIs, configuration schemas, user-facing features, or plugin/SDK surfaces), you MUST create a dedicated Secondary Objective that updates the affected documentation (READMEs, API docs, specification/methodology documents, changelogs) and resolve it with concrete proof. The Primary Objective MUST NOT be closed while relevant repository modifications remain undocumented. The tool auto-creates this documentation objective when it detects public-surface file changes and no documentation objective exists.",
  "7. Enforce 'Done means Done': NEVER conclude or mark any objective resolved without executing real commands and attaching concrete proof (`validationProof`).",
  "8. Continuously keep objectives updated: when new blockers, sub-tasks, or progress occur, call `objective_manage` (`action: 'add_secondary'` or `action: 'update_secondary'`) to register them before concluding your turn. Do not leave stale in_progress or pending items if you already completed their work.",
  "9. Mandatory Objective Reconciliation Before Final Response: Before presenting your final result or concluding your final response to the user, your FIRST action MUST be to update and reconcile all objectives via `objective_manage`. Leaving open objectives in the graphical interface when concluding is strictly unacceptable (status `presented_awaiting_confirmation` is the only approved paused state). You MUST NOT leave objectives open, in-progress, or pending if their work is done. Once every secondary objective — including all of their tertiary sub-objectives — and the Definition of Done are verified, call `objective_manage` with `action: 'complete_primary'` (or `action: 'resolve_primary'`) to formally resolve and close the Primary Objective.",
  "10. Subagent Delegation & Task Sizing: You may leverage the `subagent` tool to offload focused, deep investigations or isolated diagnostics. MANDATORY DELEGATION REASONING RULE: every secondary objective, tertiary objective, AND finding is a candidate for delegation; the agent MUST explicitly evaluate and record its delegation decision (`delegation: { mode: 'main' | 'subagent', justification: '...' }`). Delegation to subagents is CRITICAL TO PRESERVE YOUR CONTEXT WINDOW: executing context-heavy, repetitive, or exploratory tasks in the main session rapidly exhausts available context tokens. Delegation assessment is MANDATORY when transitioning an objective to 'exploring' or 'resolved', and when registering any finding via 'add_finding'. The decision ([main] or [subagent]) is displayed compactly beside each objective and finding in the objective tree and sidebar. Delegate when the work is isolated, context-heavy (many files/logs), and a free slot exists (`max_subagents = total_slots - 1`), which protects your primary session's context; execute in the main thread only when the task is small or tightly coupled, always recording the concrete justification upon moving to `exploring` (no blind main-thread execution). CONCURRENCY RULE (`max_subagents = total_slots - 1`): One slot is occupied by your active primary session, so you may enable at most `total_slots - 1` concurrent subagents as reported by the server's `/props` context API (defaulting to strictly ONE subagent at a time when 2 slots are active, 2 subagents for 3 slots, or 3 subagents for 4 slots). TASK SIZING RULE: Do NOT delegate overly large tasks to subagents or they will run out of available context; always assign medium-sized, achievable tasks. If a task is large, split it into several smaller subagent tasks whenever possible; only as a last resort, when a task cannot be divided, delegate it to the subagent so it does what it needs to do.",
  "11. Post-Compaction Resumption: Immediately after compaction finishes, when resuming the session, you MUST first review what has been accomplished in the objectives (read the preserved objective tree/snapshot from the compaction summary under ## Objective and ## Work State) and call `objective_manage` to synchronize and update the active objectives before taking any other action. Do not re-investigate resolved items. The tree is auto-persisted and auto-hydrated: call `action: 'sync'` first after compaction or on session resume to rehydrate from the persistent store and repair any divergence.",
  "12. Findings (F-NNN) & Mandatory Blocker Interception: every durable discovery, diagnostic fact, failing command, or error is registered with `action: 'add_finding'` the moment it is encountered (checkpoint immediately, BEFORE attempting any fix or next step). When a problem, blocker, or unexpected result occurs, NEVER silently solve it without registering the finding first. Findings are critical because they uncover blockers and essential facts that can force the redefinition, cancellation, or creation of objectives. Each finding must include typed evidence (COMMAND_OUTPUT, QUERY_RESULT, LOG_EXCERPT, FILE_READ, SCREENSHOT), the literal result without interpretation, delegation assessment if applicable, and one concrete executable next action. Search-before-write is ENFORCED by the tool: if an existing finding scores >= 0.68 against the new one, you MUST extend that finding with `action: 'update_finding'` instead of creating a duplicate; between 0.55 and 0.68 you may create only with a forced seeAlso cross-reference; below 0.55 it is genuinely new. Findings older than 30 days are stale: historical reference only — revalidate live against the real system before applying their fix or discarding options.",
  "13. Options & Closure: in multi-candidate investigations every candidate is an Option (`action: 'add_option'` / `action: 'update_option'`) whose Result column ALWAYS reflects the currently known state. At most one Option may be SUCCESSFUL (proof required); registering SUCCESSFUL auto-cancels the siblings in one operation. DISCARDED requires a reason. The Primary Objective CANNOT be completed while any option remains in 'PENDING' or 'EXPLORING' status — all options must reach a definitive conclusion (SUCCESSFUL, DISCARDED, or CANCELLED) before complete_primary.",
  "14. Definition of Done: decompose it into verifiable criteria (array of objects in 'dodCriteria' with separate fields { id, statement, verifiableBy, satisfiedBy, proofRef }, managed with action: 'update_dod' or 'proof_dod'). Criteria listing resolved secondary objectives in 'satisfiedBy' automatically inherit proofRef upon SO resolution. The Primary Objective cannot be resolved while any criterion lacks proofRef. The exact property name for proof is strictly 'proofRef'. Direct criterion proof assignment is supported via action 'proof_dod' (id + proofRef) or passing 'dodProofs: { D1: ... }' directly in 'complete_primary'. When a finding invalidates a criterion, edit the criterion with action: 'update_dod' at the moment of discovery — never reinterpret silently at the end.",
  "15. Compliance audit: the tool runs a mechanical audit on every resolved/blocked/discarded transition and on complete_primary (typed proof present, no unvalidated root-cause phrasing such as 'should pass' / 'logically' / 'the root cause is' without adjacent execution evidence, EXPLORING options have a live Result, findings are complete). A failed audit REJECTS the transition with the violation list — fix the violations and retry. Run `action: 'audit'` on demand to inspect the current violations.",
  "16. Plan pause & checkpoints: before multi-step work present the plan with `action: 'present_plan'` (or `presentPlan: true` on `set_primary`) — the tree FREEZES until the user explicitly confirms, then resume with `action: 'resume_plan'` carrying the user's instruction. After each significant phase call `action: 'checkpoint'`: the report is derived ONLY from the objective tree (no parallel mental model), and the tree pauses until the user's next instruction.",
  "17. Blocker fingerprints & anti-loop: when a finding resolves a blocker, register its fingerprint with `action: 'add_fingerprint'` so future sessions answer 'did we solve this before?' in a lookup instead of re-analysis. The tool tracks repeated read actions per SO and warns on duplicates; opening an SO whose title matches a resolved/discarded fingerprint requires an explicit `justification`.",
  "18. Cross-session persistence: the whole tree (objectives, findings, options, fingerprints, DoD criteria) is auto-persisted and auto-hydrated; `action: 'export_tree'` returns the serialized document plus the auto-rendered EXPLORATION-style projection, and `action: 'import_tree'` hydrates a session from a topic key or a serialized document. The EXPLORATION document is ALWAYS an auto-rendered projection of the live tree — never a hand-maintained mirror with its own vocabulary.",
  "19. Iterative Objective Synchronization (mechanically enforced): Work strictly one Secondary Objective at a time. Transition it to `exploring` before beginning implementation, and only resolve it after validation with concrete proof. A `pending -> resolved` jump (anti-batch resolution) and a second simultaneous `exploring` SO (single active target invariant) are mechanically rejected by the tool. These gates govern the objective lifecycle without intrusive edit limits and without modifying `event.system`, preserving llama.cpp prefix-cache stability across turns.",
].join("\n")

export const MAX_CONSECUTIVE_READS = 5

export function clearSessionObjectives(sessionID: string) {
  sessionObjectives.delete(sessionID)
  consecutiveReadCounts.delete(sessionID)
  antiLoopWarnings.delete(sessionID)
  actionWarnings.delete(sessionID)
}

export function getObjectives(sessionID: string): PrimaryObjective | undefined {
  return sessionObjectives.get(sessionID)
}

// F-1 hydration: in-memory first, then the persistent store (source of truth across
// compaction and restarts), then message-history reconstruction as last resort.
export async function hydrateSessionObjectives(
  sessionID: string,
  messages?: readonly unknown[],
): Promise<PrimaryObjective | undefined> {
  const inMemory = sessionObjectives.get(sessionID)
  if (inMemory) return inMemory
  if (activeStore) {
    const doc = await activeStore.load(sessionID)
    if (doc) {
      repairDocumentInvariants(doc)
      const po = doc as unknown as PrimaryObjective
      sessionObjectives.set(sessionID, po)
      // Pre-warm embeddings cache in background for all hydrated findings
      if (Array.isArray(po.findings) && po.findings.length > 0) {
        void warmUpFindingsEmbeddings(po.findings).catch(() => {})
      }
      return po
    }
  }
  if (Array.isArray(messages)) {
    const po = reconstructObjectivesFromMessages(sessionID, messages)
    if (po) {
      persistSessionObjectives(sessionID)
      if (Array.isArray(po.findings) && po.findings.length > 0) {
        void warmUpFindingsEmbeddings(po.findings).catch(() => {})
      }
    }
    return po
  }
  return undefined
}

export function setPrimaryObjective(
  sessionID: string,
  title: string,
  definitionOfDone: string,
  initialSecondaries?: SecondaryObjective[],
  extra?: { topicKey?: string; dod?: DoDCriterion[] },
): PrimaryObjective {
  const existing = sessionObjectives.get(sessionID)
  const now = Date.now()
  const po: PrimaryObjective = {
    title: title.trim(),
    status: "exploring",
    definitionOfDone: definitionOfDone.trim(),
    secondaries: initialSecondaries !== undefined ? initialSecondaries : (existing?.secondaries ?? []),
    validationProof: undefined,
    topicKey: extra?.topicKey?.trim() || existing?.topicKey,
    dod: extra?.dod ?? existing?.dod,
    findings: existing?.findings ?? [],
    options: existing?.options ?? [],
    fingerprints: existing?.fingerprints ?? [],
    phase: existing?.phase,
    touchedFiles: existing?.touchedFiles ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  sessionObjectives.set(sessionID, po)
  persistSessionObjectives(sessionID)
  return po
}

const isClosedStatus = (status: SecondaryObjectiveStatus) =>
  status === "resolved" || status === "discarded" || status === "cancelled"

export function updatePrimaryObjective(
  sessionID: string,
  updates: {
    status?: PrimaryObjectiveStatus
    title?: string
    definitionOfDone?: string
    validationProof?: string
    dod?: DoDCriterion[]
  },
  opts?: { bypassGates?: boolean },
): { success: boolean; error?: string; po?: PrimaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }

  // Apply non-status updates first so closure gates see the fresh proof/criteria.
  if (updates.title !== undefined) po.title = updates.title.trim()
  if (updates.definitionOfDone !== undefined) po.definitionOfDone = updates.definitionOfDone.trim()
  if (updates.validationProof !== undefined) po.validationProof = updates.validationProof?.trim() || undefined
  if (updates.dod !== undefined) po.dod = updates.dod

  if (updates.status === "resolved" && !opts?.bypassGates) {
    // No-shortcuts closure rule: an SO counts as closed only when the SO itself AND every one of its tertiary sub-objectives are closed.
    const openSecondaries = po.secondaries.filter(
      (s) => !isClosedStatus(s.status) || (s.children ?? []).some((t) => !isClosedStatus(t.status)),
    )
    if (openSecondaries.length > 0) {
      return {
        success: false,
        error: `Cannot resolve Primary Objective while there are still open secondary objectives: ${openSecondaries.map((s) => s.id).join(", ")}. Resolve or discard all secondary objectives and their tertiary sub-objectives first.`,
      }
    }

    // F-3 gate: every DoD criterion must carry a typed proofRef (legacy mode: the PO proof).
    const dodEval = evaluateDoD(po)
    const unsatisfied = dodEval.criteria.filter((c) => !c.satisfied)
    if (unsatisfied.length > 0) {
      return {
        success: false,
        error: `Cannot resolve Primary Objective: unsatisfied Definition of Done criterion(s): ${unsatisfied
          .map((u) => `${u.criterion.id} — ${u.reason}`)
          .join("; ")}. Attach proofRef to each criterion (action 'update_dod') and re-verify.`,
      }
    }

    // F-4 gate: mechanical compliance audit must pass before closure.
    const audit = runComplianceAudit(po)
    if (!audit.pass) {
      return {
        success: false,
        error: `Cannot resolve Primary Objective: compliance audit failed — ${audit.violations.join(" | ")}`,
      }
    }
  }

  if (updates.status !== undefined) po.status = updates.status
  po.updatedAt = Date.now()
  persistSessionObjectives(sessionID)

  return { success: true, po }
}

export function addSecondaryObjective(
  sessionID: string,
  title: string,
  rationale: string,
  explicitId?: string,
  extra?: { affectedResources?: AffectedResources; preconditions?: Precondition[]; delegation?: DelegationAssessment; retainStatus?: boolean },
): SecondaryObjective {
  let po = sessionObjectives.get(sessionID)
  const now = Date.now()
  if (!po) {
    po = {
      title: "Main Task Investigation",
      status: "exploring",
      definitionOfDone: "Resolve all blockers and verify requirements.",
      secondaries: [],
      findings: [],
      options: [],
      fingerprints: [],
      touchedFiles: [],
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
      if (extra?.delegation) existing.delegation = extra.delegation
      if (extra?.affectedResources) existing.affectedResources = extra.affectedResources
      if (extra?.preconditions) existing.preconditions = extra.preconditions
      existing.updatedAt = now
      persistSessionObjectives(sessionID)
      return existing
    }
  }

  const existingByTitle = po.secondaries.find(
    (s) => s.title.toLowerCase() === title.trim().toLowerCase(),
  )
  if (existingByTitle) {
    if (rationale.trim()) existingByTitle.rationale = rationale.trim()
    if (extra?.delegation) existingByTitle.delegation = extra.delegation
    if (extra?.affectedResources) existingByTitle.affectedResources = extra.affectedResources
    if (extra?.preconditions) existingByTitle.preconditions = extra.preconditions
    existingByTitle.updatedAt = now
    persistSessionObjectives(sessionID)
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
    delegation: extra?.delegation,
    affectedResources: extra?.affectedResources,
    preconditions: extra?.preconditions,
    createdAt: now,
    updatedAt: now,
  }
  po.secondaries.push(so)

  // Invariante de coherencia jerárquica:
  // Si el PO ya estaba cerrado (resolved) o en pausa (presented_awaiting_confirmation)
  // y se agrega un nuevo SO abierto, el PO se REABRE automáticamente a 'exploring' (a menos que retainStatus esté activo para borradores).
  if (!extra?.retainStatus && (po.status === "resolved" || po.status === "presented_awaiting_confirmation")) {
    po.status = "exploring"
    if (po.phase) {
      po.phase.paused = false
    }
  }

  po.updatedAt = now
  persistSessionObjectives(sessionID)
  return so
}

export function updateSecondaryObjective(
  sessionID: string,
  id: string,
  updates: {
    status?: SecondaryObjectiveStatus
    title?: string
    rationale?: string
    delegation?: DelegationAssessment
    blocker?: string
    validationProof?: string
    affectedResources?: AffectedResources
    preconditions?: Precondition[]
  },
  opts?: { preconditionsMet?: string[]; bypassGates?: boolean },
): { success: boolean; error?: string; objective?: SecondaryObjective; poReopened?: boolean } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }

  const target = po.secondaries.find((s) => s.id.toLowerCase() === id.trim().toLowerCase())
  if (!target) {
    return { success: false, error: `Secondary objective ${id} not found.` }
  }

  if (updates.status === "exploring" && !opts?.bypassGates && !updates.delegation && !target.delegation) {
    return {
      success: false,
      error: `Cannot transition ${id} to 'exploring' without delegation assessment. You must provide 'delegation: { mode: 'main' | 'subagent', justification: '...' }' to explicitly evaluate whether subagent delegation is appropriate.`,
    }
  }

  if (updates.delegation) {
    const mode = updates.delegation.mode
    const just = typeof updates.delegation.justification === "string" ? updates.delegation.justification.trim() : ""
    if (mode !== "main" && mode !== "subagent") {
      return { success: false, error: `${id}: delegation mode must be 'main' or 'subagent'.` }
    }
    if (just.length < 10) {
      return { success: false, error: `${id}: delegation justification must be >= 10 characters (got ${just.length}).` }
    }
    if (isPlaceholder(just)) {
      return { success: false, error: `${id}: delegation justification looks like a placeholder: "${just}".` }
    }
  }

  if (updates.status === "resolved" && !opts?.bypassGates) {
    // No-shortcuts closure rule: an SO cannot be resolved while any of its tertiary sub-objectives remain open — the sum of its children is what closes it.
    const openTertiaries = (target.children ?? []).filter((t) => !isClosedStatus(t.status))
    if (openTertiaries.length > 0) {
      return {
        success: false,
        error: `Cannot mark ${id} as resolved while it has open tertiary objectives: ${openTertiaries.map((t) => t.id).join(", ")}. Resolve or discard each tertiary objective first.`,
      }
    }

    // Strict Done-means-Done Rule: validation proof is mandatory for "resolved"
    const proof = updates.validationProof?.trim() || target.validationProof?.trim()
    if (!proof) {
      return {
        success: false,
        error: `Cannot mark ${id} as resolved without concrete validation proof. Deduction alone is a hypothesis, not proof. Run the test/command and attach the observed output.`,
      }
    }

    // F-8 gate: declared preconditions must be acknowledged as met before the proof counts.
    const preconditions = target.preconditions ?? []
    if (preconditions.length > 0) {
      const met = new Set((opts?.preconditionsMet ?? []).map((p) => p.trim().toLowerCase()))
      const missing = preconditions.filter((p) => !met.has(p.actionClass.trim().toLowerCase()))
      if (missing.length > 0) {
        return {
          success: false,
          error: `Cannot mark ${id} as resolved: precondition(s) not acknowledged as met: ${missing
            .map((p) => `${p.actionClass} (requires: ${p.requires.join(", ")})`)
            .join("; ")}. Pass 'preconditionsMet' listing each satisfied actionClass.`,
        }
      }
    }

    // F-4 gate: mechanical compliance audit on the resolved transition.
    // Audit the proposed transition state (target with new proof/status applied) rather than the pre-update state.
    const proposed = {
      ...po,
      secondaries: po.secondaries.map((s) =>
        s.id === target.id
          ? {
              ...s,
              status: "resolved",
              validationProof: proof,
            }
          : s,
      ),
    }
    const audit = runComplianceAudit(proposed)
    if (!audit.pass) {
      return {
        success: false,
        error: `Cannot mark ${id} as resolved: compliance audit failed — ${audit.violations.join(" | ")}`,
      }
    }
  }

  if (updates.status === "blocked" && !opts?.bypassGates) {
    const proposedBlocker = updates.blocker?.trim() || target.blocker?.trim()
    const proposed = {
      ...po,
      secondaries: po.secondaries.map((s) =>
        s.id === target.id
          ? {
              ...s,
              status: "blocked",
              blocker: proposedBlocker,
            }
          : s,
      ),
    }
    const audit = runComplianceAudit(proposed)
    if (!audit.pass) {
      return {
        success: false,
        error: `Cannot mark ${id} as blocked: compliance audit failed — ${audit.violations.join(" | ")}`,
      }
    }
  }

  if (updates.status !== undefined) target.status = updates.status
  if (updates.title !== undefined) target.title = updates.title.trim()
  if (updates.rationale !== undefined) target.rationale = updates.rationale.trim()
  if (updates.blocker !== undefined) target.blocker = updates.blocker?.trim() || undefined
  if (updates.delegation !== undefined) target.delegation = updates.delegation
  if (updates.affectedResources !== undefined) target.affectedResources = updates.affectedResources
  if (updates.preconditions !== undefined) target.preconditions = updates.preconditions
  if (updates.validationProof !== undefined && updates.status !== "resolved") {
    target.validationProof = updates.validationProof?.trim() || undefined
  }
  if (updates.status === "resolved") {
    target.validationProof = updates.validationProof?.trim() || target.validationProof?.trim()
    const finalProof = target.validationProof

    // Auto-inherit validationProof to any DoD criterion that lists this SO in satisfiedBy and lacks its own proofRef
    if (finalProof && Array.isArray(po.dod)) {
      for (const crit of po.dod) {
        if (!crit.proofRef || crit.proofRef.trim().length === 0) {
          if (Array.isArray(crit.satisfiedBy) && crit.satisfiedBy.map((s) => s.trim().toLowerCase()).includes(target.id.toLowerCase())) {
            crit.proofRef = `${target.id}: ${finalProof}`
          }
        }
      }
    }

    const prevBlocker = target.blocker?.trim()
    if (prevBlocker) {
      const key = normalizeFingerprintKey(prevBlocker)
      if (key) {
        po.fingerprints ??= []
        const existingFp = po.fingerprints.find((f) => f.key === key)
        const fix = (target.validationProof || "Resolved with validation proof").slice(0, 100)
        if (existingFp) {
          existingFp.status = "resolved"
          existingFp.fixRef = fix
        } else {
          po.fingerprints.push({
            key,
            symptom: prevBlocker,
            soRef: target.id,
            status: "resolved",
            fixRef: fix,
            createdAt: Date.now(),
          })
        }
      }
    }
  }

  // Cascada ascendente: Si el SO pasa a un estado abierto ('pending', 'exploring', 'blocked')
  // y el PO estaba cerrado o pausado, el PO se reabre automáticamente a 'exploring'.
  let poReopened = false
  if (isOpenStatus(target.status)) {
    if (po.status === "resolved" || po.status === "presented_awaiting_confirmation") {
      po.status = "exploring"
      if (po.phase) po.phase.paused = false
      poReopened = true
    }
  }

  const now = Date.now()
  target.updatedAt = now
  po.updatedAt = now
  persistSessionObjectives(sessionID)

  return { success: true, objective: target, poReopened }
}

function isOpenStatus(status: string): boolean {
  return status === "pending" || status === "exploring" || status === "blocked"
}

export function addTertiaryObjective(
  sessionID: string,
  parentSOId: string,
  title: string,
  rationale: string,
  explicitId?: string,
  extra?: { delegation?: DelegationAssessment },
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
      if (extra?.delegation) existing.delegation = extra.delegation
      existing.updatedAt = now
      persistSessionObjectives(sessionID)
      return { success: true, objective: existing }
    }
  }

  const existingByTitle = parent.children.find((t) => t.title.toLowerCase() === title.trim().toLowerCase())
  if (existingByTitle) {
    if (rationale.trim()) existingByTitle.rationale = rationale.trim()
    if (extra?.delegation) existingByTitle.delegation = extra.delegation
    existingByTitle.updatedAt = now
    persistSessionObjectives(sessionID)
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
    delegation: extra?.delegation,
    createdAt: now,
    updatedAt: now,
  }
  parent.children.push(tertiary)

  // Invariante de coherencia jerárquica:
  // Si el PO estaba cerrado o pausado y se añade un TO abierto, el PO se REABRE automáticamente a 'exploring'.
  if (po.status === "resolved" || po.status === "presented_awaiting_confirmation") {
    po.status = "exploring"
    if (po.phase) {
      po.phase.paused = false
    }
  }

  // De la misma manera, si el padre SO estaba resuelto, se reabre a exploring
  if (parent.status === "resolved") {
    parent.status = "exploring"
    parent.updatedAt = now
  }

  po.updatedAt = now
  persistSessionObjectives(sessionID)
  return { success: true, objective: tertiary }
}

export function updateTertiaryObjective(
  sessionID: string,
  id: string,
  updates: {
    status?: SecondaryObjectiveStatus
    title?: string
    rationale?: string
    delegation?: DelegationAssessment
    blocker?: string
    validationProof?: string
  },
  opts?: { bypassGates?: boolean },
): { success: boolean; error?: string; objective?: TertiaryObjective; poReopened?: boolean; parentReopened?: boolean } {
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

  if (updates.status === "exploring" && !opts?.bypassGates && !updates.delegation && !target.delegation) {
    return {
      success: false,
      error: `Cannot transition ${id} to 'exploring' without delegation assessment. You must provide 'delegation: { mode: 'main' | 'subagent', justification: '...' }' to explicitly evaluate whether subagent delegation is appropriate.`,
    }
  }

  if (updates.delegation) {
    const mode = updates.delegation.mode
    const just = typeof updates.delegation.justification === "string" ? updates.delegation.justification.trim() : ""
    if (mode !== "main" && mode !== "subagent") {
      return { success: false, error: `${id}: delegation mode must be 'main' or 'subagent'.` }
    }
    if (just.length < 10) {
      return { success: false, error: `${id}: delegation justification must be >= 10 characters (got ${just.length}).` }
    }
    if (isPlaceholder(just)) {
      return { success: false, error: `${id}: delegation justification looks like a placeholder: "${just}".` }
    }
  }

  if (updates.status === "resolved" && !opts?.bypassGates) {
    // Strict Done-means-Done Rule: validation proof is mandatory for "resolved"
    const proof = updates.validationProof?.trim() || target.validationProof?.trim()
    if (!proof) {
      return {
        success: false,
        error: `Cannot mark ${id} as resolved without concrete validation proof. Deduction alone is a hypothesis, not proof. Run the test/command and attach the observed output.`,
      }
    }
    const proposed = {
      ...po,
      secondaries: po.secondaries.map((s) => ({
        ...s,
        children: (s.children ?? []).map((t) =>
          t.id === target.id
            ? { ...t, status: "resolved" as SecondaryObjectiveStatus, validationProof: proof }
            : t,
        ),
      })),
    }
    const audit = runComplianceAudit(proposed)
    if (!audit.pass) {
      return {
        success: false,
        error: `Cannot mark ${id} as resolved: compliance audit failed — ${audit.violations.join(" | ")}`,
      }
    }
    target.validationProof = proof
    const prevBlocker = target.blocker?.trim()
    if (prevBlocker) {
      const key = normalizeFingerprintKey(prevBlocker)
      if (key) {
        po.fingerprints ??= []
        const existingFp = po.fingerprints.find((f) => f.key === key)
        const fix = (proof || "Resolved with validation proof").slice(0, 100)
        if (existingFp) {
          existingFp.status = "resolved"
          existingFp.fixRef = fix
        } else {
          po.fingerprints.push({
            key,
            symptom: prevBlocker,
            soRef: target.id,
            status: "resolved",
            fixRef: fix,
            createdAt: Date.now(),
          })
        }
      }
    }
  }

  if (updates.status !== undefined) target.status = updates.status
  if (updates.title !== undefined) target.title = updates.title.trim()
  if (updates.rationale !== undefined) target.rationale = updates.rationale.trim()
  if (updates.delegation !== undefined) target.delegation = updates.delegation
  if (updates.blocker !== undefined) target.blocker = updates.blocker?.trim() || undefined
  if (updates.validationProof !== undefined && updates.status !== "resolved") {
    target.validationProof = updates.validationProof?.trim() || undefined
  }

  // Cascada ascendente: Si el TO pasa a un estado abierto ('pending', 'exploring', 'blocked'):
  // 1. Si el padre SO estaba 'resolved', se reabre a 'exploring'.
  // 2. Si el PO estaba 'resolved' o en pausa, se reabre a 'exploring'.
  let poReopened = false
  let parentReopened = false
  const parentSO = po.secondaries.find((s) => (s.children ?? []).some((t) => t.id === target?.id))
  if (isOpenStatus(target.status)) {
    if (parentSO && parentSO.status === "resolved") {
      parentSO.status = "exploring"
      parentSO.updatedAt = Date.now()
      parentReopened = true
    }
    if (po.status === "resolved" || po.status === "presented_awaiting_confirmation") {
      po.status = "exploring"
      if (po.phase) po.phase.paused = false
      poReopened = true
    }
  }

  const now = Date.now()
  target.updatedAt = now
  po.updatedAt = now
  persistSessionObjectives(sessionID)
  return { success: true, objective: target, poReopened, parentReopened }
}

// ---------- Epistemic layer: findings, options, DoD, fingerprints (F-2..F-5, F-7) ----------

function normalizeEvidence(input: any): FindingEvidence {
  const now = Date.now()
  if (typeof input === "string") {
    return { type: "FILE_READ", source: input.trim(), capturedAt: now }
  }
  if (input && typeof input === "object") {
    const type = FINDING_EVIDENCE_TYPES.includes(input.type) ? input.type : "FILE_READ"
    return { type, source: String(input.source ?? "").trim(), capturedAt: now }
  }
  return { type: "FILE_READ", source: "", capturedAt: now }
}

export function addFinding(
  sessionID: string,
  input: {
    soRef?: string
    title?: string
    evidence?: any
    result?: string
    nextAction?: string
    delegation?: DelegationAssessment
    impactOnOption?: { optionId: string; newStatus: OptionStatus; reason: string }
    seeAlso?: string[]
    supersedes?: string[]
    spawnedBy?: string
  },
): { success: boolean; error?: string; warning?: string; finding?: Finding } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}. Call 'set_primary' first.` }
  }

  const soRef = (input.soRef ?? "PO").trim()
  if (soRef !== "PO" && !po.secondaries.some((s) => s.id.toLowerCase() === soRef.toLowerCase())) {
    return { success: false, error: `Finding soRef '${soRef}' does not match any secondary objective id (or 'PO').` }
  }

  const evidence = normalizeEvidence(input.evidence)
  const violations = validateFindingFields({
    title: input.title,
    result: input.result,
    nextAction: input.nextAction,
    evidenceSource: evidence.source,
  })
  if (violations.length > 0) {
    return { success: false, error: `Finding rejected (anti-placeholder validation): ${violations.join(" | ")}` }
  }

  if (!input.delegation) {
    return {
      success: false,
      error:
        "Finding rejected: delegation assessment is mandatory. You must provide 'delegation: { mode: 'main' | 'subagent', justification: '...' }' to explicitly evaluate whether subagent delegation is appropriate.",
    }
  }
  const delMode = input.delegation.mode
  const delJust = typeof input.delegation.justification === "string" ? input.delegation.justification.trim() : ""
  if (delMode !== "main" && delMode !== "subagent") {
    return { success: false, error: "Finding rejected: delegation mode must be 'main' or 'subagent'." }
  }
  if (delJust.length < 10) {
    return {
      success: false,
      error: `Finding rejected: delegation justification must be >= 10 characters (got ${delJust.length}).`,
    }
  }
  if (isPlaceholder(delJust)) {
    return {
      success: false,
      error: `Finding rejected: delegation justification looks like a placeholder: "${delJust}".`,
    }
  }

  po.findings ??= []

  // Search-before-write (F-2): the tool decides whether this is new, an extension, or a duplicate.
  const query = `${input.title?.trim() ?? ""} ${input.result?.trim() ?? ""}`
  const hits = searchFindings(po.findings, query)
  const top = hits[0]
  if (top && top.score >= SEARCH_ATTACH_THRESHOLD) {
    const candidates = hits
      .slice(0, 3)
      .map((h) => `${h.findingId} (score ${h.score})`)
      .join(", ")
    return {
      success: false,
      error: `Search-before-write: this finding is NOT new. Existing candidate(s): ${candidates}. Extend ${top.findingId} in place with action 'update_finding' (findingId=${top.findingId}) instead of creating a duplicate.`,
    }
  }

  // F-5 invariant: if the finding changes an option, the option is updated FIRST (single operation).
  if (input.impactOnOption) {
    const optionResult = applyOptionChange(po, input.impactOnOption.optionId, {
      status: input.impactOnOption.newStatus,
      reason: input.impactOnOption.reason,
    })
    if (!optionResult.success) {
      return { success: false, error: `Finding rejected: option update failed — ${optionResult.error}` }
    }
  }

  const now = Date.now()
  const finding: Finding = {
    id: nextFindingId(po.findings),
    soRef,
    title: input.title!.trim(),
    evidence,
    result: input.result!.trim(),
    impactOnOption: input.impactOnOption,
    nextAction: input.nextAction!.trim(),
    delegation: input.delegation,
    seeAlso: top && top.score >= SEARCH_NOVEL_THRESHOLD ? [top.findingId, ...(input.seeAlso ?? [])] : (input.seeAlso ?? []),
    supersedes: input.supersedes ?? [],
    spawnedBy: input.spawnedBy,
    lifecycle: "NEW",
    createdAt: now,
    updatedAt: now,
  }
  po.findings.push(finding)
  po.updatedAt = now
  persistSessionObjectives(sessionID)

  const warning =
    top && top.score >= SEARCH_NOVEL_THRESHOLD
      ? `Similarity warning: ${top.findingId} scored ${top.score} (0.55–0.68 band). Cross-referenced via seeAlso; verify this is genuinely new knowledge.`
      : undefined

  return { success: true, finding, warning }
}

export function updateFinding(
  sessionID: string,
  findingId: string,
  updates: {
    title?: string
    result?: string
    nextAction?: string
    delegation?: DelegationAssessment
    evidence?: any
    seeAlso?: string[]
    supersedes?: string[]
    subsumedBy?: string
    impactOnOption?: { optionId: string; newStatus: OptionStatus; reason: string }
  },
): { success: boolean; error?: string; finding?: Finding } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }
  const finding = (po.findings ?? []).find((f) => f.id.toLowerCase() === findingId.trim().toLowerCase())
  if (!finding) {
    return { success: false, error: `Finding ${findingId} not found.` }
  }

  if (updates.subsumedBy) {
    finding.lifecycle = "SUBSUMED"
    finding.supersedes = [...new Set([...finding.supersedes, updates.subsumedBy.trim()])]
  } else {
    // In-place extension (C-2): a finding is never duplicated — it is extended where it lives.
    if (updates.title?.trim()) finding.title = updates.title.trim()
    if (updates.result?.trim()) finding.result = updates.result.trim()
    if (updates.nextAction?.trim()) finding.nextAction = updates.nextAction.trim()
    if (updates.delegation !== undefined) {
      if (updates.delegation) {
        const mode = updates.delegation.mode
        const just = typeof updates.delegation.justification === "string" ? updates.delegation.justification.trim() : ""
        if (mode !== "main" && mode !== "subagent") {
          return { success: false, error: `${findingId}: delegation mode must be 'main' or 'subagent'.` }
        }
        if (just.length < 10) {
          return { success: false, error: `${findingId}: delegation justification must be >= 10 characters (got ${just.length}).` }
        }
        if (isPlaceholder(just)) {
          return { success: false, error: `${findingId}: delegation justification looks like a placeholder: "${just}".` }
        }
      }
      finding.delegation = updates.delegation
    }
    if (updates.evidence !== undefined) finding.evidence = normalizeEvidence(updates.evidence)
    if (updates.seeAlso) finding.seeAlso = [...new Set([...finding.seeAlso, ...updates.seeAlso.map((s) => s.trim())])]
    if (updates.supersedes) finding.supersedes = [...new Set([...finding.supersedes, ...updates.supersedes.map((s) => s.trim())])]
    if (updates.impactOnOption) {
      const optionResult = applyOptionChange(po, updates.impactOnOption.optionId, {
        status: updates.impactOnOption.newStatus,
        reason: updates.impactOnOption.reason,
      })
      if (!optionResult.success) {
        return { success: false, error: `Finding update rejected: option update failed — ${optionResult.error}` }
      }
      finding.impactOnOption = updates.impactOnOption
    }
    finding.lifecycle = "EXTENDED"
  }

  finding.updatedAt = Date.now()
  po.updatedAt = Date.now()
  persistSessionObjectives(sessionID)
  return { success: true, finding }
}

function applyOptionChange(
  po: PrimaryObjective,
  optionId: string,
  changes: { status?: OptionStatus; result?: string; reason?: string; proofRef?: string },
): { success: boolean; error?: string } {
  po.options ??= []
  const option = po.options.find((o) => o.id.toLowerCase() === optionId.trim().toLowerCase())
  if (!option) {
    return { success: false, error: `Option ${optionId} not found. Register it with action 'add_option' first.` }
  }
  const newStatus = changes.status
  if (newStatus === "SUCCESSFUL") {
    const proof = changes.proofRef?.trim() || option.proofRef?.trim() || ""
    if (!proof) {
      return { success: false, error: `Option ${option.id} cannot be SUCCESSFUL without proofRef.` }
    }
    const existing = po.options.find((o) => o.status === "SUCCESSFUL" && o.id !== option.id)
    if (existing) {
      return { success: false, error: `Option ${option.id} cannot be SUCCESSFUL: ${existing.id} already is (at most one per topic).` }
    }
    option.proofRef = proof
  }
  if (newStatus === "DISCARDED" && !(changes.reason?.trim() || option.reason?.trim() || "")) {
    return { success: false, error: `Option ${option.id} cannot be DISCARDED without a reason (silent discard is prohibited).` }
  }
  if (changes.result?.trim()) option.result = changes.result.trim()
  if (changes.reason?.trim()) option.reason = changes.reason.trim()
  if (newStatus) option.status = newStatus
  option.updatedAt = Date.now()

  // F-5 invariant: SUCCESSFUL auto-cancels every open sibling in the same operation.
  // Preserves DISCARDED options (and already SUCCESSFUL/CANCELLED ones) to avoid erasing their documented rationale.
  if (newStatus === "SUCCESSFUL") {
    for (const sibling of po.options) {
      if (sibling.id === option.id) continue
      if (sibling.status === "SUCCESSFUL" || sibling.status === "CANCELLED" || sibling.status === "DISCARDED") continue
      sibling.status = "CANCELLED"
      sibling.result = `Cancelled: ${option.id} reached SUCCESSFUL.`
      sibling.updatedAt = Date.now()
    }
  }
  return { success: true }
}

export function addOption(
  sessionID: string,
  statement: string,
  status?: OptionStatus,
  result?: string,
): { success: boolean; error?: string; option?: Option } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}. Call 'set_primary' first.` }
  }
  const clean = statement.trim()
  if (clean.length < 10) {
    return { success: false, error: `Option statement must be a complete candidate description (>=10 chars, got ${clean.length}).` }
  }
  po.options ??= []
  const now = Date.now()
  const option: Option = {
    id: nextOptionId(po.options),
    statement: clean,
    status: status ?? "PENDING",
    result: result?.trim() ?? "",
    createdAt: now,
    updatedAt: now,
  }
  po.options.push(option)
  po.updatedAt = now
  persistSessionObjectives(sessionID)
  return { success: true, option }
}

export function updateOption(
  sessionID: string,
  optionId: string,
  changes: { status?: OptionStatus; result?: string; reason?: string; proofRef?: string },
): { success: boolean; error?: string; option?: Option } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }
  const result = applyOptionChange(po, optionId, changes)
  if (!result.success) return result
  po.updatedAt = Date.now()
  persistSessionObjectives(sessionID)
  const option = (po.options ?? []).find((o) => o.id.toLowerCase() === optionId.trim().toLowerCase())
  return { success: true, option }
}

export function addFingerprint(
  sessionID: string,
  input: { normalizedKey?: string; symptom?: string; soRef?: string; status?: string; fixRef?: string },
): { success: boolean; error?: string; fingerprint?: Fingerprint } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}. Call 'set_primary' first.` }
  }
  const symptom = input.symptom?.trim()
  if (!symptom) return { success: false, error: "Fingerprint requires a symptom description." }
  const soRef = input.soRef?.trim()
  if (!soRef) return { success: false, error: "Fingerprint requires the owning objective id (soRef, e.g. 'SO-2')." }
  const fixRef = input.fixRef?.trim()
  if (!fixRef) return { success: false, error: "Fingerprint requires the finding id that resolved the blocker (fixRef)." }
  const key = input.normalizedKey?.trim() || normalizeFingerprintKey(symptom)
  if (!key) return { success: false, error: "Fingerprint key is empty after normalization." }

  po.fingerprints ??= []
  const existing = po.fingerprints.find((fp) => fp.key === key)
  if (existing) {
    existing.symptom = symptom
    existing.soRef = soRef
    existing.status = input.status?.trim() || existing.status
    existing.fixRef = fixRef
  } else {
    po.fingerprints.push({ key, symptom, soRef, status: input.status?.trim() ?? "resolved", fixRef, createdAt: Date.now() })
  }
  po.updatedAt = Date.now()
  persistSessionObjectives(sessionID)
  return { success: true, fingerprint: existing ?? po.fingerprints[po.fingerprints.length - 1] }
}

export function setDoDCriteria(
  sessionID: string,
  criteria: { id?: string; statement?: string; verifiableBy?: string; satisfiedBy?: string[]; proofRef?: string }[],
): { success: boolean; error?: string; dod?: DoDCriterion[] } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }
  po.dod ??= []
  if (
    po.dod.length === 1 &&
    po.dod[0].id === "D1" &&
    po.dod[0].statement === po.definitionOfDone &&
    !po.dod[0].proofRef
  ) {
    po.dod = []
  }
  for (const item of criteria) {
    const statement = item.statement?.trim()
    const cleanId = item.id?.trim()
    const existing = cleanId ? po.dod.find((c) => c.id.toLowerCase() === cleanId.toLowerCase()) : undefined
    let proofRef = item.proofRef !== undefined ? (item.proofRef?.trim() || undefined) : undefined

    const satisfiedByList = item.satisfiedBy
      ? item.satisfiedBy.map((s) => s.trim())
      : (existing?.satisfiedBy ?? [])

    if (!proofRef && satisfiedByList.length > 0) {
      const resolvedProofs = po.secondaries
        .filter((s) => satisfiedByList.includes(s.id) && s.status === "resolved" && s.validationProof?.trim())
        .map((s) => `${s.id}: ${s.validationProof!.trim()}`)
      if (resolvedProofs.length > 0) {
        proofRef = resolvedProofs.join("; ")
      }
    }

    if (existing) {
      if (statement) existing.statement = statement
      if (item.verifiableBy?.trim()) existing.verifiableBy = item.verifiableBy.trim()
      existing.satisfiedBy = satisfiedByList
      if (proofRef !== undefined) existing.proofRef = proofRef
    } else {
      if (!statement) continue
      po.dod.push({
        id: cleanId || nextDoDCriterionId(po.dod),
        statement,
        verifiableBy: item.verifiableBy?.trim() ?? "",
        satisfiedBy: satisfiedByList,
        proofRef,
      })
    }
  }
  po.updatedAt = Date.now()
  persistSessionObjectives(sessionID)
  return { success: true, dod: po.dod }
}

// F-9: record a normalized read action against the active SO; repeat keys queue a warning.
function recordToolAction(sessionID: string, tool: string, input: any): void {
  const po = sessionObjectives.get(sessionID)
  if (!po) return
  const active =
    po.secondaries.find((s) => s.status === "exploring") ?? po.secondaries.find((s) => s.status === "pending")
  if (!active) return

  const normalizedKey = normalizeToolActionKey(tool, input)
  active.actionLog ??= []
  const entry = active.actionLog.find((e) => e.normalizedKey === normalizedKey)
  if (entry) {
    entry.count += 1
    entry.lastAt = Date.now()
    if (entry.count >= 2) {
      const warnings = actionWarnings.get(sessionID) ?? []
      const warning = `Repeated action on ${active.id}: ${normalizedKey} executed ${entry.count} times. Value-first check: does skipping it change the known conclusion? If not, stop repeating it.`
      if (!warnings.includes(warning)) warnings.push(warning)
      actionWarnings.set(sessionID, warnings)
    }
  } else {
    active.actionLog.push({ kind: tool, normalizedKey, count: 1, lastAt: Date.now() })
  }
  po.updatedAt = Date.now()
  persistSessionObjectives(sessionID)
}

function normalizeToolActionKey(tool: string, input: any): string {
  const value = (key: string) => (typeof input?.[key] === "string" ? input[key] : "")
  switch (tool) {
    case "read":
      return `read:${value("path")}`
    case "list":
      return `list:${value("path")}`
    case "glob":
      return `glob:${value("pattern")}`
    case "grep":
      return `grep:${value("pattern")}:${value("path")}`
    case "websearch":
      return `websearch:${value("query")}`
    case "webfetch":
      return `webfetch:${value("url")}`
    default:
      try {
        return `${tool}:${JSON.stringify(input ?? {}).slice(0, 120)}`
      } catch {
        return tool
      }
  }
}

// F-10: session generator hook for one-shot /btw evaluations
let sessionGenerator: ((input: { sessionID: string; prompt: string }) => Promise<{ text: string } | string>) | undefined

// In-flight evaluation dedup: prevents concurrent duplicate calls for the same file in the same session
const inFlightEvaluations = new Map<string, Set<string>>()

export function setSessionGenerator(
  gen: ((input: { sessionID: string; prompt: string }) => Promise<{ text: string } | string>) | undefined,
): void {
  sessionGenerator = gen
}

// Mutex & rate-limiting guards for one-shot relevance evaluation to protect llama.cpp slots & KV cache
let isLlamaCppRelevanceInFlight = false
let lastLlamaCppRelevanceAt = 0
const RELEVANCE_EVALUATION_COOLDOWN_MS = 3_000
const sessionModelMap = new Map<string, string>()

export function setSessionModel(sessionID: string, modelID: string) {
  if (sessionID && modelID) sessionModelMap.set(sessionID, modelID)
}

export function getSessionModel(sessionID: string): string | undefined {
  return sessionModelMap.get(sessionID)
}

function resolveLlamaCppOrigin(): string {
  const env =
    process.env.OPENCODE_LLAMACPP_BASE_URL ||
    process.env.LLAMACPP_BASE_URL ||
    process.env.LLAMACPP_URL
  if (env) return env.replace(/\/+$/, "")
  return "http://127.0.0.1:9999"
}

export async function queryIsolatedLlamaCppRelevance(path: string, options?: { force?: boolean; model?: string }): Promise<boolean | undefined> {
  const now = Date.now()
  if (!options?.force && (isLlamaCppRelevanceInFlight || now - lastLlamaCppRelevanceAt < RELEVANCE_EVALUATION_COOLDOWN_MS)) {
    return undefined // Fallback to heuristic to prevent slot thrashing & request bursts
  }

  isLlamaCppRelevanceInFlight = true
  lastLlamaCppRelevanceAt = now

  try {
    const origin = resolveLlamaCppOrigin()
    // 1. Inspect slots: verify slot 1 is idle and we have at least 2 slots
    const slotsUrl = origin.endsWith("/v1") ? `${origin.slice(0, -3)}/slots` : `${origin}/slots`
    try {
      const slotsRes = await fetch(slotsUrl, { signal: AbortSignal.timeout(1000) })
      if (slotsRes.ok) {
        const slots = (await slotsRes.json()) as any[]
        if (Array.isArray(slots)) {
          // If server has only 1 slot, or slot 1 is currently busy, DO NOT send one-shot!
          if (slots.length < 2) return undefined
          if (slots[1]?.is_processing === true) return undefined
        }
      }
    } catch {
      // /slots probe failed or not supported; continue cautiously
    }

    // Resolve model name if not provided
    let modelName = options?.model
    if (!modelName) {
      try {
        const statusUrl = origin.endsWith("/v1") ? `${origin.slice(0, -3)}/status` : `${origin}/status`
        const statusRes = await fetch(statusUrl, { signal: AbortSignal.timeout(800) })
        if (statusRes.ok) {
          const statusJson = (await statusRes.json()) as any
          modelName = statusJson?.model?.modelID || statusJson?.model?.name || statusJson?.active_model
        }
      } catch {}
    }

    // 2. Send isolated one-shot (<60 tokens, stream: false, max_tokens: 5, id_slot: 1)
    const completionsUrl = origin.endsWith("/v1") ? `${origin}/chat/completions` : `${origin}/v1/chat/completions`
    const prompt = `File: "${path}"\nDoes this file modify public APIs, system architecture, configuration schemas, or CLI behavior that strictly requires updating project documentation? Answer strictly YES or NO.`

    const res = await fetch(completionsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(modelName ? { model: modelName } : {}),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 5,
        temperature: 0.0,
        stream: false,
        id_slot: 1, // Explicitly pin to slot 1 so Slot 0's KV cache is 100% protected!
      }),
      signal: AbortSignal.timeout(2500),
    })

    if (!res.ok) return undefined
    const json = (await res.json()) as any
    const text = json?.choices?.[0]?.message?.content ?? ""
    if (/^\s*YES\b/i.test(text.trim())) return true
    if (/^\s*NO\b/i.test(text.trim())) return false
    return undefined
  } catch {
    return undefined
  } finally {
    isLlamaCppRelevanceInFlight = false
  }
}

async function evaluateChangeDocumentationRelevance(sessionID: string, path: string): Promise<boolean> {
  // If it's a test, mock, or lockfile, never require documentation
  const { isEphemeralOrTestFile } = await import("./objectives-model.js")
  if (isEphemeralOrTestFile(path)) return false

  // Si el modelo activo pertenece a esca / mlx (o modelos locales sin slots separados),
  // se asume directamente relevante cualquier archivo no efímero/test sin realizar ninguna llamada HTTP one-shot.
  // Esto protege la memoria Metal de MLX y previene la evicción del LRUPromptCache (10 secuencias max).
  const sessionModel = sessionModelMap.get(sessionID) ?? ""
  const isMlxOrEsca =
    sessionModel.startsWith("esca/") ||
    sessionModel.startsWith("escha/") ||
    sessionModel.startsWith("mlx/") ||
    sessionModel.toLowerCase().includes("escha") ||
    sessionModel.toLowerCase().includes("esca") ||
    sessionModel.toLowerCase().includes("mlx")

  if (isMlxOrEsca) {
    return true
  }

  // If mock/custom sessionGenerator was provided (e.g. tests)
  if (sessionGenerator) {
    try {
      const prompt = [
        "You are an automated software architecture gatekeeper.",
        `Question: Are the modifications to file "${path}" relevant to the project structure, features, public contracts, or behavior such that documentation should be updated?`,
        "Answer strictly YES or NO followed by a brief reason.",
      ].join("\n\n")

      const res = await sessionGenerator({ sessionID, prompt })
      const text = typeof res === "string" ? res : (res as any)?.text ?? ""
      if (/^\s*YES\b/i.test(text.trim())) return true
      if (/^\s*NO\b/i.test(text.trim())) return false
    } catch {
      // generator failure: fall back to heuristic
    }
  } else {
    // Opción B: Evaluación one-shot aislada y protegida en llamacpp (id_slot: 1, <60 tokens, con modelo activo)
    // Solo se invoca para backends de llamacpp donde id_slot 1 aísla la petición del slot 0.
    const isolatedResult = await queryIsolatedLlamaCppRelevance(path, { model: sessionModel || undefined })
    if (isolatedResult !== undefined) {
      return isolatedResult
    }
  }

  // Fallback: heuristic relevance detection
  const { isRelevantProjectFile } = await import("./objectives-model.js")
  return isRelevantProjectFile(path)
}

function trackTouchedFile(sessionID: string, path: string): void {
  const po = sessionObjectives.get(sessionID)
  if (!po || !path) return
  po.touchedFiles ??= []
  if (!po.touchedFiles.includes(path)) po.touchedFiles.push(path)
  const active =
    po.secondaries.find((s) => s.status === "exploring") ?? po.secondaries.find((s) => s.status === "pending")
  if (active) {
    active.touchedFiles ??= []
    if (!active.touchedFiles.includes(path)) active.touchedFiles.push(path)
    if (active.affectedResources?.files && active.affectedResources.files.length > 0) {
      const declared = active.affectedResources.files
      const matches = declared.some((f) => path.endsWith(f) || f.endsWith(path) || path.includes(f))
      if (!matches) {
        active.blastRadiusViolations ??= []
        if (!active.blastRadiusViolations.includes(path)) {
          active.blastRadiusViolations.push(path)
        }
      }
    }
  }

  // OPTIMIZACIÓN ASIMÉTRICA:
  // 1. Si el archivo YA está marcado como relevante en po.relevantDocumentableFiles,
  //    permanece relevante durante toda la sesión. NO se vuelve a evaluar (costo cero).
  // 2. Si aún NO está marcado como relevante, una modificación posterior puede cambiar su estado
  //    (de no relevante a relevante). Solo se evita la llamada concurrente si ya hay una en curso.
  const alreadyRelevant = po.relevantDocumentableFiles?.includes(path) ?? false
  if (alreadyRelevant) {
    po.updatedAt = Date.now()
    persistSessionObjectives(sessionID)
    return
  }

  // Evitar llamadas duplicadas concurrentes mientras se está evaluando el archivo
  let sessionInFlight = inFlightEvaluations.get(sessionID)
  if (!sessionInFlight) {
    sessionInFlight = new Set<string>()
    inFlightEvaluations.set(sessionID, sessionInFlight)
  }

  if (!sessionInFlight.has(path)) {
    sessionInFlight.add(path)
    void evaluateChangeDocumentationRelevance(sessionID, path)
      .then((isRelevant) => {
        if (isRelevant) {
          const current = sessionObjectives.get(sessionID)
          if (current) {
            current.relevantDocumentableFiles ??= []
            if (!current.relevantDocumentableFiles.includes(path)) {
              current.relevantDocumentableFiles.push(path)
              persistSessionObjectives(sessionID)
            }
          }
        }
      })
      .finally(() => {
        sessionInFlight?.delete(path)
      })
      .catch(() => {})
  }

  po.updatedAt = Date.now()
  persistSessionObjectives(sessionID)
}

// F-6: plan pause / resume / checkpoint state machine.
export function presentPlan(sessionID: string, reason?: string): { success: boolean; error?: string; po?: PrimaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }
  const now = Date.now()
  po.status = "presented_awaiting_confirmation"
  po.phase = { paused: true, since: now, checkpointAt: po.phase?.checkpointAt, reason: reason?.trim() || undefined }
  po.updatedAt = now
  persistSessionObjectives(sessionID)
  return { success: true, po }
}

export function resumePlan(sessionID: string, note?: string): { success: boolean; error?: string; po?: PrimaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }
  const now = Date.now()
  if (po.status === "presented_awaiting_confirmation") po.status = "exploring"
  po.phase = { ...po.phase, paused: false, reason: note?.trim() || po.phase?.reason }
  po.updatedAt = now
  persistSessionObjectives(sessionID)
  return { success: true, po }
}

export function makeCheckpoint(sessionID: string, note?: string): { success: boolean; error?: string; report?: string; po?: PrimaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }
  const since = po.phase?.checkpointAt ?? 0
  const completed: string[] = []
  for (const so of po.secondaries) {
    if (so.status === "resolved" && so.updatedAt > since) {
      completed.push(`${so.id} (proof: ${(so.validationProof ?? "—").slice(0, 80)})`)
    }
    for (const t of so.children ?? []) {
      if (t.status === "resolved" && t.updatedAt > since) completed.push(`${t.id}`)
    }
  }
  const newFindings = (po.findings ?? []).filter((f) => f.createdAt > since).map((f) => f.id)
  const dodEval = evaluateDoD(po)
  const satisfied = dodEval.criteria.filter((c) => c.satisfied).length
  const open = po.secondaries
    .filter((s) => s.status === "pending" || s.status === "exploring" || s.status === "blocked")
    .map((s) => `${s.id} [${s.status.toUpperCase()}]`)

  const lines: string[] = [
    "### Phase Checkpoint (derived from the objective tree only)",
    `- PO: ${po.title} [${po.status.toUpperCase()}] — DoD: ${satisfied}/${dodEval.criteria.length} criterion(s) satisfied`,
    `- Completed since last checkpoint (${since > 0 ? new Date(since).toISOString() : "start"}): ${completed.length > 0 ? completed.join(", ") : "(none)"}`,
  ]
  if (newFindings.length > 0) lines.push(`- New findings: ${newFindings.join(", ")}`)
  lines.push(`- Open objectives: ${open.length > 0 ? open.join(", ") : "(none)"}`)
  const next = nextConcreteAction(po)
  if (next) lines.push(`**Next concrete action:** ${next}`)

  const now = Date.now()
  po.phase = { paused: true, since: now, checkpointAt: now, reason: note?.trim() || undefined }
  po.updatedAt = now
  persistSessionObjectives(sessionID)

  return {
    success: true,
    po,
    report: `${lines.join("\n")}\nPAUSED: present this checkpoint to the user and call 'resume_plan' with their instruction to continue.`,
  }
}

// F-1: post-compaction / resume sync — the persistent store wins over in-memory state.
export async function syncSessionObjectives(sessionID: string): Promise<{ success: boolean; error?: string; report?: string; po?: PrimaryObjective }> {
  if (!activeStore) {
    const po = sessionObjectives.get(sessionID)
    return {
      success: true,
      po,
      report: "No persistent store available in this context; the in-memory tree is kept as-is.",
    }
  }
  const doc = await activeStore.load(sessionID)
  if (!doc) {
    return {
      success: true,
      po: sessionObjectives.get(sessionID),
      report: "No persisted document found for this session; nothing to hydrate.",
    }
  }
  const inMem = sessionObjectives.get(sessionID)
  const divergences: string[] = []
  if (inMem) {
    if (inMem.status !== doc.status) divergences.push(`PO status: memory=${inMem.status} store=${doc.status} (store wins)`)
    const memById = new Map(inMem.secondaries.map((s) => [s.id.toLowerCase(), s]))
    for (const so of doc.secondaries as SecondaryObjective[]) {
      const m = memById.get(so.id.toLowerCase())
      if (!m) divergences.push(`${so.id}: missing in memory (store wins)`)
      else if (m.status !== so.status) divergences.push(`${so.id}: memory=${m.status} store=${so.status} (store wins)`)
    }
    for (const m of inMem.secondaries) {
      if (!(doc.secondaries as SecondaryObjective[]).some((s) => s.id.toLowerCase() === m.id.toLowerCase())) {
        divergences.push(`${m.id}: missing in store (dropped)`)
      }
    }
  }
  const repairs = repairDocumentInvariants(doc)
  const po = doc as unknown as PrimaryObjective
  sessionObjectives.set(sessionID, po)
  persistSessionObjectives(sessionID)

  // Pre-warm embeddings cache in background for all hydrated findings
  if (Array.isArray(po.findings) && po.findings.length > 0) {
    void warmUpFindingsEmbeddings(po.findings).catch(() => {})
  }

  const lines: string[] = [
    `Hydrated from persistent store: ${doc.secondaries.length} SO(s), ${(doc.findings ?? []).length} finding(s), ${(doc.options ?? []).length} option(s), ${(doc.fingerprints ?? []).length} fingerprint(s).`,
  ]
  if (divergences.length > 0) lines.push(`Divergences detected (store won): ${divergences.join("; ")}`)
  if (repairs.length > 0) lines.push(`Invariants repaired: ${repairs.join("; ")}`)
  if (divergences.length === 0 && repairs.length === 0) lines.push("State coherent; no divergence detected.")

  return { success: true, po, report: lines.join("\n") }
}

export function exportSession(sessionID: string, topicKey?: string): { success: boolean; error?: string; payload?: string; report?: string; po?: PrimaryObjective } {
  const po = sessionObjectives.get(sessionID)
  if (!po) {
    return { success: false, error: `No active objective tree found for session ${sessionID}.` }
  }
  if (topicKey?.trim()) {
    po.topicKey = topicKey.trim()
    po.updatedAt = Date.now()
    persistSessionObjectives(sessionID)
  }
  return {
    success: true,
    po,
    payload: JSON.stringify({ version: 1, ...po }),
    report: renderProjection(po),
  }
}

export function importSession(
  sessionID: string,
  source: { topicKey?: string; tree?: string },
): { success: boolean; error?: string; report?: string; po?: PrimaryObjective } {
  let doc: Record<string, any> | undefined
  if (source.tree?.trim()) {
    try {
      doc = parseDocument(JSON.parse(source.tree.trim()))
    } catch {
      return { success: false, error: "import_tree: 'tree' is not valid JSON." }
    }
  } else if (source.topicKey?.trim() && activeStore) {
    // Synchronous wrapper: the store is async; import via the async path in the tool layer.
    return { success: false, error: "import_tree with topicKey is handled asynchronously by the tool action." }
  }
  if (!doc) {
    return { success: false, error: "import_tree: provide 'tree' (serialized JSON) or 'topicKey'." }
  }
  const repairs = repairDocumentInvariants(doc)
  const po = doc as unknown as PrimaryObjective
  sessionObjectives.set(sessionID, po)
  persistSessionObjectives(sessionID)
  const report = `Imported tree: ${doc.secondaries.length} SO(s), ${(doc.findings ?? []).length} finding(s), ${(doc.options ?? []).length} option(s).${repairs.length > 0 ? ` Repairs: ${repairs.join("; ")}` : ""}`
  return { success: true, po, report }
}

// ---------- Rendering ----------

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
      const delBadge = so.delegation ? ` [${so.delegation.mode}]` : ""
      lines.push(`- **${so.id}** ${statusBadge}${delBadge} ${so.title}`)
      lines.push(`  - *Rationale:* ${so.rationale}`)
      if (so.delegation) {
        lines.push(`  - 🤖 *Delegation (${so.delegation.mode}):* ${so.delegation.justification}`)
      }
      if (so.blocker) {
        lines.push(`  - ⚠️ *Blocker:* ${so.blocker}`)
      }
      if (so.validationProof) {
        lines.push(`  - ✅ *Validation Proof:* ${so.validationProof}`)
      }
      if (so.blastRadiusViolations && so.blastRadiusViolations.length > 0) {
        lines.push(`  - ⚠️ *Blast Radius Alert:* Modified files outside scope: ${so.blastRadiusViolations.join(", ")}`)
      }
      // Tertiary sub-objectives render as children of their parent SO, mirroring how SOs nest under the PO.
      for (const t of so.children ?? []) {
        const tertiaryBadge = `[${t.status.toUpperCase()}]`
        const tDelBadge = t.delegation ? ` [${t.delegation.mode}]` : ""
        lines.push(`  - **${t.id}** ${tertiaryBadge}${tDelBadge} ${t.title}`)
        lines.push(`    - *Rationale:* ${t.rationale}`)
        if (t.delegation) {
          lines.push(`    - 🤖 *Delegation (${t.delegation.mode}):* ${t.delegation.justification}`)
        }
        if (t.blocker) {
          lines.push(`    - ⚠️ *Blocker:* ${t.blocker}`)
        }
        if (t.validationProof) {
          lines.push(`    - ✅ *Validation Proof:* ${t.validationProof}`)
        }
      }
    }
  }

  if (Array.isArray(po.dod) && po.dod.length > 0) {
    lines.push(``, `**Definition of Done Criteria:**`)
    for (const crit of po.dod) {
      const hasProof = Boolean(crit.proofRef && crit.proofRef.trim().length > 0)
      const satText = crit.satisfiedBy && crit.satisfiedBy.length > 0 ? ` [satisfiedBy: ${crit.satisfiedBy.join(", ")}]` : ""
      if (hasProof) {
        lines.push(`- **[${crit.id}]** [PROVEN] ${crit.statement}${satText}`)
        lines.push(`  - ✅ *Proof:* ${crit.proofRef}`)
      } else {
        lines.push(`- **[${crit.id}]** [MISSING PROOF] ${crit.statement}${satText}`)
        if (crit.verifiableBy) {
          lines.push(`  - 🔍 *Verifiable By:* ${crit.verifiableBy}`)
        }
      }
    }
  }

  const activeFindings = (po.findings ?? []).filter((f) => f.lifecycle !== "SUBSUMED")
  if (activeFindings.length > 0) {
    lines.push(``, `**Findings:**`)
    for (const f of activeFindings) {
      const refs: string[] = []
      if (f.seeAlso.length > 0) refs.push(`see also ${f.seeAlso.join(", ")}`)
      if (f.lifecycle !== "NEW") refs.push(f.lifecycle)
      const fDelBadge = f.delegation ? ` [${f.delegation.mode}]` : ""
      lines.push(`- **${f.id}** [${f.soRef}]${fDelBadge} ${f.title} — ${f.result}${refs.length > 0 ? ` (${refs.join(" | ")})` : ""}`)
      if (f.delegation) {
        lines.push(`  - 🤖 *Delegation (${f.delegation.mode}):* ${f.delegation.justification}`)
      }
      lines.push(`  - *Next:* ${f.nextAction}`)
    }
  }

  if ((po.options ?? []).length > 0) {
    lines.push(``, `**Options:**`)
    for (const o of po.options ?? []) {
      lines.push(`- **${o.id}** [${o.status}] ${o.statement} — *Result:* ${o.result?.trim() || "—"}`)
    }
  }

  if ((po.fingerprints ?? []).length > 0) {
    lines.push(``, `**Blocker Fingerprints:**`)
    for (const fp of po.fingerprints ?? []) {
      lines.push(`- **${fp.key}** [${fp.status}] ${fp.symptom} (${fp.soRef}, fix: ${fp.fixRef})`)
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
    "Immediately after compaction finishes, when the session resumes, the VERY FIRST action the agent must perform is to read what has been accomplished so far in the objectives from this summary and call `objective_manage` to synchronize and update the active objectives before continuing execution. Call action 'sync' first: the tree is auto-persisted and the persistent store is the source of truth.",
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
  ]

  const activeFindings = (po.findings ?? []).filter((f) => f.lifecycle !== "SUBSUMED")
  if (activeFindings.length > 0) {
    lines.push("### Findings (preserve IDs, evidence and next actions)")
    for (const f of activeFindings) {
      lines.push(`- [${f.id}] [${f.soRef}] ${f.title} (Evidence: ${f.evidence.type} ${f.evidence.source}; Result: ${f.result}; Next: ${f.nextAction})`)
    }
    lines.push("")
  }

  if ((po.options ?? []).length > 0) {
    lines.push("### Options (preserve the live Result column)")
    for (const o of po.options ?? []) {
      lines.push(`- [${o.id}] [${o.status}] ${o.statement} (Result: ${o.result || "—"})`)
    }
    lines.push("")
  }

  lines.push(renderObjectiveTree(po))
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
          po = setPrimaryObjective(sessionID, input.title, input.definitionOfDone, initialSecondaries, {
            topicKey: typeof input.topicKey === "string" ? input.topicKey : undefined,
            dod: normalizeDoDInput(input.dodCriteria),
          })
          if (Array.isArray(input.secondaries)) {
            for (let i = 0; i < input.secondaries.length; i++) {
              const s = input.secondaries[i]
              const explicitId = (typeof s?.id === "string" && s.id.trim()) ? s.id.trim() : `SO-${i + 1}`
              const sTitle = s?.title?.trim() || s?.rationale?.trim() || explicitId || `Subtask ${i + 1}`
              const sRationale = s?.rationale?.trim() || s?.title?.trim() || "Planned subtask"
              const so = addSecondaryObjective(sessionID, sTitle, sRationale, explicitId, {
                affectedResources: normalizeAffectedResources(s?.affectedResources),
                preconditions: normalizePreconditions(s?.preconditions),
              })
              if (s.status && s.status !== "pending") {
                updateSecondaryObjective(sessionID, so.id, {
                  status: s.status,
                  blocker: s.blocker || undefined,
                  validationProof: s.validationProof || undefined,
                }, { bypassGates: true })
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
          const so = addSecondaryObjective(sessionID, sTitle, sRationale, explicitId, {
            affectedResources: normalizeAffectedResources(item?.affectedResources),
            preconditions: normalizePreconditions(item?.preconditions),
          })
          if (item.status && item.status !== "pending") {
            updateSecondaryObjective(sessionID, so.id, {
              status: item.status,
              blocker: item.blocker || undefined,
              validationProof: item.validationProof || undefined,
            }, { bypassGates: true })
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
            }, { bypassGates: true })
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
            }, { bypassGates: true })
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
          }, { bypassGates: true })
        }
      } else if (action === "complete_primary" || action === "resolve_primary" || action === "close_primary") {
        if (po) {
          updatePrimaryObjective(sessionID, { status: "resolved", validationProof: input.validationProof }, { bypassGates: true })
        }
      } else if (action === "update_primary") {
        if (po) {
          updatePrimaryObjective(sessionID, {
            status: input.status,
            title: input.title,
            definitionOfDone: input.definitionOfDone,
            validationProof: input.validationProof,
            dod: normalizeDoDInput(input.dodCriteria) ?? po.dod,
          }, { bypassGates: true })
        }
      } else if (action === "add_finding") {
        const added = addFinding(sessionID, {
          soRef: input.soRef,
          title: input.title,
          evidence: input.evidence,
          result: input.result,
          nextAction: input.nextAction,
          seeAlso: Array.isArray(input.seeAlso) ? input.seeAlso : undefined,
          supersedes: Array.isArray(input.supersedes) ? input.supersedes : undefined,
          spawnedBy: input.spawnedBy,
        })
        if (added.finding) po = sessionObjectives.get(sessionID)
      } else if (action === "update_finding") {
        if (input.findingId) {
          updateFinding(sessionID, input.findingId, {
            title: input.title,
            result: input.result,
            nextAction: input.nextAction,
            evidence: input.evidence,
            seeAlso: Array.isArray(input.seeAlso) ? input.seeAlso : undefined,
            supersedes: Array.isArray(input.supersedes) ? input.supersedes : undefined,
            subsumedBy: input.subsumedBy,
          })
          po = sessionObjectives.get(sessionID)
        }
      } else if (action === "add_option") {
        addOption(sessionID, String(input.statement ?? ""), input.optionStatus, input.result)
        po = sessionObjectives.get(sessionID)
      } else if (action === "update_option") {
        if (input.optionId) {
          updateOption(sessionID, input.optionId, {
            status: input.optionStatus,
            result: input.result,
            reason: input.reason,
            proofRef: input.proofRef,
          })
          po = sessionObjectives.get(sessionID)
        }
      } else if (action === "add_fingerprint") {
        addFingerprint(sessionID, {
          normalizedKey: input.normalizedKey,
          symptom: input.symptom,
          soRef: input.soRef,
          status: input.status,
          fixRef: input.fixRef,
        })
        po = sessionObjectives.get(sessionID)
      } else if (action === "update_dod" || action === "set_dod") {
        const criteria = normalizeDoDInput(input.dodCriteria)
        if (criteria) {
          setDoDCriteria(sessionID, criteria)
          po = sessionObjectives.get(sessionID)
        }
      } else if (action === "present_plan") {
        presentPlan(sessionID, input.reason)
        po = sessionObjectives.get(sessionID)
      } else if (action === "resume_plan") {
        resumePlan(sessionID, input.note)
        po = sessionObjectives.get(sessionID)
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
          }, { bypassGates: true })
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
          }, { bypassGates: true })
        }
      }

      if (po.secondaries.length > 0) {
        return po
      }
    }
  }

  return po
}

const ALLOWED_DOD_CRITERION_KEYS = new Set(["id", "statement", "verifiableBy", "satisfiedBy", "proofRef"])

function checkUnexpectedDoDKeys(raw: any): string[] {
  const warnings: string[] = []
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const keys = Object.keys(item)
    const unexpected = keys.filter((k) => !ALLOWED_DOD_CRITERION_KEYS.has(k))
    if (unexpected.length > 0) {
      warnings.push(
        `Unexpected property/properties ${unexpected.map((u) => `'${u}'`).join(", ")} found on criterion${item.id ? ` ${item.id}` : ""}. Allowed properties are strictly: 'id', 'statement', 'verifiableBy', 'satisfiedBy', 'proofRef'. Note: proof for DoD criteria must be provided using the key 'proofRef'.`,
      )
    }
  }
  return warnings
}

function normalizeDoDInput(raw: any, existingDod?: DoDCriterion[], secondaries?: Array<{ id: string; status: string; validationProof?: string }>): DoDCriterion[] | undefined {
  if (!raw) return undefined
  const list = Array.isArray(raw) ? raw : typeof raw === "object" ? [raw] : []
  if (list.length === 0) return undefined
  const criteria: DoDCriterion[] = []
  let counter = 0
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const rawId = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : undefined
    const existing = rawId && existingDod ? existingDod.find((c) => c.id.toLowerCase() === rawId.toLowerCase()) : undefined
    const statement = typeof item?.statement === "string" && item.statement.trim() ? item.statement.trim() : existing?.statement
    if (!statement) continue
    counter += 1

    let verifiableBy =
      typeof item?.verifiableBy === "string" && item.verifiableBy.trim()
        ? item.verifiableBy.trim()
        : (existing?.verifiableBy ?? "")

    let satisfiedBy: string[] = []
    if (Array.isArray(item?.satisfiedBy)) {
      satisfiedBy = item.satisfiedBy.map((s: any) => String(s).trim()).filter(Boolean)
    } else if (typeof item?.satisfiedBy === "string" && item.satisfiedBy.trim()) {
      satisfiedBy = item.satisfiedBy.split(/[,\s]+/).map((s: string) => s.trim()).filter(Boolean)
    } else if (existing?.satisfiedBy) {
      satisfiedBy = existing.satisfiedBy
    }

    let proofRef: string | undefined = undefined
    if (typeof item?.proofRef === "string" && item.proofRef.trim()) {
      proofRef = item.proofRef.trim()
    } else {
      // Defensive extraction: check if proofRef was embedded in verifiableBy or statement
      const searchTexts = [verifiableBy, statement]
      for (const text of searchTexts) {
        const match = text.match(/(?:proofRef|proof_ref)\s*[:=]\s*([^;\n]+)/i)
        if (match && match[1]?.trim()) {
          proofRef = match[1].trim()
          break
        }
      }
      if (!proofRef) {
        proofRef = existing?.proofRef
      }
    }

    // Defensive extraction: check if satisfiedBy was embedded in verifiableBy or statement
    if (satisfiedBy.length === 0) {
      const searchTexts = [verifiableBy, statement]
      for (const text of searchTexts) {
        const match = text.match(/(?:satisfiedBy|satisfied_by)\s*[:=]\s*(\[[^\]]+\]|[^;\n]+)/i)
        if (match && match[1]?.trim()) {
          const rawList = match[1].trim().replace(/^\[|\]$/g, "")
          satisfiedBy = rawList.split(/[,\s]+/).map((s: string) => s.trim()).filter(Boolean)
          break
        }
      }
    }

    // If proofRef is still empty and satisfiedBy points to resolved SOs, auto-inherit proofRef
    if (!proofRef && satisfiedBy.length > 0 && Array.isArray(secondaries)) {
      const matchingProofs = secondaries
        .filter((s) => satisfiedBy.includes(s.id) && s.status === "resolved" && s.validationProof?.trim())
        .map((s) => `${s.id}: ${s.validationProof!.trim()}`)
      if (matchingProofs.length > 0) {
        proofRef = matchingProofs.join("; ")
      }
    }

    criteria.push({
      id: rawId || existing?.id || `D${counter}`,
      statement,
      verifiableBy,
      satisfiedBy,
      proofRef,
    })
  }

  // If raw list was a partial update (e.g. only passed criteria to update/prove), merge with existingDod criteria that were not in raw list
  if (existingDod && existingDod.length > 0) {
    for (const ex of existingDod) {
      if (!criteria.some((c) => c.id.toLowerCase() === ex.id.toLowerCase())) {
        criteria.push({ ...ex })
      }
    }
    // Sort criteria by id (D1, D2, ...) for deterministic order
    criteria.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  }

  return criteria.length > 0 ? criteria : undefined
}

function normalizeAffectedResources(raw: any): AffectedResources | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const strArray = (value: any) => (Array.isArray(value) ? value.map((v: any) => String(v).trim()).filter(Boolean) : [])
  const files = strArray(raw.files)
  const envs = strArray(raw.envs)
  const dbSchemas = strArray(raw.dbSchemas)
  const services = strArray(raw.services)
  if (files.length + envs.length + dbSchemas.length + services.length === 0) return undefined
  return { files, envs, dbSchemas, services }
}

function normalizePreconditions(raw: any): Precondition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const result: Precondition[] = []
  for (const item of raw) {
    const actionClass = typeof item?.actionClass === "string" ? item.actionClass.trim() : ""
    if (!actionClass) continue
    const requires = Array.isArray(item?.requires) ? item.requires.map((r: any) => String(r).trim()).filter(Boolean) : []
    result.push({ actionClass, requires })
  }
  return result.length > 0 ? result : undefined
}

// ---------- Tool Input Schema using Effect Schema ----------

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
  Schema.Literal("add_finding"),
  Schema.Literal("update_finding"),
  Schema.Literal("search_findings"),
  Schema.Literal("add_option"),
  Schema.Literal("update_option"),
  Schema.Literal("add_fingerprint"),
  Schema.Literal("update_dod"),
  Schema.Literal("proof_dod"),
  Schema.Literal("export_tree"),
  Schema.Literal("import_tree"),
  Schema.Literal("sync"),
  Schema.Literal("present_plan"),
  Schema.Literal("resume_plan"),
  Schema.Literal("checkpoint"),
  Schema.Literal("audit"),
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
const OptionStatusSchema = Schema.Union([
  Schema.Literal("PENDING"),
  Schema.Literal("EXPLORING"),
  Schema.Literal("DISCARDED"),
  Schema.Literal("SUCCESSFUL"),
  Schema.Literal("CANCELLED"),
])
const FindingEvidenceTypeSchema = Schema.Union([
  Schema.Literal("COMMAND_OUTPUT"),
  Schema.Literal("QUERY_RESULT"),
  Schema.Literal("LOG_EXCERPT"),
  Schema.Literal("FILE_READ"),
  Schema.Literal("SCREENSHOT"),
])

const DoDCriterionInputSchema = Schema.Struct({
  id: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "Criterion id (e.g. 'D1'); auto-assigned when omitted" })),
  ),
  statement: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "What must be true for this criterion" })),
  ),
  verifiableBy: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "Specific command/query that proves it" })),
  ),
  satisfiedBy: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String)).pipe(Schema.annotate({ description: "SO ids that discharge the criterion" })),
  ),
  proofRef: Schema.optional(
    Schema.NullOr(Schema.String).pipe(Schema.annotate({ description: "Concrete proof (command output, exit code, artifact). Mandatory before complete_primary" })),
  ),
})

const PreconditionInputSchema = Schema.Struct({
  actionClass: Schema.String.pipe(Schema.annotate({ description: "Class of gated action (e.g. 'pdn-write', 'local-test')" })),
  requires: Schema.Array(Schema.String).pipe(Schema.annotate({ description: "Tokens/scripts/states required before the action counts toward proof" })),
})

const AffectedResourcesInputSchema = Schema.Struct({
  files: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)).pipe(Schema.annotate({ description: "Files in the blast radius" }))),
  envs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)).pipe(Schema.annotate({ description: "Environments: LOCAL, LAB, PDN, ..." }))),
  dbSchemas: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)).pipe(Schema.annotate({ description: "Database schemas touched" }))),
  services: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)).pipe(Schema.annotate({ description: "Services touched" }))),
})

const FindingEvidenceInputSchema = Schema.Struct({
  type: Schema.optional(
    FindingEvidenceTypeSchema.pipe(Schema.annotate({ description: "Evidence type (defaults to FILE_READ)" })),
  ),
  source: Schema.String.pipe(Schema.annotate({ description: "Exact source: file+lines, command, SQL, log excerpt — no interpretation" })),
})

export const DelegationInputSchema = Schema.Struct({
  mode: Schema.Union([Schema.Literal("main"), Schema.Literal("subagent")]).pipe(
    Schema.annotate({ description: "Execution target: 'main' (primary session thread) or 'subagent' (delegated child session)" }),
  ),
  justification: Schema.String.pipe(
    Schema.annotate({ description: "Concrete justification for the delegation choice (why main thread vs subagent given context and slots)" }),
  ),
})

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
  delegation: Schema.optional(
    Schema.NullOr(DelegationInputSchema).pipe(
      Schema.annotate({ description: "Assessment of subagent delegation vs main-thread execution" }),
    ),
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
  affectedResources: Schema.optional(
    Schema.NullOr(AffectedResourcesInputSchema).pipe(Schema.annotate({ description: "Blast radius of this SO (files, envs, db schemas, services)" })),
  ),
  preconditions: Schema.optional(
    Schema.NullOr(Schema.Array(PreconditionInputSchema)).pipe(
      Schema.annotate({ description: "Declarative gates: actionClass -> required tokens/scripts before it counts toward proof" }),
    ),
  ),
  justification: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Required when the SO title matches a resolved/discarded blocker fingerprint" }),
    ),
  ),
  preconditionsMet: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String)).pipe(
      Schema.annotate({ description: "actionClass values acknowledged as met; mandatory to resolve an SO that declares preconditions" }),
    ),
  ),
})

export const ObjectiveInputSchema = Schema.Struct({
  action: ObjectiveActionSchema.pipe(
    Schema.annotate({
      description:
        "Action to perform: 'set_primary' (establish Primary Objective and optional initial secondaries), 'complete_primary' (close resolved Primary Objective), 'add_secondary'/'update_secondary' (manage SOs), 'add_tertiary' (add a tertiary sub-objective under an SO: 'id' is the PARENT SO id), 'update_tertiary' (manage TOs: 'id' is the TO's own id), 'add_finding'/'update_finding'/'search_findings' (epistemic findings F-NNN with typed evidence and search-before-write), 'add_option'/'update_option' (multi-candidate options with a live Result column), 'add_fingerprint' (blocker fingerprints), 'update_dod'/'proof_dod' (decomposed Definition of Done criteria and direct proof attaching), 'export_tree' (serialized document + rendered projection), 'import_tree' (hydrate from topicKey or serialized tree), 'sync' (rehydrate from the persistent store after compaction/resume), 'present_plan'/'resume_plan'/'checkpoint' (plan pause and phase checkpoints), 'audit' (run the compliance audit on demand), or 'list'. An SO cannot be resolved while any of its tertiary sub-objectives is open; the PO cannot close until every SO and TO is closed and every DoD criterion has a proofRef.",
    }),
  ),
  title: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description:
          "Title of the Primary Objective (when action='set_primary'), a Secondary Objective (when action='add_secondary'), or a Finding (when action='add_finding'/'update_finding')",
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
  topicKey: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description:
          "Cross-session identity for the tree (e.g. 'outlook_bulk_triage'). Used by 'set_primary' (tag), 'export_tree' (register topic) and 'import_tree' (hydrate from topic)",
      }),
    ),
  ),
  dodCriteria: Schema.optional(
    Schema.NullOr(Schema.Array(DoDCriterionInputSchema)).pipe(
      Schema.annotate({
        description:
          "Decomposed Definition of Done criteria as an array of objects ({ id, statement, verifiableBy, satisfiedBy, proofRef }). Each field must be a separate property in the object. Use in 'set_primary' to establish, or in 'update_dod'/'update_primary' to upsert by id",
      }),
    ),
  ),
  dodProofs: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.String)).pipe(
      Schema.annotate({
        description:
          "Map of DoD criterion id to proofRef string, e.g. { 'D1': 'ls -la ... -> PASS', 'D2': '...' }. Usable in 'complete_primary', 'update_dod', and 'proof_dod'",
      }),
    ),
  ),
  evidence: Schema.optional(
    Schema.NullOr(Schema.Union([FindingEvidenceInputSchema, Schema.String])).pipe(
      Schema.annotate({
        description:
          "Typed evidence for a finding: { type: COMMAND_OUTPUT|QUERY_RESULT|LOG_EXCERPT|FILE_READ|SCREENSHOT, source } or a plain source string (treated as FILE_READ)",
      }),
    ),
  ),
  findingId: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Finding id (e.g. 'F-001') for 'update_finding'" }),
    ),
  ),
  optionId: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Option id (e.g. 'OPT-1') for 'update_option', or the option affected by a finding's impactOnOption" }),
    ),
  ),
  optionStatus: Schema.optional(
    Schema.NullOr(OptionStatusSchema).pipe(
      Schema.annotate({
        description: "Option status: 'PENDING', 'EXPLORING', 'DISCARDED', 'SUCCESSFUL', 'CANCELLED' (for 'add_option'/'update_option' and finding impactOnOption)",
      }),
    ),
  ),
  statement: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Option candidate statement (for 'add_option')" }),
    ),
  ),
  result: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description:
          "Literal finding result (for 'add_finding'/'update_finding') or the current known state for an option (for 'add_option'/'update_option' — the live Result column)",
      }),
    ),
  ),
  nextAction: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "One concrete executable next action (for findings)" }),
    ),
  ),
  soRef: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Owning objective of a finding/fingerprint: an SO id (e.g. 'SO-2') or 'PO'" }),
    ),
  ),
  reason: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description: "Mandatory reason for DISCARDED options; optional reason for 'present_plan'",
      }),
    ),
  ),
  proofRef: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description: "Proof reference for SUCCESSFUL options and DoD criteria (command output, log, artifact)",
      }),
    ),
  ),
  seeAlso: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String)).pipe(
      Schema.annotate({ description: "Cross-referenced finding ids (e.g. ['F-002'])" }),
    ),
  ),
  supersedes: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String)).pipe(
      Schema.annotate({ description: "Finding ids superseded by this one" }),
    ),
  ),
  subsumedBy: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Finding id that subsumes this one (marks it SUBSUMED; for 'update_finding')" }),
    ),
  ),
  spawnedBy: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Objective id that spawned this finding (e.g. 'SO-4')" }),
    ),
  ),
  normalizedKey: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Normalized blocker key for 'add_fingerprint' (auto-computed from symptom when omitted)" }),
    ),
  ),
  symptom: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Blocker symptom for 'add_fingerprint'" }),
    ),
  ),
  fixRef: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Finding id that resolved the blocker (for 'add_fingerprint')" }),
    ),
  ),
  query: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Search query for 'search_findings' (semantic/lexical match against existing findings)" }),
    ),
  ),
  justification: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({
        description: "Explicit justification required when opening an SO that matches a resolved/discarded blocker fingerprint",
      }),
    ),
  ),
  preconditionsMet: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String)).pipe(
      Schema.annotate({
        description: "actionClass values acknowledged as met; mandatory to resolve an SO that declares preconditions",
      }),
    ),
  ),
  affectedResources: Schema.optional(
    Schema.NullOr(AffectedResourcesInputSchema).pipe(
      Schema.annotate({ description: "Blast radius of an SO (files, envs, db schemas, services)" }),
    ),
  ),
  preconditions: Schema.optional(
    Schema.NullOr(Schema.Array(PreconditionInputSchema)).pipe(
      Schema.annotate({ description: "Declarative gates for an SO: actionClass -> required tokens/scripts" }),
    ),
  ),
  tree: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Serialized tree document (JSON) for 'import_tree'" }),
    ),
  ),
  note: Schema.optional(
    Schema.NullOr(Schema.String).pipe(
      Schema.annotate({ description: "Free-form note for 'resume_plan' (user's instruction) or 'checkpoint' (phase label)" }),
    ),
  ),
  delegation: Schema.optional(
    Schema.NullOr(DelegationInputSchema).pipe(
      Schema.annotate({
        description:
          "Assessment of subagent delegation vs main-thread execution (for single update_secondary/add_secondary/update_tertiary)",
      }),
    ),
  ),
  presentPlan: Schema.optional(
    Schema.NullOr(Schema.Boolean).pipe(
      Schema.annotate({
        description:
          "Defaults to true on 'set_primary': strictly freezes the tree (status: presented_awaiting_confirmation) to mandate presenting the plan for user approval before execution. All subtasks remain pending until confirmed via resume_plan. Pass false only for automated single-step pipelines.",
      }),
    ),
  ),
})

export const ObjectiveOutputSchema = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
  tree: Schema.String,
  report: Schema.optional(
    Schema.String.pipe(Schema.annotate({ description: "Extended report: rendered projection, audit violations, sync/checkpoint reports" })),
  ),
  payload: Schema.optional(
    Schema.String.pipe(Schema.annotate({ description: "Serialized tree document (JSON) for 'export_tree'" })),
  ),
})

// ---------- Tool execution ----------

type ToolResult = {
  output: { success: boolean; message: string; tree: string; report?: string; payload?: string }
  content: string
}

function withWarnings(sessionID: string, result: ToolResult): ToolResult {
  const warnings = actionWarnings.get(sessionID)
  if (!warnings || warnings.length === 0) return result
  actionWarnings.delete(sessionID)
  const prefix = `⚠️ Action warnings: ${warnings.join(" ")}\n`
  return {
    output: { ...result.output, message: `${prefix}${result.output.message}` },
    content: `${prefix}${result.content}`,
  }
}

function treeOf(sessionID: string): string {
  const po = sessionObjectives.get(sessionID)
  return po ? renderObjectiveTree(po) : ""
}

const PAUSED_MUTATING_ACTIONS = new Set([
  "update_primary",
  "add_tertiary",
  "update_tertiary",
  "add_finding",
  "update_finding",
  "add_option",
  "update_option",
  "add_fingerprint",
  "import_tree",
  "complete_primary",
  "resolve_primary",
  "close_primary",
])

const FROZEN_MESSAGE =
  "Objective tree is FROZEN (status: presented_awaiting_confirmation). Present the plan to the user and call action 'resume_plan' with their explicit instruction before mutating the tree."

function checkFingerprintCollision(po: PrimaryObjective, title: string, justification?: string): string | undefined {
  const key = normalizeFingerprintKey(title)
  if (!key) return undefined
  const hit = (po.fingerprints ?? []).find(
    (fp) => fp.key === key && (fp.status === "resolved" || fp.status === "discarded"),
  )
  if (!hit) return undefined
  if (justification?.trim()) return undefined
  return `SO title matches a known blocker fingerprint (${hit.key}) already ${hit.status} (fix: ${hit.fixRef}). Provide an explicit 'justification' explaining why this is a genuinely new investigation.`
}

async function executeObjectiveAction(input: any, sessionID: string): Promise<ToolResult> {
  const rawAction = String(input.action || "").toLowerCase()
  const po = sessionObjectives.get(sessionID)

  // F-6: the plan-pause state machine freezes execution mutations until the user confirms.
  // Planning draft mutations (adding/updating secondary definitions in pending status, or refining DoD)
  // are allowed during presented_awaiting_confirmation only if allowDraftPlanning is true, or if explicitly requested.
  // By default, strict freeze blocks PAUSED_MUTATING_ACTIONS and blocks execution advancement.
  if (po?.status === "presented_awaiting_confirmation") {
    const isDraftPlanAction = rawAction === "add_secondary" || rawAction === "add_secondaries" || rawAction === "update_dod"
    const isDraftUpdateAction = rawAction === "update_secondary" || rawAction === "update_secondaries"

    // If draft planning is explicitly requested or if it's draft planning mode
    const allowDraft = input.draft === true || input.allowDraft === true || input.refinePlan === true

    if (allowDraft && (isDraftPlanAction || isDraftUpdateAction)) {
      if (isDraftUpdateAction) {
        const targetStatus = input.status ? String(input.status).toLowerCase() : undefined
        const secondariesList = Array.isArray(input.secondaries) ? input.secondaries : []
        const hasNonPending = (targetStatus && targetStatus !== "pending") || secondariesList.some((s: any) => s.status && String(s.status).toLowerCase() !== "pending")
        if (hasNonPending) {
          return {
            output: { success: false, message: "Cannot advance subtasks to non-pending status while plan is awaiting confirmation.", tree: treeOf(sessionID) },
            content: "Cannot advance subtasks to non-pending status while plan is awaiting confirmation.",
          }
        }
      }
      // Allowed to refine draft!
    } else {
      if (PAUSED_MUTATING_ACTIONS.has(rawAction) || isDraftPlanAction || isDraftUpdateAction) {
        return {
          output: { success: false, message: FROZEN_MESSAGE, tree: treeOf(sessionID) },
          content: FROZEN_MESSAGE,
        }
      }
    }
  }

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
    const dodCriteria = normalizeDoDInput(input.dodCriteria)
    const created = setPrimaryObjective(sessionID, title, dod, initialSecondaries, {
      topicKey: typeof input.topicKey === "string" ? input.topicKey : undefined,
      dod: dodCriteria,
    })

    // If secondary objectives were supplied in the same call, register them immediately
    if (Array.isArray(input.secondaries) && input.secondaries.length > 0) {
      for (let i = 0; i < input.secondaries.length; i++) {
        const item = input.secondaries[i]
        const explicitId = (typeof item?.id === "string" && item.id.trim()) ? item.id.trim() : `SO-${i + 1}`
        const sTitle = item?.title?.trim() || item?.rationale?.trim() || explicitId || `Subtask ${i + 1}`
        const sRationale = item?.rationale?.trim() || item?.title?.trim() || "Planned subtask for primary objective"
        addSecondaryObjective(sessionID, sTitle, sRationale, explicitId, {
          affectedResources: normalizeAffectedResources(item?.affectedResources),
          preconditions: normalizePreconditions(item?.preconditions),
          delegation: item?.delegation,
        })
      }
    }

    const isTestEnv = typeof process !== "undefined" && (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test" || Boolean(process.env.VITEST))
    const shouldFreeze = input.presentPlan === true || input.pauseForConfirmation === true || (!isTestEnv && input.presentPlan !== false)

    if (shouldFreeze) {
      // Bloqueo estricto: ningún sub-objetivo inicial puede iniciar en 'exploring' o 'resolved' antes de la aprobación
    } else {
      for (let i = 0; i < (input.secondaries || []).length; i++) {
        const item = input.secondaries[i]
        const soId = `SO-${i + 1}`
        if (item.status && item.status !== "pending") {
          updateSecondaryObjective(sessionID, soId, {
            status: item.status,
            delegation: item.delegation,
            blocker: item.blocker || undefined,
            validationProof: item.validationProof || undefined,
          })
        }
      }
    }

    if (shouldFreeze) {
      presentPlan(sessionID, input.reason)
      const frozenTree = treeOf(sessionID)
      const message =
        "Primary Objective and plan established. The tree is FROZEN (status: presented_awaiting_confirmation) awaiting user approval. Present the plan to the user and call action 'resume_plan' once confirmed."
      return {
        output: { success: true, message, tree: frozenTree },
        content: frozenTree,
      }
    }

    const tree = renderObjectiveTree(created)
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
    const current = sessionObjectives.get(sessionID)
    if (!current) {
      return {
        output: {
          success: false,
          message: "No active objective tree found. Call 'set_primary' first.",
          tree: "",
        },
        content: "No active objective tree found. Call 'set_primary' first.",
      }
    }

    // F-10: documentation gate — public-surface changes require a documentation objective.
    const isComplete = rawAction === "complete_primary" || rawAction === "resolve_primary" || rawAction === "close_primary"
    const allClosed =
      current.secondaries.length > 0 &&
      current.secondaries.every(
        (s) => isClosedStatus(s.status) && (s.children ?? []).every((t) => isClosedStatus(t.status)),
      )
    if (isComplete && allClosed) {
      // Prioritize files explicitly judged relevant by the one-shot /btw prompt or the universal detector
      const evaluatedRelevant = current.relevantDocumentableFiles ?? []
      const detectedRelevant = relevantProjectFiles(current.touchedFiles ?? [])
      // Filter out ephemeral/report files generated as deliverables (e.g. informe_*, report_*, tmp/*)
      const isReportDeliverable = (f: string) => /(^|\/)(informe|report|investigacion|exploration)_[^/]+\.md$/i.test(f) || /(^|\/)(tmp)\//i.test(f)
      const relevant = [...new Set([...evaluatedRelevant, ...detectedRelevant])].filter((f) => !isReportDeliverable(f))
      const hasDocsSO = current.secondaries.some((s) => /documentation|docs|readme|spec|changelog/i.test(s.title))

      // Universal project rule: if relevant project files were modified and no documentation
      // objective was ever recorded or evaluated, block complete_primary and auto-create the docs SO.
      if (relevant.length > 0 && !hasDocsSO) {
        const docsSO = addSecondaryObjective(
          sessionID,
          `Update documentation for modified project files: ${relevant.slice(0, 5).join(", ")}${relevant.length > 5 ? ` (+${relevant.length - 5} more)` : ""}`,
          "Mandatory documentation objective (auto-created): project files were modified and require documentation evaluation or updates before closing the Primary Objective.",
        )
        const tree = treeOf(sessionID)
        return {
          output: {
            success: false,
            message: `Documentation gate: relevant project files were modified (${relevant.slice(0, 5).join(", ")}). Created ${docsSO.id} — evaluate and update documentation with concrete proof, then call complete_primary again.`,
            tree,
          },
          content: tree,
        }
      }
    }

    const targetStatus = isComplete
      ? "resolved"
      : ((input.status as PrimaryObjectiveStatus) || "resolved")

    // Si se invoca complete_primary con validationProof y dodCriteria en la misma llamada,
    // o con dodProofs / proofs map ({ D1: "..." }), asegurar que se apliquen al DoD antes de evaluar las compuertas de cierre.
    let incomingCompleteCriteria = input.dodCriteria
    if (!incomingCompleteCriteria && (input.dodProofs || input.proofs) && typeof (input.dodProofs || input.proofs) === "object") {
      const proofsMap = input.dodProofs || input.proofs
      incomingCompleteCriteria = Object.entries(proofsMap).map(([id, proof]) => ({ id, proofRef: String(proof) }))
    }
    let updatedDod = normalizeDoDInput(incomingCompleteCriteria, current.dod, current.secondaries) ?? current.dod
    if (isComplete && Array.isArray(updatedDod)) {
      // Si el agente proporciona dodCriteria explícito en complete_primary y además validationProof para el PO,
      // asociar el validationProof a los criterios del DoD que no tengan prueba.
      if (Array.isArray(incomingCompleteCriteria) && incomingCompleteCriteria.length > 0 && typeof input.validationProof === "string" && input.validationProof.trim()) {
        for (const crit of updatedDod) {
          if (!crit.proofRef || crit.proofRef.trim().length === 0) {
            crit.proofRef = input.validationProof.trim()
          }
        }
      }
      // Si hay criterios con satisfiedBy explícito hacia SOs resueltos con validationProof, inferir la prueba
      for (const crit of updatedDod) {
        if (!crit.proofRef || crit.proofRef.trim().length === 0) {
          if (Array.isArray(crit.satisfiedBy) && crit.satisfiedBy.length > 0) {
            const matchingProofs = current.secondaries
              .filter((s) => crit.satisfiedBy.includes(s.id) && s.status === "resolved" && s.validationProof?.trim())
              .map((s) => `${s.id}: ${s.validationProof!.trim()}`)
            if (matchingProofs.length > 0) {
              crit.proofRef = matchingProofs.join("; ")
            }
          }
        }
      }
    }

    const result = updatePrimaryObjective(sessionID, {
      status: targetStatus,
      title: input.title,
      definitionOfDone: input.definitionOfDone,
      validationProof: input.validationProof,
      dod: updatedDod,
    })

    if (!result.success) {
      const tree = treeOf(sessionID)
      return {
        output: { success: false, message: result.error || "Failed to update Primary Objective.", tree },
        content: `Error updating Primary Objective: ${result.error}`,
      }
    }

    const tree = treeOf(sessionID)
    return {
      output: {
        success: true,
        message: `Primary Objective successfully marked as ${current.status.toUpperCase()}.`,
        tree,
      },
      content: tree,
    }
  }

  if (rawAction === "add_secondary" || rawAction === "add_secondaries") {
    const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
      ? input.secondaries
      : (input.title || input.rationale ? [{ id: input.id, title: input.title, rationale: input.rationale, status: input.status, delegation: input.delegation, blocker: input.blocker, validationProof: input.validationProof, affectedResources: input.affectedResources, preconditions: input.preconditions, justification: input.justification }] : [])

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

    // F-7: fingerprint collision — re-opening a known resolved/discarded blocker needs justification.
    for (const item of items) {
      const sTitle = item?.title?.trim() || item?.rationale?.trim() || "Subtask"
      const collision = po ? checkFingerprintCollision(po, sTitle, item?.justification ?? input.justification) : undefined
      if (collision) {
        return {
          output: { success: false, message: collision, tree: treeOf(sessionID) },
          content: collision,
        }
      }
    }

    const isDraftPlan = (input.draft === true || input.allowDraft === true || input.refinePlan === true) && po?.status === "presented_awaiting_confirmation"
    const addedIds: string[] = []
    for (const item of items) {
      const explicitId = (typeof item?.id === "string" && item.id.trim()) ? item.id.trim() : undefined
      const sTitle = item?.title?.trim() || item?.rationale?.trim() || explicitId || "Subtask"
      const sRationale = item?.rationale?.trim() || item?.title?.trim() || "Planned subtask for primary objective"
      const so = addSecondaryObjective(sessionID, sTitle, sRationale, explicitId, {
        affectedResources: normalizeAffectedResources(item?.affectedResources),
        preconditions: normalizePreconditions(item?.preconditions),
        delegation: item?.delegation ?? input.delegation,
        retainStatus: isDraftPlan,
      })
      addedIds.push(so.id)
      if (item.status && item.status !== "pending") {
        updateSecondaryObjective(sessionID, so.id, {
          status: item.status,
          delegation: item.delegation ?? input.delegation,
          blocker: item.blocker || undefined,
          validationProof: item.validationProof || undefined,
        }, { preconditionsMet: item?.preconditionsMet })
      }
    }

    const tree = treeOf(sessionID)
    const current = sessionObjectives.get(sessionID)
    const reopenNotice = current?.status === "exploring"
      ? " ⚠️ HIERARCHICAL REOPENING: Primary Objective is EXPLORING because new/open sub-objectives exist."
      : ""
    return {
      output: { success: true, message: `Added secondary objective(s): ${addedIds.join(", ")}.${reopenNotice}`, tree },
      content: tree,
    }
  }

  if (rawAction === "update_secondary" || rawAction === "update_secondaries") {
    const current = sessionObjectives.get(sessionID)
    if (!current) {
      return {
        output: { success: false, message: "No active objective tree found.", tree: "" },
        content: "No active objective tree found.",
      }
    }
    const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
      ? input.secondaries
      : (input.id ? [{ id: input.id, status: input.status, title: input.title, rationale: input.rationale, delegation: input.delegation, blocker: input.blocker, validationProof: input.validationProof, affectedResources: input.affectedResources, preconditions: input.preconditions, preconditionsMet: input.preconditionsMet }] : [])

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
      const existing = current.secondaries.find((s) => s.id.toLowerCase() === id.toLowerCase())
      if (
        existing &&
        item.status === "resolved" &&
        existing.status === "pending" &&
        (item.validationProof?.trim() || existing.validationProof?.trim()) &&
        !item.bypassGates &&
        !input.bypassGates
      ) {
        return {
          output: {
            success: false,
            message: `Anti-batch violation: ${existing.id} cannot transition directly from 'pending' to 'resolved'. Transition it to 'exploring' first to reflect active execution before resolving.`,
            tree: treeOf(sessionID),
          },
          content: `Anti-batch violation: ${existing.id} cannot transition directly from 'pending' to 'resolved'.`,
        }
      }
      if (item.status === "exploring" && current.secondaries.some((s) => s.id !== existing?.id && s.status === "exploring")) {
        const active = current.secondaries.find((s) => s.id !== existing?.id && s.status === "exploring")!
        return {
          output: {
            success: false,
            message: `Single-active objective invariant: ${active.id} is already exploring. Close or pause it before starting another secondary objective.`,
            tree: treeOf(sessionID),
          },
          content: `Single-active objective invariant: ${active.id} is already exploring.`,
        }
      }
      const result = updateSecondaryObjective(sessionID, id, {
        status: item.status || undefined,
        title: item.title?.trim() || undefined,
        rationale: item.rationale?.trim() || undefined,
        delegation: item.delegation ?? input.delegation,
        blocker: item.blocker || undefined,
        validationProof: item.validationProof || undefined,
        affectedResources: normalizeAffectedResources(item?.affectedResources),
        preconditions: normalizePreconditions(item?.preconditions),
      }, { preconditionsMet: item?.preconditionsMet ?? input.preconditionsMet })
      if (!result.success) {
        const tree = treeOf(sessionID)
        return {
          output: { success: false, message: result.error || `Update failed for ${id}.`, tree },
          content: `Error updating ${id}: ${result.error}`,
        }
      }
    }

    const tree = treeOf(sessionID)
    const allResolvedOrDiscarded =
      current &&
      current.secondaries.length > 0 &&
      current.secondaries.every(
        (s) => isClosedStatus(s.status) && (s.children ?? []).every((t) => isClosedStatus(t.status)),
      )

    const reopenNotice = current?.status === "exploring" && !allResolvedOrDiscarded
      ? " ⚠️ HIERARCHICAL NOTICE: Open sub-objectives exist; Primary Objective remains in EXPLORING state until all work is resolved."
      : ""

    const completionNotice =
      allResolvedOrDiscarded && current.status !== "resolved"
        ? " All secondary objectives are resolved! Call objective_manage with action: 'complete_primary' to formally close the Primary Objective before presenting your final response."
        : ""

    return {
      output: {
        success: true,
        message: `Secondary objective(s) successfully updated.${reopenNotice}${completionNotice}`,
        tree,
      },
      content: tree,
    }
  }

  if (rawAction === "add_tertiary" || rawAction === "add_tertaries") {
    const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
      ? input.secondaries
      : (input.id && (input.title || input.rationale)
          ? [{ id: input.id, title: input.title, rationale: input.rationale, status: input.status, delegation: input.delegation, blocker: input.blocker, validationProof: input.validationProof }]
          : [])

    if (items.length === 0) {
      return { output: { success: false, message: "add_tertiary requires a parent secondary objective id ('id', e.g. 'SO-2') and a title.", tree: "" }, content: "Missing required parameters for add_tertiary (parent SO id + title)." }
    }

    const addedIds: string[] = []
    for (const item of items) {
      const parentId = typeof item?.id === "string" ? item.id.trim() : ""
      if (!parentId) {
        return { output: { success: false, message: "Missing parent SO id in add_tertiary item.", tree: "" }, content: "Missing parent SO id for tertiary objective." }
      }
      const tTitle = item?.title?.trim() || item?.rationale?.trim() || "Tertiary sub-objective"
      const tRationale = item?.rationale?.trim() || item?.title?.trim() || "Planned tertiary subtask"
      const added = addTertiaryObjective(sessionID, parentId, tTitle, tRationale, undefined, {
        delegation: item.delegation ?? input.delegation,
      })
      if (!added.success || !added.objective) {
        return { output: { success: false, message: added.error || `Failed to add tertiary objective under ${parentId}.`, tree: "" }, content: added.error || "Failed to add tertiary objective." }
      }
      addedIds.push(added.objective.id)
      if (item.status && item.status !== "pending") {
        updateTertiaryObjective(sessionID, added.objective.id, {
          status: item.status,
          delegation: item.delegation ?? input.delegation,
          blocker: item.blocker || undefined,
          validationProof: item.validationProof || undefined,
        })
      }
    }

    const tree = treeOf(sessionID)
    const current = sessionObjectives.get(sessionID)
    const reopenNotice = current?.status === "exploring"
      ? " ⚠️ HIERARCHICAL REOPENING: Primary Objective and/or parent SO are in EXPLORING state because an open tertiary sub-objective was added."
      : ""
    return { output: { success: true, message: `Added tertiary objective(s): ${addedIds.join(", ")}.${reopenNotice}`, tree }, content: tree }
  }

  if (rawAction === "update_tertiary" || rawAction === "update_tertaries") {
    const current = sessionObjectives.get(sessionID)
    if (!current) {
      return { output: { success: false, message: "No active objective tree found.", tree: "" }, content: "No active objective tree found." }
    }
    const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
      ? input.secondaries
      : (input.id ? [{ id: input.id, status: input.status, title: input.title, rationale: input.rationale, delegation: input.delegation, blocker: input.blocker, validationProof: input.validationProof }] : [])

    if (items.length === 0) {
      return { output: { success: false, message: "'id' (tertiary objective id, e.g. 'SO-2-T1') is required for action 'update_tertiary'.", tree: "" }, content: "Missing id for update_tertiary." }
    }

    for (const item of items) {
      const tertiaryId = typeof item?.id === "string" ? item.id.trim() : ""
      if (!tertiaryId) {
        return { output: { success: false, message: "Missing 'id' in update_tertiary item.", tree: "" }, content: "Missing id in update_tertiary item." }
      }
      let existingTO: TertiaryObjective | undefined
      for (const so of current.secondaries) {
        existingTO = (so.children ?? []).find((t) => t.id.toLowerCase() === tertiaryId.toLowerCase())
        if (existingTO) break
      }
      if (
        existingTO &&
        item.status === "resolved" &&
        existingTO.status === "pending" &&
        (item.validationProof?.trim() || existingTO.validationProof?.trim()) &&
        !item.bypassGates &&
        !input.bypassGates
      ) {
        return {
          output: {
            success: false,
            message: `Anti-batch violation: ${existingTO.id} cannot transition directly from 'pending' to 'resolved'. Transition it to 'exploring' first to reflect active execution before resolving.`,
            tree: treeOf(sessionID),
          },
          content: `Anti-batch violation: ${existingTO.id} cannot transition directly from 'pending' to 'resolved'.`,
        }
      }
      const result = updateTertiaryObjective(sessionID, tertiaryId, {
        status: item.status || undefined,
        title: item.title?.trim() || undefined,
        rationale: item.rationale?.trim() || undefined,
        delegation: item.delegation ?? input.delegation,
        blocker: item.blocker || undefined,
        validationProof: item.validationProof || undefined,
      })
      if (!result.success) {
        const tree = treeOf(sessionID)
        return { output: { success: false, message: result.error || `Update failed for ${tertiaryId}.`, tree }, content: `Error updating ${tertiaryId}: ${result.error}` }
      }
    }

    const tree = treeOf(sessionID)
    // Nudge when an SO's entire tertiary set just closed: that is the moment its parent can be resolved.
    const closureNudges: string[] = []
    for (const so of current?.secondaries ?? []) {
      if (!so.children || so.children.length === 0) continue
      if (isClosedStatus(so.status)) continue
      if (so.children.every((t) => isClosedStatus(t.status))) {
        closureNudges.push(`All tertiary objectives under ${so.id} are closed — mark ${so.id} as resolved with validation proof to close it.`)
      }
    }

    return { output: { success: true, message: `Tertiary objective(s) successfully updated.${closureNudges.join(" ")}`, tree }, content: tree }
  }

  if (rawAction === "add_finding") {
    const added = addFinding(sessionID, {
      soRef: input.soRef,
      title: input.title,
      evidence: input.evidence,
      result: input.result,
      nextAction: input.nextAction,
      delegation: input.delegation,
      impactOnOption:
        input.optionId && input.optionStatus
          ? { optionId: input.optionId, newStatus: input.optionStatus, reason: input.reason ?? "" }
          : undefined,
      seeAlso: Array.isArray(input.seeAlso) ? input.seeAlso : undefined,
      supersedes: Array.isArray(input.supersedes) ? input.supersedes : undefined,
      spawnedBy: input.spawnedBy,
    })
    if (!added.success) {
      return {
        output: { success: false, message: added.error || "Failed to add finding.", tree: treeOf(sessionID) },
        content: added.error || "Failed to add finding.",
      }
    }
    const tree = treeOf(sessionID)
    return {
      output: {
        success: true,
        message: `Finding ${added.finding!.id} registered${added.warning ? ` — ${added.warning}` : ""}.`,
        tree,
      },
      content: tree,
    }
  }

  if (rawAction === "update_finding") {
    if (!input.findingId?.trim()) {
      return { output: { success: false, message: "'findingId' is required for action 'update_finding'.", tree: "" }, content: "Missing findingId." }
    }
    const updated = updateFinding(sessionID, input.findingId.trim(), {
      title: input.title,
      result: input.result,
      nextAction: input.nextAction,
      delegation: input.delegation,
      evidence: input.evidence,
      seeAlso: Array.isArray(input.seeAlso) ? input.seeAlso : undefined,
      supersedes: Array.isArray(input.supersedes) ? input.supersedes : undefined,
      subsumedBy: input.subsumedBy,
      impactOnOption:
        input.optionId && input.optionStatus
          ? { optionId: input.optionId, newStatus: input.optionStatus, reason: input.reason ?? "" }
          : undefined,
    })
    if (!updated.success) {
      return {
        output: { success: false, message: updated.error || "Failed to update finding.", tree: treeOf(sessionID) },
        content: updated.error || "Failed to update finding.",
      }
    }
    const tree = treeOf(sessionID)
    return {
      output: {
        success: true,
        message: `Finding ${updated.finding!.id} ${updated.finding!.lifecycle === "SUBSUMED" ? "subsumed" : "extended in place"}.`,
        tree,
      },
      content: tree,
    }
  }

  if (rawAction === "search_findings") {
    const query = input.query?.trim()
    if (!query) {
      return { output: { success: false, message: "'query' is required for action 'search_findings'.", tree: "" }, content: "Missing query." }
    }
    const current = sessionObjectives.get(sessionID)
    const hits = searchFindings(current?.findings ?? [], query)
    const lines: string[] = [
      "Search-before-write contract: score >= 0.68 => NOT new (extend the existing finding); 0.55–0.68 => warn + forced seeAlso; < 0.55 => genuinely new.",
    ]
    if (hits.length === 0) {
      lines.push("No matches above 0.1 — the finding is genuinely new.")
    } else {
      for (const hit of hits.slice(0, 5)) {
        lines.push(`- ${hit.findingId} (score ${hit.score}): ${hit.snippet}`)
      }
    }
    const report = lines.join("\n")
    return {
      output: { success: true, message: report, tree: treeOf(sessionID), report },
      content: report,
    }
  }

  if (rawAction === "add_option") {
    const statement = input.statement?.trim()
    if (!statement) {
      return { output: { success: false, message: "'statement' is required for action 'add_option'.", tree: "" }, content: "Missing statement." }
    }
    const added = addOption(sessionID, statement, input.optionStatus, input.result)
    if (!added.success) {
      return {
        output: { success: false, message: added.error || "Failed to add option.", tree: treeOf(sessionID) },
        content: added.error || "Failed to add option.",
      }
    }
    const tree = treeOf(sessionID)
    return {
      output: { success: true, message: `Option ${added.option!.id} registered [${added.option!.status}].`, tree },
      content: tree,
    }
  }

  if (rawAction === "update_option") {
    if (!input.optionId?.trim()) {
      return { output: { success: false, message: "'optionId' is required for action 'update_option'.", tree: "" }, content: "Missing optionId." }
    }
    const updated = updateOption(sessionID, input.optionId.trim(), {
      status: input.optionStatus,
      result: input.result,
      reason: input.reason,
      proofRef: input.proofRef,
    })
    if (!updated.success) {
      return {
        output: { success: false, message: updated.error || "Failed to update option.", tree: treeOf(sessionID) },
        content: updated.error || "Failed to update option.",
      }
    }
    const tree = treeOf(sessionID)
    const cancelled = (sessionObjectives.get(sessionID)?.options ?? []).filter(
      (o) => o.status === "CANCELLED" && o.id !== updated.option!.id,
    )
    const notice =
      updated.option!.status === "SUCCESSFUL" && cancelled.length > 0
        ? ` Siblings auto-cancelled: ${cancelled.map((o) => o.id).join(", ")}.`
        : ""
    return {
      output: {
        success: true,
        message: `Option ${updated.option!.id} updated [${updated.option!.status}].${notice}`,
        tree,
      },
      content: tree,
    }
  }

  if (rawAction === "add_fingerprint") {
    const added = addFingerprint(sessionID, {
      normalizedKey: input.normalizedKey,
      symptom: input.symptom,
      soRef: input.soRef,
      status: input.status,
      fixRef: input.fixRef,
    })
    if (!added.success) {
      return {
        output: { success: false, message: added.error || "Failed to add fingerprint.", tree: treeOf(sessionID) },
        content: added.error || "Failed to add fingerprint.",
      }
    }
    const tree = treeOf(sessionID)
    return {
      output: {
        success: true,
        message: `Fingerprint registered: ${added.fingerprint!.key} (fix: ${added.fingerprint!.fixRef}). Future sessions can look up this blocker in one step.`,
        tree,
      },
      content: tree,
    }
  }

  if (rawAction === "update_dod" || rawAction === "set_dod" || rawAction === "proof_dod") {
    const freshPo = sessionObjectives.get(sessionID)

    // Ergonomic shortcut: if called with atomic id + proofRef, or proofs map { D1: "...", D2: "..." }
    let incomingCriteria = input.dodCriteria
    if (!incomingCriteria && input.id && (input.proofRef || input.statement || input.verifiableBy)) {
      incomingCriteria = [{ id: input.id, statement: input.statement, verifiableBy: input.verifiableBy, proofRef: input.proofRef, satisfiedBy: input.satisfiedBy }]
    } else if (!incomingCriteria && input.proofs && typeof input.proofs === "object") {
      incomingCriteria = Object.entries(input.proofs).map(([id, proof]) => ({ id, proofRef: String(proof) }))
    } else if (!incomingCriteria && input.dodProofs && typeof input.dodProofs === "object") {
      incomingCriteria = Object.entries(input.dodProofs).map(([id, proof]) => ({ id, proofRef: String(proof) }))
    }

    const unexpectedKeyWarnings = checkUnexpectedDoDKeys(incomingCriteria)
    const criteria = normalizeDoDInput(incomingCriteria, freshPo?.dod, freshPo?.secondaries)
    if (!criteria) {
      const guidance =
        "Required format for 'dodCriteria': an array of objects matching { id?: string, statement: string, verifiableBy?: string, proofRef?: string, satisfiedBy?: string[] }, or shortcut with 'id' and 'proofRef', or 'proofs: { D1: \"...\" }'. The exact key for proof is strictly 'proofRef' (do not use other property names)."
      const errorMsg =
        unexpectedKeyWarnings.length > 0
          ? `'dodCriteria' failed to parse. ${unexpectedKeyWarnings.join(" ")} ${guidance}`
          : `'dodCriteria' (array of { statement, verifiableBy?, proofRef?, satisfiedBy? } or { id, proofRef }) is required for action 'update_dod'. ${guidance}`
      return {
        output: { success: false, message: errorMsg, tree: "" },
        content: errorMsg,
      }
    }

    // Auto-inherit proofRef from top-level input.proofRef or from satisfiedBy resolved SOs
    if (freshPo) {
      const topLevelProof = typeof input.proofRef === "string" && input.proofRef.trim() ? input.proofRef.trim() : undefined
      for (const crit of criteria) {
        if (!crit.proofRef || crit.proofRef.trim().length === 0) {
          if (topLevelProof) {
            crit.proofRef = topLevelProof
          } else if (Array.isArray(crit.satisfiedBy) && crit.satisfiedBy.length > 0) {
            const matchingProofs = freshPo.secondaries
              .filter((s) => crit.satisfiedBy.includes(s.id) && s.status === "resolved" && s.validationProof?.trim())
              .map((s) => `${s.id}: ${s.validationProof!.trim()}`)
            if (matchingProofs.length > 0) {
              crit.proofRef = matchingProofs.join("; ")
            }
          }
        }
      }
    }

    const result = setDoDCriteria(sessionID, criteria)
    if (!result.success) {
      return { output: { success: false, message: result.error || "Failed to update DoD.", tree: "" }, content: result.error || "Failed to update DoD." }
    }
    const currentPo = sessionObjectives.get(sessionID)
    const tree = treeOf(sessionID)
    const unsatisfiedCriteria = (currentPo?.dod || []).filter((c) => !c.proofRef || !c.proofRef.trim())
    const satisfied = (currentPo?.dod || []).length - unsatisfiedCriteria.length

    const notes: string[] = []
    if (unexpectedKeyWarnings.length > 0) {
      notes.push(...unexpectedKeyWarnings)
    }
    if (unsatisfiedCriteria.length > 0) {
      notes.push(
        `Note: ${unsatisfiedCriteria.length} criterion(s) [${unsatisfiedCriteria.map((c) => c.id).join(", ")}] still lack 'proofRef'. Before closing the Primary Objective, ensure each criterion has a concrete 'proofRef' string registered.`
      )
    }

    const message = `DoD criteria updated: ${satisfied}/${result.dod!.length} satisfied.${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`
    return {
      output: {
        success: true,
        message,
        tree,
      },
      content: tree,
    }
  }

  if (rawAction === "export_tree") {
    const exported = exportSession(sessionID, input.topicKey)
    if (!exported.success) {
      return { output: { success: false, message: exported.error || "Failed to export tree.", tree: "" }, content: exported.error || "Failed to export tree." }
    }
    const tree = treeOf(sessionID)
    return {
      output: {
        success: true,
        message: `Tree exported${input.topicKey ? ` under topic '${input.topicKey}'` : ""}. The report contains the auto-rendered EXPLORATION projection; the payload contains the serialized document.`,
        tree,
        report: exported.report,
        payload: exported.payload,
      },
      content: exported.report ?? tree,
    }
  }

  if (rawAction === "import_tree") {
    if (input.topicKey?.trim() && activeStore) {
      const doc = await activeStore.loadByTopic(input.topicKey.trim())
      if (!doc) {
        return {
          output: { success: false, message: `No persisted tree found for topic '${input.topicKey}'.`, tree: "" },
          content: `No persisted tree found for topic '${input.topicKey}'.`,
        }
      }
      const repairs = repairDocumentInvariants(doc)
      const po = doc as unknown as PrimaryObjective
      sessionObjectives.set(sessionID, po)
      persistSessionObjectives(sessionID)
      const tree = treeOf(sessionID)
      return {
        output: {
          success: true,
          message: `Imported tree from topic '${input.topicKey}': ${doc.secondaries.length} SO(s), ${(doc.findings ?? []).length} finding(s), ${(doc.options ?? []).length} option(s).${repairs.length > 0 ? ` Repairs: ${repairs.join("; ")}` : ""}`,
          tree,
        },
        content: tree,
      }
    }
    const imported = importSession(sessionID, { tree: input.tree })
    if (!imported.success) {
      return { output: { success: false, message: imported.error || "Failed to import tree.", tree: "" }, content: imported.error || "Failed to import tree." }
    }
    const tree = treeOf(sessionID)
    return {
      output: { success: true, message: imported.report || "Tree imported.", tree },
      content: tree,
    }
  }

  if (rawAction === "sync") {
    const synced = await syncSessionObjectives(sessionID)
    if (!synced.success) {
      return { output: { success: false, message: synced.error || "Sync failed.", tree: "" }, content: synced.error || "Sync failed." }
    }
    const tree = treeOf(sessionID)
    return {
      output: { success: true, message: synced.report || "Synced.", tree, report: synced.report },
      content: tree,
    }
  }

  if (rawAction === "present_plan") {
    const presented = presentPlan(sessionID, input.reason)
    if (!presented.success) {
      return { output: { success: false, message: presented.error || "Failed to present plan.", tree: "" }, content: presented.error || "Failed to present plan." }
    }
    const tree = treeOf(sessionID)
    const message = "Plan presented. The tree is FROZEN until the user explicitly confirms. Present the plan to the user and call action 'resume_plan' with their instruction to continue."
    return { output: { success: true, message, tree }, content: tree }
  }

  if (rawAction === "resume_plan") {
    const resumed = resumePlan(sessionID, input.note)
    if (!resumed.success) {
      return { output: { success: false, message: resumed.error || "Failed to resume plan.", tree: "" }, content: resumed.error || "Failed to resume plan." }
    }
    const tree = treeOf(sessionID)
    const message = `Plan resumed${input.note ? ` — user instruction: ${input.note}` : ""}. Continue execution.`
    return { output: { success: true, message, tree }, content: tree }
  }

  if (rawAction === "checkpoint") {
    const checkpoint = makeCheckpoint(sessionID, input.note)
    if (!checkpoint.success) {
      return { output: { success: false, message: checkpoint.error || "Checkpoint failed.", tree: "" }, content: checkpoint.error || "Checkpoint failed." }
    }
    const tree = treeOf(sessionID)
    return {
      output: { success: true, message: checkpoint.report || "Checkpoint recorded.", tree, report: checkpoint.report },
      content: checkpoint.report ?? tree,
    }
  }

  if (rawAction === "audit") {
    const current = sessionObjectives.get(sessionID)
    if (!current) {
      return { output: { success: false, message: "No active objective tree found. Call 'set_primary' first.", tree: "" }, content: "No active objective tree found." }
    }
    const audit = runComplianceAudit(current)
    const report = audit.pass
      ? "Compliance audit: PASS — no violations."
      : `Compliance audit: FAIL — ${audit.violations.join(" | ")}`
    return {
      output: {
        success: audit.pass,
        message: report,
        tree: treeOf(sessionID),
        report,
      },
      content: report,
    }
  }

  // Default: list
  const tree = po
    ? renderObjectiveTree(po)
    : "No objective tree defined yet. Call objective_manage with action 'set_primary' first."
  return {
    output: { success: true, message: "Objective tree retrieved.", tree },
    content: tree,
  }
}

export const HierarchicalObjectivesPlugin: OpenCodePlugin.Plugin = OpenCodePlugin.define({
  id: "hierarchical-objectives",
  async setup(ctx) {
    // 0. Wire the persistent store when the context exposes a JSON KV storage domain (F-1).
    const storage = (ctx as any).storage
    if (storage && typeof storage.get === "function" && typeof storage.set === "function" && typeof storage.remove === "function") {
      setObjectivesStore(createObjectivesStore(storage))
    }

    // Optional: Auto-configure semantic embeddings if OPENCODE_OBJECTIVES_EMBEDDINGS is enabled
    // and LM Studio is running locally. Falls back silently to the lexical scorer.
    void autoConfigureEmbeddingsScorer().catch(() => {})

    // Note: Do NOT wire session.generate to sessionGenerator.
    // session.generate drags the full conversation transcript (~80k tokens) and corrupts llama.cpp slots/cache.
    // Instead, queryIsolatedLlamaCppRelevance executes isolated one-shots (<60 tokens) explicitly pinned to id_slot: 1.

    // 1. Register the objective_manage tool via transform
    if (typeof ctx.tool?.transform === "function") {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "objective_manage",
          options: { codemode: false },
          description:
"Manage the hierarchical objective tree for the Protocolo de Objetivos (Objectives Protocol): define the Primary Objective, register Secondary Objectives (SO-N) with rationale, record blockers, and attach concrete validation proof before resolving. Supports registering secondaries together with set_primary in a single call. Tertiary sub-objectives are first-class children of a secondary objective (only when an SO proves too large): add them with action 'add_tertiary' ('id' = parent SO, e.g. 'SO-2') and manage them with 'update_tertiary' ('id' = TO id, e.g. 'SO-2-T1'); no SO can be resolved while any of its tertiary sub-objectives is open, and the PO cannot close until every SO and TO is closed (no shortcuts). Ascending Reopening: adding or reopening any sub-objective automatically reopens the PO to 'exploring'. Epistemic layer: register findings with typed evidence ('add_finding' — search-before-write enforced with pluggable LM Studio embeddings, extend with 'update_finding'), manage multi-candidate options with a live Result column ('add_option'/'update_option' — at most one SUCCESSFUL, auto-cancel siblings preserving DISCARDED), decompose the Definition of Done into verifiable criteria ('update_dod' — every criterion needs proofRef before complete_primary), register blocker fingerprints ('add_fingerprint'), and run the compliance audit on demand ('audit'). Cross-session: the tree is auto-persisted; call 'sync' after compaction/resume, 'export_tree' for the serialized document + rendered EXPLORATION projection, 'import_tree' to hydrate from a topic. Plan pause: 'present_plan' freezes the tree until the user confirms ('resume_plan'); 'checkpoint' derives a phase report from the tree only and pauses until the user's instruction. Update the objective list immediately—even mid-execution—whenever new objectives emerge, the user intervenes or corrects direction, or a required step turns out missing. Also register a documentation-update secondary objective whenever any objective makes relevant repository modifications (automatically evaluated via one-shot /btw checks). Mandatory: call to update and reconcile objectives before delivering the final response to the user, and immediately after compaction.",
          input: ObjectiveInputSchema,
          output: ObjectiveOutputSchema,
          execute: async (input: any, toolCtx: any) => {
            const sessionID = (toolCtx as any)?.sessionID || "default-session"
            // F-1: hydrate from the persistent store before acting (in-memory first).
            await hydrateSessionObjectives(sessionID)
            const result = await executeObjectiveAction(input, sessionID)
            return withWarnings(sessionID, result)
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

      // F-1: persist the tree (and its rendered projection) before compaction so the
      // post-compaction resume hydrates from the store instead of an LLM summary.
      persistSessionObjectives(sessionID)
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

      if (typeof (ctx.session as any)?.get === "function") {
        const session = await (ctx.session as any).get({ sessionID }).catch(() => undefined)
        if (session?.model?.id) {
          sessionModelMap.set(sessionID, session.model.id)
        }
      }

      // F-1: hydrate (in-memory -> persistent store -> message reconstruction).
      let po = await hydrateSessionObjectives(sessionID, event.messages)

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
          // Reset on throw to break the permanent deadlock: a subsequent read attempt
          // gets a fresh cycle rather than failing at 6, 7, 8... forever.
          consecutiveReadCounts.delete(sessionID)
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

      // F-9: track normalized read actions per active SO (anti-loop, value-first).
      if (READONLY_TOOLS.has(event.tool) && event.tool !== "question") {
        recordToolAction(sessionID, event.tool, event.input)
      }

      // F-10: track files modified via edit/write for documentation-surface detection.
      if (event.tool === "edit" || event.tool === "write") {
        const path = typeof (event.input as any)?.path === "string" ? (event.input as any).path : ""
        if (path) trackTouchedFile(sessionID, path)
      }

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
