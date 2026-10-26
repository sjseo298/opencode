// Epistemic layer for the Protocolo de Objetivos: types and pure, synchronous logic
// for findings, options, decomposed Definition of Done, blocker fingerprints,
// compliance auditing, search-before-write, and the rendered projection.
// Dependency-free by design so the plugin engine can validate and audit without I/O.

export type FindingEvidenceType = "COMMAND_OUTPUT" | "QUERY_RESULT" | "LOG_EXCERPT" | "FILE_READ" | "SCREENSHOT"

export const FINDING_EVIDENCE_TYPES: FindingEvidenceType[] = [
  "COMMAND_OUTPUT",
  "QUERY_RESULT",
  "LOG_EXCERPT",
  "FILE_READ",
  "SCREENSHOT",
]

export interface FindingEvidence {
  type: FindingEvidenceType
  source: string // exact source: file+lines, command, SQL, log excerpt — no interpretation
  capturedAt: number
}

export type FindingLifecycle = "NEW" | "EXTENDED" | "SUBSUMED"

export interface FindingImpact {
  optionId: string
  newStatus: OptionStatus
  reason: string
}

export interface Finding {
  id: string // "F-001" — permanent, sequential per topic
  soRef: string // owning objective: "SO-2" or "PO"
  title: string // one complete line
  evidence: FindingEvidence
  result: string // literal finding, without interpretation
  impactOnOption?: FindingImpact
  nextAction: string // one concrete executable action
  delegation?: { mode: "main" | "subagent"; justification: string }
  seeAlso: string[]
  supersedes: string[]
  spawnedBy?: string
  lifecycle: FindingLifecycle
  createdAt: number
  updatedAt: number
}

export type OptionStatus = "PENDING" | "EXPLORING" | "DISCARDED" | "SUCCESSFUL" | "CANCELLED"

export const OPTION_STATUSES: OptionStatus[] = ["PENDING", "EXPLORING", "DISCARDED", "SUCCESSFUL", "CANCELLED"]

export interface Option {
  id: string // "OPT-1"
  statement: string
  status: OptionStatus
  result: string // always reflects the currently known state
  reason?: string // mandatory for DISCARDED
  proofRef?: string
  createdAt: number
  updatedAt: number
}

export interface DoDCriterion {
  id: string // "D1"
  statement: string
  verifiableBy: string // specific command/query that proves it
  satisfiedBy: string[] // SO ids that discharge the criterion
  proofRef?: string
}

export interface Fingerprint {
  key: string // normalized blocker key (sorted tokens)
  symptom: string
  soRef: string
  status: string // status the SO reached when the blocker was resolved
  fixRef: string // finding id that resolved it
  createdAt: number
}

export interface ActionEntry {
  kind: string // "read" | "grep" | "glob" | "websearch" | "webfetch" | ...
  normalizedKey: string
  count: number
  lastAt: number
}

export interface PhaseState {
  paused: boolean
  since?: number
  checkpointAt?: number
  reason?: string
}

export interface AffectedResources {
  files: string[]
  envs: string[]
  dbSchemas: string[]
  services: string[]
}

export interface Precondition {
  actionClass: string
  requires: string[]
}

// Search-before-write contract thresholds (documented in the tool surface):
// score >= SEARCH_ATTACH_THRESHOLD  => the finding is NOT new: extend/cross-reference an existing one
// score <  SEARCH_NOVEL_THRESHOLD   => genuinely new
// in between                        => create only with a warning and a forced seeAlso
export const SEARCH_ATTACH_THRESHOLD = 0.68
export const SEARCH_NOVEL_THRESHOLD = 0.55

// ---------- ID allocation ----------

export function nextFindingId(findings: Finding[]): string {
  let max = 0
  for (const f of findings) {
    const match = f.id.match(/^F-(\d+)$/i)
    if (match) max = Math.max(max, parseInt(match[1], 10))
  }
  return `F-${String(max + 1).padStart(3, "0")}`
}

export function nextOptionId(options: Option[]): string {
  let max = 0
  for (const o of options) {
    const match = o.id.match(/^OPT-(\d+)$/i)
    if (match) max = Math.max(max, parseInt(match[1], 10))
  }
  return `OPT-${max + 1}`
}

export function nextDoDCriterionId(criteria: DoDCriterion[]): string {
  let max = 0
  for (const c of criteria) {
    const match = c.id.match(/^D(\d+)$/i)
    if (match) max = Math.max(max, parseInt(match[1], 10))
  }
  return `D${max + 1}`
}

// ---------- Anti-placeholder validation ----------

const CASE_INSENSITIVE_PLACEHOLDER = /<[^>\n]+>|\b(TBD|FIXME|N\/A|TBA|PLACEHOLDER|XXX+|LOREM)\b/i
const CASE_SENSITIVE_PLACEHOLDER = /\bTODO\b|\bTodo\s*:/

const PLACEHOLDER_PATTERN = {
  test: (s: string) => CASE_INSENSITIVE_PLACEHOLDER.test(s) || CASE_SENSITIVE_PLACEHOLDER.test(s),
}

export function isPlaceholder(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 15) return true
  return PLACEHOLDER_PATTERN.test(trimmed)
}

export function validateFindingFields(input: {
  title?: string
  result?: string
  nextAction?: string
  evidenceSource?: string
}): string[] {
  const violations: string[] = []
  const title = input.title?.trim() ?? ""
  const result = input.result?.trim() ?? ""
  const nextAction = input.nextAction?.trim() ?? ""
  const source = input.evidenceSource?.trim() ?? ""

  if (title.length < 15) violations.push(`finding title must be a complete one-line statement (>=15 chars, got ${title.length})`)
  else if (PLACEHOLDER_PATTERN.test(title)) violations.push(`finding title looks like a placeholder: "${title}"`)

  if (result.length < 15) violations.push(`finding result must be the literal observation (>=15 chars, got ${result.length})`)
  else if (PLACEHOLDER_PATTERN.test(result)) violations.push(`finding result looks like a placeholder: "${result}"`)

  if (nextAction.length < 15) violations.push(`finding nextAction must be one concrete executable action (>=15 chars, got ${nextAction.length})`)
  else if (PLACEHOLDER_PATTERN.test(nextAction)) violations.push(`finding nextAction looks like a placeholder: "${nextAction}"`)

  if (source.length < 3) violations.push("finding evidence.source must name the exact source (file+lines, command, SQL, log excerpt)")

  return violations
}

// ---------- Compliance audit (port of compliance_check.sh semantics) ----------

export interface AuditResult {
  pass: boolean
  violations: string[]
}

// Unvalidated root-cause phrasing: deduction words that assert a cause without adjacent execution evidence.
const UNVALIDATED_CAUSE_PATTERN = /\b(root cause (is|was)|should pass|should work|should be|should now|ought to|logically)\b/i
// Adjacent execution evidence markers that make a deduction acceptable.
const ARTIFACT_PATTERN = /\b(exit code|passed|passing|success|succeeded|ok\b|HTTP \d{3}|file:|line \d+|->|→)\b/i

export interface AuditObjectiveLike {
  id: string
  title: string
  status: string
  blocker?: string
  validationProof?: string
  delegation?: { mode?: string; justification?: string }
  children?: AuditObjectiveLike[]
}

export interface AuditDocLike {
  status?: string
  secondaries: AuditObjectiveLike[]
  options?: Option[]
  findings?: Finding[]
}

export function runComplianceAudit(doc: AuditDocLike): AuditResult {
  const violations: string[] = []

  const checkObjective = (obj: AuditObjectiveLike) => {
    if (obj.status === "resolved") {
      const proof = obj.validationProof?.trim() ?? ""
      if (!proof) violations.push(`${obj.id}: resolved without validation proof`)
      else if (UNVALIDATED_CAUSE_PATTERN.test(proof) && !ARTIFACT_PATTERN.test(proof)) {
        violations.push(`${obj.id}: proof asserts a root cause without execution evidence ("${proof.slice(0, 80)}")`)
      }
    }
    if (obj.status === "blocked") {
      const blocker = obj.blocker?.trim() ?? ""
      if (!blocker) {
        violations.push(`${obj.id}: status is 'blocked' but no blocker symptom or reason provided`)
      } else if (UNVALIDATED_CAUSE_PATTERN.test(blocker) && !ARTIFACT_PATTERN.test(blocker)) {
        violations.push(`${obj.id}: blocker declares an unvalidated root cause ("${blocker.slice(0, 80)}")`)
      }
    }
    if (obj.delegation) {
      const mode = obj.delegation.mode
      const just = obj.delegation.justification?.trim() ?? ""
      if (mode !== "main" && mode !== "subagent") {
        violations.push(`${obj.id}: delegation mode must be 'main' or 'subagent'`)
      }
      if (just.length < 10) {
        violations.push(`${obj.id}: delegation justification must be >= 10 characters (got ${just.length})`)
      } else if (PLACEHOLDER_PATTERN.test(just)) {
        violations.push(`${obj.id}: delegation justification looks like a placeholder: "${just}"`)
      }
    }
    for (const child of obj.children ?? []) checkObjective(child)
  }

  for (const so of doc.secondaries) checkObjective(so)

  for (const option of doc.options ?? []) {
    if (option.status === "EXPLORING" && !(option.result?.trim() ?? "")) {
      violations.push(`${option.id}: option is EXPLORING but its Result column is empty`)
    }
    if (option.status === "DISCARDED" && !(option.reason?.trim() ?? "")) {
      violations.push(`${option.id}: option is DISCARDED without a reason`)
    }
    if (option.status === "SUCCESSFUL" && !(option.proofRef?.trim() ?? "")) {
      violations.push(`${option.id}: option is SUCCESSFUL without proofRef`)
    }
    if (doc.status === "resolved" && (option.status === "PENDING" || option.status === "EXPLORING")) {
      violations.push(`${option.id}: Primary Objective cannot be resolved while option is still in '${option.status}' status (must be SUCCESSFUL, DISCARDED, or CANCELLED)`)
    }
  }

  for (const finding of doc.findings ?? []) {
    if (finding.lifecycle === "SUBSUMED") continue
    const fieldViolations = validateFindingFields({
      title: finding.title,
      result: finding.result,
      nextAction: finding.nextAction,
      evidenceSource: finding.evidence.source,
    })
    for (const v of fieldViolations) violations.push(`${finding.id}: ${v}`)
    if (!finding.delegation) {
      violations.push(`${finding.id}: delegation assessment is mandatory (must provide delegation: { mode: 'main' | 'subagent', justification: '...' })`)
    } else {
      const mode = finding.delegation.mode
      const just = finding.delegation.justification?.trim() ?? ""
      if (mode !== "main" && mode !== "subagent") {
        violations.push(`${finding.id}: delegation mode must be 'main' or 'subagent'`)
      }
      if (just.length < 10) {
        violations.push(`${finding.id}: delegation justification must be >= 10 characters (got ${just.length})`)
      } else if (PLACEHOLDER_PATTERN.test(just)) {
        violations.push(`${finding.id}: delegation justification looks like a placeholder: "${just}"`)
      }
    }
  }

  return { pass: violations.length === 0, violations }
}

// ---------- Search-before-write (pluggable scorer contract) ----------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "that", "this", "is", "are",
  "was", "were", "be", "been", "it", "its", "as", "at", "by", "from", "not", "no", "yes", "there",
  "here", "when", "then", "than", "so", "if", "but", "into", "over", "under", "about", "after",
  "before", "between", "out", "up", "down", "off", "ya", "el", "la", "los", "las", "un", "una",
  "que", "de", "en", "y", "o", "por", "con", "se", "su", "al", "del", "lo", "mas", "más",
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token))
}

// Query-coverage based score: fraction of query tokens present in the finding.
// Query coverage is primary; detailed findings are rewarded, not over-penalized. A subtle
// damping applies only to discourage matching short queries against giant irrelevant bodies.
// A real embeddings backend can replace this scorer through setFindingScorer without protocol changes.
export function defaultFindingScore(query: string, finding: Finding): number {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return 0
  const haystack = tokenize([finding.title, finding.result, finding.evidence.source, finding.nextAction].join(" "))
  const haystackSet = new Set(haystack)
  let coverage = 0
  for (const token of new Set(queryTokens)) {
    if (haystackSet.has(token)) coverage += 1
  }
  coverage /= new Set(queryTokens).size
  if (coverage < 0.5) return round3(coverage * 0.8)
  // When all (or most) query tokens match, keep the score high (>=0.70) even if the finding is detailed.
  const lengthRatio = Math.min(1, new Set(queryTokens).size / Math.max(1, haystackSet.size))
  return round3(coverage * (0.85 + 0.15 * lengthRatio))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

export interface FindingScorer {
  score(query: string, finding: Finding): number
}

export const defaultFindingScorer: FindingScorer = {
  score(query, finding) {
    return defaultFindingScore(query, finding)
  },
}

let activeFindingScorer: FindingScorer = defaultFindingScorer

export function setFindingScorer(scorer: FindingScorer | undefined): void {
  activeFindingScorer = scorer ?? defaultFindingScorer
}

export interface SearchHit {
  findingId: string
  score: number
  snippet: string
}

export function searchFindings(
  findings: Finding[],
  query: string,
  opts: { scorer?: FindingScorer } = {},
): SearchHit[] {
  const scorer = opts.scorer ?? activeFindingScorer
  const hits: SearchHit[] = []
  for (const finding of findings) {
    if (finding.lifecycle === "SUBSUMED") continue
    const score = scorer.score(query, finding)
    if (score < 0.1) continue
    hits.push({
      findingId: finding.id,
      score,
      snippet: `${finding.title} — ${finding.result}`.slice(0, 200),
    })
  }
  return hits.sort((a, b) => b.score - a.score)
}

// ---------- Fingerprints ----------

export function normalizeFingerprintKey(text: string): string {
  return tokenize(text)
    .sort()
    .join(" ")
}

// ---------- Definition of Done ----------

export interface DoDStateLike {
  definitionOfDone?: string
  validationProof?: string
  dod?: DoDCriterion[]
  secondaries?: Array<{
    id: string
    status: string
    validationProof?: string
  }>
}

export interface DoDEvaluation {
  legacy: boolean
  criteria: { criterion: DoDCriterion; satisfied: boolean; reason: string }[]
}

export function evaluateDoD(doc: DoDStateLike): DoDEvaluation {
  const criteria = doc.dod ?? []
  if (criteria.length === 0) {
    const proof = doc.validationProof?.trim() ?? ""
    const implicit: DoDCriterion = {
      id: "D1",
      statement: doc.definitionOfDone?.trim() || "Verify requirements",
      verifiableBy: "primary objective validation proof",
      satisfiedBy: [],
      proofRef: proof || undefined,
    }
    return {
      legacy: true,
      criteria: [
        {
          criterion: implicit,
          satisfied: proof.length > 0,
          reason: proof.length > 0 ? "proof attached" : "no validation proof attached to the Primary Objective",
        },
      ],
    }
  }
  return {
    legacy: false,
    criteria: criteria.map((criterion) => {
      let proof = criterion.proofRef?.trim() ?? ""
      // Auto-inherit proof from satisfiedBy secondary objectives if proofRef is omitted
      if (proof.length === 0 && Array.isArray(criterion.satisfiedBy) && criterion.satisfiedBy.length > 0) {
        const resolvedProofs = (doc.secondaries ?? [])
          .filter((s) => criterion.satisfiedBy.includes(s.id) && s.status === "resolved" && s.validationProof?.trim())
          .map((s) => `${s.id}: ${s.validationProof!.trim()}`)
        if (resolvedProofs.length > 0) {
          proof = resolvedProofs.join("; ")
          criterion.proofRef = proof
        }
      }
      return {
        criterion,
        satisfied: proof.length > 0 && (criterion.verifiableBy?.trim() ?? "").length > 0,
        reason: proof.length > 0
          ? "proofRef attached"
          : "missing proofRef (attach via action 'update_dod' with dodCriteria: [{ id: '" + criterion.id + "', proofRef: '...' }])",
      }
    }),
  }
}

// ---------- Documentation & Relevant Project Files detection (F-10) ----------

export function isDocsSurfaceFile(path: string): boolean {
  const base = path.split("/").pop() ?? path
  return (
    /^README|^AGENT|^CHANGELOG|^CONTRIBUTING/i.test(base) ||
    /(^|\/)docs\//i.test(path) ||
    /(^|\/)investigaciones\//i.test(path) ||
    /\.(md|mdx|rst|adoc|txt)$/i.test(base)
  )
}

/**
 * Checks if a file is an ephemeral, test-only, or non-production artifact.
 * Tests, fixtures, lockfiles, temporary logs, and dotfiles are excluded so
 * pure test runs don't falsely force a docs update.
 */
export function isEphemeralOrTestFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
  const base = normalized.split("/").pop() ?? normalized
  return (
    /(\.test|\.spec|\.fixture)\.[a-z0-9]+$/i.test(base) ||
    /(^|\/)(test|tests|__tests__|fixtures|spec|specs|mock|mocks)\//i.test(normalized) ||
    /(lock|cache|log)$/i.test(base) ||
    /^\.(git|turbo|next|nuxt|DS_Store)/.test(base)
  )
}

/**
 * Detects any relevant project modification (source code, configs, schemas, scripts, etc.)
 * regardless of technology stack or naming conventions.
 */
export function isRelevantProjectFile(path: string): boolean {
  if (!path || path.trim().length === 0) return false
  if (isDocsSurfaceFile(path)) return true
  if (isEphemeralOrTestFile(path)) return false

  // Any non-ephemeral project source or config file is relevant
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|ya?ml|toml|py|rs|go|rb|php|java|c|cpp|h|hpp|cs|swift|kt|sql|sh|bash|zsh|dockerfile|env.*)$/i.test(
    path,
  )
}

export function docsSurfaceFiles(files: string[]): string[] {
  const unique = new Set(files)
  return [...unique].filter(isDocsSurfaceFile)
}

export function relevantProjectFiles(files: string[]): string[] {
  const unique = new Set(files)
  return [...unique].filter(isRelevantProjectFile)
}

// ---------- Rendered projection (F-11): the EXPLORATION document as an auto-render ----------

export interface ProjectionObjectiveLike {
  id: string
  title: string
  status: string
  rationale?: string
  delegation?: { mode?: string; justification?: string }
  blocker?: string
  validationProof?: string
  children?: ProjectionObjectiveLike[]
  updatedAt: number
}

export interface ProjectionDocLike {
  topicKey?: string
  title: string
  status: string
  definitionOfDone?: string
  dod?: DoDCriterion[]
  secondaries: ProjectionObjectiveLike[]
  findings?: Finding[]
  options?: Option[]
  fingerprints?: Fingerprint[]
  phase?: PhaseState
  updatedAt: number
}

export function renderProjection(doc: ProjectionDocLike): string {
  const lines: string[] = []
  lines.push(`# EXPLORATION: ${doc.topicKey?.trim() ? doc.topicKey.trim() : doc.title}`)
  lines.push(`> Auto-rendered projection of the live objective tree (updated ${new Date(doc.updatedAt).toISOString()}).`)
  lines.push(`> Do not edit by hand — the objective tree is the source of truth; this document is regenerated on every change.`)
  lines.push("")

  lines.push("## Plan")
  lines.push(`- [PO] ${doc.title} [${String(doc.status).toUpperCase()}]`)
  if (doc.definitionOfDone?.trim()) lines.push(`- Definition of Done: ${doc.definitionOfDone.trim()}`)
  for (const criterion of doc.dod ?? []) {
    const proof = criterion.proofRef?.trim() ? `; proof: ${criterion.proofRef.trim()}` : "; proof: —"
    const by = criterion.satisfiedBy.length > 0 ? `; satisfied by: ${criterion.satisfiedBy.join(", ")}` : ""
    lines.push(`  - ${criterion.id}: ${criterion.statement} (verify: ${criterion.verifiableBy}${by}${proof})`)
  }
  lines.push("")

  lines.push("## Options")
  const options = doc.options ?? []
  if (options.length === 0) {
    lines.push("- (none)")
  } else {
    lines.push("| Option | Status | Result |")
    lines.push("|---|---|---|")
    for (const option of options) {
      const result = option.result?.trim() || "—"
      lines.push(`| ${option.id}: ${option.statement} | ${option.status} | ${result.replace(/\|/g, "\\|")} |`)
    }
  }
  lines.push("")

  lines.push("## Findings")
  const findings = (doc.findings ?? []).filter((f) => f.lifecycle !== "SUBSUMED")
  if (findings.length === 0) {
    lines.push("- (none)")
  } else {
    for (const finding of findings) {
      const fDelTag = finding.delegation ? ` [${finding.delegation.mode}]` : ""
      lines.push(`### ${finding.id} [${finding.soRef}]${fDelTag} ${finding.title}`)
      lines.push(`- Evidence: ${finding.evidence.type} — ${finding.evidence.source} (${new Date(finding.evidence.capturedAt).toISOString()})`)
      lines.push(`- Result: ${finding.result}`)
      if (finding.impactOnOption) {
        lines.push(`- Impact on Option: ${finding.impactOnOption.optionId} -> ${finding.impactOnOption.newStatus} (${finding.impactOnOption.reason})`)
      }
      lines.push(`- Next: ${finding.nextAction}`)
      const refs: string[] = []
      if (finding.seeAlso.length > 0) refs.push(`see also ${finding.seeAlso.join(", ")}`)
      if (finding.supersedes.length > 0) refs.push(`supersedes ${finding.supersedes.join(", ")}`)
      if (finding.spawnedBy) refs.push(`spawned by ${finding.spawnedBy}`)
      refs.push(`lifecycle ${finding.lifecycle}`)
      lines.push(`- Refs: ${refs.join(" | ")}`)
      lines.push("")
    }
  }

  lines.push("## Blocker Fingerprints")
  const fingerprints = doc.fingerprints ?? []
  if (fingerprints.length === 0) {
    lines.push("- (none)")
  } else {
    for (const fp of fingerprints) {
      lines.push(`- ${fp.key} -> ${fp.symptom} (${fp.soRef}, ${fp.status}, fix: ${fp.fixRef})`)
    }
  }
  lines.push("")

  lines.push("## Current Status")
  for (const so of doc.secondaries) {
    const soDelTag = so.delegation ? ` [${so.delegation.mode}]` : ""
    lines.push(`- ${so.id} [${String(so.status).toUpperCase()}]${soDelTag} ${so.title}`)
    if (so.blocker) lines.push(`  - Blocker: ${so.blocker}`)
    if (so.validationProof) lines.push(`  - Proof: ${so.validationProof}`)
    for (const child of so.children ?? []) {
      const chDelTag = child.delegation ? ` [${child.delegation.mode}]` : ""
      lines.push(`  - ${child.id} [${String(child.status).toUpperCase()}]${chDelTag} ${child.title}`)
    }
  }
  const nextAction = nextConcreteAction(doc)
  if (nextAction) lines.push(`**Next concrete action:** ${nextAction}`)

  return lines.join("\n")
}

export function nextConcreteAction(doc: ProjectionDocLike): string | undefined {
  const active =
    doc.secondaries.find((s) => s.status === "exploring") ?? doc.secondaries.find((s) => s.status === "pending")
  if (!active) return undefined
  const latest = (doc.findings ?? [])
    .filter((f) => f.soRef === active.id && f.lifecycle !== "SUBSUMED")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return latest?.nextAction?.trim() || active.title
}

// ---------- Document serialization / normalization ----------

export const OBJECTIVE_DOC_VERSION = 1

export function serializeDocument(doc: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify({ version: OBJECTIVE_DOC_VERSION, ...doc }))
}

// Boundary validation for documents loaded from storage: one-time shape normalization,
// typed values flow inward from here.
export function parseDocument(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as Record<string, any>
  if (typeof raw.title !== "string" || raw.title.length === 0) return undefined

  const doc: Record<string, any> = { ...raw }
  if (typeof doc.status !== "string") doc.status = "exploring"
  if (typeof doc.definitionOfDone !== "string") doc.definitionOfDone = ""
  doc.secondaries = Array.isArray(raw.secondaries) ? raw.secondaries : []
  doc.findings = Array.isArray(raw.findings) ? raw.findings : []
  doc.options = Array.isArray(raw.options) ? raw.options : []
  doc.fingerprints = Array.isArray(raw.fingerprints) ? raw.fingerprints : []
  doc.dod = Array.isArray(raw.dod) ? raw.dod : []
  if (!Array.isArray(doc.touchedFiles)) doc.touchedFiles = []
  if (!Array.isArray(doc.relevantDocumentableFiles)) doc.relevantDocumentableFiles = []
  if (typeof doc.createdAt !== "number") doc.createdAt = Date.now()
  if (typeof doc.updatedAt !== "number") doc.updatedAt = Date.now()
  return doc
}

// Repairs invariants that must hold on hydration: a resolved PO with open children is corrupt
// (the observed "PO RESOLVED with 4 open SOs" failure mode) and is reverted to exploring.
export function repairDocumentInvariants(doc: Record<string, any>): string[] {
  const repairs: string[] = []
  const isClosed = (status: string) => status === "resolved" || status === "discarded" || status === "cancelled"
  const openSecondaries = (doc.secondaries ?? []).filter(
    (s: any) => !isClosed(s.status) || (s.children ?? []).some((t: any) => !isClosed(t.status)),
  )
  if (doc.status === "resolved" && openSecondaries.length > 0) {
    doc.status = "exploring"
    repairs.push(`PO was resolved with ${openSecondaries.length} open secondary objective(s) (${openSecondaries.map((s: any) => s.id).join(", ")}); reverted to exploring`)
  }
  if (doc.status === "presented_awaiting_confirmation" && doc.phase && typeof doc.phase === "object") {
    doc.phase.paused = true
  }
  return repairs
}
