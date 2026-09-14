import { describe, expect, test } from "bun:test"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { FORCE_CONTEXT_REFRESH_OPTION, LlamacppContextPlugin } from "../../src/plugin/llamacpp-context"

type ChatParams = NonNullable<Hooks["chat.params"]>
type AskQuestion = NonNullable<PluginInput["experimental_question"]>["ask"]

function makePluginInput(ask: AskQuestion): PluginInput {
  return {
    client: {
      tui: {
        showToast: async () => true,
      },
    } as never,
    project: {} as never,
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: {
      register() {},
    },
    experimental_question: { ask },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  }
}

function makeModel(context: number): Parameters<ChatParams>[0]["model"] {
  return {
    id: "llama-3.1",
    providerID: "llamacpp",
    name: "Llama 3.1",
    limit: {
      context,
    },
  } as Parameters<ChatParams>[0]["model"]
}

function makeInput(model: Parameters<ChatParams>[0]["model"], baseURL: string): Parameters<ChatParams>[0] {
  return {
    sessionID: "ses_test",
    agent: "build",
    model,
    provider: {
      source: "config",
      info: {} as never,
      options: {
        baseURL,
      },
    },
    message: {} as never,
  }
}

function makeOutput(force = false): Parameters<ChatParams>[1] {
  return {
    temperature: 0,
    topP: 1,
    topK: 0,
    maxOutputTokens: 4_096,
    options: force
      ? {
          [FORCE_CONTEXT_REFRESH_OPTION]: true,
        }
      : {},
  }
}

function makeServer(nCtx: number, onPropsRequest?: () => void) {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/props") return new Response("not found", { status: 404 })
      onPropsRequest?.()
      return Response.json({
        default_generation_settings: {
          n_ctx: nCtx,
        },
      })
    },
  })
}

describe("LlamacppContextPlugin", () => {
  test("updates model context when the user accepts the detected value", async () => {
    using server = makeServer(8192)
    let questions = 0
    const hooks = await LlamacppContextPlugin(
      makePluginInput(async (input) => {
        questions += 1
        const accept = input.questions[0]?.options[0]?.label ?? ""
        return [[accept]]
      }),
    )
    const hook = hooks["chat.params"]!
    const model = makeModel(4096)

    await hook(makeInput(model, new URL("/v1", server.url).toString()), makeOutput())

    expect(model.limit.context).toBe(8192)
    expect(questions).toBe(1)
  })

  test("force refresh bypasses dismissed context prompts", async () => {
    let propsRequests = 0
    using server = makeServer(8192, () => {
      propsRequests += 1
    })
    let questions = 0
    const hooks = await LlamacppContextPlugin(
      makePluginInput(async (input) => {
        questions += 1
        const keep = input.questions[0]?.options[1]?.label ?? ""
        return [[keep]]
      }),
    )
    const hook = hooks["chat.params"]!
    const model = makeModel(4096)
    const input = makeInput(model, new URL("/v1", server.url).toString())

    await hook(input, makeOutput())
    await hook(input, makeOutput())
    await hook(input, makeOutput(true))

    expect(model.limit.context).toBe(4096)
    expect(questions).toBe(2)
    expect(propsRequests).toBe(2)
  })
})
