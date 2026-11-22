import { describe, expect, test } from "bun:test"
import { AlibabaUsageRpc, formatCycleProgress, formatQuotaPercent } from "../src/alibaba-usage.js"
import { DynamicContextRpc } from "../src/dynamic-context.js"
import {
  cloneObjectivesForFreshSession,
  formatTreeSummary,
  normalizePrimaryObjectiveView,
  normalizeSessionObjectives,
} from "../src/objectives.js"
import { SHARED_SERVER_SETTINGS, SLASH_COMMAND_PARITY } from "../src/surface-parity.js"

describe("cross-surface shared contracts", () => {
  test("AlibabaUsageRpc exposes tokenPlan method and cycle helpers", () => {
    expect(AlibabaUsageRpc.id).toBe("alibaba.usage")
    expect(Object.keys(AlibabaUsageRpc.methods)).toEqual(["tokenPlan"])
    expect(formatQuotaPercent(0)).toBe("0%")
    expect(formatQuotaPercent(0.000025)).toBe("<0.01%")
    expect(formatQuotaPercent(42.5)).toBe("42.50%")
    const now = Date.UTC(2026, 10, 22, 14, 0, 0)
    const resetAt = now + 30 * 86_400_000
    const cycle = formatCycleProgress(resetAt, now)
    expect(cycle.elapsedDays).toBe(1)
    expect(cycle.remainingDays).toBe(30)
    expect(cycle.countdownLabel).toBe("30d 0h 0m")
  })

  test("DynamicContextRpc exposes canonical snapshot, setLimit, and refresh methods", () => {
    expect(DynamicContextRpc.id).toBe("llamacpp.context")
    expect(Object.keys(DynamicContextRpc.methods).sort()).toEqual(["getSnapshot", "refresh", "setLimit"])
  })

  test("ObjectivesView normalizes, repairs, summarizes, and clones fresh session state", () => {
    const raw = {
      title: "Unify TUI and Web",
      status: "resolved",
      definitionOfDone: "Parity passes",
      secondaries: [{ id: "SO-1", title: "Consolidate schemas", status: "exploring", rationale: "Single source" }],
    }
    const normalized = normalizePrimaryObjectiveView(raw)
    expect(normalized?.status).toBe("exploring")
    expect(normalizeSessionObjectives({ objectives: raw })?.secondaries).toHaveLength(1)
    expect(formatTreeSummary(normalized)).toContain("Unify TUI and Web")

    const cloned = cloneObjectivesForFreshSession({ objectives: raw }, "ses_origin")
    expect(cloned.status).toBe("exploring")
    expect(cloned.approvedByUser).toBe(true)
    expect(cloned.originSessionID).toBe("ses_origin")
  })

  test("surface parity manifest has unique IDs, no duplicate triggers per surface, and explicit exception reasons", () => {
    const ids = new Set<string>()
    const tuiNames = new Set<string>()
    const webNames = new Set<string>()

    for (const entry of SLASH_COMMAND_PARITY) {
      expect(ids.has(entry.id)).toBe(false)
      ids.add(entry.id)
      expect(entry.names.length).toBeGreaterThan(0)
      expect(entry.surfaces.length).toBeGreaterThan(0)
      if (entry.surfaces.length < 2) {
        expect(typeof entry.reason).toBe("string")
        expect(entry.reason!.trim().length).toBeGreaterThan(0)
      }
      for (const name of entry.names) {
        if (entry.surfaces.includes("tui")) {
          expect(tuiNames.has(name)).toBe(false)
          tuiNames.add(name)
        }
        if (entry.surfaces.includes("web")) {
          expect(webNames.has(name)).toBe(false)
          webNames.add(name)
        }
      }
    }

    const settingPaths = new Set<string>()
    for (const setting of SHARED_SERVER_SETTINGS) {
      expect(settingPaths.has(setting.path)).toBe(false)
      settingPaths.add(setting.path)
      expect(setting.surfaces).toContain("tui")
      expect(setting.surfaces).toContain("web")
    }
  })
})
