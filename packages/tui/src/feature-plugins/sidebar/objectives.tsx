import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"

export type ObjectiveStatus =
  | "pending"
  | "exploring"
  | "blocked"
  | "resolved"
  | "discarded"
  | "cancelled"

export interface TertiaryObjectiveView {
  id: string // "SO-1-T2" etc. — child of its parent Secondary Objective
  title: string
  status: ObjectiveStatus
  rationale: string
  blocker?: string
  validationProof?: string
}

export interface SecondaryObjectiveView {
  id: string
  title: string
  status: ObjectiveStatus
  rationale: string
  blocker?: string
  validationProof?: string
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
}

export interface OptionView {
  id: string // "OPT-1"
  statement: string
  status: OptionStatusView
  result?: string
  reason?: string
}

export interface PrimaryObjectiveView {
  title: string
  status: PrimaryObjectiveStatus
  definitionOfDone: string
  secondaries: SecondaryObjectiveView[]
  dodCriteria?: DoDCriterionView[]
  findings?: FindingView[]
  options?: OptionView[]
  checkpointNote?: string
}

declare global {
  var __OPENCODE_OBJECTIVES__: Map<string, any> | undefined
}

function nextFindingIdView(findings: FindingView[]): string {
  let maxIdx = 0
  for (const f of findings) {
    const match = f.id.match(/^F-(\d+)$/i)
    if (match) maxIdx = Math.max(maxIdx, parseInt(match[1], 10))
  }
  return `F-${String(maxIdx + 1).padStart(3, "0")}`
}

function nextOptionIdView(options: OptionView[]): string {
  let maxIdx = 0
  for (const o of options) {
    const match = o.id.match(/^OPT-(\d+)$/i)
    if (match) maxIdx = Math.max(maxIdx, parseInt(match[1], 10))
  }
  return `OPT-${maxIdx + 1}`
}

function parseDodCriteriaInput(value: any): DoDCriterionView[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const criteria: DoDCriterionView[] = []
  for (const c of value) {
    if (typeof c?.statement !== "string" || !c.statement.trim()) continue
    const id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : `DoD-${criteria.length + 1}`
    criteria.push({
      id,
      statement: c.statement.trim(),
      proofRef: typeof c.proofRef === "string" && c.proofRef.trim() ? c.proofRef.trim() : undefined,
    })
  }
  return criteria.length > 0 ? criteria : undefined
}

export function extractObjectivesFromMessages(
  sessionID: string,
  messages: any[],
): PrimaryObjectiveView | undefined {
  // 1. Live memory lookup first
  if (globalThis.__OPENCODE_OBJECTIVES__?.has(sessionID)) {
    const raw = globalThis.__OPENCODE_OBJECTIVES__.get(sessionID)
    if (raw && typeof raw.title === "string") {
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
        checkpointNote: typeof raw.checkpointNote === "string" ? raw.checkpointNote : undefined,
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
              const explicitId = (typeof item?.id === "string" && item.id.trim()) ? item.id.trim() : `SO-${i + 1}`
              const sTitle = item?.title?.trim() || item?.rationale?.trim() || explicitId || `Subtask ${i + 1}`
              initialSecondaries.push({
                id: explicitId,
                title: sTitle,
                status: item?.status || "pending",
                rationale: item?.rationale || "Planned subtask for primary objective",
                blocker: item?.blocker || undefined,
                validationProof: item?.validationProof || undefined,
              })
            }
          }

          po = {
            title: input.title || "Primary Task",
            status: "exploring",
            definitionOfDone: input.definitionOfDone || "",
            secondaries: initialSecondaries.length > 0 ? initialSecondaries : prevSecondaries,
            dodCriteria: parseDodCriteriaInput(input.dodCriteria),
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
            : (input.title || input.rationale ? [{ id: input.id, title: input.title, rationale: input.rationale, status: input.status, blocker: input.blocker, validationProof: input.validationProof }] : [])

          for (const item of items) {
            const explicitId = (typeof item?.id === "string" && item.id.trim()) ? item.id.trim() : undefined
            const sTitle = item?.title?.trim() || item?.rationale?.trim() || explicitId || "Subtask"
            
            let existing = explicitId ? po.secondaries.find((s) => s.id.toLowerCase() === explicitId.toLowerCase()) : undefined
            if (!existing) {
              existing = po.secondaries.find((s) => s.title.toLowerCase() === sTitle.toLowerCase())
            }

            if (existing) {
              existing.title = sTitle
              if (item?.status) existing.status = item.status
              if (item?.rationale) existing.rationale = item.rationale
              if (item?.blocker !== undefined) existing.blocker = item.blocker || undefined
              if (item?.validationProof !== undefined) existing.validationProof = item.validationProof || undefined
            } else {
              let nextId = explicitId
              if (!nextId) {
                let maxIdx = 0
                for (const s of po.secondaries) {
                  const match = s.id.match(/^SO-(\d+)$/i)
                  if (match) {
                    const num = parseInt(match[1], 10)
                    if (num > maxIdx) maxIdx = num
                  }
                }
                nextId = `SO-${Math.max(maxIdx, po.secondaries.length) + 1}`
              }
              po.secondaries.push({
                id: nextId,
                title: sTitle,
                status: item?.status || "pending",
                rationale: item?.rationale || "",
                blocker: item?.blocker || undefined,
                validationProof: item?.validationProof || undefined,
              })
            }

            // Invariante de coherencia jerárquica en reconstrucción:
            // Al añadir un SO a un PO cerrado o en pausa, se reabre a 'exploring'
            if (po.status === "resolved" || po.status === "presented_awaiting_confirmation") {
              po.status = "exploring"
            }
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

                // Invariante de coherencia jerárquica en reconstrucción:
                // Si el SO se actualiza a un estado abierto ('pending', 'exploring', 'blocked'),
                // el PO se reabre automáticamente a 'exploring'.
                const isOpen = target.status === "pending" || target.status === "exploring" || target.status === "blocked"
                if (isOpen && (po.status === "resolved" || po.status === "presented_awaiting_confirmation")) {
                  po.status = "exploring"
                }
              }
            }
          }
        } else if (action === "add_tertiary" || action === "add_tertaries") {
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
            : (input.id && (input.title || input.rationale) ? [{ id: input.id, title: input.title, rationale: input.rationale, status: input.status, blocker: input.blocker, validationProof: input.validationProof }] : [])

          for (const item of items) {
            const parentId = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : ""
            if (!parentId) continue
            const parent = po.secondaries.find((s) => s.id.toLowerCase() === parentId.toLowerCase())
            if (!parent) continue

            const tTitle = item?.title?.trim() || item?.rationale?.trim() || "Tertiary sub-objective"
            parent.children ??= []

            const existing = parent.children.find((t) => t.title.toLowerCase() === tTitle.toLowerCase())
            if (existing) {
              if (item?.status) existing.status = item.status
              if (item?.rationale) existing.rationale = item.rationale
              if (item?.blocker !== undefined) existing.blocker = item.blocker || undefined
              if (item?.validationProof !== undefined) existing.validationProof = item.validationProof || undefined
            } else {
              const parentNum = parent.id.match(/^SO-(\d+)/i)?.[1] ?? "0"
              let maxIdx = 0
              for (const t of parent.children) {
                const match = t.id.match(new RegExp(`^SO-${parentNum}-T(\\d+)$`, "i"))
                if (match) {
                  const num = parseInt(match[1], 10)
                  if (num > maxIdx) maxIdx = num
                }
              }
              parent.children.push({
                id: `SO-${parentNum}-T${maxIdx + 1}`,
                title: tTitle,
                status: item?.status || "pending",
                rationale: item?.rationale || "",
                blocker: item?.blocker || undefined,
                validationProof: item?.validationProof || undefined,
              })
            }

            // Invariante de coherencia jerárquica en reconstrucción:
            // Al añadir un TO abierto a un PO/SO cerrado, se reabren a 'exploring'
            if (po.status === "resolved" || po.status === "presented_awaiting_confirmation") {
              po.status = "exploring"
            }
            if (parent.status === "resolved") {
              parent.status = "exploring"
            }
          }
        } else if (action === "update_tertiary" || action === "update_tertaries") {
          if (!po) continue
          const items = Array.isArray(input.secondaries) && input.secondaries.length > 0
            ? input.secondaries
            : (input.id ? [{ id: input.id, status: input.status, title: input.title, rationale: input.rationale, blocker: input.blocker, validationProof: input.validationProof }] : [])

          for (const item of items) {
            const targetId = typeof item?.id === "string" ? item.id.trim().toLowerCase() : ""
            if (!targetId) continue
            let target: TertiaryObjectiveView | undefined
            for (const so of po.secondaries) {
              target = (so.children ?? []).find((t) => t.id.toLowerCase() === targetId)
              if (target) break
            }
            if (target) {
              if (item.status) target.status = item.status
              if (item.title) target.title = item.title
              if (item.rationale) target.rationale = item.rationale
              if (item.blocker !== undefined) target.blocker = item.blocker
              if (item.validationProof !== undefined) target.validationProof = item.validationProof

              // Invariante de coherencia jerárquica en reconstrucción:
              // Si el TO se actualiza a abierto ('pending', 'exploring', 'blocked'),
              // el SO padre y el PO se reabren automáticamente a 'exploring'.
              const isOpen = target.status === "pending" || target.status === "exploring" || target.status === "blocked"
              if (isOpen) {
                const parentSO = po.secondaries.find((s) => (s.children ?? []).some((t) => t.id === target?.id))
                if (parentSO && parentSO.status === "resolved") {
                  parentSO.status = "exploring"
                }
                if (po.status === "resolved" || po.status === "presented_awaiting_confirmation") {
                  po.status = "exploring"
                }
              }
            }
          }
        } else if (action === "add_finding") {
          if (!po) {
            po = {
              title: "Primary Objective",
              status: "exploring",
              definitionOfDone: "Complete all tasks",
              secondaries: [],
            }
          }
          po.findings ??= []
          const fTitle = input.title?.trim() || input.result?.trim() || "Finding"
          const explicitId = typeof input.findingId === "string" && input.findingId.trim() ? input.findingId.trim() : ""
          const existing = explicitId
            ? po.findings.find((f) => f.id.toLowerCase() === explicitId.toLowerCase())
            : undefined
          if (existing) {
            if (input.title?.trim()) existing.title = input.title.trim()
            if (input.result?.trim()) existing.result = input.result.trim()
          } else {
            po.findings.push({
              id: explicitId || nextFindingIdView(po.findings),
              title: fTitle,
              lifecycle: "NEW",
              result: input.result?.trim() ?? "",
              soRef: typeof input.soRef === "string" && input.soRef.trim() ? input.soRef.trim() : undefined,
              evidenceType:
                input.evidence && typeof input.evidence === "object" && typeof input.evidence.type === "string"
                  ? input.evidence.type
                  : "FILE_READ",
            })
          }
        } else if (action === "update_finding") {
          if (po) {
            const targetId = typeof input.findingId === "string" ? input.findingId.trim().toLowerCase() : ""
            if (!targetId) continue
            const target = po.findings?.find((f) => f.id.toLowerCase() === targetId)
            if (target) {
              if (typeof input.subsumedBy === "string" && input.subsumedBy.trim()) {
                target.lifecycle = "SUBSUMED"
              } else {
                target.lifecycle = "EXTENDED"
                if (input.title?.trim()) target.title = input.title.trim()
                if (input.result?.trim()) target.result = input.result.trim()
              }
            }
          }
        } else if (action === "add_option") {
          const statement = input.statement?.trim()
          if (!statement) continue
          if (!po) {
            po = {
              title: "Primary Objective",
              status: "exploring",
              definitionOfDone: "Complete all tasks",
              secondaries: [],
            }
          }
          po.options ??= []
          po.options.push({
            id: nextOptionIdView(po.options),
            statement,
            status: typeof input.optionStatus === "string" && input.optionStatus ? (input.optionStatus as OptionStatusView) : "PENDING",
            result: input.result?.trim() || undefined,
            reason: input.reason?.trim() || undefined,
          })
        } else if (action === "update_option") {
          if (po) {
            const targetId = typeof input.optionId === "string" ? input.optionId.trim().toLowerCase() : ""
            if (!targetId) continue
            const target = po.options?.find((o) => o.id.toLowerCase() === targetId)
            if (target) {
              const newStatus =
                typeof input.optionStatus === "string" && input.optionStatus
                  ? (input.optionStatus as OptionStatusView)
                  : undefined
              if (newStatus) target.status = newStatus
              if (input.result?.trim()) target.result = input.result.trim()
              if (input.reason?.trim()) target.reason = input.reason.trim()
              // Mirror the server invariant: SUCCESSFUL auto-cancels every open sibling (preserving DISCARDED).
              if (newStatus === "SUCCESSFUL") {
                for (const sibling of po.options ?? []) {
                  if (sibling.id === target.id) continue
                  if (
                    sibling.status === "SUCCESSFUL" ||
                    sibling.status === "CANCELLED" ||
                    sibling.status === "DISCARDED"
                  ) {
                    continue
                  }
                  sibling.status = "CANCELLED"
                  sibling.result = `Cancelled: ${target.id} reached SUCCESSFUL.`
                }
              }
            }
          }
        } else if (action === "update_dod" || (action === "update_primary" && Array.isArray(input.dodCriteria))) {
          if (po) {
            const criteria = parseDodCriteriaInput(input.dodCriteria)
            if (criteria) {
              po.dodCriteria ??= []
              for (const c of criteria) {
                const existing = po.dodCriteria.find((x) => x.id.toLowerCase() === c.id.toLowerCase())
                if (existing) {
                  existing.statement = c.statement
                  if (c.proofRef) existing.proofRef = c.proofRef
                } else {
                  po.dodCriteria.push(c)
                }
              }
            }
          }
        } else if (action === "present_plan") {
          if (po) {
            po.status = "presented_awaiting_confirmation"
            po.checkpointNote = input.reason?.trim() || input.note?.trim() || undefined
          }
        } else if (action === "resume_plan") {
          if (po) {
            po.status = "exploring"
            if (input.note?.trim()) po.checkpointNote = input.note.trim()
          }
        } else if (action === "checkpoint") {
          if (po && input.note?.trim()) po.checkpointNote = input.note.trim()
        } else if (
          action === "complete_primary" ||
          action === "resolve_primary" ||
          action === "close_primary"
        ) {
          if (po) {
            // Invariante de coherencia jerárquica:
            // Un PO solo puede cerrarse como 'resolved' si TODOS los SOs y TOs están cerrados.
            const isClosed = (s: string) => s === "resolved" || s === "discarded" || s === "cancelled"
            const allSecondariesClosed =
              po.secondaries.length === 0 ||
              po.secondaries.every(
                (s) => isClosed(s.status) && (s.children ?? []).every((t) => isClosed(t.status)),
              )

            if (allSecondariesClosed) {
              po.status = "resolved"
            } else {
              po.status = "exploring"
            }
          }
        } else if (action === "update_primary") {
          if (po) {
            if (input.status) po.status = input.status
            if (input.title) po.title = input.title
            if (input.definitionOfDone) po.definitionOfDone = input.definitionOfDone
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
        const objMatch = text.match(/## Objective\s*\n+(?:-\s*)?([^\n]+)/i)
        if (objMatch) poTitle = objMatch[1].trim()
      }

      const dodMatch = text.match(/Definition of Done:\s*([^\n]+)/i)
      if (dodMatch) dod = dodMatch[1].trim()

      if (poTitle) {
        const secondaries: SecondaryObjectiveView[] = []
        const pendingTertiaries: { id: string; title: string; rationale: string; blocker?: string; proof?: string; status: ObjectiveStatus }[] = []

        // Parse line by line to support all compaction formats reliably:
        // 1. - [SO-1] [RESOLVED] Title (Details)
        // 2. - **SO-1 [RESOLVED]** Title
        // 3. - **SO-1** [RESOLVED] Title
        for (const line of text.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("-")) continue

          let id = ""
          let rawStatus = "pending"
          let title = ""
          let extra = ""

          // Pattern 1: - [SO-1] [RESOLVED] Title (Extra)
          let m = trimmed.match(/^-\s*\[(SO-\d+(?:-T\d+)?)\]\s*\[([A-Z_]+)\]\s*([^(\n]+)(?:\(([^)]+)\))?/i)
          if (m) {
            id = m[1].toUpperCase()
            rawStatus = m[2].toLowerCase()
            title = m[3].trim()
            extra = m[4] || ""
          } else {
            // Pattern 2: - **SO-1 [RESOLVED]** Title
            m = trimmed.match(/^-\s*\*\*(SO-\d+(?:-T\d+)?)\s*\[([A-Z_]+)\]\*\*\s*[:\s]*([^(\n]+)(?:\(([^)]+)\))?/i)
            if (m) {
              id = m[1].toUpperCase()
              rawStatus = m[2].toLowerCase()
              title = m[3].trim()
              extra = m[4] || ""
            } else {
              // Pattern 3: - **SO-1** [RESOLVED] Title
              m = trimmed.match(/^-\s*\*\*(SO-\d+(?:-T\d+)?)\*\*\s*\[([A-Z_]+)\]\s*[:\s]*([^(\n]+)(?:\(([^)]+)\))?/i)
              if (m) {
                id = m[1].toUpperCase()
                rawStatus = m[2].toLowerCase()
                title = m[3].trim()
                extra = m[4] || ""
              }
            }
          }

          if (!id) continue

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

          if (!/-T\d+$/i.test(id)) {
            secondaries.push({
              id,
              title,
              status,
              rationale,
              blocker,
              validationProof: proof,
            })
          } else {
            pendingTertiaries.push({ id, title, rationale, blocker, proof, status })
          }
        }

        // Attach tertiary sub-objectives under their parent SO (recovered placeholder if missing).
        for (const entry of pendingTertiaries) {
          const parentId = entry.id.replace(/-T\d+$/i, "")
          let parent = secondaries.find((s) => s.id.toLowerCase() === parentId.toLowerCase())
          if (!parent) {
            parent = { id: parentId, title: `Recovered parent ${parentId}`, status: "exploring", rationale: "Reconstructed from compaction checkpoint" }
            secondaries.push(parent)
          }
          parent.children ??= []
          parent.children.push({
            id: entry.id,
            title: entry.title,
            status: entry.status,
            rationale: entry.rationale,
            blocker: entry.blocker,
            validationProof: entry.proof,
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

  // Auto-cierre de seguridad en la UI:
  // Si todos los objetivos secundarios y terciarios ya están cerrados ('resolved', 'discarded', 'cancelled')
  // el PO no debe permanecer abierto en la barra lateral aunque el agente haya omitido llamar a complete_primary.
  if (po && po.status !== "resolved") {
    const isClosed = (s: string) => s === "resolved" || s === "discarded" || s === "cancelled"
    const allChildrenClosed =
      po.secondaries.length > 0 &&
      po.secondaries.every(
        (s) => isClosed(s.status) && (s.children ?? []).every((t) => isClosed(t.status)),
      )
    if (allChildrenClosed) {
      po.status = "resolved"
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
                                        <span style={{ fg: theme.text.muted }}>{to.id}:</span> {to.title}
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
                          <span style={{ fg: theme.text.muted }}>{f.id}:</span> {f.title}
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
