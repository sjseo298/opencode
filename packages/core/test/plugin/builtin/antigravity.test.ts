import { describe, test, expect } from "bun:test"
import { Plugin } from "../../../src/plugin/builtin/antigravity/index.js"
import { generatePKCE, authorizeAntigravity } from "../../../src/plugin/builtin/antigravity/antigravity/oauth.js"
import { ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_SCOPES } from "../../../src/plugin/builtin/antigravity/constants.js"
import { AntigravityConfigSchema, DEFAULT_CONFIG } from "../../../src/plugin/builtin/antigravity/plugin/config/schema.js"
import { loadConfig } from "../../../src/plugin/builtin/antigravity/plugin/config/loader.js"
import { parseRateLimitReason } from "../../../src/plugin/builtin/antigravity/plugin/accounts.js"
import { splitOverflowSystemInstruction } from "../../../src/plugin/builtin/antigravity/plugin/request.js"
import { __testExports } from "../../../src/plugin/builtin/antigravity/plugin.js"

describe("Antigravity Builtin Plugin", () => {
  test("plugin is defined with correct ID", () => {
    expect(Plugin).toBeDefined()
    expect(Plugin.id).toBe("opencode-antigravity-auth")
    expect(typeof Plugin.setup).toBe("function")
  })

  test("generatePKCE generates valid verifier and S256 challenge", async () => {
    const pkce = await generatePKCE()
    expect(pkce).toBeDefined()
    expect(typeof pkce.verifier).toBe("string")
    expect(pkce.verifier.length).toBeGreaterThan(20)
    expect(typeof pkce.challenge).toBe("string")
    expect(pkce.challenge.length).toBeGreaterThan(20)
  })

  test("authorizeAntigravity generates valid auth URL with PKCE and scopes", async () => {
    const auth = await authorizeAntigravity("test-project-123")
    expect(auth.url).toContain("accounts.google.com")
    expect(auth.url).toContain("code_challenge=")
    expect(auth.url).toContain("code_challenge_method=S256")
    expect(auth.projectId).toBe("test-project-123")
    expect(auth.verifier).toBeDefined()
  })

  test("constants expose correct endpoints and scopes", () => {
    expect(ANTIGRAVITY_ENDPOINT).toContain("googleapis.com")
    expect(ANTIGRAVITY_SCOPES.length).toBeGreaterThan(0)
  })

  test("soft_quota_threshold_percent defaults to 100 in schema and DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.soft_quota_threshold_percent).toBe(100)
    const parsed = AntigravityConfigSchema.parse({})
    expect(parsed.soft_quota_threshold_percent).toBe(100)
  })

  test("soft_quota_threshold_percent allows custom lower values via config", () => {
    const parsed = AntigravityConfigSchema.parse({ soft_quota_threshold_percent: 85 })
    expect(parsed.soft_quota_threshold_percent).toBe(85)
  })

  test("loadConfig returns soft_quota_threshold_percent: 100 by default", () => {
    const config = loadConfig("/non/existent/path")
    expect(config.soft_quota_threshold_percent).toBe(100)
  })

  test("OAuth callback handling parses localhost and 127.0.0.1 redirect URLs properly", async () => {
    const state = "test-state-123"
    const parseCallback = (input: string) => {
      let code = input.trim()
      let callbackState = state
      if (/^https?:\/\//i.test(code)) {
        const callback = new URL(code)
        const errorParam = callback.searchParams.get("error")
        if (errorParam) {
          const desc = callback.searchParams.get("error_description")
          throw new Error(`Google returned an error: ${errorParam}${desc ? ` (${desc})` : ""}`)
        }
        const urlCode = callback.searchParams.get("code")
        const urlState = callback.searchParams.get("state")
        if (urlState && urlState !== state) {
          throw new Error("Invalid Antigravity OAuth callback state")
        }
        if (urlState) callbackState = urlState
        if (!urlCode) {
          throw new Error("Missing authorization code in callback URL")
        }
        code = urlCode
      }
      return { code, state: callbackState }
    }

    // Accepts 127.0.0.1 redirect URL
    const r1 = parseCallback(`http://127.0.0.1:51121/oauth-callback?code=4/0A123&state=${state}`)
    expect(r1.code).toBe("4/0A123")
    expect(r1.state).toBe(state)

    // Accepts localhost redirect URL
    const r2 = parseCallback(`http://localhost:51121/oauth-callback?code=4/0B456&state=${state}`)
    expect(r2.code).toBe("4/0B456")
    expect(r2.state).toBe(state)

    // Accepts raw authorization code
    const r3 = parseCallback("4/0C789")
    expect(r3.code).toBe("4/0C789")
    expect(r3.state).toBe(state)

    // Rejects mismatched state
    expect(() => parseCallback(`http://localhost:51121/oauth-callback?code=4/0D&state=wrong-state`))
      .toThrow("Invalid Antigravity OAuth callback state")

    // Surfaces Google errors
    expect(() => parseCallback(`http://localhost:51121/oauth-callback?error=access_denied&error_description=User%20denied`))
      .toThrow("Google returned an error: access_denied (User denied)")
  })

  test("resolveHeaderRoutingDecision respects quota_fallback and explicitQuota", () => {
    const explicitUrl = "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-4-hydrogen-medium:streamGenerateContent?alt=sse"
    const genericUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse"

    const defaultDecision = __testExports.resolveHeaderRoutingDecision(genericUrl, "gemini", DEFAULT_CONFIG)
    expect(defaultDecision.preferredHeaderStyle).toBe("antigravity")
    expect(defaultDecision.allowQuotaFallback).toBe(false)

    const enabledDecision = __testExports.resolveHeaderRoutingDecision(genericUrl, "gemini", {
      ...DEFAULT_CONFIG,
      quota_fallback: true,
    })
    expect(enabledDecision.allowQuotaFallback).toBe(true)

    const explicitDecision = __testExports.resolveHeaderRoutingDecision(explicitUrl, "gemini", {
      ...DEFAULT_CONFIG,
      quota_fallback: true,
    })
    expect(explicitDecision.explicitQuota).toBe(true)
    expect(explicitDecision.allowQuotaFallback).toBe(false)

    const claudeDecision = __testExports.resolveHeaderRoutingDecision(genericUrl, "claude", {
      ...DEFAULT_CONFIG,
      quota_fallback: true,
    })
    expect(claudeDecision.allowQuotaFallback).toBe(false)
  })

  test("parseRateLimitReason treats generic 'Resource has been exhausted' without explicit reason as capacity", () => {
    expect(parseRateLimitReason(undefined, "Resource has been exhausted (e.g. check quota).", 429))
      .toBe("MODEL_CAPACITY_EXHAUSTED")
    expect(parseRateLimitReason("QUOTA_EXHAUSTED", "Resource has been exhausted (e.g. check quota).", 429))
      .toBe("QUOTA_EXHAUSTED")
  })

  test("acquireAccountSlot serializes concurrent requests per account and supports abort", async () => {
    const events: string[] = []
    const releaseFirst = await __testExports.acquireAccountSlot("acct-test")
    events.push("first-acquired")

    const controller = new AbortController()
    const abortedWaiter = __testExports.acquireAccountSlot("acct-test", controller.signal)
    const thirdWaiter = __testExports.acquireAccountSlot("acct-test").then((release) => {
      events.push("third-acquired")
      release()
    })

    controller.abort()
    await expect(abortedWaiter).rejects.toThrow("Aborted")
    expect(events).toEqual(["first-acquired"])

    releaseFirst()
    await thirdWaiter
    expect(events).toEqual(["first-acquired", "third-acquired"])
  })

  test("splitOverflowSystemInstruction leaves small systemInstruction untouched and splits oversized ones into contents", () => {
    const smallPayload: Record<string, unknown> = {
      systemInstruction: { role: "user", parts: [{ text: "Short instructions" }] },
      contents: [{ role: "user", parts: [{ text: "hola" }] }],
    }
    expect(splitOverflowSystemInstruction(smallPayload, 14_000)).toBe(false)
    expect((smallPayload.contents as unknown[]).length).toBe(1)

    const part1 = "Rule 1: Always verify.\n\n".repeat(400)
    const part2 = "Rule 2: Keep tests passing.\n\n".repeat(400)
    const largePayload: Record<string, unknown> = {
      systemInstruction: { role: "user", parts: [{ text: part1 + part2 }] },
      contents: [{ role: "user", parts: [{ text: "hola" }] }],
    }

    expect(splitOverflowSystemInstruction(largePayload, 14_000)).toBe(true)
    const sysText = ((largePayload.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!).text
    expect(sysText.length).toBeLessThanOrEqual(14_000)
    expect(sysText).toContain("Additional system instructions continue in the first user message below")

    const contents = largePayload.contents as Array<{ role: string; parts: Array<{ text: string }> }>
    expect(contents.length).toBe(3)
    expect(contents[0]!.role).toBe("user")
    expect(contents[0]!.parts[0]!.text).toContain("Rule 2: Keep tests passing.")
    expect(contents[1]!.role).toBe("model")
    expect(contents[2]!.parts[0]!.text).toBe("hola")
  })
})
