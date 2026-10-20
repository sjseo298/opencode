import { describe, test, expect } from "bun:test"
import plugin, { buildOrchestratorGuide } from "../../../src/plugin/builtin/subagent-mandatory-instruction.js"

// Helper to create mock client
function createMockClient(sessions: Record<string, { parentID?: string }>) {
  return {
    session: {
      get: async (input: any) => {
        const id = input.sessionID ?? input.path?.id
        const session = sessions[id]
        if (!session) throw new Error("Session not found")
        return { data: session, ...session }
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
  const sessionHooks: Record<string, ((event: any) => Promise<void> | void)[]> = {}
  const toolTransforms: ((editor: any) => Promise<void> | void)[] = []

  const mockCtx = {
    options,
    session: {
      ...mockClient.session,
      hook: async (name: string, handler: any) => {
        sessionHooks[name] = sessionHooks[name] ?? []
        sessionHooks[name].push(handler)
      },
    },
    tool: {
      transform: async (handler: any) => {
        toolTransforms.push(handler)
      },
    },
  }

  await plugin.setup(mockCtx as any)

  return {
    "tool.definition": async (input: { toolID: string }, output: { description: string }) => {
      const editor = {
        update: (toolId: string, fn: (tool: any) => void) => {
          if (toolId === input.toolID) {
            const tool = { description: output.description }
            fn(tool)
            output.description = tool.description
          }
        },
      }
      for (const t of toolTransforms) {
        await t(editor)
      }
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      const event = {
        sessionID: input.sessionID,
        system: output.system.map((text) => ({ type: "text", text })),
      }
      for (const h of sessionHooks["context"] ?? []) {
        await h(event)
      }
      output.system = event.system.map((s) => s.text)
    },
  }
}

describe("subagent-mandatory-instruction plugin", () => {
  describe("tool.transform", () => {
    test("injects structured prompt guide into subagent tool description", async () => {
      const hooks = await createHooks({})

      const output = {
        description: "Original subagent tool description",
        parameters: {},
      }

      await hooks["tool.definition"]({ toolID: "subagent" }, output)

      expect(output.description).toContain("## Structured Prompt Format")
      expect(output.description).toContain("### SCOPE")
      expect(output.description).toContain("### OBJECTIVE")
      expect(output.description).toContain("### OUTPUT")
      expect(output.description).toContain("Original subagent tool description")
    })

    test("does NOT modify other tools", async () => {
      const hooks = await createHooks({})

      const readOutput = { description: "Read tool description", parameters: {} }
      const shellOutput = { description: "Shell tool description", parameters: {} }
      const writeOutput = { description: "Write tool description", parameters: {} }

      await hooks["tool.definition"]({ toolID: "read" }, readOutput)
      await hooks["tool.definition"]({ toolID: "shell" }, shellOutput)
      await hooks["tool.definition"]({ toolID: "write" }, writeOutput)

      expect(readOutput.description).toBe("Read tool description")
      expect(shellOutput.description).toBe("Shell tool description")
      expect(writeOutput.description).toBe("Write tool description")
    })

    test("does NOT duplicate injection if already present", async () => {
      const hooks = await createHooks({})

      const output = {
        description: "Subagent tool with ## Structured Prompt Format already",
        parameters: {},
      }

      await hooks["tool.definition"]({ toolID: "subagent" }, output)

      // Should not modify since marker already exists
      expect(output.description).toBe("Subagent tool with ## Structured Prompt Format already")
    })
  })

  describe("experimental.chat.system.transform hook", () => {
    test("injects protocol for subagent sessions (empty system)", async () => {
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

    test("prepends protocol to existing system message", async () => {
      const hooks = await createHooks({
        "child-session": { parentID: "parent-session" },
      })

      const output = { system: ["You are a helpful assistant."] }

      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, output)

      // Should still be 1 message (prepended, not pushed)
      expect(output.system.length).toBe(1)
      // Protocol should be at the beginning
      expect(output.system[0]).toMatch(/^# SUBAGENT EXECUTION PROTOCOL/)
      // Original content should be at the end
      expect(output.system[0]).toContain("You are a helpful assistant.")
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
      const sessionHooks: Record<string, ((event: any) => Promise<void> | void)[]> = {}
      const mockCtx = {
        options: {},
        session: {
          get: async (input: any) => {
            callCount++
            const id = input.sessionID ?? input.path?.id
            if (id === "child-session") {
              return { parentID: "parent-session" }
            }
            return {}
          },
          hook: async (name: string, handler: any) => {
            sessionHooks[name] = sessionHooks[name] ?? []
            sessionHooks[name].push(handler)
          },
        },
        tool: { transform: async () => {} },
      }

      await plugin.setup(mockCtx as any)

      const triggerContext = async () => {
        const event = { sessionID: "child-session", system: [] as { type: string; text: string }[] }
        for (const h of sessionHooks["context"] ?? []) {
          await h(event)
        }
      }

      // First call - should fetch
      await triggerContext()
      expect(callCount).toBe(1)

      // Second call - should use cache
      await triggerContext()
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

      const output = { description: "Subagent tool", parameters: {} }
      await hooks["tool.definition"]({ toolID: "subagent" }, output)

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

    test("allows custom subagentProtocol with existing system", async () => {
      const hooks = await createHooks(
        {
          "child-session": { parentID: "parent" },
        },
        {
          subagentProtocol: "CUSTOM PROTOCOL",
        },
      )

      const output = { system: ["Original system prompt"] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, output)

      expect(output.system.length).toBe(1)
      expect(output.system[0]).toBe("CUSTOM PROTOCOL\n\nOriginal system prompt")
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

      const subagentOutput = { description: "Subagent", parameters: {} }
      await hooks["tool.definition"]({ toolID: "subagent" }, subagentOutput)
      expect(subagentOutput.description).toContain("## Structured Prompt Format")

      const systemOutput = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "child-session" }, systemOutput)
      expect(systemOutput.system[0]).toContain("SUBAGENT EXECUTION PROTOCOL")
    })
  })

  describe("protocol content validation", () => {
    test("orchestrator guide contains concurrency rule of strictly 1 subagent at a time by default (2 slots) and task sizing rules", async () => {
      ;(globalThis as any).__OPENCODE_TOTAL_SLOTS__ = 2
      ;(globalThis as any).__OPENCODE_MAX_SUBAGENTS__ = 1
      if ((globalThis as any).__OPENCODE_DYNAMIC_CONTEXT__) {
        ;(globalThis as any).__OPENCODE_DYNAMIC_CONTEXT__.latestTotalSlots = 2
        ;(globalThis as any).__OPENCODE_DYNAMIC_CONTEXT__.latestMaxSubagents = 1
      }
      const hooks = await createHooks({})

      const output = { description: "Subagent", parameters: {} }
      await hooks["tool.definition"]({ toolID: "subagent" }, output)

      expect(output.description).toContain("Strictly 1 Subagent At A Time")
      expect(output.description).toContain("Delegate to only ONE subagent at a time")
      expect(output.description).toContain("Never launch multiple subagents in parallel or concurrently")
      expect(output.description).toContain("Do NOT delegate overly large tasks to subagents")
      expect(output.description).toContain("medium-sized, achievable tasks")
      expect(output.description).toContain("split it into several smaller subagent tasks whenever possible")
    })

    test("buildOrchestratorGuide reflects 2 subagents for 3 slots and 3 subagents for 4 slots (slots - 1)", () => {
      const guide3 = buildOrchestratorGuide({ totalSlots: 3, maxSubagents: 2 })
      expect(guide3).toContain("Up To 2 Subagents At A Time (slots - 1 = 2 of 3 slots)")
      expect(guide3).toContain("up to 2 concurrent subagents")

      const guide4 = buildOrchestratorGuide({ totalSlots: 4, maxSubagents: 3 })
      expect(guide4).toContain("Up To 3 Subagents At A Time (slots - 1 = 3 of 4 slots)")
      expect(guide4).toContain("up to 3 concurrent subagents")
    })

    test("orchestrator guide contains example prompt", async () => {
      const hooks = await createHooks({})

      const output = { description: "Subagent", parameters: {} }
      await hooks["tool.definition"]({ toolID: "subagent" }, output)

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
