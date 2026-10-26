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

  test("extracts objectives from part.state.input with initial secondaries array", () => {
    const sid = "test-session-state-input"
    const messages = [
      {
        id: "m1",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call_1",
            name: "objective_manage",
            state: {
              status: "completed",
              input: {
                action: "set_primary",
                title: "Full App Redesign",
                definitionOfDone: "Zero CSS regressions and high lighthouse score",
                secondaries: [
                  {
                    title: "Audit color tokens",
                    rationale: "Required for theme alignment",
                  },
                  {
                    title: "Implement responsive grid",
                    rationale: "Support mobile devices",
                    status: "exploring",
                  },
                ],
              },
            },
          },
        ],
      },
    ]

    const po = extractObjectivesFromMessages(sid, messages)
    expect(po).toBeDefined()
    expect(po?.title).toBe("Full App Redesign")
    expect(po?.definitionOfDone).toBe("Zero CSS regressions and high lighthouse score")
    expect(po?.secondaries.length).toBe(2)
    expect(po?.secondaries[0].id).toBe("SO-1")
    expect(po?.secondaries[0].title).toBe("Audit color tokens")
    expect(po?.secondaries[0].status).toBe("pending")
    expect(po?.secondaries[1].id).toBe("SO-2")
    expect(po?.secondaries[1].status).toBe("exploring")
  })

  test("extracts objectives from compaction checkpoint summary as fallback", () => {
    const sid = "test-session-compaction-fallback"
    const messages = [
      {
        id: "c1",
        type: "compaction",
        summary: [
          "## Protocolo de Objetivos - Resumen de Objetivos (Insumo de Compactación)",
          "[PO] Core Engine Modernization [EXPLORING]",
          "Definition of Done: Zero compilation warnings and all unit tests pass",
          "",
          "### Completed Objectives",
          "- [SO-1] [RESOLVED] Update build script (Validation Proof: bash build.sh exit 0)",
          "",
          "### Active / Exploring Objectives",
          "- [SO-2] [EXPLORING] Refactor session runner (Rationale: Improve concurrency)",
        ].join("\n"),
      },
    ]

    const po = extractObjectivesFromMessages(sid, messages)
    expect(po).toBeDefined()
    expect(po?.title).toBe("Core Engine Modernization")
    expect(po?.definitionOfDone).toBe("Zero compilation warnings and all unit tests pass")
    expect(po?.secondaries.length).toBe(2)
    expect(po?.secondaries[0].id).toBe("SO-1")
    expect(po?.secondaries[0].status).toBe("resolved")
    expect(po?.secondaries[0].validationProof).toBe("bash build.sh exit 0")
    expect(po?.secondaries[1].id).toBe("SO-2")
    expect(po?.secondaries[1].status).toBe("exploring")
    expect(po?.secondaries[1].rationale).toBe("Improve concurrency")
  })

  test("renders resolved badge [PO ✓] when Primary Objective is resolved", async () => {
    const sid = "render-resolved-po"
    globalThis.__OPENCODE_OBJECTIVES__ = new Map()
    globalThis.__OPENCODE_OBJECTIVES__.set(sid, {
      title: "Completed Project",
      status: "resolved",
      definitionOfDone: "All done",
      secondaries: [],
    })

    const ctx = makeMockContext({ messages: [] })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 44,
      height: 10,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("[PO ✓]")
      expect(frame).toContain("Completed Project")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders tertiary sub-objectives nested under their parent secondary", async () => {
    const sid = "render-nested-to"
    globalThis.__OPENCODE_OBJECTIVES__ = new Map()
    globalThis.__OPENCODE_OBJECTIVES__.set(sid, {
      title: "Platform Overhaul",
      status: "exploring",
      definitionOfDone: "Zero regressions",
      secondaries: [
        {
          id: "SO-1",
          title: "Oversized task",
          status: "exploring",
          rationale: "Needs decomposition",
          children: [
            {
              id: "SO-1-T1",
              title: "Patch step A",
              status: "resolved",
              rationale: "Isolate first step",
              validationProof: "exit 0 on stepA test",
            },
            {
              id: "SO-1-T2",
              title: "Patch step B",
              status: "pending",
              rationale: "Isolate second step",
            },
          ],
        },
      ],
    })

    const ctx = makeMockContext({ messages: [] })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 46,
      height: 30,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Oversized task")
      expect(frame).toContain("SO-1-T1:")
      expect(frame).toContain("Patch step A")
      expect(frame).toContain("[✓]")
      expect(frame).toContain("Proof: exit 0 on stepA test")
      expect(frame).toContain("SO-1-T2:")
      expect(frame).toContain("Isolate second step")
    } finally {
      app.renderer.destroy()
    }
  })

  test("reconstructs tertiary objectives from add_tertiary/update_tertiary tool calls", () => {
    const sid = "test-session-to-replay"
    const messages = [
      {
        id: "m1",
        type: "assistant",
        content: [
          {
            type: "tool",
            tool: "objective_manage",
            input: { action: "set_primary", title: "Nested Task", definitionOfDone: "All levels closed" },
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
            input: { action: "add_secondary", title: "Oversized task", rationale: "Needs decomposition" },
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
            input: { action: "add_tertiary", id: "SO-1", title: "Patch step A", rationale: "Isolate first step" },
          },
        ],
      },
      {
        id: "m4",
        type: "assistant",
        content: [
          {
            type: "tool",
            tool: "objective_manage",
            input: { action: "update_tertiary", id: "SO-1-T1", status: "resolved", validationProof: "step A exit 0" },
          },
        ],
      },
    ]

    const po = extractObjectivesFromMessages(sid, messages)
    expect(po).toBeDefined()
    expect(po?.secondaries.length).toBe(1)
    expect(po?.secondaries[0].children?.length).toBe(1)
    expect(po?.secondaries[0].children?.[0]?.id).toBe("SO-1-T1")
    expect(po?.secondaries[0].children?.[0]?.status).toBe("resolved")
    expect(po?.secondaries[0].children?.[0]?.validationProof).toContain("step A exit 0")
  })

  test("attaches tertiary lines to their parent when reconstructing from compaction checkpoint", () => {
    const sid = "test-session-to-checkpoint"
    const messages = [
      {
        id: "c1",
        type: "compaction",
        summary: [
          "[PO] Checkpoint Nest Task [EXPLORING]",
          "Definition of Done: All levels recovered",
          "",
          "### Active / Exploring Objectives",
          "- [SO-2] [EXPLORING] Oversized work (Rationale: Needs decomposition)",
          "  - [SO-2-T1] [PENDING] Patch step A",
        ].join("\n"),
      },
    ]

    const po = extractObjectivesFromMessages(sid, messages)
    expect(po).toBeDefined()
    expect(po?.secondaries.length).toBe(1)
    expect(po?.secondaries[0].id).toBe("SO-2")
    expect(po?.secondaries[0].children?.length).toBe(1)
    expect(po?.secondaries[0].children?.[0]?.id).toBe("SO-2-T1")
    expect(po?.secondaries[0].children?.[0]?.status).toBe("pending")
  })

  test("hydrates findings, options, and dod fallback from memory and messages", () => {
    const sid = "test-session-epistemic"
    const memoryTree = {
      title: "Epistemic Task",
      status: "presented_awaiting_confirmation",
      definitionOfDone: "Verify DoD",
      dod: [{ id: "D1", statement: "Criteria 1", proofRef: "proof" }],
      findings: [
        { id: "F-001", title: "Cookie bug", lifecycle: "NEW", result: "observed", evidence: { source: "src/auth.ts" } },
      ],
      options: [
        { id: "OPT-1", statement: "Strategy A", status: "DISCARDED", result: "failed", reason: "slow" },
        { id: "OPT-2", statement: "Strategy B", status: "SUCCESSFUL", result: "ok" },
      ],
      secondaries: [],
    }
    ;(globalThis as any).__OPENCODE_OBJECTIVES__ = new Map([[sid, memoryTree]])

    const po = extractObjectivesFromMessages(sid, [])
    expect(po).toBeDefined()
    expect(po?.status).toBe("presented_awaiting_confirmation")
    expect(po?.dodCriteria?.length).toBe(1)
    expect(po?.dodCriteria?.[0]?.statement).toBe("Criteria 1")
    expect(po?.findings?.length).toBe(1)
    expect(po?.options?.length).toBe(2)
    // DISCARDED sibling was preserved when OPT-2 became SUCCESSFUL
    expect(po?.options?.find((o) => o.id === "OPT-1")?.status).toBe("DISCARDED")
  })

  test("parses compaction checkpoint with Markdown summary format (no leading dash, bolded SOs)", () => {
    const sid = "test-session-checkpoint-markdown"
    const messages = [
      {
        type: "user",
        content: [
          "<conversation-checkpoint>",
          "<summary>",
          "## Objective",
          "Improve OpenCode's Protocolo de Objetivos",
          "",
          "## Work State",
          "### Completed",
          "- **SO-1 [RESOLVED]** Recon current objective_manage implementation",
          "- **SO-2 [RESOLVED]** Design data model and API surface",
          "### Active",
          "- **SO-3 [EXPLORING]** Implement cross-session persistence",
          "</summary>",
          "</conversation-checkpoint>",
        ].join("\n"),
      },
    ]

    const po = extractObjectivesFromMessages(sid, messages)
    expect(po).toBeDefined()
    expect(po?.title).toBe("Improve OpenCode's Protocolo de Objetivos")
    expect(po?.secondaries.length).toBe(3)
    expect(po?.secondaries[0].id).toBe("SO-1")
    expect(po?.secondaries[0].status).toBe("resolved")
    expect(po?.secondaries[1].id).toBe("SO-2")
    expect(po?.secondaries[1].status).toBe("resolved")
    expect(po?.secondaries[2].id).toBe("SO-3")
    expect(po?.secondaries[2].status).toBe("exploring")
  })

  test("auto-repairs memory status if PO says resolved but SOs are open", () => {
    const sid = "test-corrupt-mem"
    globalThis.__OPENCODE_OBJECTIVES__ = new Map([[
      sid,
      {
        title: "Corrupt Task",
        status: "resolved",
        definitionOfDone: "DoD",
        secondaries: [
          { id: "SO-1", title: "Open subtask", status: "pending", rationale: "r" },
        ],
      },
    ]])

    const po = extractObjectivesFromMessages(sid, [])
    expect(po).toBeDefined()
    // Auto-repaired to exploring because SO-1 is pending
    expect(po?.status).toBe("exploring")
  })

  test("message reconstruction complete_primary rejects resolved if an SO is still pending", () => {
    const sid = "test-msg-complete-gate"
    const messages = [
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "objective_manage",
            input: {
              action: "set_primary",
              title: "Task",
              definitionOfDone: "DoD",
              secondaries: [{ id: "SO-1", title: "Task 1", status: "pending", rationale: "r" }],
            },
          },
          {
            type: "tool",
            name: "objective_manage",
            input: {
              action: "complete_primary",
              validationProof: "premature attempt",
            },
          },
        ],
      },
    ]

    const po = extractObjectivesFromMessages(sid, messages)
    expect(po).toBeDefined()
    // Cannot be resolved because SO-1 is pending
    expect(po?.status).toBe("exploring")
  })

  test("renders delegation indicator compactly beside SO, TO, and finding nomenclature", async () => {
    const sid = "delegation-sidebar-render"
    globalThis.__OPENCODE_OBJECTIVES__ = new Map()
    globalThis.__OPENCODE_OBJECTIVES__.set(sid, {
      title: "Distributed Pipeline",
      status: "exploring",
      definitionOfDone: "High throughput",
      secondaries: [
        {
          id: "SO-1",
          title: "Build worker queue",
          status: "exploring",
          rationale: "Queue tasks",
          delegation: { mode: "subagent", justification: "Isolated worker setup" },
          children: [
            {
              id: "SO-1-T1",
              title: "Redis adapter",
              status: "pending",
              rationale: "Transport layer",
              delegation: { mode: "main", justification: "Small config" },
            },
          ],
        },
      ],
      findings: [
        {
          id: "F-001",
          title: "Redis latency check",
          lifecycle: "NEW",
          result: "Latency is 0.5ms",
          delegation: { mode: "main", justification: "Quick ping command" },
        },
      ],
    })

    const ctx = makeMockContext({ messages: [] })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 60,
      height: 25,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("SO-1 [subagent]: Build worker queue")
      expect(frame).toContain("SO-1-T1 [main]: Redis adapter")
      expect(frame).toContain("F-001 [main]: Redis latency check")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders blast radius scope and fingerprints in sidebar", async () => {
    const sid = "blast-radius-fingerprints-sidebar"
    globalThis.__OPENCODE_OBJECTIVES__ = new Map()
    globalThis.__OPENCODE_OBJECTIVES__.set(sid, {
      title: "Cluster Migration",
      status: "exploring",
      definitionOfDone: "Zero downtime",
      secondaries: [
        {
          id: "SO-1",
          title: "Migrate database",
          status: "exploring",
          rationale: "Upgrade engine",
          affectedResources: { files: ["packages/core/db.ts", "packages/core/schema.ts"] },
        },
      ],
      fingerprints: [
        {
          key: "pg-timeout",
          symptom: "Postgres timeout on connection pool",
          fixRef: "max_connections=100",
        },
      ],
    })

    const ctx = makeMockContext({ messages: [] })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 80,
      height: 25,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Scope: packages/core/db.ts, packages/core/schema.ts")
      expect(frame).toContain("Fingerprints (1)")
      expect(frame).toContain("pg-timeout: Postgres timeout on connection pool")
      expect(frame).toContain("(fix: max_connections=100)")
    } finally {
      app.renderer.destroy()
    }
  })
})
