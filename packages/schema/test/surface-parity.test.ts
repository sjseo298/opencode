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
  test("AlibabaUsageRpc exposes tokenPlan and login methods with cycle helpers", () => {
    expect(AlibabaUsageRpc.id).toBe("alibaba.usage")
    expect(Object.keys(AlibabaUsageRpc.methods).sort()).toEqual([
      "cancelLogin",
      "completeLogin",
      "loginStatus",
      "logout",
      "startLogin",
      "tokenPlan",
    ])
    expect(formatQuotaPercent(0)).toBe("0%")
    expect(formatQuotaPercent(0.000025)).toBe("<0.01%")
    expect(formatQuotaPercent(42.5)).toBe("42.50%")
    const nov22 = new Date(2026, 10, 22, 11, 0, 0).getTime()
    const dec22 = new Date(2026, 11, 22, 11, 0, 0).getTime()
    const jan22 = new Date(2027, 0, 22, 11, 0, 0).getTime()
    const mar22 = new Date(2027, 2, 22, 11, 0, 0).getTime()

    const cycle30 = formatCycleProgress(dec22, nov22)
    expect(cycle30.cycleDays).toBe(30)
    expect(cycle30.elapsedDays).toBe(1)
    expect(cycle30.remainingDays).toBe(30)
    expect(cycle30.countdownLabel).toBe("30d 0h 0m")

    const cycle31 = formatCycleProgress(jan22, dec22)
    expect(cycle31.cycleDays).toBe(31)

    const cycle28 = formatCycleProgress(mar22, new Date(2027, 1, 22, 11, 0, 0).getTime())
    expect(cycle28.cycleDays).toBe(28)
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
