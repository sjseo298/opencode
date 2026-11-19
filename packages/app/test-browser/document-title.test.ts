import { afterEach, describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"

const require = createRequire(import.meta.url)

const solid = createRequire(require.resolve("vite-plugin-solid"))

const { transformSync } = solid("@babel/core")

// This file runs with --isolate. Replace the shared hyperscript preload so Solid owns reactive JSX getters.
Bun.plugin.clearAll()

Bun.plugin({
  name: "document-title-solid",
  setup(build) {
    build.onLoad({ filter: /\.(jsx|tsx)$/ }, async (args) => ({
      contents: transformSync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [solid.resolve("babel-preset-solid"), solid.resolve("@babel/preset-typescript")],
      }).code,
      loader: "js",
    }))
  },
})

const { MetaProvider, Title } = await import("@solidjs/meta")

const { DocumentTitleHost, useDocumentTitle } = await import("@/shell/document-title")

describe("DocumentTitleHost", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
    document.head.querySelectorAll("title").forEach((el) => el.remove())
  })

  test("preserves host badge without duplicating base <title> across home, session, and new-chat transitions", () => {
    const container = document.createElement("div")
    document.body.append(container)

    const [defaultMachine, setDefaultMachine] = createSignal<string | undefined>("Local")
    const [route, setRoute] = createSignal<"home" | "session" | "draft" | "preparing">("home")
    const [sessionTitle, setSessionTitle] = createSignal<string | undefined>("Fix auth")
    const [draftMachine, setDraftMachine] = createSignal<string | undefined>("OIPA")
    const [sessionMachine, setSessionMachine] = createSignal<string | undefined>("OIPA")

    function SessionRoute() {
      useDocumentTitle({ title: sessionTitle, machine: sessionMachine })

      return null
    }

    function DraftRoute() {
      useDocumentTitle({ machine: draftMachine })

      return null
    }

    function PreparingRoute() {
      useDocumentTitle({ title: () => undefined, machine: sessionMachine })

      return null
    }

    const dispose = render(
      () =>
        createComponent(MetaProvider, {
          get children() {
            return [
              createComponent(Title, { children: "OpenCode" }),
              createComponent(DocumentTitleHost, {
                defaultMachine,
                get children() {
                  return [
                    createComponent(Show, {
                      get when() {
                        return route() === "session"
                      },
                      get children() {
                        return createComponent(SessionRoute, {})
                      },
                    }),
                    createComponent(Show, {
                      get when() {
                        return route() === "draft"
                      },
                      get children() {
                        return createComponent(DraftRoute, {})
                      },
                    }),
                    createComponent(Show, {
                      get when() {
                        return route() === "preparing"
                      },
                      get children() {
                        return createComponent(PreparingRoute, {})
                      },
                    }),
                  ]
                },
              }),
            ]
          },
        }),
      container,
    )

    cleanups.push(() => {
      dispose()
      container.remove()
    })

    // Home -> shows default machine badge
    expect(document.head.querySelectorAll("title")).toHaveLength(1)
    expect(document.title).toBe("[Local] OpenCode")

    // Open session on OIPA -> shows [OIPA] session title
    setRoute("session")
    expect(document.head.querySelectorAll("title")).toHaveLength(1)
    expect(document.title).toBe("[OIPA] Fix auth · OpenCode")

    // Start new chat (DraftRoute on OIPA while default server is Local) -> keeps [OIPA] and never leaks base "OpenCode"
    setRoute("draft")
    expect(document.head.querySelectorAll("title")).toHaveLength(1)
    expect(document.title).toBe("[OIPA] OpenCode")

    // Switch draft target back to Local -> updates to [Local] OpenCode
    setDraftMachine("Local")
    expect(document.head.querySelectorAll("title")).toHaveLength(1)
    expect(document.title).toBe("[Local] OpenCode")

    // Submit new chat (preparing on OIPA before title exists) -> keeps [OIPA]
    setSessionTitle(undefined)
    setRoute("preparing")
    expect(document.head.querySelectorAll("title")).toHaveLength(1)
    expect(document.title).toBe("[OIPA] OpenCode")

    // Session becomes ready and receives generated title -> updates to [OIPA] New chat · OpenCode
    setRoute("session")
    expect(document.head.querySelectorAll("title")).toHaveLength(1)
    expect(document.title).toBe("[OIPA] OpenCode")

    setSessionTitle("New chat")
    expect(document.head.querySelectorAll("title")).toHaveLength(1)
    expect(document.title).toBe("[OIPA] New chat · OpenCode")

    // Return to Home -> restores default host
    setDefaultMachine("OIPA")
    setRoute("home")
    expect(document.head.querySelectorAll("title")).toHaveLength(1)
    expect(document.title).toBe("[OIPA] OpenCode")
  })
})
