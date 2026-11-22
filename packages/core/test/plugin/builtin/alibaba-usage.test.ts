import { describe, expect, test } from "bun:test"
import {
  buildUsageCommandArgs,
  parseAuthStatus,
  parseTokenPlanResult,
} from "../../../src/plugin/builtin/alibaba-usage.js"

describe("AlibabaUsagePlugin helpers", () => {
  test("parses bl auth status with console site and region", () => {
    const status = parseAuthStatus(
      JSON.stringify({
        authenticated: true,
        config: "token-plan",
        console: { region: "ap-southeast-1", site: "international" },
      }),
    )
    expect(status?.config).toBe("token-plan")
    expect(status?.console?.site).toBe("international")
    expect(status?.console?.region).toBe("ap-southeast-1")
    expect(buildUsageCommandArgs(status)).toEqual([
      "usage",
      "token-plan",
      "--output",
      "json",
      "--config",
      "token-plan",
      "--console-site",
      "international",
      "--console-region",
      "ap-southeast-1",
    ])
  })

  test("parses bl usage token-plan JSON payload", () => {
    const result = parseTokenPlanResult(
      JSON.stringify({
        per1MonthPercentage: 12.345,
        per1MonthResetTime: 1797955200000,
        hasQuotaData: true,
      }),
      1000,
      { config: "token-plan", console: { region: "ap-southeast-1", site: "international" } },
    )
    expect(result.ok).toBe(true)
    expect(result.hasQuotaData).toBe(true)
    expect(result.usedPercent).toBe(12.345)
    expect(result.remainingPercent).toBeCloseTo(87.655, 5)
    expect(result.resetAt).toBe(1797955200000)
    expect(result.region).toBe("ap-southeast-1")
    expect(result.site).toBe("international")
  })

  test("parses bl CLI JSON error with hint", () => {
    const result = parseTokenPlanResult(
      JSON.stringify({
        error: {
          code: 3,
          message: "No console access token found.",
          hint: "Run `bl auth login --console --config token-plan`.",
        },
      }),
      1000,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe("No console access token found.")
    expect(result.hint).toContain("bl auth login --console")
  })
})
