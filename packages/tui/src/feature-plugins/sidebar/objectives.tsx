import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"

export type ObjectiveStatus =
  | "pending"
  | "exploring"
  | "blocked"
  | "resolved"
  | "discarded"
  | "cancelled"

export interface SecondaryObjectiveView {
  id: string
  title: string
  status: ObjectiveStatus
  rationale: string
  blocker?: string
  validationProof?: string
}

export interface PrimaryObjectiveView {
  title: string
  status: "pending" | "exploring" | "resolved"
  definitionOfDone: string
  secondaries: SecondaryObjectiveView[]
}

declare global {
  var __OPENCODE_OBJECTIVES__: Map<string, any> | undefined
}

export function extractObjectivesFromMessages(
  sessionID: string,
  messages: any[],
): PrimaryObjectiveView | undefined {
  // 1. Live memory lookup first
  if (globalThis.__OPENCODE_OBJECTIVES__?.has(sessionID)) {
    const raw = globalThis.__OPENCODE_OBJECTIVES__.get(sessionID)
    if (raw && typeof raw.title === "string") {
      return {
        title: raw.title,
        status: raw.status ?? "exploring",
        definitionOfDone: raw.definitionOfDone ?? "",
        secondaries: Array.isArray(raw.secondaries) ? [...raw.secondaries] : [],
      }
    }
  }

  // 2. Reconstruct from session message history (tool calls)
  let po: PrimaryObjectiveView | undefined = undefined

  for (const msg of messages) {
    if (msg.type !== "assistant" || !Array.isArray(msg.content)) continue

    for (const part of msg.content) {
      if (part.type !== "tool") continue

      const toolName = (part.tool || part.name || "").toLowerCase()

      if (toolName === "objective_manage") {
        const input = part.input as any
        if (!input) continue

        if (input.action === "set_primary") {
          const prevSecondaries: SecondaryObjectiveView[] = (po as any)?.secondaries ?? []
          po = {
            title: input.title || "Primary Task",
            status: "exploring",
            definitionOfDone: input.definitionOfDone || "",
            secondaries: prevSecondaries,
          }
        } else if (input.action === "add_secondary") {
          if (!po) {
            po = {
              title: "Primary Objective",
              status: "exploring",
              definitionOfDone: "Complete all tasks",
              secondaries: [],
            }
          }
          const nextId = `SO-${po.secondaries.length + 1}`
          po.secondaries.push({
            id: nextId,
            title: input.title || "Subtask",
            status: "pending",
            rationale: input.rationale || "",
          })
        } else if (input.action === "update_secondary") {
          if (po && input.id) {
            const target = po.secondaries.find(
              (s) => s.id.toLowerCase() === String(input.id).toLowerCase(),
            )
            if (target) {
              if (input.status) target.status = input.status
              if (input.title) target.title = input.title
              if (input.rationale) target.rationale = input.rationale
              if (input.blocker !== undefined) target.blocker = input.blocker
              if (input.validationProof !== undefined) target.validationProof = input.validationProof
            }
          }
        }
      } else if (toolName === "todowrite") {
        // Compatibility with legacy todowrite tool calls
        const input = part.input as any
        const todos = Array.isArray(input?.todos) ? input.todos : []
        if (todos.length > 0) {
          if (!po) {
            po = {
              title: "Session Objectives",
              status: "exploring",
              definitionOfDone: "Complete all session tasks",
              secondaries: [],
            }
          }
          for (const t of todos) {
            const content = typeof t?.content === "string" ? t.content.trim() : ""
            if (!content) continue
            const existing = po.secondaries.find((s) => s.title.toLowerCase() === content.toLowerCase())
            if (!existing) {
              po.secondaries.push({
                id: `SO-${po.secondaries.length + 1}`,
                title: content,
                status: t.status === "completed" ? "resolved" : "pending",
                rationale: "Imported task",
                validationProof: t.status === "completed" ? "Completed via todowrite" : undefined,
              })
            } else if (t.status === "completed") {
              existing.status = "resolved"
              existing.validationProof = existing.validationProof || "Completed via todowrite"
            }
          }
        }
      }
    }
  }

  return po
}

export function SidebarObjectives(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID) ?? [])

  const objectives = createMemo(() => extractObjectivesFromMessages(props.sessionID, messages()))

  const totalSecondaries = createMemo(() => objectives()?.secondaries.length ?? 0)
  const resolvedSecondaries = createMemo(
    () => objectives()?.secondaries.filter((s) => s.status === "resolved").length ?? 0,
  )

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
          </box>

          <Show when={view.open}>
            {/* Primary Objective Card */}
            <box paddingTop={0} paddingBottom={0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme.text.feedback.warning.base}>
                  <b>[PO]</b>
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
                            <span style={{ fg: theme.text.muted }}>{so.id}:</span> {so.title}
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
                      </box>
                    )
                  }}
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
