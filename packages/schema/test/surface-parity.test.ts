import { describe, expect, test } from "bun:test"
import {
  AlibabaUsageRpc,
  computeBudgetBreakdown,
  formatCycleProgress,
  formatQuotaPercent,
} from "../src/alibaba-usage.js"
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
      "discountedModels",
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

    // After 6 unused days in a 30-day cycle, cushion grows and daily allowance increases
    const day7 = nov22 + 6 * 86_400_000
    const healthy = computeBudgetBreakdown(0, dec22, day7)
    expect(healthy.health).toBe("healthy")
    expect(healthy.cushionPercent).toBeCloseTo(20, 1)
    expect(healthy.adjustedDailyPercent).toBeGreaterThan(healthy.baseDailyPercent)
    expect(healthy.adjustedWeeklyPercent).toBeGreaterThan(healthy.baseWeeklyPercent)

    // Overspending beyond expected pace triggers caution
    const caution = computeBudgetBreakdown(45, dec22, day7)
    expect(caution.health).toBe("caution")
    expect(caution.cushionPercent).toBeLessThan(0)

    // Low remaining quota triggers critical (red)
    const critical = computeBudgetBreakdown(90, dec22, day7)
    expect(critical.health).toBe("critical")
  })

  test("stateless daily/weekly pace estimates derive only from monthly percentage and reset time", () => {
    const nov22 = new Date(2026, 10, 22, 11, 0, 0).getTime()
    const dec22 = new Date(2026, 11, 22, 11, 0, 0).getTime()
    const day7 = nov22 + 6 * 86_400_000
    const day8 = nov22 + 7 * 86_400_000
    const baseDaily = 100 / 30

    // Unused quota: zero estimate, no exhaustion projection, everything within budget
    const fresh = computeBudgetBreakdown(0, dec22, day7)
    expect(fresh.estimatedDailyPercent).toBe(0)
    expect(fresh.estimatedWeeklyPercent).toBe(0)
    expect(fresh.daysUntilCycleExhaustion).toBeUndefined()
    expect(fresh.dailyPace).toBe("within-budget")
    expect(fresh.weeklyPace).toBe("within-budget")

    // 10% after 6 days: average 1.67%/day under the 3.33% base, inside the pre-today schedule (≤ 20%)
    const ahead = computeBudgetBreakdown(10, dec22, day7)
    expect(ahead.estimatedDailyPercent).toBeCloseTo(10 / 6, 6)
    expect(ahead.estimatedWeeklyPercent).toBeCloseTo(70 / 6, 6)
    expect(ahead.daysUntilCycleExhaustion).toBeCloseTo(90 / (10 / 6), 6)
    expect(ahead.dailyPace).toBe("within-budget")
    // Week 1 is still in progress, so any spend falls inside the current window
    expect(ahead.weeklyPace).toBe("using-window")

    // 22% at day 7: beyond the 20% scheduled before today but inside today's allowance (≤ 23.33%)
    const today = computeBudgetBreakdown(22, dec22, day7)
    expect(today.dailyPace).toBe("using-window")
    expect(today.weeklyPace).toBe("using-window")

    // 25% at day 7: past everything scheduled through the end of today and of week 1
    const over = computeBudgetBreakdown(25, dec22, day7)
    expect(over.dailyPace).toBe("over-pace")
    expect(over.weeklyPace).toBe("over-pace")

    // Crossing into day 8 resets the daily window: 22% is again covered by prior days' schedule
    const rolled = computeBudgetBreakdown(22, dec22, day8)
    expect(rolled.dailyPace).toBe("within-budget")
    expect(rolled.weeklyPace).toBe("within-budget")

    // Early day 1: elapsed days floored at one hour so the average cannot explode; usage stays in today's window
    const early = computeBudgetBreakdown(0.1, dec22, nov22 + 30 * 60_000)
    expect(early.dailyPace).toBe("using-window")
    expect(early.estimatedDailyPercent).toBeCloseTo(0.1 / (1 / 24), 6)
    expect(baseDaily).toBeGreaterThan(0)
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
