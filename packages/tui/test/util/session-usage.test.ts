import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Provider, Session } from "@opencode-ai/sdk/v2"
import { formatSessionUsage } from "../../src/util/session-usage"

const providers: Provider[] = [
  {
    id: "llamacpp",
    name: "llama.cpp",
    source: "api",
    env: [],
    options: {},
    models: {
      "old-context": {
        id: "old-context",
        providerID: "llamacpp",
        api: { id: "old-context", url: "http://localhost", npm: "@ai-sdk/openai-compatible" },
        name: "old-context",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200_000, output: 8_192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "",
      },
      "new-context": {
        id: "new-context",
        providerID: "llamacpp",
        api: { id: "new-context", url: "http://localhost", npm: "@ai-sdk/openai-compatible" },
        name: "new-context",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 32_000, output: 8_192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "",
      },
    },
  },
]

const assistant: AssistantMessage = {
  id: "msg_assistant",
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 1, completed: 2 },
  parentID: "msg_user",
  modelID: "old-context",
  providerID: "llamacpp",
  mode: "default",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 5_000, output: 3_000, reasoning: 0, cache: { read: 0, write: 0 } },
}

describe("session usage", () => {
  test("uses the active session model for context percentage", () => {
    const session: Session = {
      id: "ses_1",
      slug: "session",
      projectID: "proj_1",
      directory: "/repo",
      title: "Session",
      version: "1",
      time: { created: 1, updated: 2 },
      model: { providerID: "llamacpp", id: "new-context" },
    }

    const usage = formatSessionUsage({
      messages: [assistant],
      providers,
      session,
    })

    expect(usage).toEqual({
      tokens: 8_000,
      percent: 25,
      contextLimit: "32.0K",
      context: "8.0K (25%)",
      cost: undefined,
    })
  })

  test("falls back to assistant model when session model is missing", () => {
    const usage = formatSessionUsage({
      messages: [assistant],
      providers,
      session: {
        id: "ses_1",
        slug: "session",
        projectID: "proj_1",
        directory: "/repo",
        title: "Session",
        version: "1",
        time: { created: 1, updated: 2 },
        cost: 12.34,
      } satisfies Session,
    })

    expect(usage).toEqual({
      tokens: 8_000,
      percent: 4,
      contextLimit: "200.0K",
      context: "8.0K (4%)",
      cost: "$12.34",
    })
  })

  test("keeps one decimal in context percentage", () => {
    const usage = formatSessionUsage({
      messages: [
        {
          ...assistant,
          tokens: { input: 5_300, output: 3_000, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
      providers,
      session: {
        id: "ses_1",
        slug: "session",
        projectID: "proj_1",
        directory: "/repo",
        title: "Session",
        version: "1",
        time: { created: 1, updated: 2 },
        model: { providerID: "llamacpp", id: "old-context" },
      },
    })

    expect(usage).toEqual({
      tokens: 8_300,
      percent: 4.2,
      contextLimit: "200.0K",
      context: "8.3K (4.2%)",
      cost: undefined,
    })
  })
})
