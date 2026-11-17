import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Option, Schema } from "effect"
import { Accordion } from "@opencode/ui/accordion"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { StickyAccordionHeader } from "@opencode/ui/sticky-accordion-header"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import type ObjectivesDefinition from "./index"

type ObjectiveStatus = "pending" | "exploring" | "blocked" | "resolved" | "discarded" | "cancelled"

type PrimaryObjectiveStatus =
  | "pending"
  | "investigating"
  | "exploring"
  | "resolved"
  | "presented_awaiting_confirmation"

type FindingLifecycle = "NEW" | "EXTENDED" | "SUBSUMED"

type OptionStatusView = "PENDING" | "EXPLORING" | "DISCARDED" | "SUCCESSFUL" | "CANCELLED"

interface DelegationView {
  mode: "main" | "subagent"
  justification?: string
}

interface TertiaryObjectiveView {
  id: string
  title: string
  status: ObjectiveStatus
  rationale: string
  delegation?: DelegationView
  blocker?: string
  validationProof?: string
}

interface SecondaryObjectiveView {
  id: string
  title: string
  status: ObjectiveStatus
  rationale: string
  delegation?: DelegationView
  blocker?: string
  validationProof?: string
  affectedResources?: {
    files?: string[]
  }
  children?: TertiaryObjectiveView[]
}

interface DoDCriterionView {
  id: string
  statement: string
  proofRef?: string
}

interface FindingView {
  id: string
  title: string
  lifecycle: FindingLifecycle
  result: string
  soRef?: string
  delegation?: DelegationView
}

interface OptionView {
  id: string
  statement: string
  status: OptionStatusView
  result?: string
}

interface FingerprintView {
  key: string
  symptom: string
  fixRef?: string
}

interface PrimaryObjectiveView {
  title: string
  status: PrimaryObjectiveStatus
  definitionOfDone: string
  approvedByUser?: boolean
  secondaries: SecondaryObjectiveView[]
  dodCriteria?: DoDCriterionView[]
  findings?: FindingView[]
  options?: OptionView[]
  fingerprints?: FingerprintView[]
  checkpointNote?: string
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

const SecondarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.optional(ObjectiveStatusSchema),
  rationale: Schema.optional(Schema.String),
  delegation: Schema.optional(DelegationSchema),
  blocker: Schema.optional(Schema.String),
  validationProof: Schema.optional(Schema.String),
  affectedResources: Schema.optional(
    Schema.Struct({
      files: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  children: Schema.optional(Schema.Array(TertiarySchema)),
})

const DodCriterionSchema = Schema.Struct({
  id: Schema.String,
  statement: Schema.String,
  proofRef: Schema.optional(Schema.String),
})

const FindingSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  lifecycle: Schema.optional(Schema.Literals(["NEW", "EXTENDED", "SUBSUMED"])),
  result: Schema.optional(Schema.String),
  soRef: Schema.optional(Schema.String),
  delegation: Schema.optional(DelegationSchema),
})

const OptionSchema = Schema.Struct({
  id: Schema.String,
  statement: Schema.String,
  status: Schema.optional(Schema.Literals(["PENDING", "EXPLORING", "DISCARDED", "SUCCESSFUL", "CANCELLED"])),
  result: Schema.optional(Schema.String),
})

const FingerprintSchema = Schema.Struct({
  key: Schema.String,
  symptom: Schema.String,
  fixRef: Schema.optional(Schema.String),
})

const RawPrimaryObjectiveSchema = Schema.Struct({
  title: Schema.String,
  status: Schema.optional(
    Schema.Literals(["pending", "investigating", "exploring", "resolved", "presented_awaiting_confirmation"]),
  ),
  definitionOfDone: Schema.optional(Schema.String),
  approvedByUser: Schema.optional(Schema.Boolean),
  secondaries: Schema.optional(Schema.Array(SecondarySchema)),
  dodCriteria: Schema.optional(Schema.Array(DodCriterionSchema)),
  dod: Schema.optional(Schema.Array(DodCriterionSchema)),
  findings: Schema.optional(Schema.Array(FindingSchema)),
  options: Schema.optional(Schema.Array(OptionSchema)),
  fingerprints: Schema.optional(Schema.Array(FingerprintSchema)),
  checkpointNote: Schema.optional(Schema.String),
})

const decodeRawObjectives = Schema.decodeUnknownOption(RawPrimaryObjectiveSchema)

function isClosed(status: ObjectiveStatus): boolean {
  return status === "resolved" || status === "discarded" || status === "cancelled"
}

export function readSessionObjectives(session: MountedSession): PrimaryObjectiveView | undefined {
  if (!session.id) return undefined
  const info = session.server.data.session.get(session.id)
  const decoded = decodeRawObjectives(info?.metadata?.objectives)

  if (Option.isNone(decoded) || !decoded.value.title) return undefined

  const raw = decoded.value
  const initialStatus: PrimaryObjectiveStatus = raw.status ?? "exploring"

  const secondaries: SecondaryObjectiveView[] = (raw.secondaries ?? []).map((s) => {
    const files = s.affectedResources?.files ? [...s.affectedResources.files] : []

    return {
      id: s.id,
      title: s.title,
      status: s.status ?? "pending",
      rationale: s.rationale ?? "",
      delegation: s.delegation ? { mode: s.delegation.mode, justification: s.delegation.justification } : undefined,
      blocker: s.blocker,
      validationProof: s.validationProof,
      affectedResources: files.length > 0 ? { files } : undefined,
      children:
        s.children && s.children.length > 0
          ? s.children.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status ?? "pending",
              rationale: t.rationale ?? "",
              delegation: t.delegation
                ? { mode: t.delegation.mode, justification: t.delegation.justification }
                : undefined,
              blocker: t.blocker,
              validationProof: t.validationProof,
            }))
          : undefined,
    }
  })

  const hasOpenChild = secondaries.some(
    (s) => !isClosed(s.status) || (s.children ?? []).some((t) => !isClosed(t.status)),
  )

  const allChildrenClosed =
    secondaries.length > 0 &&
    secondaries.every((s) => isClosed(s.status) && (s.children ?? []).every((t) => isClosed(t.status)))

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
          proofRef: d.proofRef,
        }))
      : undefined

  const findings: FindingView[] | undefined =
    raw.findings && raw.findings.length > 0
      ? raw.findings.map((f) => ({
          id: f.id,
          title: f.title,
          lifecycle: f.lifecycle ?? "NEW",
          result: f.result ?? "",
          soRef: f.soRef,
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
        }))
      : undefined

  const fingerprints: FingerprintView[] | undefined =
    raw.fingerprints && raw.fingerprints.length > 0
      ? raw.fingerprints.map((fp) => ({
          key: fp.key,
          symptom: fp.symptom,
          fixRef: fp.fixRef,
        }))
      : undefined

  return {
    title: raw.title,
    status,
    definitionOfDone: raw.definitionOfDone ?? "",
    approvedByUser: raw.approvedByUser,
    secondaries,
    dodCriteria,
    findings,
    options,
    fingerprints,
    checkpointNote: raw.checkpointNote,
  }
}

export default function SessionObjectivesTab(props: { session: MountedSession }) {
  const ctx = usePlugin<typeof ObjectivesDefinition>()
  const objectives = createMemo(() => readSessionObjectives(props.session))

  const resolvedCount = createMemo(
    () => objectives()?.secondaries.filter((s) => s.status === "resolved").length ?? 0,
  )

  const totalCount = createMemo(() => objectives()?.secondaries.length ?? 0)

  return (
    <div class="@container h-full overflow-y-auto" data-scrollable>
      <div
        data-slot="session-objectives-content"
        class="px-4 pt-4 pb-6 flex flex-col gap-5 md:px-6 md:pb-10"
      >
        <Show
          when={objectives()}
          fallback={
            <div class="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <div class="text-[14px] font-medium leading-[var(--line-height-base)] text-text-strong">
                {ctx.t("empty.title")}
              </div>
              <div class="max-w-xs text-[13px] leading-[var(--line-height-base)] text-text-weak">
                {ctx.t("empty.description")}
              </div>
            </div>
          }
        >
          {(po) => (
            <>
              {/* Primary Objective Header Card */}
              <div class="flex flex-col gap-3 rounded-lg border border-v2-border-border-base bg-surface-base p-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="flex items-center gap-2 min-w-0">
                    <StatusGlyph status={po().status} />
                    <span class="text-[14px] font-medium leading-[var(--line-height-base)] text-text-strong" dir="auto">
                      {po().title}
                    </span>
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <Show when={po().approvedByUser && po().status === "exploring"}>
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => ctx.commands.run("session.plan.unapprove")}
                      >
                        {ctx.t("action.pausePlan")}
                      </Button>
                    </Show>
                    <Button
                      size="small"
                      variant={po().status === "presented_awaiting_confirmation" ? "submit" : "outline"}
                      onClick={() => ctx.commands.run("session.plan.review")}
                    >
                      {ctx.t("action.reviewPlan")}
                    </Button>
                  </div>
                </div>

                {/* Phase Banner */}
                <Switch>
                  <Match when={po().status === "presented_awaiting_confirmation"}>
                    <div class="rounded-md bg-v2-background-bg-layer-02 px-3 py-1.5 text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-state-fg-warning">
                      {ctx.t("status.awaitingConfirmation")}
                    </div>
                  </Match>
                  <Match when={po().status === "investigating"}>
                    <div class="rounded-md bg-v2-background-bg-layer-02 px-3 py-1.5 text-[12px] leading-[var(--line-height-compact)] text-text-base">
                      {ctx.t("status.investigating")}
                    </div>
                  </Match>
                  <Match when={po().status === "exploring"}>
                    <div class="text-[12px] leading-[var(--line-height-compact)] text-text-weak">
                      {ctx.t("status.exploring")}
                    </div>
                  </Match>
                  <Match when={po().status === "resolved"}>
                    <div class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-state-fg-success">
                      {ctx.t("status.resolved")}
                    </div>
                  </Match>
                </Switch>

                <Show when={po().checkpointNote}>
                  {(note) => (
                    <div class="text-[12px] leading-[var(--line-height-compact)] text-text-weak" dir="auto">
                      {note()}
                    </div>
                  )}
                </Show>

                {/* Definition of Done */}
                <Show when={po().definitionOfDone || (po().dodCriteria && po().dodCriteria!.length > 0)}>
                  <div class="flex flex-col gap-1.5 border-t border-v2-border-border-base pt-2.5">
                    <div class="text-[12px] font-medium leading-[var(--line-height-compact)] text-text-weak">
                      {ctx.t("section.dod")}
                    </div>
                    <Show when={po().definitionOfDone}>
                      <div class="text-[13px] leading-[var(--line-height-base)] text-text-base" dir="auto">
                        {po().definitionOfDone}
                      </div>
                    </Show>
                    <Show when={po().dodCriteria && po().dodCriteria!.length > 0}>
                      <div class="flex flex-col gap-1 pt-1">
                        <For each={po().dodCriteria ?? []}>
                          {(criterion) => (
                            <div class="flex items-start gap-2 text-[12px] leading-[var(--line-height-compact)]">
                              <span
                                class={
                                  criterion.proofRef
                                    ? "text-v2-state-fg-success font-medium"
                                    : "text-text-weak"
                                }
                              >
                                {criterion.proofRef ? "✓" : "·"}
                              </span>
                              <span class="text-text-base" dir="auto">
                                <span class="font-medium text-text-weak">{`${criterion.id}: `}</span>
                                {criterion.statement}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>

              {/* Secondary Objectives Tree */}
              <Show when={po().secondaries.length > 0}>
                <div class="flex flex-col gap-2">
                  <div class="text-[12px] font-medium leading-[var(--line-height-compact)] text-text-weak">
                    {ctx.t("section.secondaries", {
                      resolved: String(resolvedCount()),
                      total: String(totalCount()),
                    })}
                  </div>
                  <div class="flex flex-col gap-2">
                    <For each={po().secondaries}>
                      {(so) => <SecondaryCard item={so} />}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Epistemic Sections: Findings, Options, Fingerprints */}
              <Show
                when={
                  (po().findings?.length ?? 0) > 0 ||
                  (po().options?.length ?? 0) > 0 ||
                  (po().fingerprints?.length ?? 0) > 0
                }
              >
                <Accordion multiple defaultValue={["findings"]}>
                  <Show when={po().findings && po().findings!.length > 0}>
                    <Accordion.Item value="findings">
                      <StickyAccordionHeader>
                        <Accordion.Trigger>
                          <div class="flex items-center justify-between gap-2 w-full">
                            <span>{ctx.t("section.findings", { count: String(po().findings!.length) })}</span>
                            <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
                          </div>
                        </Accordion.Trigger>
                      </StickyAccordionHeader>
                      <Accordion.Content class="bg-background-base">
                        <div class="flex flex-col gap-2 p-3">
                          <For each={po().findings ?? []}>
                            {(f) => (
                              <div class="flex flex-col gap-0.5 rounded-md border border-v2-border-border-base p-2.5 text-[12px] leading-[var(--line-height-compact)]">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                  <span class="font-medium text-text-strong">{f.id}</span>
                                  <Show when={f.soRef}>
                                    <Badge>{f.soRef}</Badge>
                                  </Show>
                                  <Show when={f.delegation}>
                                    {(del) => <Badge>{del().mode}</Badge>}
                                  </Show>
                                  <span class="font-medium text-text-base" dir="auto">
                                    {f.title}
                                  </span>
                                </div>
                                <Show when={f.result}>
                                  <div class="text-text-weak pt-0.5" dir="auto">
                                    {f.result}
                                  </div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </Accordion.Content>
                    </Accordion.Item>
                  </Show>

                  <Show when={po().options && po().options!.length > 0}>
                    <Accordion.Item value="options">
                      <StickyAccordionHeader>
                        <Accordion.Trigger>
                          <div class="flex items-center justify-between gap-2 w-full">
                            <span>{ctx.t("section.options", { count: String(po().options!.length) })}</span>
                            <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
                          </div>
                        </Accordion.Trigger>
                      </StickyAccordionHeader>
                      <Accordion.Content class="bg-background-base">
                        <div class="flex flex-col gap-2 p-3">
                          <For each={po().options ?? []}>
                            {(opt) => (
                              <div class="flex flex-col gap-0.5 rounded-md border border-v2-border-border-base p-2.5 text-[12px] leading-[var(--line-height-compact)]">
                                <div class="flex items-center gap-1.5">
                                  <span class="font-medium text-text-strong">{opt.id}</span>
                                  <Badge>{opt.status}</Badge>
                                  <span class="text-text-base" dir="auto">
                                    {opt.statement}
                                  </span>
                                </div>
                                <Show when={opt.result}>
                                  <div class="text-text-weak pt-0.5" dir="auto">
                                    {opt.result}
                                  </div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </Accordion.Content>
                    </Accordion.Item>
                  </Show>

                  <Show when={po().fingerprints && po().fingerprints!.length > 0}>
                    <Accordion.Item value="fingerprints">
                      <StickyAccordionHeader>
                        <Accordion.Trigger>
                          <div class="flex items-center justify-between gap-2 w-full">
                            <span>{ctx.t("section.fingerprints", { count: String(po().fingerprints!.length) })}</span>
                            <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
                          </div>
                        </Accordion.Trigger>
                      </StickyAccordionHeader>
                      <Accordion.Content class="bg-background-base">
                        <div class="flex flex-col gap-2 p-3">
                          <For each={po().fingerprints ?? []}>
                            {(fp) => (
                              <div class="flex items-start gap-2 rounded-md border border-v2-border-border-base p-2.5 text-[12px] leading-[var(--line-height-compact)]">
                                <span class="font-medium text-text-strong">{fp.key}:</span>
                                <span class="text-text-base flex-1" dir="auto">
                                  {fp.symptom}
                                  <Show when={fp.fixRef}>
                                    {(fix) => <span class="text-text-weak">{` (${ctx.t("label.fix")} ${fix()})`}</span>}
                                  </Show>
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Accordion.Content>
                    </Accordion.Item>
                  </Show>
                </Accordion>
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}

function SecondaryCard(props: { item: SecondaryObjectiveView }) {
  const ctx = usePlugin<typeof ObjectivesDefinition>()

  return (
    <div class="flex flex-col gap-1.5 rounded-md border border-v2-border-border-base bg-surface-base p-3">
      <div class="flex items-start gap-2">
        <span class="flex h-5 shrink-0 items-center">
          <StatusGlyph status={props.item.status} />
        </span>
        <div class="min-w-0 flex-1 flex flex-col gap-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[13px] font-medium leading-[var(--line-height-base)] text-text-weak">
              {props.item.id}
            </span>
            <Show when={props.item.delegation}>
              {(del) => <Badge>{del().mode}</Badge>}
            </Show>
            <span class="text-[13px] font-medium leading-[var(--line-height-base)] text-text-strong" dir="auto">
              {props.item.title}
            </span>
          </div>

          <Show when={props.item.rationale}>
            <div class="text-[12px] leading-[var(--line-height-compact)] text-text-weak" dir="auto">
              {props.item.rationale}
            </div>
          </Show>

          <Show when={props.item.blocker}>
            {(blocker) => (
              <div class="text-[12px] leading-[var(--line-height-compact)] text-v2-state-fg-danger" dir="auto">
                {`${ctx.t("label.blocker")} ${blocker()}`}
              </div>
            )}
          </Show>

          <Show when={props.item.validationProof}>
            {(proof) => (
              <div class="text-[12px] leading-[var(--line-height-compact)] text-v2-state-fg-success" dir="auto">
                {`${ctx.t("label.proof")} ${proof()}`}
              </div>
            )}
          </Show>

          <Show when={props.item.affectedResources?.files && props.item.affectedResources.files.length > 0}>
            <div class="text-[11px] font-mono leading-[var(--line-height-compact)] text-text-weak" dir="auto">
              {`${ctx.t("label.scope")} ${props.item.affectedResources!.files!.join(", ")}`}
            </div>
          </Show>

          <Show when={props.item.children && props.item.children.length > 0}>
            <div class="mt-1.5 flex flex-col gap-1.5 border-s-2 border-v2-border-border-base ps-3">
              <For each={props.item.children ?? []}>
                {(to) => (
                  <div class="flex flex-col gap-0.5">
                    <div class="flex items-start gap-2">
                      <span class="flex h-4 shrink-0 items-center">
                        <StatusGlyph status={to.status} />
                      </span>
                      <div class="min-w-0 flex-1 text-[12px] leading-[var(--line-height-compact)]" dir="auto">
                        <span class="font-medium text-text-weak">{to.id}</span>
                        <Show when={to.delegation}>
                          {(del) => <span class="text-text-weak">{` [${del().mode}]`}</span>}
                        </Show>
                        {`: `}
                        <span class="text-text-base">{to.title}</span>
                      </div>
                    </div>
                    <Show when={to.rationale}>
                      <div class="ps-6 text-[11px] leading-[var(--line-height-compact)] text-text-weak" dir="auto">
                        {to.rationale}
                      </div>
                    </Show>
                    <Show when={to.blocker}>
                      {(blocker) => (
                        <div
                          class="ps-6 text-[11px] leading-[var(--line-height-compact)] text-v2-state-fg-danger"
                          dir="auto"
                        >
                          {`${ctx.t("label.blocker")} ${blocker()}`}
                        </div>
                      )}
                    </Show>
                    <Show when={to.validationProof}>
                      {(proof) => (
                        <div
                          class="ps-6 text-[11px] leading-[var(--line-height-compact)] text-v2-state-fg-success"
                          dir="auto"
                        >
                          {`${ctx.t("label.proof")} ${proof()}`}
                        </div>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

function StatusGlyph(props: { status: ObjectiveStatus | PrimaryObjectiveStatus }) {
  const color = () => {
    if (props.status === "resolved") return "text-v2-state-fg-success"

    if (props.status === "blocked") return "text-v2-state-fg-danger"

    if (props.status === "exploring" || props.status === "presented_awaiting_confirmation")
      return "text-v2-state-fg-warning"

    if (props.status === "investigating") return "text-text-base"

    return "text-text-weak"
  }

  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
      class={`shrink-0 ${color()}`}
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
      <Switch>
        <Match when={props.status === "exploring" || props.status === "investigating"}>
          <path d="M8 4a4 4 0 0 0 0 8V4Z" fill="currentColor" />
        </Match>
        <Match when={props.status === "presented_awaiting_confirmation"}>
          <path d="M6.5 5.5v5M9.5 5.5v5" stroke="currentColor" stroke-linecap="round" />
        </Match>
        <Match when={props.status === "blocked"}>
          <path d="M8 4.5v4M8 11v.5" stroke="currentColor" stroke-linecap="round" />
        </Match>
        <Match when={props.status === "resolved"}>
          <path d="M5 8 7.5 11 11 5.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
        </Match>
        <Match when={props.status === "cancelled" || props.status === "discarded"}>
          <path d="M3.5 12.5 12.5 3.5" stroke="currentColor" />
        </Match>
      </Switch>
    </svg>
  )
}
