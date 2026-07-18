import { describe, test, expect, beforeEach } from "bun:test"
import plugin from "../loop-guard.ts"

// Helper to create mock hooks with specific options
async function createHooks(options: Record<string, unknown> = {}) {
  const mockClient = {}
  return plugin({ client: mockClient } as any, options)
}

type SimulatedToolCall = {
  tool: string
  args: Record<string, unknown>
  output: { title: string; output: string; metadata: Record<string, unknown> }
  callID?: string
}

// Helper to simulate one assistant turn containing one or more tool calls
async function simulateTurn(
  hooks: Awaited<ReturnType<typeof createHooks>>,
  sessionID: string,
  calls: SimulatedToolCall[],
) {
  for (const call of calls) {
    const id = call.callID ?? `call-${Date.now()}-${Math.random()}`
    await hooks["tool.execute.before"]({ sessionID, tool: call.tool, callID: id }, { args: call.args })
    await hooks["tool.execute.after"]({ sessionID, tool: call.tool, callID: id, args: call.args }, call.output)
  }
  return checkGuardInjected(hooks, sessionID)
}

// Helper to check if guard was injected
async function checkGuardInjected(hooks: Awaited<ReturnType<typeof createHooks>>, sessionID: string) {
  const systemOutput = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, systemOutput)
  return systemOutput.system.length > 0 && systemOutput.system.some((s) => s.includes("Loop guard detected"))
}

describe("loop-guard plugin", () => {
  describe("ignoreResults option", () => {
    test("detects loop with ignoreResults: true even when results differ", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1, // warn at 2 repeats
        cooldownMs: 0,
      })

      const sessionID = "test-session-1"
      const args = { operation: "items_get", project: "MyProject", path: "/app.js" }

      let injected = false
      // Simulate 3 calls with same args but different results
      for (let i = 0; i < 3; i++) {
        injected =
          (await simulateTurn(hooks, sessionID, [
            {
              tool: "azure-devops",
              args,
              output: {
                title: "Result",
                output: `Content version ${i}`,
                metadata: { objectId: `obj-${Math.random()}` },
              },
            },
          ])) || injected
      }

      // After 2+ calls (threshold-1), guard should be injected
      expect(injected).toBe(true)
    })

    test("does NOT detect loop with ignoreResults: false when results differ", async () => {
      const hooks = await createHooks({
        ignoreResults: false,
        requireNoProgress: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        cooldownMs: 0,
      })

      const sessionID = "test-session-2"
      const args = { operation: "items_get", project: "MyProject", path: "/app.js" }

      let injected = false
      for (let i = 0; i < 3; i++) {
        injected =
          (await simulateTurn(hooks, sessionID, [
            {
              tool: "azure-devops",
              args,
              output: {
                title: "Result",
                output: `Content version ${i}`,
                metadata: { objectId: `obj-${Math.random()}` },
              },
            },
          ])) || injected
      }

      expect(injected).toBe(false)
    })

    test("detects loop with ignoreResults: false when results are identical", async () => {
      const hooks = await createHooks({
        ignoreResults: false,
        requireNoProgress: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        cooldownMs: 0,
      })

      const sessionID = "test-session-3"
      const args = { operation: "items_get", project: "MyProject", path: "/app.js" }
      const identicalOutput = {
        title: "Result",
        output: "Same content always",
        metadata: { objectId: "same-id" },
      }

      let injected = false
      for (let i = 0; i < 3; i++) {
        injected =
          (await simulateTurn(hooks, sessionID, [{ tool: "azure-devops", args, output: identicalOutput }])) ||
          injected
      }

      expect(injected).toBe(true)
    })
  })

  describe("ignoreTools option", () => {
    test("does not track calls to ignored tools", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        ignoreTools: ["todowrite", "read"],
        cooldownMs: 0,
      })

      const sessionID = "test-session-4"
      const args = { filePath: "/some/file.ts" }

      // Simulate many calls to ignored tool
      for (let i = 0; i < 10; i++) {
        await simulateTurn(hooks, sessionID, [{ tool: "read", args, output: { title: "Read", output: "file content", metadata: {} } }])
      }

      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })

    test("tracks calls to non-ignored tools", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        ignoreTools: ["todowrite"],
        cooldownMs: 0,
      })

      const sessionID = "test-session-5"

      let injected = false
      for (let i = 0; i < 3; i++) {
        injected =
          (await simulateTurn(hooks, sessionID, [
            { tool: "bash", args: { command: "ls" }, output: { title: "Bash", output: "files", metadata: {} } },
          ])) || injected
      }

      expect(injected).toBe(true)
    })
  })

  describe("chat.message hook (state reset)", () => {
    test("resets state when new user message arrives", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        cooldownMs: 0,
      })

      const sessionID = "test-session-6"

      // Build up almost to threshold
      for (let i = 0; i < 2; i++) {
        await simulateTurn(
          hooks,
          sessionID,
          [{ tool: "grep", args: { pattern: "foo" }, output: { title: "Grep", output: "matches", metadata: {} } }],
        )
      }

      // Simulate new user message (resets state)
      await hooks["chat.message"]({ sessionID }, { message: {} as any, parts: [] })

      // Now make more calls - should not trigger because counter reset
      await simulateTurn(
        hooks,
        sessionID,
        [{ tool: "grep", args: { pattern: "foo" }, output: { title: "Grep", output: "matches", metadata: {} } }],
      )

      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })
  })

  describe("windowMs option", () => {
    test("expires old attempts outside window", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 4,  // Need 4 consecutive calls
        warning_before_doom_loop: 1,  // Warn at 3 calls
        windowMs: 100, // Very short window for testing
        cooldownMs: 0,
      })

      const sessionID = "test-session-7"

      // Make 2 calls
      for (let i = 0; i < 2; i++) {
        await simulateTurn(
          hooks,
          sessionID,
          [{ tool: "glob", args: { pattern: "*.ts" }, output: { title: "Glob", output: "files", metadata: {} } }],
        )
      }

      // Wait for window to expire
      await Bun.sleep(150)

      // Make 2 more calls - the previous 2 should have expired
      // So we only have 2 within window, threshold is 3, no guard
      for (let i = 0; i < 2; i++) {
        await simulateTurn(
          hooks,
          sessionID,
          [{ tool: "glob", args: { pattern: "*.ts" }, output: { title: "Glob", output: "files", metadata: {} } }],
        )
      }

      // Only 2 calls within window, warning threshold is 3, so no guard
      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })
  })

  describe("cooldownMs option", () => {
    test("does not trigger again during cooldown period", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        cooldownMs: 1000,
      })

      const sessionID = "test-session-8"

      // Trigger first guard
      let firstGuard = false
      for (let i = 0; i < 3; i++) {
        firstGuard =
          (await simulateTurn(
          hooks,
          sessionID,
          [{ tool: "webfetch", args: { url: "https://example.com" }, output: { title: "Fetch", output: "content", metadata: {} } }],
          )) || firstGuard
      }

      expect(firstGuard).toBe(true)

      // Try to trigger again immediately - should be in cooldown
      for (let i = 0; i < 3; i++) {
        await simulateTurn(
          hooks,
          sessionID,
          [{ tool: "webfetch", args: { url: "https://example.com" }, output: { title: "Fetch", output: "content", metadata: {} } }],
        )
      }

      // Second check should not inject (cooldown active)
      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })
  })

  describe("volatileKeys option", () => {
    test("ignores volatile keys when hashing args", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        volatileKeys: ["timestamp", "requestId"],
        cooldownMs: 0,
      })

      const sessionID = "test-session-9"

      let injected = false
      // Same logical args but with different volatile keys
      for (let i = 0; i < 3; i++) {
        injected =
          (await simulateTurn(hooks, sessionID, [
            {
              tool: "api-call",
              args: {
                endpoint: "/users",
                timestamp: Date.now(),
                requestId: `req-${i}`,
              },
              output: { title: "API", output: "users", metadata: {} },
            },
          ])) || injected
      }

      // Should detect as loop because volatile keys are ignored
      expect(injected).toBe(true)
    })
  })

  describe("different tools are tracked separately", () => {
    test("does not mix tool signatures", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        cooldownMs: 0,
      })

      const sessionID = "test-session-10"

      // Interleave different tools - should not trigger
      await simulateTurn(hooks, sessionID, [{ tool: "tool-a", args: { x: 1 }, output: { title: "", output: "", metadata: {} } }])
      await simulateTurn(hooks, sessionID, [{ tool: "tool-b", args: { x: 1 }, output: { title: "", output: "", metadata: {} } }])
      await simulateTurn(hooks, sessionID, [{ tool: "tool-a", args: { x: 1 }, output: { title: "", output: "", metadata: {} } }])
      await simulateTurn(hooks, sessionID, [{ tool: "tool-b", args: { x: 1 }, output: { title: "", output: "", metadata: {} } }])

      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })
  })

  describe("different args are tracked separately", () => {
    test("does not trigger for same tool with different args", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        cooldownMs: 0,
      })

      const sessionID = "test-session-11"

      // Same tool but different args each time
      await simulateTurn(hooks, sessionID, [{ tool: "read", args: { path: "/a.ts" }, output: { title: "", output: "", metadata: {} } }])
      await simulateTurn(hooks, sessionID, [{ tool: "read", args: { path: "/b.ts" }, output: { title: "", output: "", metadata: {} } }])
      await simulateTurn(hooks, sessionID, [{ tool: "read", args: { path: "/c.ts" }, output: { title: "", output: "", metadata: {} } }])

      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })
  })

  describe("virtual signature", () => {
    test("detects repeated multi-tool bursts across turns", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        cooldownMs: 0,
      })

      const sessionID = "test-session-12"
      const burst = [
        {
          tool: "bash",
          args: { command: "git ls-files | rg contacts" },
          output: { title: "bash", output: "contacts-a.scala", metadata: {} },
        },
        {
          tool: "bash",
          args: { command: "git ls-files | rg employees" },
          output: { title: "bash", output: "employees-a.scala", metadata: {} },
        },
        {
          tool: "bash",
          args: { command: "git ls-files | rg completion" },
          output: { title: "bash", output: "completion-a.scala", metadata: {} },
        },
      ] satisfies SimulatedToolCall[]

      const firstTurn = await simulateTurn(hooks, sessionID, burst)
      const secondTurn = await simulateTurn(hooks, sessionID, burst)

      expect(firstTurn).toBe(false)
      expect(secondTurn).toBe(true)
    })
  })
})
