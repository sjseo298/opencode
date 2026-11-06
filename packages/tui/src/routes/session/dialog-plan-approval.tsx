import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useClient } from "../../context/client"
import { useTheme } from "../../context/theme"
import { useSessionTabs } from "../../context/session-tabs"
import { Keymap } from "../../context/keymap"
import { DialogHeader, DialogLayout, useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"

export type PlanApprovalAction = "fresh_session" | "same_session" | "refine_plan"

function formatTreeSummary(po: any): string {
  if (!po || typeof po.title !== "string") return ""
  const lines: string[] = [
    `### Árbol de Objetivos Activo`,
    `**Objetivo Primario:** ${po.title}`,
  ]
  if (po.definitionOfDone) {
    lines.push(`**Definición de Hecho (DoD):** ${po.definitionOfDone}`)
  }
  if (Array.isArray(po.secondaries) && po.secondaries.length > 0) {
    lines.push(``, `**Objetivos Secundarios:**`)
    for (const so of po.secondaries) {
      const del = so.delegation?.mode ? ` [${so.delegation.mode}]` : ""
      lines.push(`- **${so.id}** [${(so.status ?? "pending").toUpperCase()}]${del} ${so.title}`)
      if (so.rationale) lines.push(`  - *Rationale:* ${so.rationale}`)
    }
  }
  if (Array.isArray(po.findings) && po.findings.length > 0) {
    lines.push(``, `**Hallazgos de Exploración:**`)
    for (const f of po.findings) {
      lines.push(`- **${f.id}**: ${f.title}`)
      if (f.result) lines.push(`  - *Resultado:* ${f.result}`)
    }
  }
  return lines.join("\n")
}

export function DialogPlanApproval(props: {
  sessionID: string
  po?: any
  onRefine?: () => void
}) {
  const data = useData()
  const dialog = useDialog()
  const client = useClient()
  const route = useRoute()
  const toast = useToast()
  const sessionTabs = useSessionTabs()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const [pending, setPending] = createSignal(false)

  const [store, setStore] = createStore({
    activeIndex: 0,
  })

  const po = createMemo(() => {
    if (props.po) return props.po
    const session = data.session.get(props.sessionID)
    return session?.metadata?.objectives
  })

  const contextMetrics = createMemo(() => po()?.contextMetrics)

  const modelLabel = createMemo(() => {
    const session = data.session.get(props.sessionID)
    if (!session?.model) return "modelo actual"
    return `${session.model.providerID}/${session.model.id}${session.model.variant ? `#${session.model.variant}` : ""}`
  })

  const planHeight = createMemo(() => {
    const totalHeight = dimensions()?.height ?? 35
    return Math.max(8, Math.min(18, totalHeight - 19))
  })

  const options = createMemo<{ action: PlanApprovalAction; key: string; title: string; description: string }[]>(() => {
    const cm = contextMetrics()
    const isRecommended = Boolean(cm?.recommendFreshSession)

    return [
      {
        action: "fresh_session",
        key: "1",
        title: isRecommended
          ? "🚀 Aprobar e Iniciar en Sesión Fresca (Recomendada)"
          : "🚀 Aprobar e Iniciar en Sesión Fresca",
        description: `Inicia una sesión limpia 100% independiente (mismo directorio, sin parent, modelo: ${modelLabel()}) con 100% de tokens libres.`,
      },
      {
        action: "same_session",
        key: "2",
        title: "▶️ Aprobar y Continuar en Esta Misma Sesión",
        description: "Descongela la ejecución en este hilo y arranca SO-1.",
      },
      {
        action: "refine_plan",
        key: "3",
        title: "✏️ Solicitar Ajustes / Refinar el Plan",
        description: "Cierra el diálogo para escribir correcciones al agente en modo borrador.",
      },
    ]
  })

  const handleSelect = async (choice: PlanApprovalAction) => {
    if (pending()) return
    setPending(true)

    const currentPo = po()

    if (choice === "refine_plan") {
      dialog.clear()
      props.onRefine?.()
      return
    }

    if (choice === "same_session") {
      dialog.clear()
      await client.api.session
        .prompt({
          sessionID: props.sessionID,
          text: "Plan aprobado explícitamente por el usuario. Procede con la ejecución de SO-1.",
        })
        .catch((err) => {
          toast.show({ message: errorMessage(err), variant: "error", duration: 5000 })
        })
      toast.show({ message: "Plan aprobado. Ejecutando en la sesión actual.", variant: "success", duration: 4000 })
      return
    }

    if (choice === "fresh_session") {
      try {
        const session = data.session.get(props.sessionID)
        const location = session?.location ?? data.location.default()
        const clonedTree = currentPo ? JSON.parse(JSON.stringify(currentPo)) : {}
        clonedTree.status = "exploring"
        clonedTree.approvedByUser = true
        clonedTree.originSessionID = props.sessionID
        if (clonedTree.phase) {
          clonedTree.phase.paused = false
          clonedTree.phase.reason = "Transferred to fresh session"
        }

        // 1. Create completely independent top-level fresh session in the EXACT SAME environment/directory
        const created = await client.api.session.create({
          title: currentPo?.title ? `[Ejecución] ${currentPo.title}` : "Sesión de Ejecución",
          parentID: undefined, // Standalone top-level session (no parent hierarchy)
          location: { directory: location.directory }, // Same working directory/environment
          agent: session?.agent,
          model: session?.model,
          metadata: {
            objectives: clonedTree, // Tree migrated immediately in database and event stream!
          },
        })

        const treeSummary = formatTreeSummary(clonedTree)
        const initialPrompt = [
          "Plan de objetivos aprobado por el usuario.",
          treeSummary,
          "Instrucción: Sincronízate con el Protocolo de Objetivos (action: 'sync') y comienza la ejecución de las tareas planificadas.",
        ]
          .filter(Boolean)
          .join("\n\n")

        // 2. Submit prompt cleanly to the new session inbox so it starts running immediately
        await client.api.session.prompt({
          sessionID: created.id,
          text: initialPrompt,
        })

        // 3. Clear dialog and navigate cleanly to the new session (NO dirty prompt in composer)
        const oldSessionID = props.sessionID
        dialog.clear()
        route.navigate({
          sessionID: created.id,
          type: "session",
        })

        // 4. Close the old tab in TUI and permanently delete the exploration session (zero residue)
        try {
          if (sessionTabs.enabled()) {
            sessionTabs.close(oldSessionID)
          }
          await client.api.session.remove({ sessionID: oldSessionID })
        } catch (err) {
          console.error("Failed to remove old exploration session:", err)
        }

        toast.show({
          message: "🚀 Sesión fresca iniciada (sesión previa eliminada sin residuos)",
          variant: "success",
          duration: 4000,
        })
      } catch (err) {
        setPending(false)
        toast.show({ message: errorMessage(err), variant: "error", duration: 5000 })
      }
    }
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm selection",
        group: "Dialog",
        run: () => {
          const opt = options()[store.activeIndex]
          if (opt) handleSelect(opt.action)
        },
      },
      {
        bind: "up",
        title: "Previous option",
        group: "Dialog",
        run: () => {
          setStore("activeIndex", Math.max(0, store.activeIndex - 1))
        },
      },
      {
        bind: "down",
        title: "Next option",
        group: "Dialog",
        run: () => {
          setStore("activeIndex", Math.min(options().length - 1, store.activeIndex + 1))
        },
      },
      {
        bind: "1",
        title: "Select option 1",
        group: "Dialog",
        run: () => handleSelect("fresh_session"),
      },
      {
        bind: "2",
        title: "Select option 2",
        group: "Dialog",
        run: () => handleSelect("same_session"),
      },
      {
        bind: "3",
        title: "Select option 3",
        group: "Dialog",
        run: () => handleSelect("refine_plan"),
      },
      {
        bind: "escape",
        title: "Cancel / Refine",
        group: "Dialog",
        run: () => {
          dialog.clear()
          props.onRefine?.()
        },
      },
    ],
  }))

  const p = po()
  const cm = contextMetrics()

  return (
    <DialogLayout
      header={
        <DialogHeader
          title="📋 Plan de Trabajo - Aprobación Requerida"
          onClose={() => {
            dialog.clear()
            props.onRefine?.()
          }}
        />
      }
    >
      <box flexDirection="column" gap={1}>
        {/* Scrollable Plan Content (bounded height, scrolls smoothly with up/down) */}
        <box
          borderStyle="single"
          borderColor={theme.border.base}
          paddingLeft={1}
          paddingRight={1}
          height={planHeight()}
        >
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1}>
              <box flexDirection="column" gap={0}>
                <text fg={theme.text.feedback.warning.base}>
                  <b>🎯 Objetivo Primario:</b> <span style={{ fg: theme.text.base }}>{p?.title}</span>
                </text>
                <Show when={p?.definitionOfDone}>
                  <text fg={theme.text.muted} wrapMode="word">
                    <b>DoD:</b> {p.definitionOfDone}
                  </text>
                </Show>
              </box>

              {/* List of Secondary Objectives */}
              <Show when={(p?.secondaries ?? []).length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.text.muted}>
                    <b>Tareas Secundarias ({p.secondaries.length}):</b>
                  </text>
                  <For each={p.secondaries}>
                    {(so: any) => (
                      <box flexDirection="column" gap={0} paddingLeft={1}>
                        <text fg={theme.text.base} wrapMode="word">
                          <span style={{ fg: theme.text.feedback.info.base }}><b>{so.id}:</b></span> {so.title}
                        </text>
                        <Show when={so.rationale}>
                          <text fg={theme.text.muted} wrapMode="word" paddingLeft={1}>
                            <i>↳ {so.rationale}</i>
                          </text>
                        </Show>
                      </box>
                    )}
                  </For>
                </box>
              </Show>

              {/* Findings */}
              <Show when={(p?.findings ?? []).length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.text.muted}>
                    <b>Hallazgos del reconocimiento ({p.findings.length}):</b>
                  </text>
                  <For each={p.findings}>
                    {(f: any) => (
                      <box flexDirection="column" gap={0} paddingLeft={1}>
                        <text fg={theme.text.base} wrapMode="word">
                          <span style={{ fg: theme.text.feedback.info.base }}><b>{f.id}:</b></span> {f.title}
                        </text>
                        <Show when={f.result}>
                          <text fg={theme.text.muted} wrapMode="word" paddingLeft={1}>
                            <i>↳ {f.result}</i>
                          </text>
                        </Show>
                      </box>
                    )}
                  </For>
                </box>
              </Show>

              {/* Context Diagnostics */}
              <Show when={cm}>
                <box flexDirection="column" gap={0}>
                  <text
                    fg={
                      cm?.recommendFreshSession
                        ? theme.text.feedback.warning.base
                        : theme.text.feedback.success.base
                    }
                  >
                    <b>Diagnóstico de contexto:</b>{" "}
                    {typeof cm?.tokensUsed === "number" ? cm.tokensUsed.toLocaleString() : "—"} tokens usados
                    {typeof cm?.percentUsed === "number" ? ` (${cm.percentUsed}% ventana)` : ""}.
                    {cm?.recommendFreshSession
                      ? " ⚠️ Se recomienda iniciar en Sesión Fresca."
                      : " ✅ Margen suficiente en sesión actual."}
                  </text>
                </box>
              </Show>
            </box>
          </scrollbox>
        </box>

        {/* Options Selection Area - ALWAYS VISIBLE AT THE BOTTOM */}
        <box flexDirection="column" gap={0}>
          <text fg={theme.text.muted}>
            <b>Selecciona una opción (↑/↓ o teclas 1/2/3, Enter para confirmar):</b>
          </text>
          <For each={options()}>
            {(opt, index) => {
              const isSelected = () => store.activeIndex === index()
              return (
                <box
                  flexDirection="column"
                  gap={0}
                  paddingLeft={1}
                  paddingRight={1}
                  paddingTop={0}
                  paddingBottom={0}
                  backgroundColor={isSelected() ? theme.background.action.primary.focused : undefined}
                >
                  <text fg={isSelected() ? theme.text.action.primary.focused : theme.text.base}>
                    <b>[{opt.key}] {opt.title}</b>
                  </text>
                  <text fg={isSelected() ? theme.text.action.primary.focused : theme.text.muted} wrapMode="word" paddingLeft={4}>
                    {opt.description}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </box>
    </DialogLayout>
  )
}
