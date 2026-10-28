/** @jsxImportSource @opentui/solid */
import { expect, test, describe } from "bun:test"
import { createSignal } from "solid-js"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import {
  SidebarObjectives,
  normalizePrimaryObjectiveView,
  extractObjectivesFromMessages,
} from "../../src/feature-plugins/sidebar/objectives"

function makeMockContext(options?: {
  session?: any
  objectives?: any
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
        get: (sessionID?: string) => {
          if (options?.session) return options.session
          if (options?.objectives) {
            return {
              id: sessionID,
              location: { directory: "/workspace" },
              metadata: { objectives: options.objectives },
            }
          }
          return { id: sessionID, location: { directory: "/workspace" }, metadata: {} }
        },
        message: {
          list: () => [],
        },
      },
    },
  } as unknown as Context
}

describe("SidebarObjectives TUI component (Canonical session.metadata architecture)", () => {
  test("normalizePrimaryObjectiveView normalizes valid tree from session.metadata", () => {
    const raw = {
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
    }

    const po = normalizePrimaryObjectiveView(raw)
    expect(po).toBeDefined()
    expect(po?.title).toBe("Migrate Auth Layer")
    expect(po?.secondaries.length).toBe(2)
    expect(po?.secondaries[0].id).toBe("SO-1")
    expect(po?.secondaries[0].status).toBe("resolved")
    expect(po?.secondaries[1].id).toBe("SO-2")
    expect(po?.secondaries[1].blocker).toContain("CORS domain mismatch")
  })

  test("auto-repairs status if PO says resolved but SOs or TOs are open", () => {
    const corruptTree = {
      title: "Broken PO Status",
      status: "resolved",
      secondaries: [
        { id: "SO-1", title: "Still in progress", status: "exploring", rationale: "WIP" },
      ],
    }
    const repaired = normalizePrimaryObjectiveView(corruptTree)
    expect(repaired?.status).toBe("exploring")
  })

  test("auto-closes PO if all secondaries and tertiaries are closed", () => {
    const closedChildrenTree = {
      title: "All Tasks Finished",
      status: "exploring",
      secondaries: [
        {
          id: "SO-1",
          title: "Task 1",
          status: "resolved",
          rationale: "Done",
          children: [{ id: "SO-1-T1", title: "Subtask", status: "resolved", rationale: "Done" }],
        },
        { id: "SO-2", title: "Task 2", status: "discarded", rationale: "Not needed" },
      ],
    }
    const result = normalizePrimaryObjectiveView(closedChildrenTree)
    expect(result?.status).toBe("resolved")
  })

  test("renders nothing when no objectives exist in session.metadata", async () => {
    const ctx = makeMockContext()
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID="empty-ses" />, {
      width: 60,
      height: 20,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).not.toContain("Objectives")
      expect(frame).not.toContain("Definition of Done")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders Primary Objective and Secondary Objectives with badges and details", async () => {
    const sid = "render-test"
    const objectives = {
      title: "Core Platform Refactor",
      status: "exploring",
      definitionOfDone: "Zero test regressions across all packages",
      secondaries: [
        {
          id: "SO-1",
          title: "Migrate database schema",
          status: "resolved",
          rationale: "Upgrade SQLite tables",
          validationProof: "All drizzle migrations passed",
        },
        {
          id: "SO-2",
          title: "Update API routes",
          status: "exploring",
          rationale: "Expose v2 endpoints",
        },
        {
          id: "SO-3",
          title: "Deploy staging environment",
          status: "blocked",
          rationale: "Verify deployment pipeline",
          blocker: "Missing staging credentials",
        },
        {
          id: "SO-4",
          title: "Deprecated legacy endpoint",
          status: "discarded",
          rationale: "No longer needed",
        },
      ],
    }

    const ctx = makeMockContext({ objectives })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 70,
      height: 25,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Core Platform Refactor")
      expect(frame).toContain("DoD: Zero test regressions across all packages")
      expect(frame).toContain("(1/4)")
      expect(frame).toContain("[✓] SO-1: Migrate database schema")
      expect(frame).toContain("↳ Upgrade SQLite tables")
      expect(frame).toContain("Proof: All drizzle migrations passed")
      expect(frame).toContain("[•] SO-2: Update API routes")
      expect(frame).toContain("[!] SO-3: Deploy staging environment")
      expect(frame).toContain("Blocker: Missing staging credentials")
      expect(frame).toContain("[✕] SO-4: Deprecated legacy endpoint")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders resolved badge [PO ✓] when Primary Objective is resolved", async () => {
    const sid = "render-resolved-po"
    const objectives = {
      title: "Completed Project",
      status: "resolved",
      definitionOfDone: "Finished and verified",
      secondaries: [
        {
          id: "SO-1",
          title: "All done",
          status: "resolved",
          rationale: "Complete",
        },
      ],
    }

    const ctx = makeMockContext({ objectives })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 60,
      height: 15,
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
    const objectives = {
      title: "Platform Overhaul",
      status: "exploring",
      definitionOfDone: "Zero regressions",
      secondaries: [
        {
          id: "SO-1",
          title: "Refactor Session Core",
          status: "exploring",
          rationale: "Break into sub-steps",
          children: [
            {
              id: "SO-1-T1",
              title: "Migrate state machine",
              status: "resolved",
              rationale: "Step 1 of core refactor",
              validationProof: "State machine tests pass",
            },
            {
              id: "SO-1-T2",
              title: "Update inbox queue",
              status: "exploring",
              rationale: "Step 2 of core refactor",
            },
          ],
        },
      ],
    }

    const ctx = makeMockContext({ objectives })
    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 70,
      height: 20,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("[•] SO-1: Refactor Session Core")
      expect(frame).toContain("[✓] SO-1-T1: Migrate state machine")
      expect(frame).toContain("[•] SO-1-T2: Update inbox queue")
      expect(frame).toContain("Proof: State machine tests pass")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders delegation indicator compactly beside SO, TO, and finding nomenclature", async () => {
    const sid = "delegation-sidebar-render"
    const objectives = {
      title: "Distributed Pipeline",
      status: "exploring",
      definitionOfDone: "Completed with optimal context management",
      secondaries: [
        {
          id: "SO-1",
          title: "Build worker queue",
          status: "exploring",
          rationale: "Heavy task",
          delegation: { mode: "subagent", justification: "Delegate worker to subagent" },
          children: [
            {
              id: "SO-1-T1",
              title: "Redis adapter",
              status: "resolved",
              rationale: "Connect cache",
              delegation: { mode: "main", justification: "Quick connection setup" },
            },
          ],
        },
      ],
      findings: [
        {
          id: "F-001",
          soRef: "SO-1",
          title: "Redis latency check",
          lifecycle: "NEW",
          result: "Latency is 0.5ms",
          delegation: { mode: "main", justification: "Quick ping command" },
        },
      ],
    }

    const ctx = makeMockContext({ objectives })
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
    const objectives = {
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
    }

    const ctx = makeMockContext({ objectives })
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

  test("displays active objective in header when collapsed (view.open=false)", async () => {
    const sid = "collapsed-header-active-badge"
    const objectives = {
      title: "Large Task Session",
      status: "exploring",
      definitionOfDone: "Verify feedback",
      secondaries: [
        {
          id: "SO-1",
          title: "Diagnose bug",
          status: "resolved",
          rationale: "Understand cause",
        },
        {
          id: "SO-2",
          title: "Implement resilience fix",
          status: "exploring",
          rationale: "Fix root cause",
        },
      ],
    }

    const ctx = makeMockContext({ objectives })
    const [, setView] = ctx.storage.store("view", { initial: { open: false } })
    await setView((d) => {
      d.open = false
    })

    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 80,
      height: 20,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("▶")
      expect(frame).toContain("Objectives")
      expect(frame).toContain("(1/2)")
      expect(frame).toContain("[•]")
      expect(frame).toContain("SO-2: Implement resilience fix")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders tree reactively from canonical session.metadata.objectives directly", async () => {
    const sid = "session-metadata-canonical-test"
    const metadataTree = {
      title: "Canonical Metadata Architecture",
      status: "exploring",
      definitionOfDone: "Zero failure reactivity",
      secondaries: [
        {
          id: "SO-1",
          title: "Persistent session state",
          status: "exploring",
          rationale: "Eliminate ephemeral state",
        },
      ],
    }

    const ctx = makeMockContext({
      session: {
        id: sid,
        location: { directory: "/workspace" },
        metadata: {
          objectives: metadataTree,
        },
      },
    })

    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID={sid} />, {
      width: 80,
      height: 25,
    })

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Canonical Metadata Architecture")
      expect(frame).toContain("DoD: Zero failure reactivity")
      expect(frame).toContain("[•] SO-1: Persistent session state")
    } finally {
      app.renderer.destroy()
    }
  })

  test("extractObjectivesFromMessages backward compatibility wrapper extracts metadata objectives", () => {
    const sid = "compat-test"
    const tree = { title: "Test", status: "exploring", secondaries: [] }
    const po = extractObjectivesFromMessages(sid, [], tree)
    expect(po?.title).toBe("Test")
    expect(extractObjectivesFromMessages(sid, [])).toBeUndefined()
  })

  test("reacts immediately when session metadata updates in real time", async () => {
    const [sess, setSess] = createSignal({
      id: "live-session",
      location: { directory: "/workspace" },
      metadata: {
        objectives: {
          title: "Live Session Tree",
          status: "exploring",
          definitionOfDone: "Verify live updates",
          secondaries: [{ id: "SO-1", title: "Task 1", status: "pending", rationale: "R1" }],
        },
      },
    })

    const ctx = {
      ...makeMockContext(),
      data: {
        session: {
          get: () => sess(),
        },
      },
    } as unknown as Context

    const app = await testRender(() => <SidebarObjectives context={ctx} sessionID="live-session" />, {
      width: 80,
      height: 20,
    })

    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("[ ] SO-1: Task 1")

      // Simulate live update of SO-1 to exploring
      setSess({
        id: "live-session",
        location: { directory: "/workspace" },
        metadata: {
          objectives: {
            title: "Live Session Tree",
            status: "exploring",
            definitionOfDone: "Verify live updates",
            secondaries: [{ id: "SO-1", title: "Task 1", status: "exploring", rationale: "R1" }],
          },
        },
      })

      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("[•] SO-1: Task 1")
    } finally {
      app.renderer.destroy()
    }
  })
})
