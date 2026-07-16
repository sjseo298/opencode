import { describe, test, expect, beforeEach } from "bun:test"
import plugin from "../loop-guard.ts"

// Helper to create mock hooks with specific options
async function createHooks(options: Record<string, unknown> = {}) {
  const mockClient = {}
  return plugin({ client: mockClient } as any, options)
}

// Helper to simulate a tool call
async function simulateToolCall(
  hooks: Awaited<ReturnType<typeof createHooks>>,
  sessionID: string,
  tool: string,
  args: Record<string, unknown>,
  output: { title: string; output: string; metadata: Record<string, unknown> },
  callID?: string,
) {
  const id = callID ?? `call-${Date.now()}-${Math.random()}`
  await hooks["tool.execute.before"]({ sessionID, tool, callID: id }, { args })
  await hooks["tool.execute.after"]({ sessionID, tool, callID: id, args }, output)
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
      })

      const sessionID = "test-session-1"
      const args = { operation: "items_get", project: "MyProject", path: "/app.js" }

      // Simulate 3 calls with same args but different results
      for (let i = 0; i < 3; i++) {
        await simulateToolCall(hooks, sessionID, "azure-devops", args, {
          title: "Result",
          output: `Content version ${i}`,
          metadata: { objectId: `obj-${Math.random()}` }, // Different each time
        })
      }

      // After 2+ calls (threshold-1), guard should be injected
      expect(await checkGuardInjected(hooks, sessionID)).toBe(true)
    })

    test("does NOT detect loop with ignoreResults: false when results differ", async () => {
      const hooks = await createHooks({
        ignoreResults: false,
        requireNoProgress: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
      })

      const sessionID = "test-session-2"
      const args = { operation: "items_get", project: "MyProject", path: "/app.js" }

      for (let i = 0; i < 3; i++) {
        await simulateToolCall(hooks, sessionID, "azure-devops", args, {
          title: "Result",
          output: `Content version ${i}`,
          metadata: { objectId: `obj-${Math.random()}` },
        })
      }

      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })

    test("detects loop with ignoreResults: false when results are identical", async () => {
      const hooks = await createHooks({
        ignoreResults: false,
        requireNoProgress: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
      })

      const sessionID = "test-session-3"
      const args = { operation: "items_get", project: "MyProject", path: "/app.js" }
      const identicalOutput = {
        title: "Result",
        output: "Same content always",
        metadata: { objectId: "same-id" },
      }

      for (let i = 0; i < 3; i++) {
        await simulateToolCall(hooks, sessionID, "azure-devops", args, identicalOutput)
      }

      expect(await checkGuardInjected(hooks, sessionID)).toBe(true)
    })
  })

  describe("ignoreTools option", () => {
    test("does not track calls to ignored tools", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        ignoreTools: ["todowrite", "read"],
      })

      const sessionID = "test-session-4"
      const args = { filePath: "/some/file.ts" }

      // Simulate many calls to ignored tool
      for (let i = 0; i < 10; i++) {
        await simulateToolCall(hooks, sessionID, "read", args, {
          title: "Read",
          output: "file content",
          metadata: {},
        })
      }

      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })

    test("tracks calls to non-ignored tools", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
        ignoreTools: ["todowrite"],
      })

      const sessionID = "test-session-5"

      for (let i = 0; i < 3; i++) {
        await simulateToolCall(
          hooks,
          sessionID,
          "bash",
          { command: "ls" },
          { title: "Bash", output: "files", metadata: {} },
        )
      }

      expect(await checkGuardInjected(hooks, sessionID)).toBe(true)
    })
  })

  describe("chat.message hook (state reset)", () => {
    test("resets state when new user message arrives", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
      })

      const sessionID = "test-session-6"

      // Build up almost to threshold
      for (let i = 0; i < 2; i++) {
        await simulateToolCall(
          hooks,
          sessionID,
          "grep",
          { pattern: "foo" },
          { title: "Grep", output: "matches", metadata: {} },
        )
      }

      // Simulate new user message (resets state)
      await hooks["chat.message"]({ sessionID }, { message: {} as any, parts: [] })

      // Now make more calls - should not trigger because counter reset
      await simulateToolCall(
        hooks,
        sessionID,
        "grep",
        { pattern: "foo" },
        { title: "Grep", output: "matches", metadata: {} },
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
      })

      const sessionID = "test-session-7"

      // Make 2 calls
      for (let i = 0; i < 2; i++) {
        await simulateToolCall(
          hooks,
          sessionID,
          "glob",
          { pattern: "*.ts" },
          { title: "Glob", output: "files", metadata: {} },
        )
      }

      // Wait for window to expire
      await Bun.sleep(150)

      // Make 2 more calls - the previous 2 should have expired
      // So we only have 2 within window, threshold is 3, no guard
      for (let i = 0; i < 2; i++) {
        await simulateToolCall(
          hooks,
          sessionID,
          "glob",
          { pattern: "*.ts" },
          { title: "Glob", output: "files", metadata: {} },
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
      for (let i = 0; i < 3; i++) {
        await simulateToolCall(
          hooks,
          sessionID,
          "webfetch",
          { url: "https://example.com" },
          { title: "Fetch", output: "content", metadata: {} },
        )
      }

      const firstGuard = await checkGuardInjected(hooks, sessionID)
      expect(firstGuard).toBe(true)

      // Try to trigger again immediately - should be in cooldown
      for (let i = 0; i < 3; i++) {
        await simulateToolCall(
          hooks,
          sessionID,
          "webfetch",
          { url: "https://example.com" },
          { title: "Fetch", output: "content", metadata: {} },
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
      })

      const sessionID = "test-session-9"

      // Same logical args but with different volatile keys
      for (let i = 0; i < 3; i++) {
        await simulateToolCall(
          hooks,
          sessionID,
          "api-call",
          {
            endpoint: "/users",
            timestamp: Date.now(), // Different each time but should be ignored
            requestId: `req-${i}`,
          },
          { title: "API", output: "users", metadata: {} },
        )
      }

      // Should detect as loop because volatile keys are ignored
      expect(await checkGuardInjected(hooks, sessionID)).toBe(true)
    })
  })

  describe("different tools are tracked separately", () => {
    test("does not mix tool signatures", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
      })

      const sessionID = "test-session-10"

      // Interleave different tools - should not trigger
      await simulateToolCall(hooks, sessionID, "tool-a", { x: 1 }, { title: "", output: "", metadata: {} })
      await simulateToolCall(hooks, sessionID, "tool-b", { x: 1 }, { title: "", output: "", metadata: {} })
      await simulateToolCall(hooks, sessionID, "tool-a", { x: 1 }, { title: "", output: "", metadata: {} })
      await simulateToolCall(hooks, sessionID, "tool-b", { x: 1 }, { title: "", output: "", metadata: {} })

      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })
  })

  describe("different args are tracked separately", () => {
    test("does not trigger for same tool with different args", async () => {
      const hooks = await createHooks({
        ignoreResults: true,
        doom_loop_threshold: 3,
        warning_before_doom_loop: 1,
      })

      const sessionID = "test-session-11"

      // Same tool but different args each time
      await simulateToolCall(hooks, sessionID, "read", { path: "/a.ts" }, { title: "", output: "", metadata: {} })
      await simulateToolCall(hooks, sessionID, "read", { path: "/b.ts" }, { title: "", output: "", metadata: {} })
      await simulateToolCall(hooks, sessionID, "read", { path: "/c.ts" }, { title: "", output: "", metadata: {} })

      expect(await checkGuardInjected(hooks, sessionID)).toBe(false)
    })
  })
})
