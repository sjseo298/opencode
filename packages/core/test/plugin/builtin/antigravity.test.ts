import { describe, test, expect } from "bun:test"
import { Plugin } from "../../../src/plugin/builtin/antigravity/index.js"
import { generatePKCE, authorizeAntigravity } from "../../../src/plugin/builtin/antigravity/antigravity/oauth.js"
import { ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_SCOPES } from "../../../src/plugin/builtin/antigravity/constants.js"

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
})
