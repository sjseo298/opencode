import { describe, test, expect } from "bun:test"
import plugin from "../subagent-mandatory-instruction.ts"

// Helper to create mock client
function createMockClient(sessions: Record<string, { parentID?: string }>) {
  return {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        const session = sessions[path.id]
        if (!session) throw new Error("Session not found")
        return { data: session }
      },
    },
  }
}

// Helper to create hooks with mock client
async function createHooks(
  sessions: Record<string, { parentID?: string }>,
  options: Record<string, unknown> = {},
) {
  const mockClient = createMockClient(sessions)
  return plugin({ client: mockClient } as any, options)
}

describe("subagent-mandatory-instruction plugin", () => {
  describe("tool.definition hook", () => {
    test("injects structured prompt guide into task tool description", async () => {
      const hooks = await createHooks({})

      const output = {
        description: "Original task tool description",
        parameters: {},
      }

      await hooks["tool.definition"]({ toolID: "task" }, output)

      expect(output.description).toContain("## Structured Prompt Format")
      expect(output.description).toContain("### SCOPE")
      expect(output.description).toContain("### OBJECTIVE")
      expect(output.description).toContain("### OUTPUT")
      expect(output.description).toContain("Original task tool description")
    })

    test("does NOT modify other tools", async () => {
      const hooks = await createHooks({})

      const readOutput = { description: "Read tool description", parameters: {} }
      const bashOutput = { description: "Bash tool description", parameters: {} }
      const writeOutput = { description: "Write tool description", parameters: {} }

      await hooks["tool.definition"]({ toolID: "read" }, readOutput)
      await hooks["tool.definition"]({ toolID: "bash" }, bashOutput)
      await hooks["tool.definition"]({ toolID: "write" }, writeOutput)

      expect(readOutput.description).toBe("Read tool description")
      expect(bashOutput.description).toBe("Bash tool description")
      expect(writeOutput.description).toBe("Write tool description")
    })

    test("does NOT duplicate injection if already present", async () => {
      const hooks = await createHooks({})

      const output = {
        description: "Task tool with ## Structured Prompt Format already",
        parameters: {},
      }

      await hooks["tool.definition"]({ toolID: "task" }, output)

      // Should not modify since marker already exists
      expect(output.description).toBe("Task tool with ## Structured Prompt Format already")
    })
  })

  describe("experimental.chat.system.transform hook", () => {
    test("injects protocol for subagent sessions", async () => {
      const hooks = await createHooks({
        "child-session": { parentID: "parent-session" },
        "parent-session": {},
      })

      const output = { system: [] as string[] }

      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, output)

      expect(output.system.length).toBe(1)
      expect(output.system[0]).toContain("SUBAGENT EXECUTION PROTOCOL")
      expect(output.system[0]).toContain("### SCOPE")
      expect(output.system[0]).toContain("### OBJECTIVE")
      expect(output.system[0]).toContain("### OUTPUT")
      expect(output.system[0]).toContain("<execution_blocked>")
    })

    test("does NOT inject for parent sessions (no parentID)", async () => {
      const hooks = await createHooks({
        "parent-session": {},
      })

      const output = { system: [] as string[] }

      await hooks["experimental.chat.system.transform"]({ sessionID: "parent-session" }, output)

      expect(output.system.length).toBe(0)
    })

    test("does NOT inject if sessionID is missing", async () => {
      const hooks = await createHooks({})

      const output = { system: [] as string[] }

      await hooks["experimental.chat.system.transform"]({}, output)

      expect(output.system.length).toBe(0)
    })

    test("does NOT duplicate injection if already present", async () => {
      const hooks = await createHooks({
        "child-session": { parentID: "parent-session" },
      })

      const output = { system: ["Some existing content with SUBAGENT EXECUTION PROTOCOL"] }

      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, output)

      expect(output.system.length).toBe(1) // No additional item added
    })

    test("caches session parent status", async () => {
      let callCount = 0
      const mockClient = {
        session: {
          get: async ({ path }: { path: { id: string } }) => {
            callCount++
            if (path.id === "child-session") {
              return { data: { parentID: "parent-session" } }
            }
            return { data: {} }
          },
        },
      }

      const hooks = await plugin({ client: mockClient } as any, {})

      // First call - should fetch
      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, { system: [] })
      expect(callCount).toBe(1)

      // Second call - should use cache
      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, { system: [] })
      expect(callCount).toBe(1) // No additional fetch
    })
  })

  describe("custom options", () => {
    test("allows custom orchestratorGuide", async () => {
      const hooks = await createHooks(
        {},
        {
          orchestratorGuide: "CUSTOM GUIDE FOR ORCHESTRATOR",
        },
      )

      const output = { description: "Task tool", parameters: {} }
      await hooks["tool.definition"]({ toolID: "task" }, output)

      expect(output.description).toContain("CUSTOM GUIDE FOR ORCHESTRATOR")
      expect(output.description).not.toContain("## Structured Prompt Format")
    })

    test("allows custom subagentProtocol", async () => {
      const hooks = await createHooks(
        {
          "child-session": { parentID: "parent" },
        },
        {
          subagentProtocol: "CUSTOM PROTOCOL FOR SUBAGENT",
        },
      )

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, output)

      expect(output.system[0]).toBe("CUSTOM PROTOCOL FOR SUBAGENT")
      expect(output.system[0]).not.toContain("SUBAGENT EXECUTION PROTOCOL")
    })

    test("uses default when custom option is empty string", async () => {
      const hooks = await createHooks(
        {
          "child-session": { parentID: "parent" },
        },
        {
          orchestratorGuide: "",
          subagentProtocol: "   ", // whitespace only
        },
      )

      const taskOutput = { description: "Task", parameters: {} }
      await hooks["tool.definition"]({ toolID: "task" }, taskOutput)
      expect(taskOutput.description).toContain("## Structured Prompt Format")

      const systemOutput = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, systemOutput)
      expect(systemOutput.system[0]).toContain("SUBAGENT EXECUTION PROTOCOL")
    })
  })

  describe("protocol content validation", () => {
    test("orchestrator guide contains example prompt", async () => {
      const hooks = await createHooks({})

      const output = { description: "Task", parameters: {} }
      await hooks["tool.definition"]({ toolID: "task" }, output)

      expect(output.description).toContain("### Example Prompt")
      expect(output.description).toContain("Location: local")
      expect(output.description).toContain("Constraints: read-only")
    })

    test("subagent protocol contains validation checklist", async () => {
      const hooks = await createHooks({
        "child": { parentID: "parent" },
      })

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "child" }, output)

      expect(output.system[0]).toContain("PRE-EXECUTION VALIDATION CHECKLIST")
      expect(output.system[0]).toContain("SCOPE Validation")
      expect(output.system[0]).toContain("OBJECTIVE Validation")
      expect(output.system[0]).toContain("OUTPUT Validation")
    })

    test("subagent protocol contains blocking examples", async () => {
      const hooks = await createHooks({
        "child": { parentID: "parent" },
      })

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "child" }, output)

      expect(output.system[0]).toContain("EXAMPLES OF BLOCKING SITUATIONS")
      expect(output.system[0]).toContain("Ambiguous Location")
      expect(output.system[0]).toContain("Non-existent Resources")
      expect(output.system[0]).toContain("Contradictory Instructions")
    })
  })
})
