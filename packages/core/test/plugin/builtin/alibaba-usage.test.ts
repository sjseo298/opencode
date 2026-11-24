import { describe, expect, test } from "bun:test"
import {
  GATEWAY_REGION,
  GATEWAY_SITE,
  buildAgentLoginPrompt,
  buildGatewayEndpoint,
  buildGatewayParams,
  buildModelsGatewayEndpoint,
  buildModelsGatewayParams,
  extractCapturedToken,
  parseGatewayModelsResponse,
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

describe("AlibabaUsagePlugin discounted models gateway helpers", () => {
  test("builds models gateway endpoint and PERSONAL edition params", () => {
    const endpoint = buildModelsGatewayEndpoint()
    expect(endpoint).toContain("https://bailian-singapore-cs.alibabacloud.com/cli/api.json")
    expect(endpoint).toContain("action=IntlBroadScopeAspnGateway")
    expect(endpoint).toContain("product=sfm_bailian")

    const params = JSON.parse(buildModelsGatewayParams(97572))
    expect(params.Api).toBe("zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listTokenPlanModels")
    expect(params.V).toBe("1.0")
    expect(params.Data.input).toEqual({ pageNo: 1, pageSize: 100, edition: "PERSONAL" })
    expect(params.Data.cornerstoneParam.switchAgent).toBe(97572)
  })

  test("parses nested model list, keeps only discounted models, and derives percent-off", () => {
    const result = parseGatewayModelsResponse(
      JSON.stringify({
        code: "200",
        data: {
          DataV2: {
            data: {
              code: "200",
              data: {
                total: 3,
                list: [
                  {
                    modelId: "qwen3.8-flash",
                    provider: "qwen",
                    name: '{"en-US":"Qwen3.8-Flash","zh-CN":"Qwen3.8-Flash"}',
                    capabilities: ["TG", "VU"],
                    badgeLabel: "限时夜间4折",
                    badgeDescription: "每晚 22:00 - 次日 08:00 期间调用模型，Credits 消耗低至 4 折。",
                  },
                  { modelId: "qwen4-max", provider: "qwen", isNew: true },
                  { modelId: "qwen4-max-preview", provider: "qwen", badgeLabel: "限时2折", isNew: true },
                ],
              },
            },
          },
        },
      }),
      1000,
    )
    expect(result.ok).toBe(true)
    expect(result.total).toBe(3)
    expect(result.models.map((m) => m.modelId)).toEqual(["qwen3.8-flash", "qwen4-max-preview"])
    expect(result.models[0]).toMatchObject({
      provider: "qwen",
      name: "Qwen3.8-Flash",
      percentOff: 60,
      nightOnly: true,
      badgeLabel: "限时夜间4折",
    })
    expect(result.models[1]).toMatchObject({ percentOff: 80, nightOnly: false, isNew: true })
    expect(result.region).toBe(GATEWAY_REGION)
    expect(result.site).toBe(GATEWAY_SITE)
  })

  test("detects NotLogined models gateway error as needsAuth", () => {
    const result = parseGatewayModelsResponse(
      JSON.stringify({ data: { success: false, errorCode: "NotLogined", errorMsg: "Session expired" } }),
      1000,
    )
    expect(result.ok).toBe(false)
    expect(result.needsAuth).toBe(true)
    expect(result.models).toEqual([])
    expect(result.error).toContain("expired or is not connected")
  })

  test("reports an error when no model list is returned", () => {
    const result = parseGatewayModelsResponse(JSON.stringify({ data: { DataV2: { data: { data: {} } } } }), 1000)
    expect(result.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.error).toContain("No Token Plan model list")
  })
})

describe("AlibabaUsagePlugin agent login prompt", () => {
  const started = {
    url: "https://modelstudio.console.alibabacloud.com/console-login?notice=127.0.0.1:53548?state=abc123",
    state: "abc123",
  }

  test("embeds the real login URL and state and leaves no placeholders", () => {
    const prompt = buildAgentLoginPrompt(started, "")
    expect(prompt).toContain(started.url)
    expect(prompt).toContain(`"state":"${started.state}"`)
    expect(prompt).not.toContain("${url}")
    expect(prompt).not.toContain("${state}")
    expect(prompt).not.toContain("Additional instruction from the user")
  })

  test("appends non-empty user text as an additional instruction", () => {
    const prompt = buildAgentLoginPrompt(started, "  click it for me  ")
    expect(prompt.endsWith("Additional instruction from the user: click it for me")).toBe(true)
  })

  test("prompt follows spec rev 2 ordering, bounded polling, and mandatory cleanup", () => {
    const prompt = buildAgentLoginPrompt(started, "")
    // Interceptor installed AFTER login is ensured and BEFORE the consent click.
    const ensureLogin = prompt.indexOf("Ensure the account is logged in BEFORE installing anything")
    const installInterceptor = prompt.indexOf("Install the token interceptor AFTER login")
    const authorize = prompt.indexOf("Get the user's authorization")
    expect(ensureLogin).toBeGreaterThan(-1)
    expect(installInterceptor).toBeGreaterThan(ensureLogin)
    expect(authorize).toBeGreaterThan(installInterceptor)
    // Bounded capture polling replaces the unreliable success-text wait.
    expect(prompt).toContain("up to 10 attempts spaced ~1.5 seconds apart")
    expect(prompt).toContain("Do NOT wait for a \"CLI Login successful!\" text")
    // Reinstall on lost interceptor, field-driven extraction, state guard.
    expect(prompt).toContain("re-install it (Step 3)")
    expect(prompt).toContain("extract the token BY FIELD, never by object shape")
    expect(prompt).toContain("State-mismatch guard")
    // Quota acceptance requires both flags; cleanup on every exit path.
    expect(prompt).toContain("ok:true AND hasQuotaData:true")
    expect(prompt).toContain("Cleanup (mandatory on EVERY exit path, success or failure)")
    expect(prompt).toContain("cancelLogin")
    expect(prompt).toContain('group "alibaba-login"')
    // Manual mode fallback and JSON-encoder body construction.
    expect(prompt).toContain("Manual mode")
    expect(prompt).toContain("json.dumps")
  })
})

describe("AlibabaUsagePlugin captured-token extraction (spec §4.2)", () => {
  const state = "1bab2c3d6f4c12f799f901ab96bb1d45"
  const token = "3f2b8c9e-1a4d-4e7f-9b2c-6d5e8f0a1b2c"
  const authorizeJson = JSON.stringify({ code: "200", data: { access_token: token, token_type: "Bearer", expires_in: 86400 } })
  const callbackBody = JSON.stringify({
    access_token: token,
    console_site: "international",
    console_region: "ap-southeast-1",
    console_switch_agent: "97572",
    workspace_id: "llm-test",
  })
  const callbackUrl = `http://127.0.0.1:39789?state=${state}`

  test("prefers authorize JSON data.access_token over callback entries", () => {
    const result = extractCapturedToken(
      { authorize: authorizeJson, callback: [{ url: callbackUrl, body: callbackBody }] },
      state,
    )
    expect(result?.token).toBe(token)
    expect(result?.mismatch).toBe(false)
  })

  test("falls back to callback body JSON when authorize is absent", () => {
    const result = extractCapturedToken({ authorize: null, callback: [{ url: callbackUrl, body: callbackBody }] }, state)
    expect(result?.token).toBe(token)
    expect(result?.mismatch).toBe(false)
  })

  test("falls back to regex over callback url/body when JSON fields are missing", () => {
    const result = extractCapturedToken(
      { authorize: null, callback: [{ url: `${callbackUrl}&access_token=${token}`, body: "" }] },
      state,
    )
    expect(result?.token).toBe(token)
  })

  test("extracts by field even when the page mutates the capture into an array-like object", () => {
    const mutated = {
      authorize: authorizeJson,
      callback: [{ url: callbackUrl, body: callbackBody }],
      0: "spurious",
      1: { access_token: "wrong-token-from-numeric-key" },
      length: 2,
    }
    const result = extractCapturedToken(mutated, state)
    expect(result?.token).toBe(token)
    expect(result?.mismatch).toBe(false)
  })

  test("flags state mismatch from a callback URL of a different attempt", () => {
    const result = extractCapturedToken(
      { authorize: authorizeJson, callback: [{ url: "http://127.0.0.1:39789?state=deadbeef", body: callbackBody }] },
      state,
    )
    expect(result?.mismatch).toBe(true)
  })

  test("flags state mismatch carried inside a callback payload", () => {
    const result = extractCapturedToken(
      { authorize: null, callback: [{ url: callbackUrl, body: JSON.stringify({ access_token: token, state: "other-state" }) }] },
      state,
    )
    expect(result?.mismatch).toBe(true)
  })

  test("returns undefined when nothing was captured", () => {
    expect(extractCapturedToken({ authorize: null, callback: [] }, state)).toBeUndefined()
    expect(extractCapturedToken({}, state)).toBeUndefined()
  })

  test("trims stray whitespace from the extracted token", () => {
    const result = extractCapturedToken(
      { authorize: null, callback: [{ url: callbackUrl, body: JSON.stringify({ access_token: `  ${token}\n` }) }] },
      state,
    )
    expect(result?.token).toBe(token)
  })
})
