import { Option, Schema } from "effect"
import type { SessionCreateInput, SessionInfo } from "@opencode/client/promise"

type SessionMetadataValue = NonNullable<SessionCreateInput["metadata"]>[string]

export type ObjectiveStatus =
  | "pending"
  | "exploring"
  | "blocked"
  | "resolved"
  | "discarded"
  | "cancelled"

export interface DelegationView {
  mode: "main" | "subagent"
  justification?: string
}

export interface TertiaryObjectiveView {
  id: string
  title: string
  status: ObjectiveStatus
  rationale: string
  delegation?: DelegationView
  blocker?: string
  validationProof?: string
}

export interface SecondaryObjectiveView {
  id: string
  title: string
  status: ObjectiveStatus
  rationale: string
  delegation?: DelegationView
  blocker?: string
  validationProof?: string
  affectedResources?: {
    files?: string[]
    services?: string[]
    envs?: string[]
    dbSchemas?: string[]
  }
  children?: TertiaryObjectiveView[]
}

export type PrimaryObjectiveStatus =
  | "pending"
  | "investigating"
  | "exploring"
  | "resolved"
  | "presented_awaiting_confirmation"

export type FindingLifecycle = "NEW" | "EXTENDED" | "SUBSUMED"

export type OptionStatusView = "PENDING" | "EXPLORING" | "DISCARDED" | "SUCCESSFUL" | "CANCELLED"

export interface DoDCriterionView {
  id: string
  statement: string
  verifiableBy?: string
  satisfiedBy?: string[]
  proofRef?: string
}

export interface FindingView {
  id: string
  title: string
  lifecycle: FindingLifecycle
  status?: string
  result: string
  soRef?: string
  evidenceType?: string
  delegation?: DelegationView
}

export interface OptionView {
  id: string
  statement: string
  status: OptionStatusView
  result?: string
  reason?: string
}

export interface FingerprintView {
  key: string
  symptom: string
  soRef?: string
  status?: string
  fixRef?: string
}

export interface ContextMetricsView {
  tokensUsed?: number
  contextWindow?: number
  percentUsed?: number
  recommendFreshSession?: boolean
}

export interface PrimaryObjectiveView {
  title: string
  status: PrimaryObjectiveStatus
  definitionOfDone: string
  approvedByUser?: boolean
  originSessionID?: string
  secondaries: SecondaryObjectiveView[]
  dodCriteria?: DoDCriterionView[]
  findings?: FindingView[]
  options?: OptionView[]
  fingerprints?: FingerprintView[]
  checkpointNote?: string
  contextMetrics?: ContextMetricsView
}

const ObjectiveStatusSchema = Schema.Literals([
  "pending",
  "exploring",
  "blocked",
  "resolved",
  "discarded",
  "cancelled",
])

const DelegationSchema = Schema.Struct({
  mode: Schema.Literals(["main", "subagent"]),
  justification: Schema.optional(Schema.String),
})

const TertiarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.optional(ObjectiveStatusSchema),
  rationale: Schema.optional(Schema.String),
  delegation: Schema.optional(DelegationSchema),
  blocker: Schema.optional(Schema.String),
  validationProof: Schema.optional(Schema.String),
})

const AffectedResourcesSchema = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)),
  services: Schema.optional(Schema.Array(Schema.String)),
  envs: Schema.optional(Schema.Array(Schema.String)),
  dbSchemas: Schema.optional(Schema.Array(Schema.String)),
})

const SecondarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.optional(ObjectiveStatusSchema),
  rationale: Schema.optional(Schema.String),
  delegation: Schema.optional(DelegationSchema),
  blocker: Schema.optional(Schema.String),
  validationProof: Schema.optional(Schema.String),
  affectedResources: Schema.optional(AffectedResourcesSchema),
  children: Schema.optional(Schema.Array(TertiarySchema)),
})

const DodCriterionSchema = Schema.Struct({
  id: Schema.String,
  statement: Schema.String,
  verifiableBy: Schema.optional(Schema.String),
  satisfiedBy: Schema.optional(Schema.Array(Schema.String)),
  proofRef: Schema.optional(Schema.String),
})

const FindingSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  lifecycle: Schema.optional(Schema.Literals(["NEW", "EXTENDED", "SUBSUMED"])),
  status: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  soRef: Schema.optional(Schema.String),
  evidenceType: Schema.optional(Schema.String),
  delegation: Schema.optional(DelegationSchema),
})

const OptionSchema = Schema.Struct({
  id: Schema.String,
  statement: Schema.String,
  status: Schema.optional(Schema.Literals(["PENDING", "EXPLORING", "DISCARDED", "SUCCESSFUL", "CANCELLED"])),
  result: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

const FingerprintSchema = Schema.Struct({
  key: Schema.String,
  symptom: Schema.String,
  soRef: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  fixRef: Schema.optional(Schema.String),
})

const ContextMetricsSchema = Schema.Struct({
  tokensUsed: Schema.optional(Schema.Number),
  contextWindow: Schema.optional(Schema.Number),
  percentUsed: Schema.optional(Schema.Number),
  recommendFreshSession: Schema.optional(Schema.Boolean),
})

const RawPrimaryObjectiveSchema = Schema.Struct({
  title: Schema.String,
  status: Schema.optional(
    Schema.Literals(["pending", "investigating", "exploring", "resolved", "presented_awaiting_confirmation"]),
  ),
  definitionOfDone: Schema.optional(Schema.String),
  approvedByUser: Schema.optional(Schema.Boolean),
  originSessionID: Schema.optional(Schema.String),
  secondaries: Schema.optional(Schema.Array(SecondarySchema)),
  dodCriteria: Schema.optional(Schema.Array(DodCriterionSchema)),
  dod: Schema.optional(Schema.Array(DodCriterionSchema)),
  findings: Schema.optional(Schema.Array(FindingSchema)),
  options: Schema.optional(Schema.Array(OptionSchema)),
  fingerprints: Schema.optional(Schema.Array(FingerprintSchema)),
  checkpointNote: Schema.optional(Schema.String),
  contextMetrics: Schema.optional(ContextMetricsSchema),
})

const decodeRawObjectives = Schema.decodeUnknownOption(RawPrimaryObjectiveSchema)

export function isObjectiveClosed(status: ObjectiveStatus): boolean {
  return status === "resolved" || status === "discarded" || status === "cancelled"
}

export function normalizePrimaryObjectiveView(
  metadata: SessionInfo["metadata"],
): PrimaryObjectiveView | undefined {
  const decoded = decodeRawObjectives(metadata?.objectives)

  if (Option.isNone(decoded) || !decoded.value.title) return undefined

  const raw = decoded.value
  const initialStatus: PrimaryObjectiveStatus = raw.status ?? "exploring"

  const secondaries: SecondaryObjectiveView[] = (raw.secondaries ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status ?? "pending",
    rationale: s.rationale ?? "",
    delegation: s.delegation ? { mode: s.delegation.mode, justification: s.delegation.justification } : undefined,
    blocker: s.blocker,
    validationProof: s.validationProof,
    affectedResources: s.affectedResources
      ? {
          files: s.affectedResources.files ? [...s.affectedResources.files] : undefined,
          services: s.affectedResources.services ? [...s.affectedResources.services] : undefined,
          envs: s.affectedResources.envs ? [...s.affectedResources.envs] : undefined,
          dbSchemas: s.affectedResources.dbSchemas ? [...s.affectedResources.dbSchemas] : undefined,
        }
      : undefined,
    children:
      s.children && s.children.length > 0
        ? s.children.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status ?? "pending",
            rationale: t.rationale ?? "",
            delegation: t.delegation ? { mode: t.delegation.mode, justification: t.delegation.justification } : undefined,
            blocker: t.blocker,
            validationProof: t.validationProof,
          }))
        : undefined,
  }))

  const hasOpenChild = secondaries.some(
    (s) => !isObjectiveClosed(s.status) || (s.children ?? []).some((t) => !isObjectiveClosed(t.status)),
  )

  const allChildrenClosed =
    secondaries.length > 0 &&
    secondaries.every((s) => isObjectiveClosed(s.status) && (s.children ?? []).every((t) => isObjectiveClosed(t.status)))

  const status: PrimaryObjectiveStatus =
    initialStatus === "resolved" && hasOpenChild
      ? "exploring"
      : initialStatus !== "resolved" &&
          initialStatus !== "investigating" &&
          initialStatus !== "presented_awaiting_confirmation" &&
          allChildrenClosed
        ? "resolved"
        : initialStatus

  const rawDod = raw.dodCriteria ?? raw.dod

  const dodCriteria: DoDCriterionView[] | undefined =
    rawDod && rawDod.length > 0
      ? rawDod.map((d) => ({
          id: d.id,
          statement: d.statement,
          verifiableBy: d.verifiableBy,
          satisfiedBy: d.satisfiedBy ? [...d.satisfiedBy] : undefined,
          proofRef: d.proofRef,
        }))
      : undefined

  const findings: FindingView[] | undefined =
    raw.findings && raw.findings.length > 0
      ? raw.findings.map((f) => ({
          id: f.id,
          title: f.title,
          lifecycle: f.lifecycle ?? "NEW",
          status: f.status,
          result: f.result ?? "",
          soRef: f.soRef,
          evidenceType: f.evidenceType,
          delegation: f.delegation ? { mode: f.delegation.mode, justification: f.delegation.justification } : undefined,
        }))
      : undefined

  const options: OptionView[] | undefined =
    raw.options && raw.options.length > 0
      ? raw.options.map((o) => ({
          id: o.id,
          statement: o.statement,
          status: o.status ?? "PENDING",
          result: o.result,
          reason: o.reason,
        }))
      : undefined

  const fingerprints: FingerprintView[] | undefined =
    raw.fingerprints && raw.fingerprints.length > 0
      ? raw.fingerprints.map((fp) => ({
          key: fp.key,
          symptom: fp.symptom,
          soRef: fp.soRef,
          status: fp.status,
          fixRef: fp.fixRef,
        }))
      : undefined

  return {
    title: raw.title,
    status,
    definitionOfDone: raw.definitionOfDone ?? "",
    approvedByUser: raw.approvedByUser,
    originSessionID: raw.originSessionID,
    secondaries,
    dodCriteria,
    findings,
    options,
    fingerprints,
    checkpointNote: raw.checkpointNote,
    contextMetrics: raw.contextMetrics ? { ...raw.contextMetrics } : undefined,
  }
}

export function activeSecondaryObjective(po: PrimaryObjectiveView | undefined): SecondaryObjectiveView | undefined {
  if (!po) return undefined

  return (
    po.secondaries.find((s) => s.status === "exploring" || s.status === "blocked") ??
    po.secondaries.find((s) => s.status === "pending") ??
    po.secondaries.findLast((s) => s.status === "resolved") ??
    po.secondaries[0]
  )
}

export function formatTreeSummary(po: PrimaryObjectiveView | undefined): string {
  if (!po || !po.title) return ""
  const lines: string[] = [`### Árbol de Objetivos Activo`, `**Objetivo Primario:** ${po.title}`]

  if (po.definitionOfDone) {
    lines.push(`**Definición de Hecho (DoD):** ${po.definitionOfDone}`)
  }

  if (po.secondaries.length > 0) {
    lines.push(``, `**Objetivos Secundarios:**`)

    for (const so of po.secondaries) {
      const del = so.delegation?.mode ? ` [${so.delegation.mode}]` : ""
      lines.push(`- **${so.id}** [${so.status.toUpperCase()}]${del} ${so.title}`)

      if (so.rationale) lines.push(`  - *Rationale:* ${so.rationale}`)
    }
  }

  if (po.findings && po.findings.length > 0) {
    lines.push(``, `**Hallazgos de Exploración:**`)

    for (const f of po.findings) {
      lines.push(`- **${f.id}**: ${f.title}`)

      if (f.result) lines.push(`  - *Resultado:* ${f.result}`)
    }
  }

  return lines.join("\n")
}

export function cloneObjectivesForFreshSession(
  metadata: SessionInfo["metadata"],
  originSessionID: string,
): SessionMetadataValue {
  const raw = metadata?.objectives
  // SAFETY: raw comes from session.metadata, which is a JSON-serializable value.
  const parsed = (raw ? JSON.parse(JSON.stringify(raw)) : {}) as Record<string, SessionMetadataValue>
  parsed.status = "exploring"
  parsed.approvedByUser = true
  parsed.originSessionID = originSessionID
  parsed.phase = { paused: false, reason: "Transferred to fresh session" }

  return parsed
}
