/** @jsxImportSource @opentui/solid */
import { expect, test, describe, beforeEach } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import {
  SidebarObjectives,
  extractObjectivesFromMessages,
} from "../../src/feature-plugins/sidebar/objectives"

function makeMockContext(options?: {
  messages?: any[]
  open?: boolean
}) {
  const color = RGBA.fromInts(200, 200, 200)
  const storeData = { open: options?.open ?? true }

  return {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: {
          success: { base: color },
          warning: { base: color },
          error: { base: color },
        },
      },
    },
    storage: {
      store: () => [storeData, async (fn: (d: any) => void) => fn(storeData)],
    },
    data: {
      session: {
        get: () => ({ location: { directory: "/workspace" } }),
        message: {
          list: () => options?.messages ?? [],
        },
      },
    },
  } as unknown as Context
}

describe("SidebarObjectives TUI component", () => {
  beforeEach(() => {
    if (globalThis.__OPENCODE_OBJECTIVES__) {
      globalThis.__OPENCODE_OBJECTIVES__.clear()
    }
  })

  test("extracts objectives from global in-memory state", () => {
    const sid = "test-session-mem"
    globalThis.__OPENCODE_OBJECTIVES__ = new Map()
    globalThis.__OPENCODE_OBJECTIVES__.set(sid, {
      title: "Migrate Auth Layer",
      status: "exploring",
      definitionOfDone: "Zero auth regressions",
      secondaries: [
        {
          id: "SO-1",
          title: "Update JWT verification",
          status: "resolved",
          rationale: "Required for v2 keys",
          validationProof: "All 15 JWT tests passed",
        },
        {
          id: "SO-2",
          title: "Verify session cookies",
          status: "blocked",
          rationale: "Ensure domain scoping",
          blocker: "CORS domain mismatch in dev environment",
        },
      ],
    })

    const po = extractObjectivesFromMessages(sid, [])
    expect(po).toBeDefined()
    expect(po?.title).toBe("Migrate Auth Layer")
    expect(po?.secondaries.length).toBe(2)
    expect(po?.secondaries[0].id).toBe("SO-1")
    expect(po?.secondaries[0].status).toBe("resolved")
    expect(po?.secondaries[1].id).toBe("SO-2")
    expect(po?.secondaries[1].blocker).toContain("CORS domain mismatch")
  })

  test("reconstructs objectives from session message tool calls", () => {
    const sid = "test-session-msg"
    const messages = [
      {
        id: "m1",
        type: "assistant",
        content: [
          {
            type: "tool",
            tool: "objective_manage",
            input: {
              action: "set_primary",
              title: "Backend API Optimization",
              definitionOfDone: "p95 latency < 50ms",
            },
          },
        ],
      },
      {
        id: "m2",
        type: "assistant",
        content: [
          {
            type: "tool",
            tool: "objective_manage",
            input: {
              action: "add_secondary",
              title: "Index query keys",
              rationale: "Accelerate user lookup",
            },
          },
        ],
      },
      {
        id: "m3",
        type: "assistant",
        content: [
          {
            type: "tool",
            tool: "objective_manage",
            input: {
              action: "update_secondary",
              id: "SO-1",
              status: "resolved",
              validationProof: "Explain analyze shows index scan used",
            },
          },
        ],
      },
    ]

    const po = extractObjectivesFromMessages(sid, messages)
    expect(po).toBeDefined()
    expect(po?.title).toBe("Backend API Optimization")
    expect(po?.definitionOfDone).toBe("p95 latency < 50ms")
    expect(po?.secondaries.length).toBe(1)
    expect(po?.secondaries[0].id).toBe("SO-1")
    expect(po?.secondaries[0].status).toBe("resolved")
    expect(po?.secondaries[0].validationProof).toContain("Explain analyze shows index scan used")
  })

  test("renders nothing when no objectives exist", async () => {
    const ctx = makeMockContext({ messages: [] })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID="empty-ses" />, {
      width: 42,
      height: 12,
    })

    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("Objectives")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders Primary Objective and Secondary Objectives with badges and details", async () => {
    const sid = "render-test"
    globalThis.__OPENCODE_OBJECTIVES__ = new Map()
    globalThis.__OPENCODE_OBJECTIVES__.set(sid, {
      title: "Core Platform Refactor",
      status: "exploring",
      definitionOfDone: "Pass all regression suites",
      secondaries: [
        {
          id: "SO-1",
          title: "Refactor router handlers",
          status: "resolved",
          rationale: "Clean architecture separation",
          validationProof: "bun test router.test.ts passed",
        },
        {
          id: "SO-2",
          title: "Fix broken middleware",
          status: "blocked",
          rationale: "Unblock auth pipeline",
          blocker: "Missing upstream secret",
        },
      ],
    })

    const ctx = makeMockContext({ messages: [] })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 44,
      height: 18,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Objectives")
      expect(frame).toContain("Core Platform Refactor")
      expect(frame).toContain("[PO]")
      expect(frame).toContain("SO-1:")
      expect(frame).toContain("Refactor router handlers")
      expect(frame).toContain("[✓]")
      expect(frame).toContain("SO-2:")
      expect(frame).toContain("[!]")
      expect(frame).toContain("Blocker: Missing upstream secret")
      expect(frame).toContain("Proof: bun test router.test.ts passed")
    } finally {
      app.renderer.destroy()
    }
  })
})
