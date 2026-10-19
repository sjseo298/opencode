import { Plugin } from "@opencode/plugin"

const MAX_TODOS = 30
const dirtySessions = new Set<string>()
const postCompactionSessions = new Set<string>()
const readonlyTools = new Set([
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
  "objective_manage",
  "todowrite",
])

function getObjectives(sessionID: string) {
  const map = (globalThis as any).__OPENCODE_OBJECTIVES__ as Map<string, any> | undefined
  return map?.get(sessionID)
}

function formatObjectivesSnapshot(po: any) {
  const lines: string[] = [
    `[PO] ${po.title} [${po.status?.toUpperCase() ?? "EXPLORING"}]`,
    `Definition of Done: ${po.definitionOfDone || "Verified"}`,
  ]
  if (Array.isArray(po.secondaries)) {
    for (const so of po.secondaries) {
      lines.push(`  - [${so.id}] [${so.status?.toUpperCase() ?? "PENDING"}] ${so.title}`)
      if (so.rationale) lines.push(`    Rationale: ${so.rationale}`)
      if (so.blocker) lines.push(`    Blocker: ${so.blocker}`)
      if (so.validationProof) lines.push(`    Proof: ${so.validationProof}`)
    }
  }
  return [
    "## Active Objective Snapshot",
    "Preserve these objectives across compaction.",
    "Do not change status unless directly supported by verified runtime evidence.",
    "Keep the next step strictly aligned with unfinished objectives.",
    ...lines,
  ].join("\n")
}

function todoLine(index: number, todo: { content?: unknown; status?: unknown; priority?: unknown }) {
  const status = typeof todo.status === "string" ? todo.status : "pending"
  const priority = typeof todo.priority === "string" ? todo.priority : "medium"
  const content = typeof todo.content === "string" ? todo.content.trim() : ""
  return `${index + 1}. [${status}] (${priority}) ${content || "(missing content)"}`
}

function openTodosText(todos: unknown[]) {
  const open = todos.filter((todo) => todo && typeof todo === "object" && (todo as { status?: unknown }).status !== "completed")
  if (open.length === 0) return
  const sample = open.slice(0, MAX_TODOS)
  const lines = sample.map((todo, index) => todoLine(index, todo as { content?: unknown; status?: unknown; priority?: unknown }))
  const hidden = open.length - sample.length
  return {
    open,
    block: [
      "## Open Todo Snapshot",
      "Preserve these todos across compaction.",
      "Do not change status or priority unless directly supported by conversation evidence.",
      "Keep the next move aligned with unfinished todos.",
      ...lines,
      ...(hidden > 0 ? [`- (${hidden} additional open todos omitted from snapshot)`] : []),
    ].join("\n"),
  }
}

export default Plugin.define({
  id: "compaction-todo",
  async setup(ctx) {
    await ctx.session.hook("compaction", async (event) => {
      const po = getObjectives(event.sessionID)
      if (po && (po.status !== "resolved" || po.secondaries?.some((s: any) => s.status !== "resolved"))) {
        event.system.push({ type: "text", text: formatObjectivesSnapshot(po) })
        postCompactionSessions.add(event.sessionID)
        return
      }

      const todos = await (ctx.session as any).todo?.({ sessionID: event.sessionID }).catch(() => [])
      if (!Array.isArray(todos) || todos.length === 0) return
      const summary = openTodosText(todos)
      if (!summary) return
      event.system.push({ type: "text", text: summary.block })
      postCompactionSessions.add(event.sessionID)
    })

    await ctx.session.hook("context", async (event) => {
      if (!event.sessionID) return

      const po = getObjectives(event.sessionID)
      const postCompaction = postCompactionSessions.has(event.sessionID)
      const dirty = dirtySessions.has(event.sessionID)

      // If no objectives exist, only inject if post-compaction or dirty
      if (!po && !postCompaction && !dirty) return

      const todos = !po
        ? await (ctx.session as any).todo?.({ sessionID: event.sessionID }).catch(() => [])
        : []
      const hasTodos = Array.isArray(todos) && todos.some((t: any) => t?.status !== "completed")

      // If no PO and no open todos and not dirty and not postCompaction, return
      if (!po && !hasTodos && !dirty && !postCompaction) return

      const reminders: string[] = []

      if (po) {
        reminders.push(
          "Open objectives remain in this session.",
          "Continuously keep the objective tree updated: call `objective_manage` to record progress, hit blockers, or attach validation proof.",
          "Before ending your turn, reconcile progress against objectives. Do not leave stale in_progress or pending items if you already completed their work.",
        )
        if (dirty) {
          reminders.push(
            "⚠️ You have performed code modifications or tool executions without updating objectives. Call `objective_manage` (`update_secondary` or `add_secondary`) before finishing your turn.",
          )
        }
      } else if (hasTodos) {
        reminders.push(
          "Open todos remain in this session.",
          "Before ending your turn, reconcile progress against todos.",
          "Do not leave stale in_progress or pending items if you already completed their work.",
        )
      } else if (dirty) {
        reminders.push(
          "You have performed code modifications or tool executions.",
          "Continuously keep objectives updated: call `objective_manage` (`action: 'set_primary'`, `action: 'update_secondary'`, or `action: 'add_secondary'`) to register progress or active goals before concluding.",
        )
      }

      if (postCompaction) {
        reminders.push(
          po
            ? "This is immediately after compaction: resume unfinished objectives first."
            : "This is immediately after compaction: resume unfinished todos first.",
        )
      }

      if (reminders.length > 0) {
        event.system.push({
          type: "text",
          text: reminders.join(" "),
        })
      }

      postCompactionSessions.delete(event.sessionID)
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool === "objective_manage" || event.tool === "todowrite") {
        dirtySessions.delete(event.sessionID)
        return
      }
      if (readonlyTools.has(event.tool)) return
      dirtySessions.add(event.sessionID)
    })
  },
})
