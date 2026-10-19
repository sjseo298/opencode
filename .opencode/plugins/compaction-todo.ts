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
])

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
      const todos = await (ctx.session as any).todo?.({ sessionID: event.sessionID }).catch(() => [])
      if (!Array.isArray(todos) || todos.length === 0) return
      const summary = openTodosText(todos)
      if (!summary) return
      event.system.push({ type: "text", text: summary.block })
      postCompactionSessions.add(event.sessionID)
    })

    await ctx.session.hook("context", async (event) => {
      if (!event.sessionID) return
      const todos = await (ctx.session as any).todo?.({ sessionID: event.sessionID }).catch(() => [])
      if (!Array.isArray(todos)) return
      const summary = openTodosText(todos)
      if (!summary) return

      const postCompaction = postCompactionSessions.has(event.sessionID)
      const dirty = dirtySessions.has(event.sessionID)
      if (!postCompaction && !dirty) return

      event.system.push({
        type: "text",
        text: [
          "Open todos remain in this session.",
          "Before ending your turn, reconcile progress against todos.",
          "Do not leave stale in_progress or pending items if you already completed their work.",
          postCompaction ? "This is immediately after compaction: resume unfinished todos first." : "",
        ]
          .filter(Boolean)
          .join(" "),
      })
      postCompactionSessions.delete(event.sessionID)
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool === "todowrite") {
        dirtySessions.delete(event.sessionID)
        return
      }
      if (readonlyTools.has(event.tool)) return
      dirtySessions.add(event.sessionID)
    })
  },
})
