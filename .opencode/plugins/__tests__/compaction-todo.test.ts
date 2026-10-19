import { describe, test, expect, beforeEach } from "bun:test"

// Note: Each test must use unique sessionIDs because the plugin uses
// module-level Sets (dirtySessions, postCompactionSessions) that persist
// across plugin instances within the same process.

// Generate unique session ID for each test
let testCounter = 0
function uniqueSessionID(prefix: string) {
  return `${prefix}-${++testCounter}-${Date.now()}`
}

// We need to reimport the plugin for each test to get fresh state
async function createFreshHooks(todosBySession: Record<string, unknown[]> = {}) {
  // Clear module cache to get fresh plugin state
  const modulePath = require.resolve("../compaction-todo.ts")
  delete require.cache[modulePath]
  
  const { default: plugin } = await import("../compaction-todo.ts")
  
  const sessionHooks: Record<string, ((event: any) => Promise<void> | void)[]> = {}
  const toolHooks: Record<string, ((event: any) => Promise<void> | void)[]> = {}

  const mockCtx = {
    options: {},
    session: {
      todo: async ({ sessionID }: { sessionID: string }) => {
        return todosBySession[sessionID] ?? []
      },
      hook: async (name: string, handler: any) => {
        sessionHooks[name] = sessionHooks[name] ?? []
        sessionHooks[name].push(handler)
      },
    },
    tool: {
      hook: async (name: string, handler: any) => {
        toolHooks[name] = toolHooks[name] ?? []
        toolHooks[name].push(handler)
      },
    },
  }

  await plugin.setup(mockCtx as any)

  return {
    "experimental.session.compacting": async (input: { sessionID: string }, output: { context: string[] }) => {
      const event = { sessionID: input.sessionID, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["compaction"] ?? []) {
        await h(event)
      }
      for (const part of event.system) {
        output.context.push(part.text)
      }
    },
    "experimental.compaction.autocontinue": async (input: { sessionID: string }, output: { enabled?: boolean }) => {
      const event = { sessionID: input.sessionID, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["compaction"] ?? []) {
        await h(event)
      }
      const todos = todosBySession[input.sessionID]
      const hasOpen = Array.isArray(todos) && todos.some((t: any) => t.status !== "completed")
      if (hasOpen) output.enabled = true
    },
    "experimental.chat.system.transform": async (input: { sessionID: string }, output: { system: string[] }) => {
      const event = { sessionID: input.sessionID, system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["context"] ?? []) {
        await h(event)
      }
      for (const part of event.system) {
        output.system.push(part.text)
      }
    },
    "tool.execute.after": async (input: { tool: string; sessionID: string }) => {
      for (const h of toolHooks["execute.after"] ?? []) {
        await h({ tool: input.tool, sessionID: input.sessionID })
      }
    },
  }
}

// Sample todos for testing
const sampleOpenTodos = [
  { content: "Implement feature A", status: "in_progress", priority: "high" },
  { content: "Fix bug B", status: "pending", priority: "medium" },
  { content: "Write tests", status: "pending", priority: "low" },
]

const sampleCompletedTodos = [
  { content: "Setup project", status: "completed", priority: "high" },
  { content: "Initial commit", status: "completed", priority: "medium" },
]

const sampleMixedTodos = [
  { content: "Completed task", status: "completed", priority: "high" },
  { content: "Open task", status: "pending", priority: "medium" },
]

describe("compaction-todo plugin", () => {
  describe("experimental.session.compacting hook", () => {
    test("adds open todos snapshot to compaction context", async () => {
      const sessionID = uniqueSessionID("compacting")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      const output = { context: [] as string[], prompt: undefined }
      await hooks["experimental.session.compacting"]({ sessionID }, output)

      expect(output.context.length).toBe(1)
      expect(output.context[0]).toContain("## Open Todo Snapshot")
      expect(output.context[0]).toContain("Implement feature A")
      expect(output.context[0]).toContain("Fix bug B")
      expect(output.context[0]).toContain("[in_progress]")
      expect(output.context[0]).toContain("[pending]")
    })

    test("does NOT add context when all todos are completed", async () => {
      const sessionID = uniqueSessionID("compacting-completed")
      const hooks = await createFreshHooks({
        [sessionID]: sampleCompletedTodos,
      })

      const output = { context: [] as string[], prompt: undefined }
      await hooks["experimental.session.compacting"]({ sessionID }, output)

      expect(output.context.length).toBe(0)
    })

    test("does NOT add context when no todos exist", async () => {
      const sessionID = uniqueSessionID("compacting-empty")
      const hooks = await createFreshHooks({
        [sessionID]: [],
      })

      const output = { context: [] as string[], prompt: undefined }
      await hooks["experimental.session.compacting"]({ sessionID }, output)

      expect(output.context.length).toBe(0)
    })

    test("only includes open todos in snapshot", async () => {
      const sessionID = uniqueSessionID("compacting-mixed")
      const hooks = await createFreshHooks({
        [sessionID]: sampleMixedTodos,
      })

      const output = { context: [] as string[], prompt: undefined }
      await hooks["experimental.session.compacting"]({ sessionID }, output)

      expect(output.context[0]).toContain("Open task")
      expect(output.context[0]).not.toContain("Completed task")
    })

    test("handles todos fetch error gracefully", async () => {
      // Import fresh plugin
      const modulePath = require.resolve("../compaction-todo.ts")
      delete require.cache[modulePath]
      const { default: plugin } = await import("../compaction-todo.ts")

      const sessionHooks: Record<string, ((event: any) => Promise<void> | void)[]> = {}
      const mockCtx = {
        options: {},
        session: {
          todo: async () => {
            throw new Error("Network error")
          },
          hook: async (name: string, handler: any) => {
            sessionHooks[name] = sessionHooks[name] ?? []
            sessionHooks[name].push(handler)
          },
        },
        tool: { hook: async () => {} },
      }
      await plugin.setup(mockCtx as any)

      const event = { sessionID: uniqueSessionID("error"), system: [] as { type: string; text: string }[] }
      for (const h of sessionHooks["compaction"] ?? []) {
        await h(event)
      }

      expect(event.system.length).toBe(0)
    })
  })

  describe("experimental.compaction.autocontinue hook", () => {
    test("enables autocontinue when open todos exist", async () => {
      const sessionID = uniqueSessionID("autocontinue")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      const output = { enabled: false }
      await hooks["experimental.compaction.autocontinue"](
        { sessionID, agent: "", model: {} as any, provider: {} as any, message: {} as any, overflow: false },
        output,
      )

      expect(output.enabled).toBe(true)
    })

    test("does NOT enable autocontinue when no open todos", async () => {
      const sessionID = uniqueSessionID("autocontinue-completed")
      const hooks = await createFreshHooks({
        [sessionID]: sampleCompletedTodos,
      })

      const output = { enabled: false }
      await hooks["experimental.compaction.autocontinue"](
        { sessionID, agent: "", model: {} as any, provider: {} as any, message: {} as any, overflow: false },
        output,
      )

      expect(output.enabled).toBe(false)
    })
  })

  describe("experimental.chat.system.transform hook", () => {
    test("injects reminder after compaction when open todos exist", async () => {
      const sessionID = uniqueSessionID("transform-postcompact")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      // Trigger autocontinue to mark as post-compaction
      await hooks["experimental.compaction.autocontinue"](
        { sessionID, agent: "", model: {} as any, provider: {} as any, message: {} as any, overflow: false },
        { enabled: false },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)

      expect(output.system.length).toBe(1)
      expect(output.system[0]).toContain("Open todos remain")
      expect(output.system[0]).toContain("after compaction")
    })

    test("injects reminder when session is dirty (write tool used)", async () => {
      const sessionID = uniqueSessionID("transform-dirty")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      // Simulate write tool execution (makes session dirty)
      await hooks["tool.execute.after"](
        { tool: "write", sessionID, callID: "call-1", args: {} },
        { title: "", output: "", metadata: {} },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)

      expect(output.system.length).toBe(1)
      expect(output.system[0]).toContain("Open todos remain")
    })

    test("does NOT inject when session is clean and not post-compaction", async () => {
      const sessionID = uniqueSessionID("transform-clean")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      // No tool execution, not post-compaction
      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)

      expect(output.system.length).toBe(0)
    })

    test("clears post-compaction flag after injection", async () => {
      const sessionID = uniqueSessionID("transform-clear")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      // Mark as post-compaction
      await hooks["experimental.compaction.autocontinue"](
        { sessionID, agent: "", model: {} as any, provider: {} as any, message: {} as any, overflow: false },
        { enabled: false },
      )

      // First transform - should inject
      const output1 = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output1)
      expect(output1.system.length).toBe(1)

      // Second transform - should NOT inject (flag cleared)
      const output2 = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output2)
      expect(output2.system.length).toBe(0)
    })
  })

  describe("tool.execute.after hook (dirty tracking)", () => {
    test("marks session dirty after write tool", async () => {
      const sessionID = uniqueSessionID("dirty-write")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      await hooks["tool.execute.after"](
        { tool: "write", sessionID, callID: "call-1", args: {} },
        { title: "", output: "", metadata: {} },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)
      expect(output.system.length).toBe(1)
    })

    test("marks session dirty after bash tool", async () => {
      const sessionID = uniqueSessionID("dirty-bash")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      await hooks["tool.execute.after"](
        { tool: "bash", sessionID, callID: "call-1", args: {} },
        { title: "", output: "", metadata: {} },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)
      expect(output.system.length).toBe(1)
    })

    test("does NOT mark session dirty for read tool (readonly)", async () => {
      const sessionID = uniqueSessionID("readonly-read")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      await hooks["tool.execute.after"](
        { tool: "read", sessionID, callID: "call-1", args: {} },
        { title: "", output: "", metadata: {} },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)
      expect(output.system.length).toBe(0)
    })

    test("does NOT mark session dirty for grep tool (readonly)", async () => {
      const sessionID = uniqueSessionID("readonly-grep")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      await hooks["tool.execute.after"](
        { tool: "grep", sessionID, callID: "call-1", args: {} },
        { title: "", output: "", metadata: {} },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)
      expect(output.system.length).toBe(0)
    })

    test("clears dirty flag after todowrite", async () => {
      const sessionID = uniqueSessionID("dirty-clear")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      // Make dirty
      await hooks["tool.execute.after"](
        { tool: "write", sessionID, callID: "call-1", args: {} },
        { title: "", output: "", metadata: {} },
      )

      // Clear with todowrite
      await hooks["tool.execute.after"](
        { tool: "todowrite", sessionID, callID: "call-2", args: {} },
        { title: "", output: "", metadata: {} },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)
      expect(output.system.length).toBe(0)
    })

    test("all readonly tools do not mark session dirty", async () => {
      const readonlyTools = [
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
      ]

      for (const tool of readonlyTools) {
        const sessionID = uniqueSessionID(`readonly-${tool}`)
        const hooks = await createFreshHooks({
          [sessionID]: sampleOpenTodos,
        })

        await hooks["tool.execute.after"](
          { tool, sessionID, callID: "call-1", args: {} },
          { title: "", output: "", metadata: {} },
        )

        const output = { system: [] as string[] }
        await hooks["experimental.chat.system.transform"]({ sessionID }, output)
        expect(output.system.length).toBe(0)
      }
    })
  })

  describe("todo formatting", () => {
    test("formats todos with status and priority", async () => {
      const sessionID = uniqueSessionID("format")
      const hooks = await createFreshHooks({
        [sessionID]: [
          { content: "Task A", status: "in_progress", priority: "high" },
          { content: "Task B", status: "pending", priority: "low" },
        ],
      })

      const output = { context: [] as string[], prompt: undefined }
      await hooks["experimental.session.compacting"]({ sessionID }, output)

      expect(output.context[0]).toContain("[in_progress]")
      expect(output.context[0]).toContain("(high)")
      expect(output.context[0]).toContain("[pending]")
      expect(output.context[0]).toContain("(low)")
    })

    test("handles todos with missing fields", async () => {
      const sessionID = uniqueSessionID("format-missing")
      const hooks = await createFreshHooks({
        [sessionID]: [
          { content: "Task A" }, // missing status and priority
          { status: "pending" }, // missing content
          {}, // empty object
        ],
      })

      const output = { context: [] as string[], prompt: undefined }
      await hooks["experimental.session.compacting"]({ sessionID }, output)

      expect(output.context[0]).toContain("[pending]") // default status
      expect(output.context[0]).toContain("(medium)") // default priority
      expect(output.context[0]).toContain("(missing content)")
    })
  })

  describe("hierarchical objectives continuous tracking", () => {
    test("clears dirty flag after objective_manage", async () => {
      const sessionID = uniqueSessionID("dirty-objective-manage")
      const hooks = await createFreshHooks({
        [sessionID]: sampleOpenTodos,
      })

      // Make dirty with edit
      await hooks["tool.execute.after"](
        { tool: "edit", sessionID, callID: "call-1", args: {} },
        { title: "", output: "", metadata: {} },
      )

      // Clear with objective_manage
      await hooks["tool.execute.after"](
        { tool: "objective_manage", sessionID, callID: "call-2", args: {} },
        { title: "", output: "", metadata: {} },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)
      expect(output.system.length).toBe(0)
    })

    test("injects continuous objective reminder when sessionObjectives exist in globalThis", async () => {
      const sessionID = uniqueSessionID("objectives-continuous")
      const globalObjectives = ((globalThis as any).__OPENCODE_OBJECTIVES__ ??= new Map())
      globalObjectives.set(sessionID, {
        title: "Main Migration Task",
        status: "exploring",
        definitionOfDone: "Zero test failures",
        secondaries: [
          { id: "SO-1", title: "Migrate auth schema", status: "pending", rationale: "Required for auth" },
        ],
      })

      const hooks = await createFreshHooks()

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)

      expect(output.system.length).toBe(1)
      expect(output.system[0]).toContain("Open objectives remain in this session")
      expect(output.system[0]).toContain("Continuously keep the objective tree updated")
      expect(output.system[0]).toContain("objective_manage")

      // Clean up
      globalObjectives.delete(sessionID)
    })

    test("snapshots hierarchical objectives into compaction context", async () => {
      const sessionID = uniqueSessionID("objectives-compaction")
      const globalObjectives = ((globalThis as any).__OPENCODE_OBJECTIVES__ ??= new Map())
      globalObjectives.set(sessionID, {
        title: "Database Refactor",
        status: "exploring",
        definitionOfDone: "All integration tests pass",
        secondaries: [
          { id: "SO-1", title: "Apply SQL constraints", status: "pending", rationale: "Prevent orphan records" },
        ],
      })

      const hooks = await createFreshHooks()

      const output = { context: [] as string[], prompt: undefined }
      await hooks["experimental.session.compacting"]({ sessionID }, output)

      expect(output.context.length).toBe(1)
      expect(output.context[0]).toContain("## Active Objective Snapshot")
      expect(output.context[0]).toContain("[PO] Database Refactor")
      expect(output.context[0]).toContain("SO-1")
      expect(output.context[0]).toContain("Apply SQL constraints")

      // Clean up
      globalObjectives.delete(sessionID)
    })
  })
})

