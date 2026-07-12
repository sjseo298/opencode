import type { Plugin } from "@opencode-ai/plugin"

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
  "todowrite",
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

const CompactionTodoPlugin: Plugin = async ({ client }) => {
  return {
    async "experimental.session.compacting"(input, output) {
      const todos = await client.session.todo({ sessionID: input.sessionID }).catch(() => [])
      if (!Array.isArray(todos) || todos.length === 0) return
      const summary = openTodosText(todos)
      if (!summary) return
      output.context.push(summary.block)
    },
    async "experimental.compaction.autocontinue"(input, output) {
      const todos = await client.session.todo({ sessionID: input.sessionID }).catch(() => [])
      if (!Array.isArray(todos)) return
      if (!openTodosText(todos)) return
      postCompactionSessions.add(input.sessionID)
      output.enabled = true
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!input.sessionID) return
      const todos = await client.session.todo({ sessionID: input.sessionID }).catch(() => [])
      if (!Array.isArray(todos)) return
      const summary = openTodosText(todos)
      if (!summary) return

      const postCompaction = postCompactionSessions.has(input.sessionID)
      const dirty = dirtySessions.has(input.sessionID)
      if (!postCompaction && !dirty) return

      output.system.push(
        [
          "Open todos remain in this session.",
          "Before ending your turn, reconcile progress against todos and update them with todowrite when statuses changed.",
          "Do not leave stale in_progress or pending items if you already completed their work.",
          postCompaction ? "This is immediately after compaction: resume unfinished todos first." : "",
        ]
          .filter(Boolean)
          .join(" "),
      )
      postCompactionSessions.delete(input.sessionID)
    },
    async "tool.execute.after"(input) {
      if (input.tool === "todowrite") {
        dirtySessions.delete(input.sessionID)
        return
      }
      if (readonlyTools.has(input.tool)) return
      dirtySessions.add(input.sessionID)
    },
  }
}

export default CompactionTodoPlugin
