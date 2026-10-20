import { describe, test, expect, afterEach } from "bun:test"
import plugin, {
  propsUrl,
  fetchContextLimit,
  fetchContextInfo,
  getOrCreateDynamicContextStore,
} from "../../../src/plugin/builtin/llamacpp-context.js"

describe("llamacpp-context", () => {
  describe("propsUrl", () => {
    test("handles base URL without path", () => {
      expect(propsUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/props")
    })

    test("strips trailing /v1", () => {
      expect(propsUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/props")
      expect(propsUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/props")
    })

    test("preserves nested subpath before /v1", () => {
      expect(propsUrl("http://localhost:1234/proxy/v1")).toBe("http://localhost:1234/proxy/props")
    })

    test("returns undefined for invalid or non-string inputs", () => {
      expect(propsUrl("")).toBeUndefined()
      expect(propsUrl(undefined)).toBeUndefined()
      expect(propsUrl(null)).toBeUndefined()
      expect(propsUrl("not a valid url")).toBeUndefined()
    })
  })

  describe("fetchContextLimit", () => {
    test("fetches n_ctx from default_generation_settings", async () => {
      using server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/props") {
            return Response.json({
              default_generation_settings: {
                n_ctx: 65536,
              },
            })
          }
          return new Response("not found", { status: 404 })
        },
      })

      const nCtx = await fetchContextLimit(server.url.toString())
      expect(nCtx).toBe(65536)
    })

    test("fetches n_ctx from top-level property", async () => {
      using server = Bun.serve({
        port: 0,
        fetch(req) {
          return Response.json({ n_ctx: 32768 })
        },
      })

      const nCtx = await fetchContextLimit(server.url.toString())
      expect(nCtx).toBe(32768)
    })

    test("fetches context from /status when /props returns 404", async () => {
      using server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/props") {
            return new Response("not found", { status: 404 })
          }
          if (url.pathname === "/status") {
            return Response.json({
              slots: {
                items: [{ total_tokens: 4096 }],
              },
            })
          }
          return new Response("not found", { status: 404 })
        },
      })

      const nCtx = await fetchContextLimit(server.url.toString())
      expect(nCtx).toBe(4096)
    })

    test("returns undefined when server returns 404", async () => {
      using server = Bun.serve({
        port: 0,
        fetch() {
          return new Response("not found", { status: 404 })
        },
      })

      const nCtx = await fetchContextLimit(server.url.toString())
      expect(nCtx).toBeUndefined()
    })

    test("returns undefined when server is unreachable", async () => {
      const nCtx = await fetchContextLimit("http://127.0.0.1:54321", 500)
      expect(nCtx).toBeUndefined()
    })

    test("fetches total_slots and derives max_subagents = slots - 1 from /props", async () => {
      using server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/props") {
            return Response.json({
              default_generation_settings: {
                n_ctx: 262144,
                total_slots: 3,
              },
              total_slots: 3,
            })
          }
          return new Response("not found", { status: 404 })
        },
      })

      const info = await fetchContextInfo(server.url.toString())
      expect(info.limit).toBe(262144)
      expect(info.totalSlots).toBe(3)
      expect(info.maxSubagents).toBe(2)

      const store = getOrCreateDynamicContextStore()
      store.set("llamacpp/qwen3.8", info)
      expect(store.getTotalSlots("llamacpp/qwen3.8")).toBe(3)
      expect(store.getMaxSubagents("llamacpp/qwen3.8")).toBe(2)
    })
  })

  describe("plugin lifecycle & hooks", () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      process.env = { ...originalEnv }
    })

    test("respects OPENCODE_LLAMACPP_CONTEXT=off", async () => {
      process.env.OPENCODE_LLAMACPP_CONTEXT = "off"
      let modelTransformCalled = false
      const mockCtx: any = {
        options: {},
        model: {
          transform: async () => {
            modelTransformCalled = true
          },
        },
      }

      await plugin.setup(mockCtx)
      expect(modelTransformCalled).toBe(false)
    })

    test("registers model transform, hooks, and commands", async () => {
      let modelTransformCallback: any
      const sessionHooks: Record<string, any> = {}
      const commands: Record<string, any> = {}

      const mockCtx: any = {
        options: {},
        model: {
          transform: async (fn: any) => {
            modelTransformCallback = fn
          },
          reload: async () => {},
        },
        session: {
          hook: async (name: string, fn: any) => {
            sessionHooks[name] = fn
          },
          get: async () => ({
            model: { providerID: "llamacpp", id: "llama-3.1" },
          }),
          synthetic: async () => {},
        },
        command: {
          transform: async (fn: any) => {
            fn({
              add: (def: any) => {
                commands[def.name] = def
              },
            })
          },
        },
      }

      await plugin.setup(mockCtx)

      expect(modelTransformCallback).toBeDefined()
      expect(sessionHooks["prompt"]).toBeDefined()
      expect(sessionHooks["model.request"]).toBeDefined()
      expect(commands["context"]).toBeDefined()
      expect(commands["refresh-context"]).toBeDefined()
    })

    test("updates model context on model.request hook", async () => {
      using server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/props") {
            return Response.json({
              default_generation_settings: {
                n_ctx: 131072,
              },
            })
          }
          return new Response("not found", { status: 404 })
        },
      })

      let registeredModelTransform: any
      let modelReloadCount = 0
      const sessionHooks: Record<string, any> = {}

      const mockCtx: any = {
        options: {},
        model: {
          transform: async (fn: any) => {
            registeredModelTransform = fn
          },
          reload: async () => {
            modelReloadCount += 1
          },
        },
        session: {
          hook: async (name: string, fn: any) => {
            sessionHooks[name] = fn
          },
          get: async () => ({
            model: { providerID: "llamacpp", id: "llama-3.1" },
          }),
        },
        command: {
          transform: async (fn: any) => {
            fn({ add: () => {} })
          },
        },
      }

      await plugin.setup(mockCtx)

      // Simulate model.request hook with the test server baseURL
      await sessionHooks["model.request"]({
        sessionID: "ses-1",
        baseURL: server.url.toString(),
        model: {
          providerID: "llamacpp",
          id: "llama-3.1",
        },
      })

      expect(modelReloadCount).toBe(1)

      // Verify that the model transform updates draft.limit.context
      let updatedContext: number | undefined
      const mockEditor: any = {
        provider: {
          get: () => undefined,
        },
        get: () => ({ limit: { context: 4096 } }),
        update: (providerID: string, modelID: string, updater: any) => {
          const draft = { limit: { context: 4096 } }
          updater(draft)
          updatedContext = draft.limit.context
        },
      }

      registeredModelTransform(mockEditor)
      expect(updatedContext).toBe(131072)
    })

    test("slash command /context refreshes context and sends synthetic notification", async () => {
      using server = Bun.serve({
        port: 0,
        fetch(req) {
          return Response.json({
            default_generation_settings: {
              n_ctx: 65536,
            },
          })
        },
      })

      const commands: Record<string, any> = {}
      const syntheticMessages: any[] = []

      const mockCtx: any = {
        options: {},
        model: {
          transform: async (fn: any) => {
            // Initial call to register provider baseURL
            fn({
              provider: {
                get: () => ({
                  provider: {
                    settings: { baseURL: server.url.toString() },
                  },
                }),
              },
              get: () => ({ limit: { context: 4096 } }),
              update: () => {},
            })
          },
          reload: async () => {},
        },
        session: {
          hook: async () => {},
          get: async () => ({
            model: { providerID: "llamacpp", id: "qwen-2.5-coder" },
          }),
          synthetic: async (msg: any) => {
            syntheticMessages.push(msg)
          },
        },
        command: {
          transform: async (fn: any) => {
            fn({
              add: (def: any) => {
                commands[def.name] = def
              },
            })
          },
        },
      }

      await plugin.setup(mockCtx)

      // Execute /context command
      await commands["context"].execute({ sessionID: "ses-cmd-1" })

      expect(syntheticMessages.length).toBe(1)
      expect(syntheticMessages[0].text).toContain("65,536 tokens")
      expect(syntheticMessages[0].resume).toBe(false)
    })
  })
})
