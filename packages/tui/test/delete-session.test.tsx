import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_delete",
  title: "Session to delete",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function render(state: string, onRemove?: () => void) {
  return createAppFixture({
    state,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "on" } },
    fetch: (url, init) => {
      if (url.pathname === `/api/session/${session.id}` && init?.method === "DELETE") {
        onRemove?.()
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
        })
    },
  })
}

test("/delete opens confirm dialog and removes session on confirm", async () => {
  await using state = await tmpdir()
  let removed = false
  await using setup = await render(state.path, () => {
    removed = true
  })

  await setup.waitForFrame((frame) => frame.includes("Session to delete"))
  await setup.mockInput.typeText("/delete")
  setup.mockInput.pressEnter()

  // Confirmation dialog should be displayed
  await setup.waitForFrame((frame) => frame.includes("Delete session") && frame.includes("Are you sure you want to delete"))

  // Confirm deletion with Enter
  setup.mockInput.pressEnter()

  // Wait for session remove call to be made
  await setup.waitForFrame(() => removed)
  expect(removed).toBe(true)
})

test("/delete can be cancelled with escape", async () => {
  await using state = await tmpdir()
  let removed = false
  await using setup = await render(state.path, () => {
    removed = true
  })

  await setup.waitForFrame((frame) => frame.includes("Session to delete"))
  await setup.mockInput.typeText("/delete")
  setup.mockInput.pressEnter()

  // Confirmation dialog should be displayed
  await setup.waitForFrame((frame) => frame.includes("Delete session") && frame.includes("Are you sure you want to delete"))

  // Cancel deletion with Escape
  setup.mockInput.pressEscape()

  // Dialog closes and session remains
  const frame = await setup.waitForFrame((frame) => !frame.includes("Are you sure you want to delete") && frame.includes("Session to delete"))
  expect(frame).toContain("Session to delete")
  expect(removed).toBe(false)
})
