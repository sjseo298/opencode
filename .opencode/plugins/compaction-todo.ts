import type { Plugin } from "@opencode-ai/plugin"

const MAX_TODOS = 30

function todoLine(index: number, todo: { content?: unknown; status?: unknown; priority?: unknown }) {
  const status = typeof todo.status === "string" ? todo.status : "pending"
  const priority = typeof todo.priority === "string" ? todo.priority : "medium"
  const content = typeof todo.content === "string" ? todo.content.trim() : ""
  return `${index + 1}. [${status}] (${priority}) ${content || "(missing content)"}`
}

const CompactionTodoPlugin: Plugin = async ({ client }) => {
  return {
    async "experimental.session.compacting"(input, output) {
      const todos = await client.session.todo({ sessionID: input.sessionID }).catch(() => [])
      if (!Array.isArray(todos) || todos.length === 0) return

      const open = todos.filter((todo) => todo?.status !== "completed")
      if (open.length === 0) return

      const sample = open.slice(0, MAX_TODOS)
      const lines = sample.map((todo, index) => todoLine(index, todo))
      const hidden = open.length - sample.length

      output.context.push(
        [
          "## Open Todo Snapshot",
          "Preserve these todos across compaction.",
          "Do not change status or priority unless directly supported by conversation evidence.",
          "Keep the next move aligned with unfinished todos.",
          ...lines,
          ...(hidden > 0 ? [`- (${hidden} additional open todos omitted from snapshot)`] : []),
        ].join("\n"),
      )
    },
  }
}

export default CompactionTodoPlugin
