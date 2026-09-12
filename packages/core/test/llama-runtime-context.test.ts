import { describe, expect, test } from "bun:test"
import { LlamaRuntimeContext } from "@opencode-ai/core/llama-runtime-context"

type FetchInput = string | Request | URL

const request = (input: FetchInput) => {
  if (input instanceof URL) return input
  if (input instanceof Request) return new URL(input.url)
  return new URL(String(input))
}

describe("LlamaRuntimeContext", () => {
  test("prefers /props runtime n_ctx over catalog metadata", async () => {
    LlamaRuntimeContext.clearCache()
    const calls: string[] = []
    const context = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1",
      modelIDs: ["qwen3"],
      fetch: async (input) => {
        const url = request(input)
        calls.push(url.pathname)
        if (url.pathname === "/props") {
          return Response.json({
            default_generation_settings: { n_ctx: 196_608 },
            model_alias: "qwen3",
          })
        }
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "qwen3", limit: { context: 262_144, output: 8_192 } }],
          })
        }
        return new Response("missing", { status: 404 })
      },
    })

    expect(context).toBe(196_608)
    expect(calls).toEqual(["/props"])
  })

  test("falls back to /v1/models when /props omits n_ctx", async () => {
    LlamaRuntimeContext.clearCache()
    const calls: string[] = []
    const context = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1",
      modelIDs: ["Qwen 3.8"],
      fetch: async (input) => {
        const url = request(input)
        calls.push(url.pathname)
        if (url.pathname === "/props") {
          return Response.json({
            default_generation_settings: { params: {} },
            model_alias: "Qwen 3.8",
          })
        }
        if (url.pathname === "/slots") {
          return new Response("missing", { status: 404 })
        }
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              { id: "other", limit: { context: 8_192, output: 2_048 } },
              { id: "qwen-3_8", limit: { context: 131_072, output: 4_096 } },
            ],
          })
        }
        return new Response("missing", { status: 404 })
      },
    })

    expect(context).toBe(131_072)
    expect(calls).toEqual(["/props", "/slots", "/v1/slots", "/v1/models"])
  })

  test("falls back to /slots runtime context when /props omits n_ctx", async () => {
    LlamaRuntimeContext.clearCache()
    const calls: string[] = []
    const context = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1",
      modelIDs: ["Qwen 3.8"],
      fetch: async (input) => {
        const url = request(input)
        calls.push(url.pathname)
        if (url.pathname === "/props") {
          return Response.json({
            default_generation_settings: { params: {} },
            model_alias: "Qwen 3.8",
          })
        }
        if (url.pathname === "/slots") {
          return Response.json({
            data: [
              { id: 0, n_ctx: 196_608 },
              { id: 1, n_ctx_slot: "196608" },
            ],
          })
        }
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              { id: "qwen-3_8", limit: { context: 131_072, output: 4_096 } },
            ],
          })
        }
        return new Response("missing", { status: 404 })
      },
    })

    expect(context).toBe(196_608)
    expect(calls).toEqual(["/props", "/slots"])
  })

  test("extracts runtime context from slot text like 0/196608 tok (0%)", async () => {
    LlamaRuntimeContext.clearCache()
    const calls: string[] = []
    const context = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1",
      modelIDs: ["Qwen 3.8"],
      fetch: async (input) => {
        const url = request(input)
        calls.push(url.pathname)
        if (url.pathname === "/props") {
          return Response.json({
            default_generation_settings: { params: {} },
            model_alias: "Qwen 3.8",
          })
        }
        if (url.pathname === "/slots") {
          return Response.json({
            "0": {
              id: 0,
              ctx: "0/196608 tok (0%)",
            },
          })
        }
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              { id: "qwen-3_8", limit: { context: 131_072, output: 4_096 } },
            ],
          })
        }
        return new Response("missing", { status: 404 })
      },
    })

    expect(context).toBe(196_608)
    expect(calls).toEqual(["/props", "/slots"])
  })

  test("extracts runtime context from top-level /props text fields", async () => {
    LlamaRuntimeContext.clearCache()
    const calls: string[] = []
    const context = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1",
      fetch: async (input) => {
        const url = request(input)
        calls.push(url.pathname)
        if (url.pathname === "/props") {
          return Response.json({
            ctx: "0/196608 tok (0%)",
          })
        }
        return new Response("missing", { status: 404 })
      },
    })

    expect(context).toBe(196_608)
    expect(calls).toEqual(["/props"])
  })

  test("returns cached result for equivalent base URLs", async () => {
    LlamaRuntimeContext.clearCache()
    const calls: string[] = []
    const fetchFn = async (input: FetchInput) => {
      const url = request(input)
      calls.push(url.pathname)
      if (url.pathname === "/props") {
        return Response.json({ default_generation_settings: { n_ctx: 32_768 } })
      }
      return new Response("missing", { status: 404 })
    }

    const first = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1",
      fetch: fetchFn,
    })
    const second = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1/",
      fetch: fetchFn,
    })

    expect(first).toBe(32_768)
    expect(second).toBe(32_768)
    expect(calls).toEqual(["/props"])
  })

  test("keeps model-specific contexts when /v1/models result is cached", async () => {
    LlamaRuntimeContext.clearCache()
    const calls: string[] = []
    const fetchFn = async (input: FetchInput) => {
      const url = request(input)
      calls.push(url.pathname)
      if (url.pathname === "/props") {
        return Response.json({ default_generation_settings: { params: {} } })
      }
      if (url.pathname === "/slots") {
        return new Response("missing", { status: 404 })
      }
      if (url.pathname === "/v1/slots") {
        return new Response("missing", { status: 404 })
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [
            { id: "model-a", limit: { context: 131_072, output: 4_096 } },
            { id: "model-b", limit: { context: 262_144, output: 8_192 } },
          ],
        })
      }
      return new Response("missing", { status: 404 })
    }

    const first = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1",
      modelIDs: ["model-a"],
      fetch: fetchFn,
    })

    const second = await LlamaRuntimeContext.resolve({
      providerID: "llamacpp",
      baseURL: "http://127.0.0.1:8888/v1",
      modelIDs: ["model-b"],
      fetch: fetchFn,
    })

    expect(first).toBe(131_072)
    expect(second).toBe(262_144)
    expect(calls).toEqual(["/props", "/slots", "/v1/slots", "/v1/models"])
  })

  test("ignores non-local non-llama providers", async () => {
    LlamaRuntimeContext.clearCache()
    let called = false
    const context = await LlamaRuntimeContext.resolve({
      providerID: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      fetch: async () => {
        called = true
        return Response.json({ default_generation_settings: { n_ctx: 1 } })
      },
    })

    expect(context).toBeUndefined()
    expect(called).toBe(false)
  })
})
