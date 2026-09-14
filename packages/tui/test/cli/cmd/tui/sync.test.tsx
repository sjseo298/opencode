/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

function catalogEvent(input: { directory: string; workspace?: string }): GlobalEvent {
  return {
    directory: input.directory,
    project: "proj_test",
    workspace: input.workspace,
    payload: {
      id: "evt_catalog_update",
      type: "catalog.updated",
      properties: {},
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("catalog updates refresh providers with event workspace and directory", async () => {
    const configCalls: URL[] = []
    const providerCalls: URL[] = []
    const { app, emit, project } = await mount((url) => {
      if (url.pathname === "/config/providers") {
        configCalls.push(new URL(url.toString()))
        return json({ providers: [], default: {} })
      }
      if (url.pathname === "/provider") {
        providerCalls.push(new URL(url.toString()))
        return json({ all: [], default: {}, connected: [] })
      }
    })

    try {
      project.workspace.set("ws_local")
      const beforeConfig = configCalls.length
      const beforeProvider = providerCalls.length

      emit(
        catalogEvent({
          directory: "/tmp/catalog-location",
          workspace: "ws_remote",
        }),
      )

      await wait(() => configCalls.length > beforeConfig && providerCalls.length > beforeProvider)

      expect(configCalls.at(-1)?.searchParams.get("workspace")).toBe("ws_remote")
      expect(configCalls.at(-1)?.searchParams.get("directory")).toBe("/tmp/catalog-location")
      expect(providerCalls.at(-1)?.searchParams.get("workspace")).toBe("ws_remote")
      expect(providerCalls.at(-1)?.searchParams.get("directory")).toBe("/tmp/catalog-location")
    } finally {
      app.renderer.destroy()
    }
  })
})
