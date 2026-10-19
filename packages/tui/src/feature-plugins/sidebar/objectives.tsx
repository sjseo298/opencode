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

      const toolName = (part.name || part.tool || "").toLowerCase()
      let rawInput = (part.state && "input" in part.state ? part.state.input : part.input) as any
      if (typeof rawInput === "string") {
        try {
          rawInput = JSON.parse(rawInput)
        } catch {
          rawInput = undefined
        }
      }
      const input = rawInput
      if (!input) continue

      if (toolName === "objective_manage") {
        const action = String(input.action || "").toLowerCase()

        if (action === "set_primary" || action === "init" || action === "set_objectives") {
          const prevSecondaries: SecondaryObjectiveView[] = (po as any)?.secondaries ?? []
          const initialSecondaries: SecondaryObjectiveView[] = []

          if (Array.isArray(input.secondaries) && input.secondaries.length > 0) {
            for (let i = 0; i < input.secondaries.length; i++) {
              const item = input.secondaries[i]
              const sTitle = item?.title?.trim()
              if (!sTitle) continue
              initialSecondaries.push({
                id: item?.id || `SO-${i + 1}`,
                title: sTitle,
                status: item?.status || "pending",
                rationale: item?.rationale || "Planned subtask for primary objective",
                blocker: item?.blocker,
                validationProof: item?.validationProof,
              })
            }
          }

          po = {
            title: input.title || "Primary Task",
            status: "exploring",
            definitionOfDone: input.definitionOfDone || "",
            secondaries: initialSecondaries.length > 0 ? initialSecondaries : prevSecondaries,
          }
        } else if (action === "add_secondary" || action === "add_secondaries") {
          if (!po) {
            po = {
              title: "Primary Objective",
              status: "exploring",
              definitionOfDone: "Complete all tasks",
              secondaries: [],
            }
          }
          const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
            ? input.secondaries
            : (input.title ? [{ title: input.title, rationale: input.rationale, status: input.status, blocker: input.blocker, validationProof: input.validationProof }] : [])

          for (const item of items) {
            const sTitle = item?.title?.trim()
            if (!sTitle) continue
            const nextId = item?.id || `SO-${po.secondaries.length + 1}`
            po.secondaries.push({
              id: nextId,
              title: sTitle,
              status: item?.status || "pending",
              rationale: item?.rationale || "",
              blocker: item?.blocker,
              validationProof: item?.validationProof,
            })
          }
        } else if (action === "update_secondary" || action === "update_secondaries") {
          if (po) {
            const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
              ? input.secondaries
              : (input.id ? [{ id: input.id, status: input.status, title: input.title, rationale: input.rationale, blocker: input.blocker, validationProof: input.validationProof }] : [])

            for (const item of items) {
              const targetId = String(item?.id || "").toLowerCase()
              if (!targetId) continue
              const target = po.secondaries.find((s) => s.id.toLowerCase() === targetId)
              if (target) {
                if (item.status) target.status = item.status
                if (item.title) target.title = item.title
                if (item.rationale) target.rationale = item.rationale
                if (item.blocker !== undefined) target.blocker = item.blocker
                if (item.validationProof !== undefined) target.validationProof = item.validationProof
              }
            }
          }
        }
      } else if (toolName === "todowrite") {
        // Compatibility with legacy todowrite tool calls
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

  // 3. Fallback: Parse from compaction checkpoint message if po is still undefined
  if (!po) {
    for (const msg of messages) {
      const text =
        msg.type === "compaction" && typeof msg.summary === "string"
          ? msg.summary
          : typeof msg.content === "string" && msg.content.includes("<conversation-checkpoint>")
            ? msg.content
            : ""
      if (!text) continue

      let poTitle = ""
      let dod = "Verified"
      const poMatch = text.match(/\[PO\]\s+([^\n\[]+)/i)
      if (poMatch) {
        poTitle = poMatch[1].trim()
      } else {
        const objMatch = text.match(/## Objective\s*\n+-\s*([^\n]+)/i)
        if (objMatch) poTitle = objMatch[1].trim()
      }

      const dodMatch = text.match(/Definition of Done:\s*([^\n]+)/i)
      if (dodMatch) dod = dodMatch[1].trim()

      if (poTitle) {
        const secondaries: SecondaryObjectiveView[] = []
        const soRegex = /-\s*\[(SO-\d+)\]\s*\[([A-Z_]+)\]\s*([^(\n]+)(?:\(([^)]+)\))?/gi
        let match: RegExpExecArray | null
        while ((match = soRegex.exec(text)) !== null) {
          const id = match[1].toUpperCase()
          const rawStatus = match[2].toLowerCase()
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

          const validStatuses: ObjectiveStatus[] = [
            "pending",
            "exploring",
            "blocked",
            "resolved",
            "discarded",
            "cancelled",
          ]
          const status: ObjectiveStatus = validStatuses.includes(rawStatus as any)
            ? (rawStatus as ObjectiveStatus)
            : "pending"

          secondaries.push({
            id,
            title,
            status,
            rationale,
            blocker,
            validationProof: proof,
          })
        }

        po = {
          title: poTitle,
          status: "exploring",
          definitionOfDone: dod,
          secondaries,
        }
        break
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
