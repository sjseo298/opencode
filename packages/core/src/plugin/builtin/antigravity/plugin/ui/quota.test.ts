import { describe, expect, test } from "bun:test"
import {
  renderQuotaProgressBar,
  formatQuotaCountdown,
  wrapCalloutText,
  formatAccountQuotaReport,
  getQuotaColorCode,
} from "./quota.ts"

describe("Antigravity Quota UI Formatter", () => {
  test("renders 50-width progress bar accurately", () => {
    const bar = renderQuotaProgressBar(0.391, 50, false)
    expect(bar).toBe("[████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 39.10%")

    const full = renderQuotaProgressBar(1.0, 50, false)
    expect(full).toBe("[██████████████████████████████████████████████████] 100.00%")

    const empty = renderQuotaProgressBar(0, 50, false)
    expect(empty).toBe("[░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0.00%")
  })

  test("computes dynamic colors by threshold: green > 50%, yellow 20-50%, red <= 20%", () => {
    expect(getQuotaColorCode(0.8)).toBe("\x1b[32m") // green
    expect(getQuotaColorCode(0.35)).toBe("\x1b[33m") // yellow
    expect(getQuotaColorCode(0.15)).toBe("\x1b[31m") // red
    expect(getQuotaColorCode(0.0)).toBe("\x1b[31m") // red
  })

  test("formats countdown times", () => {
    const now = 1700000000000
    // 94 hours and 37 minutes
    const reset94h = new Date(now + (94 * 60 + 37) * 60_000).toISOString()
    expect(formatQuotaCountdown(reset94h, 0.5, now)).toBe("Refreshes in 94h 37m")

    // Full quota
    expect(formatQuotaCountdown(reset94h, 1.0, now)).toBe("Quota available")

    // No reset time
    expect(formatQuotaCountdown(undefined, 0.5, now)).toBe("Quota available")
  })

  test("wraps callout text with vertical bar", () => {
    const input = "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens."
    const wrapped = wrapCalloutText(input, 50)
    for (const line of wrapped.split("\n")) {
      expect(line.startsWith("  │")).toBe(true)
    }
  })

  test("formats full graphical quota report matching user specification", () => {
    const now = 1700000000000
    const report = formatAccountQuotaReport(
      "jsecheverri@gmail.com",
      {
        index: 0,
        email: "jsecheverri@gmail.com",
        status: "ok",
        quotaSummary: {
          groups: [
            {
              displayName: "Gemini Models",
              description: "Models within this group: Gemini Flash, Gemini Pro",
              buckets: [
                {
                  displayName: "Weekly Limit Remaining",
                  remainingFraction: 0.391,
                  resetTime: new Date(now + (94 * 60 + 37) * 60_000).toISOString(),
                },
                {
                  displayName: "Five Hour Limit Remaining",
                  remainingFraction: 0.8317,
                  resetTime: new Date(now + (3 * 60 + 17) * 60_000).toISOString(),
                },
              ],
            },
            {
              displayName: "Claude and GPT models",
              description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
              buckets: [
                {
                  displayName: "Weekly Limit Remaining",
                  remainingFraction: 1,
                },
                {
                  displayName: "Five Hour Limit Remaining",
                  remainingFraction: 1,
                },
              ],
            },
            {
              displayName: "Gemini 4 Argon",
              description:
                "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
              buckets: [
                {
                  displayName: "Gemini 4 Argon Weekly Limit",
                  remainingFraction: 0.9074,
                  resetTime: new Date(now + (94 * 60 + 56) * 60_000).toISOString(),
                },
              ],
            },
          ],
          description:
            "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier.",
        },
      },
      now,
    )

    expect(report).toContain("Account: jsecheverri@gmail.com")
    expect(report).toContain("GEMINI MODELS")
    expect(report).toContain("Models within this group: Gemini Flash, Gemini Pro")
    expect(report).toContain("Weekly Limit Remaining")
    expect(report).toContain("39.10%")
    expect(report).toContain("Refreshes in 94h 37m")
    expect(report).toContain("Five Hour Limit Remaining")
    expect(report).toContain("83.17%")
    expect(report).toContain("Refreshes in 3h 17m")
    expect(report).toContain("CLAUDE AND GPT MODELS")
    expect(report).toContain("Models within this group: Claude Opus, Claude Sonnet, GPT-OSS")
    expect(report).toContain("Quota available")
    expect(report).toContain("GEMINI 4 ARGON")
    expect(report).toContain("Gemini 4 Argon Weekly Limit")
    expect(report).toContain("90.74%")
    expect(report).toContain("Refreshes in 94h 56m")
    expect(report).toContain("  │Within each group, models share a weekly limit")
  })
})
