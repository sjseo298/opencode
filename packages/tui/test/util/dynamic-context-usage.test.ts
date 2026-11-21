import { describe, expect, it } from "bun:test"
import { contextUsage, formatContextUsage } from "../../src/util/session"

describe("contextUsage with dynamic context overrides", () => {
  it("formats tokens and percentages correctly", () => {
    expect(formatContextUsage(1000)).toBe("1.0K")
    expect(formatContextUsage(1000, 25)).toBe("1.0K (25%)")
  })

  it("uses static model context limit when no dynamic override is provided", () => {
    const messages: any[] = [
      {
        type: "assistant",
        model: { providerID: "llamacpp", id: "default" },
        tokens: {
          input: 1000,
          output: 500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ]
    const models: any[] = [
      {
        providerID: "llamacpp",
        id: "default",
        limit: { context: 262144 },
      },
    ]

    const usage = contextUsage(messages, models)
    expect(usage).toBeDefined()
    expect(usage?.tokens).toBe(1500)
    expect(usage?.contextLimit).toBe(262144)
    expect(usage?.percent).toBe(1) // 1500 / 262144 ≈ 0.57% -> 1%
  })

  it("overrides context limit dynamically when dynamic override provides effective limit", () => {
    const messages: any[] = [
      {
        type: "assistant",
        model: { providerID: "llamacpp", id: "default" },
        tokens: {
          input: 70000,
          output: 3700,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ]
    const models: any[] = [
      {
        providerID: "llamacpp",
        id: "default",
        limit: { context: 262144 },
      },
    ]

    const usage = contextUsage(messages, models, undefined, { limit: 186368 })
    expect(usage).toBeDefined()
    expect(usage?.tokens).toBe(73700)
    expect(usage?.contextLimit).toBe(186368)
    // 73700 / 186368 = 39.54% -> 40%
    expect(usage?.percent).toBe(40)
  })

  it("updates tokens dynamically when dynamic override reports live used tokens greater than last assistant message", () => {
    const messages: any[] = [
      {
        type: "assistant",
        model: { providerID: "llamacpp", id: "default" },
        tokens: {
          input: 70000,
          output: 3700,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ]
    const models: any[] = [
      {
        providerID: "llamacpp",
        id: "default",
        limit: { context: 262144 },
      },
    ]

    const usage = contextUsage(messages, models, undefined, { limit: 186368, used: 95000 })
    expect(usage).toBeDefined()
    expect(usage?.tokens).toBe(95000)
    expect(usage?.contextLimit).toBe(186368)
    // 95000 / 186368 = 50.97% -> 51%
    expect(usage?.percent).toBe(51)
  })
})
