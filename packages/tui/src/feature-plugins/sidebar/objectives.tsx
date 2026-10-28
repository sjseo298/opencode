import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"

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
  id: string // "SO-1-T2" etc. — child of its parent Secondary Objective
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
  affectedResources?: { files?: string[]; services?: string[]; envs?: string[]; dbSchemas?: string[] }
  children?: TertiaryObjectiveView[] // Nested tertiary sub-objectives; present only when the SO was decomposed because it proved too large
}

export type PrimaryObjectiveStatus =
  | "pending"
  | "exploring"
  | "resolved"
  | "presented_awaiting_confirmation"

export type FindingLifecycle = "NEW" | "EXTENDED" | "SUBSUMED"

export type OptionStatusView = "PENDING" | "EXPLORING" | "DISCARDED" | "SUCCESSFUL" | "CANCELLED"

export interface DoDCriterionView {
  id: string
  statement: string
  proofRef?: string
}

export interface FindingView {
  id: string // "F-001"
  title: string
  lifecycle: FindingLifecycle
  result: string
  soRef?: string
  evidenceType?: string
  delegation?: DelegationView
}

export interface OptionView {
  id: string // "OPT-1"
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

export interface PrimaryObjectiveView {
  title: string
  status: PrimaryObjectiveStatus
  definitionOfDone: string
  secondaries: SecondaryObjectiveView[]
  dodCriteria?: DoDCriterionView[]
  findings?: FindingView[]
  options?: OptionView[]
  fingerprints?: FingerprintView[]
  checkpointNote?: string
}

export function normalizePrimaryObjectiveView(raw: any): PrimaryObjectiveView | undefined {
  if (!raw || typeof raw.title !== "string") return undefined
  let status: PrimaryObjectiveStatus =
    raw.status === "pending" ||
    raw.status === "resolved" ||
    raw.status === "presented_awaiting_confirmation"
      ? raw.status
      : "exploring"

  // Invariante jerárquico estricto en memoria viva:
  // Si el PO dice 'resolved' pero alguno de sus SOs o TOs está abierto,
  // la UI debe auto-repararlo inmediatamente a 'exploring' para nunca mostrar
  // un PO cerrado con tareas abiertas.
  const secondaries: SecondaryObjectiveView[] = Array.isArray(raw.secondaries) ? [...raw.secondaries] : []
  const isClosed = (s: string) => s === "resolved" || s === "discarded" || s === "cancelled"
  const hasOpenChild = secondaries.some(
    (s) => !isClosed(s.status) || (s.children ?? []).some((t) => !isClosed(t.status)),
  )
  if (status === "resolved" && hasOpenChild) {
    status = "exploring"
  }

  // Auto-cierre de seguridad en la UI:
  // Si todos los objetivos secundarios y terciarios ya están cerrados ('resolved', 'discarded', 'cancelled')
  // el PO no debe permanecer abierto en la barra lateral aunque el agente haya omitido llamar a complete_primary.
  if (status !== "resolved") {
    const allChildrenClosed =
      secondaries.length > 0 &&
      secondaries.every(
        (s) => isClosed(s.status) && (s.children ?? []).every((t) => isClosed(t.status)),
      )
    if (allChildrenClosed) {
      status = "resolved"
    }
  }

  const rawDod = Array.isArray(raw.dodCriteria)
    ? raw.dodCriteria
    : Array.isArray(raw.dod)
      ? raw.dod
      : undefined
  return {
    title: raw.title,
    status,
    definitionOfDone: raw.definitionOfDone ?? "",
    secondaries,
    dodCriteria: rawDod ? [...rawDod] : undefined,
    findings: Array.isArray(raw.findings) ? [...raw.findings] : undefined,
    options: Array.isArray(raw.options) ? [...raw.options] : undefined,
    fingerprints: Array.isArray(raw.fingerprints) ? [...raw.fingerprints] : undefined,
    checkpointNote: typeof raw.checkpointNote === "string" ? raw.checkpointNote : undefined,
  }
}

export function extractObjectivesFromMessages(
  _sessionID: string,
  _messages?: any[],
  metadataObjectives?: any,
): PrimaryObjectiveView | undefined {
  if (metadataObjectives && typeof metadataObjectives.title === "string") {
    return normalizePrimaryObjectiveView(metadataObjectives)
  }
  return undefined
}

export function SidebarObjectives(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const session = createMemo(() => props.context.data.session.get(props.sessionID))

  const objectives = createMemo(() =>
    normalizePrimaryObjectiveView(session()?.metadata?.objectives)
  )

  const totalSecondaries = createMemo(() => objectives()?.secondaries.length ?? 0)
  const resolvedSecondaries = createMemo(
    () => objectives()?.secondaries.filter((s) => s.status === "resolved").length ?? 0,
  )
  const activeObjective = createMemo(() => {
    const list = objectives()?.secondaries ?? []
    return (
      list.find((s) => s.status === "exploring" || s.status === "blocked") ??
      list.find((s) => s.status === "pending")
    )
  })

  const statusBadge = (status: ObjectiveStatus) => {
    switch (status) {
      case "resolved":
        return { symbol: "[✓]", color: theme.text.feedback.success.base }
      case "exploring":
        return { symbol: "[•]", color: theme.text.feedback.warning.base }
      case "blocked":
        return { symbol: "[!]", color: theme.text.feedback.error.base }
      case "discarded":
      case "cancelled":
        return { symbol: "[✕]", color: theme.text.muted }
      default:
        return { symbol: "[ ]", color: theme.text.muted }
    }
  }

  const findingBadge = (lifecycle: FindingLifecycle) => {
    switch (lifecycle) {
      case "EXTENDED":
        return { symbol: "[↻]", color: theme.text.base }
      case "SUBSUMED":
        return { symbol: "[✕]", color: theme.text.muted }
      default:
        return { symbol: "[●]", color: theme.text.feedback.warning.base }
    }
  }

  const optionBadge = (status: OptionStatusView) => {
    switch (status) {
      case "SUCCESSFUL":
        return { symbol: "[✓]", color: theme.text.feedback.success.base }
      case "EXPLORING":
        return { symbol: "[•]", color: theme.text.feedback.warning.base }
      case "DISCARDED":
      case "CANCELLED":
        return { symbol: "[✕]", color: theme.text.muted }
      default:
        return { symbol: "[ ]", color: theme.text.muted }
    }
  }

  return (
    <Show when={objectives()}>
      {(po) => (
        <box gap={0}>
          {/* Header */}
          <box
            flexDirection="row"
            gap={1}
            onMouseDown={() => {
              void updateView((draft) => {
                draft.open = !draft.open
              }).catch((error) => console.error("Failed to persist Objectives sidebar state", error))
            }}
          >
            <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
            <text fg={theme.text.base}>
              <b>Objectives</b>
              <span style={{ fg: theme.text.muted }}>
                {" "}
                ({resolvedSecondaries()}/{totalSecondaries()})
              </span>
            </text>
            <Show when={!view.open && activeObjective()}>
              {(active) => {
                const badge = statusBadge(active().status)
                return (
                  <text fg={theme.text.muted} wrapMode="none" truncate>
                    <span style={{ fg: badge.color }}>{badge.symbol}</span>{" "}
                    <span style={{ fg: theme.text.base }}>{active().id}:</span> {active().title}
                  </text>
                )
              }}
            </Show>
          </box>

          <Show when={view.open}>
            {/* Primary Objective Card */}
            <box paddingTop={0} paddingBottom={0} gap={0}>
              <box flexDirection="row" gap={1}>
                <text
                  fg={
                    po().status === "resolved"
                      ? theme.text.feedback.success.base
                      : theme.text.feedback.warning.base
                  }
                >
                  <b>
                    {po().status === "resolved"
                      ? "[PO ✓]"
                      : po().status === "presented_awaiting_confirmation"
                        ? "[PO ⏸]"
                        : "[PO]"}
                  </b>
                </text>
                <text fg={theme.text.base} wrapMode="word">
                  <b>{po().title}</b>
                </text>
              </box>
              <Show when={po().definitionOfDone}>
                <text fg={theme.text.muted} wrapMode="word">
                  DoD: {po().definitionOfDone}
                </text>
              </Show>
              {/* Decomposed Definition of Done: ✓ = proofRef attached */}
              <Show when={(po().dodCriteria ?? []).length > 0}>
                <box gap={0}>
                  <For each={po().dodCriteria ?? []}>
                    {(c) => (
                      <text fg={theme.text.muted} wrapMode="word">
                        {c.proofRef ? "✓" : "·"} {c.statement}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={po().checkpointNote}>
                <text fg={theme.text.muted} wrapMode="word">
                  ⏸ {po().checkpointNote}
                </text>
              </Show>
            </box>

            {/* Secondary Objectives List */}
            <Show when={po().secondaries.length > 0}>
              <box paddingTop={0} gap={0}>
                <For each={po().secondaries}>
                  {(so) => {
                    const badge = () => statusBadge(so.status)
                    return (
                      <box gap={0} paddingTop={0} paddingBottom={0}>
                        <box flexDirection="row" gap={1}>
                          <text fg={badge().color} flexShrink={0}>
                            {badge().symbol}
                          </text>
                          <text fg={theme.text.base} wrapMode="word" flexGrow={1}>
                            <span style={{ fg: theme.text.muted }}>{so.id}</span>
                            <Show when={so.delegation}>
                              <span style={{ fg: so.delegation!.mode === "subagent" ? theme.text.feedback.warning.base : theme.text.muted }}> [{so.delegation!.mode}]</span>
                            </Show>
                            <span style={{ fg: theme.text.muted }}>:</span> {so.title}
                          </text>
                        </box>

                        {/* Indented Rationale & Details */}
                        <Show when={so.rationale}>
                          <box paddingLeft={4}>
                            <text fg={theme.text.muted} wrapMode="word">
                              ↳ {so.rationale}
                            </text>
                          </box>
                        </Show>

                        {/* Blocker Alert */}
                        <Show when={so.blocker}>
                          <box paddingLeft={4}>
                            <text fg={theme.text.feedback.error.base} wrapMode="word">
                              ⚠️ Blocker: {so.blocker}
                            </text>
                          </box>
                        </Show>

                        {/* Validation Proof */}
                        <Show when={so.validationProof}>
                          <box paddingLeft={4}>
                            <text fg={theme.text.feedback.success.base} wrapMode="word">
                              ✅ Proof: {so.validationProof}
                            </text>
                          </box>
                        </Show>

                        {/* Scope / Affected Resources */}
                        <Show when={so.affectedResources?.files && so.affectedResources.files.length > 0}>
                          <box paddingLeft={4}>
                            <text fg={theme.text.muted} wrapMode="word">
                              🎯 Scope: {so.affectedResources!.files!.join(", ")}
                            </text>
                          </box>
                        </Show>

                        {/* Tertiary Sub-Objectives (children of this secondary, same pattern as SOs under the PO) */}
                        <Show when={(so.children ?? []).length > 0}>
                          <box paddingLeft={4} gap={0}>
                            <For each={so.children ?? []}>
                              {(to) => {
                                const badge = () => statusBadge(to.status)
                                return (
                                  <box gap={0} paddingTop={0} paddingBottom={0}>
                                    <box flexDirection="row" gap={1}>
                                      <text fg={badge().color} flexShrink={0}>
                                        {badge().symbol}
                                      </text>
                                      <text fg={theme.text.base} wrapMode="word" flexGrow={1}>
                                        <span style={{ fg: theme.text.muted }}>{to.id}</span>
                                        <Show when={to.delegation}>
                                          <span style={{ fg: to.delegation!.mode === "subagent" ? theme.text.feedback.warning.base : theme.text.muted }}> [{to.delegation!.mode}]</span>
                                        </Show>
                                        <span style={{ fg: theme.text.muted }}>:</span> {to.title}
                                      </text>
                                    </box>

                                    {/* Indented Rationale */}
                                    <Show when={to.rationale}>
                                      <box paddingLeft={4}>
                                        <text fg={theme.text.muted} wrapMode="word">
                                          ↳ {to.rationale}
                                        </text>
                                      </box>
                                    </Show>

                                    {/* Blocker Alert */}
                                    <Show when={to.blocker}>
                                      <box paddingLeft={4}>
                                        <text fg={theme.text.feedback.error.base} wrapMode="word">
                                          ⚠️ Blocker: {to.blocker}
                                        </text>
                                      </box>
                                    </Show>

                                    {/* Validation Proof */}
                                    <Show when={to.validationProof}>
                                      <box paddingLeft={4}>
                                        <text fg={theme.text.feedback.success.base} wrapMode="word">
                                          ✅ Proof: {to.validationProof}
                                        </text>
                                      </box>
                                    </Show>
                                  </box>
                                )
                              }}
                            </For>
                          </box>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>

            {/* Findings (epistemic layer): one compact line per finding */}
            <Show when={(po().findings ?? []).length > 0}>
              <box paddingTop={1} gap={0}>
                <text fg={theme.text.muted}>Findings ({(po().findings ?? []).length})</text>
                <For each={po().findings ?? []}>
                  {(f) => {
                    const badge = () => findingBadge(f.lifecycle)
                    return (
                      <box flexDirection="row" gap={1}>
                        <text fg={badge().color} flexShrink={0}>
                          {badge().symbol}
                        </text>
                        <text fg={theme.text.base} wrapMode="word" flexGrow={1}>
                          <span style={{ fg: theme.text.muted }}>{f.id}</span>
                          <Show when={f.delegation}>
                            <span style={{ fg: f.delegation!.mode === "subagent" ? theme.text.feedback.warning.base : theme.text.muted }}> [{f.delegation!.mode}]</span>
                          </Show>
                          <span style={{ fg: theme.text.muted }}>:</span> {f.title}
                          {f.result ? (
                            <span style={{ fg: theme.text.muted }}> — {f.result}</span>
                          ) : null}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>

            {/* Options (multi-candidate): live Result column */}
            <Show when={(po().options ?? []).length > 0}>
              <box paddingTop={1} gap={0}>
                <text fg={theme.text.muted}>Options ({(po().options ?? []).length})</text>
                <For each={po().options ?? []}>
                  {(o) => {
                    const badge = () => optionBadge(o.status)
                    return (
                      <box flexDirection="row" gap={1}>
                        <text fg={badge().color} flexShrink={0}>
                          {badge().symbol}
                        </text>
                        <text fg={theme.text.base} wrapMode="word" flexGrow={1}>
                          <span style={{ fg: theme.text.muted }}>{o.id}:</span> {o.statement}
                          {o.result ? (
                            <span style={{ fg: theme.text.muted }}> — {o.result}</span>
                          ) : null}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>

            {/* Blocker Fingerprints */}
            <Show when={(po().fingerprints ?? []).length > 0}>
              <box paddingTop={1} gap={0}>
                <text fg={theme.text.muted}>Fingerprints ({(po().fingerprints ?? []).length})</text>
                <For each={po().fingerprints ?? []}>
                  {(fp) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.text.feedback.success.base} flexShrink={0}>
                        [⚡]
                      </text>
                      <text fg={theme.text.base} wrapMode="word" flexGrow={1}>
                        <span style={{ fg: theme.text.muted }}>{fp.key}:</span> {fp.symptom}
                        {fp.fixRef ? (
                          <span style={{ fg: theme.text.muted }}> (fix: {fp.fixRef})</span>
                        ) : null}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </Show>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.objectives",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarObjectives context={context} sessionID={props.sessionID} />,
    })
  },
})
