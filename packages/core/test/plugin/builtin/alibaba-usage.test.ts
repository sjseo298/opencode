import { describe, expect, test } from "bun:test"
import {
  GATEWAY_REGION,
  GATEWAY_SITE,
  buildGatewayEndpoint,
  buildGatewayParams,
  parseGatewayUsageResponse,
  parseManualLoginInput,
} from "../../../src/plugin/builtin/alibaba-usage.js"

describe("AlibabaUsagePlugin native gateway helpers", () => {
  test("builds international Singapore gateway endpoint and params", () => {
    const endpoint = buildGatewayEndpoint()
    expect(endpoint).toContain("https://bailian-singapore-cs.alibabacloud.com/cli/api.json")
    expect(endpoint).toContain("action=IntlBroadScopeAspnGateway")
    expect(endpoint).toContain("product=sfm_bailian")

    const params = JSON.parse(buildGatewayParams(97572))
    expect(params.Api).toBe("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage")
    expect(params.V).toBe("1.0")
    expect(params.Data.cornerstoneParam.switchAgent).toBe(97572)
  })

  test("parses gateway Token Plan usage payload", () => {
    const result = parseGatewayUsageResponse(
      JSON.stringify({
        data: {
          success: true,
          per1MonthPercentage: 12.345,
          per1MonthResetTime: 1797955200000,
        },
      }),
      1000,
    )
    expect(result.ok).toBe(true)
    expect(result.hasQuotaData).toBe(true)
    expect(result.usedPercent).toBe(12.345)
    expect(result.remainingPercent).toBeCloseTo(87.655, 5)
    expect(result.resetAt).toBe(1797955200000)
    expect(result.region).toBe(GATEWAY_REGION)
    expect(result.site).toBe(GATEWAY_SITE)
  })

  test("unwraps DataV2.data.data from IntlBroadScopeAspnGateway response", () => {
    const result = parseGatewayUsageResponse(
      JSON.stringify({
        data: {
          DataV2: {
            data: {
              data: {
                per1MonthPercentage: 0.000025280658015,
                per1MonthResetTime: 1797955200000,
              },
            },
          },
        },
      }),
      1000,
    )
    expect(result.ok).toBe(true)
    expect(result.hasQuotaData).toBe(true)
    expect(result.usedPercent).toBeCloseTo(0.000025280658015, 10)
    expect(result.resetAt).toBe(1797955200000)
  })

  test("detects NotLogined gateway error as needsAuth", () => {
    const result = parseGatewayUsageResponse(
      JSON.stringify({
        data: {
          success: false,
          errorCode: "NotLogined",
          errorMsg: "Session expired",
        },
      }),
      1000,
    )
    expect(result.ok).toBe(false)
    expect(result.needsAuth).toBe(true)
    expect(result.error).toContain("expired or is not connected")
  })

  test("parses manual login redirect URL, JSON, query string, and raw token", () => {
    const fromUrl = parseManualLoginInput(
      "http://127.0.0.1:54321/callback?access_token=tok_abc123456789&console_region=ap-southeast-1&console_switch_agent=97572&state=st1",
    )
    expect(fromUrl?.accessToken).toBe("tok_abc123456789")
    expect(fromUrl?.region).toBe("ap-southeast-1")
    expect(fromUrl?.switchAgent).toBe(97572)
    expect(fromUrl?.state).toBe("st1")

    const fromJson = parseManualLoginInput(JSON.stringify({ access_token: "tok_json123456" }))
    expect(fromJson?.accessToken).toBe("tok_json123456")

    const fromRaw = parseManualLoginInput("tok_raw_1234567890")
    expect(fromRaw?.accessToken).toBe("tok_raw_1234567890")
  })
})
