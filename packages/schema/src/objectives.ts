export * as ObjectivesView from "./objectives.js"

import { Option, Schema } from "effect"
import { optional } from "./schema.js"
import type { SessionMetadata } from "./session-metadata.js"

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
  justification: optional(Schema.String),
})

const TertiarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: optional(ObjectiveStatusSchema),
  rationale: optional(Schema.String),
  delegation: optional(DelegationSchema),
  blocker: optional(Schema.String),
  validationProof: optional(Schema.String),
})

const AffectedResourcesSchema = Schema.Struct({
  files: optional(Schema.Array(Schema.String)),
  services: optional(Schema.Array(Schema.String)),
  envs: optional(Schema.Array(Schema.String)),
  dbSchemas: optional(Schema.Array(Schema.String)),
})

const SecondarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: optional(ObjectiveStatusSchema),
  rationale: optional(Schema.String),
  delegation: optional(DelegationSchema),
  blocker: optional(Schema.String),
  validationProof: optional(Schema.String),
  affectedResources: optional(AffectedResourcesSchema),
  children: optional(Schema.Array(TertiarySchema)),
})

const DodCriterionSchema = Schema.Struct({
  id: Schema.String,
  statement: Schema.String,
  verifiableBy: optional(Schema.String),
  satisfiedBy: optional(Schema.Array(Schema.String)),
  proofRef: optional(Schema.String),
})

const FindingSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  lifecycle: optional(Schema.Literals(["NEW", "EXTENDED", "SUBSUMED"])),
  status: optional(Schema.String),
  result: optional(Schema.String),
  soRef: optional(Schema.String),
  evidenceType: optional(Schema.String),
  delegation: optional(DelegationSchema),
})

const OptionSchema = Schema.Struct({
  id: Schema.String,
  statement: Schema.String,
  status: optional(Schema.Literals(["PENDING", "EXPLORING", "DISCARDED", "SUCCESSFUL", "CANCELLED"])),
  result: optional(Schema.String),
  reason: optional(Schema.String),
})

const FingerprintSchema = Schema.Struct({
  key: Schema.String,
  symptom: Schema.String,
  soRef: optional(Schema.String),
  status: optional(Schema.String),
  fixRef: optional(Schema.String),
})

const ContextMetricsSchema = Schema.Struct({
  tokensUsed: optional(Schema.Number),
  contextWindow: optional(Schema.Number),
  percentUsed: optional(Schema.Number),
  recommendFreshSession: optional(Schema.Boolean),
})

export const RawPrimaryObjectiveSchema = Schema.Struct({
  title: Schema.String,
  status: optional(
    Schema.Literals(["pending", "investigating", "exploring", "resolved", "presented_awaiting_confirmation"]),
  ),
  definitionOfDone: optional(Schema.String),
  approvedByUser: optional(Schema.Boolean),
  originSessionID: optional(Schema.String),
  secondaries: optional(Schema.Array(SecondarySchema)),
  dodCriteria: optional(Schema.Array(DodCriterionSchema)),
  dod: optional(Schema.Array(DodCriterionSchema)),
  findings: optional(Schema.Array(FindingSchema)),
  options: optional(Schema.Array(OptionSchema)),
  fingerprints: optional(Schema.Array(FingerprintSchema)),
  checkpointNote: optional(Schema.String),
  contextMetrics: optional(ContextMetricsSchema),
}).annotate({ identifier: "Objectives.PrimaryView" })

const decodeRawObjectives = Schema.decodeUnknownOption(RawPrimaryObjectiveSchema)

export function isObjectiveClosed(status: ObjectiveStatus): boolean {
  return status === "resolved" || status === "discarded" || status === "cancelled"
}

export function normalizePrimaryObjectiveView(rawObjectives: unknown): PrimaryObjectiveView | undefined {
  const decoded = decodeRawObjectives(rawObjectives)

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

export function normalizeSessionObjectives(metadata: SessionMetadata | undefined): PrimaryObjectiveView | undefined {
  return normalizePrimaryObjectiveView(metadata?.objectives)
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
  const lines: string[] = ["### Active Objective Tree", `**Primary Objective:** ${po.title}`]

  if (po.definitionOfDone) {
    lines.push(`**Definition of Done (DoD):** ${po.definitionOfDone}`)
  }

  if (po.secondaries.length > 0) {
    lines.push("", "**Secondary Objectives:**")

    for (const so of po.secondaries) {
      const del = so.delegation?.mode ? ` [${so.delegation.mode}]` : ""
      lines.push(`- **${so.id}** [${so.status.toUpperCase()}]${del} ${so.title}`)

      if (so.rationale) lines.push(`  - *Rationale:* ${so.rationale}`)
    }
  }

  if (po.findings && po.findings.length > 0) {
    lines.push("", "**Exploration Findings:**")

    for (const f of po.findings) {
      lines.push(`- **${f.id}**: ${f.title}`)

      if (f.result) lines.push(`  - *Result:* ${f.result}`)
    }
  }

  return lines.join("\n")
}

export function cloneObjectivesForFreshSession(
  metadata: SessionMetadata | undefined,
  originSessionID: string,
): Record<string, unknown> {
  const raw = metadata?.objectives
  const cloned =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (JSON.parse(JSON.stringify(raw)) as Record<string, unknown>)
      : {}

  return {
    ...cloned,
    status: "exploring",
    approvedByUser: true,
    originSessionID,
    phase: { paused: false, reason: "Transferred to fresh session" },
  }
}

export function prepareObjectivesRefinementMetadata(metadata: SessionMetadata | undefined): Record<string, unknown> {
  const base: Record<string, unknown> = metadata ? { ...metadata } : {}
  const raw = metadata?.objectives

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const cloned = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
    delete cloned.planPresentedAt

    const prevPhase =
      cloned.phase && typeof cloned.phase === "object" && !Array.isArray(cloned.phase)
        ? (cloned.phase as Record<string, unknown>)
        : {}

    base.objectives = {
      ...cloned,
      status: "investigating",
      approvedByUser: false,
      phase: {
        ...prevPhase,
        paused: false,
        reason: "Ajustes solicitados por el usuario",
      },
    }
  }

  base.planRefinementRequested = true

  return base
}
