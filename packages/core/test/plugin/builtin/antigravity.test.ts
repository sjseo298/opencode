import { describe, test, expect } from "bun:test"
import { Plugin } from "../../../src/plugin/builtin/antigravity/index.js"
import { generatePKCE, authorizeAntigravity } from "../../../src/plugin/builtin/antigravity/antigravity/oauth.js"
import { ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_SCOPES } from "../../../src/plugin/builtin/antigravity/constants.js"
import { AntigravityConfigSchema, DEFAULT_CONFIG } from "../../../src/plugin/builtin/antigravity/plugin/config/schema.js"
import { loadConfig } from "../../../src/plugin/builtin/antigravity/plugin/config/loader.js"

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
})
