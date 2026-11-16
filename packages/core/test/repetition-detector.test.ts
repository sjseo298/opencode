import { describe, expect, test } from "bun:test"
import { RepetitionDetector } from "@opencode/core/session/runner/repetition-detector"

function feedInChunks(detector: RepetitionDetector.Detector, text: string, chunkSize = 24) {
  for (let i = 0; i < text.length; i += chunkSize) {
    const detected = detector.feed(text.slice(i, i + chunkSize))
    if (detected) return detected
  }
  return undefined
}

describe("RepetitionDetector", () => {
  test("detects an exact multi-line reasoning cycle (668-char period)", () => {
    const cycle = [
      'I think the word is "tuongo" -> "tuongo" ->',
      "",
      'OK the correct Spanish: "tuongo" -> "tuongo" ->',
      "",
      "I'm going to fix it to:",
      '"tuongo sensacion de aburrimiento" ->',
      "",
      "NO. The correct Spanish is:",
      '"tuongo" -> "tuongo" ->',
      "",
      'What if the word was "tuongo" -> "tuongo" ->',
      "",
      'Let me fix it to: "tuongo" -> "tuongo" ->',
      "",
      'The correct Spanish is: "tuongo" -> "tuongo" ->',
      "",
      'FINAL: I am replacing "tuongo sensacion de ennui" with:',
      '"tuongo sensacion de aburrimiento" ->',
      "",
      "Wait, let me re-verify S051 one more time:",
    ].join("\n")
    expect(cycle.length).toBeGreaterThan(450)

    const prefix = "Let me review segment S051 carefully and check the phrasing against the glossary. "
    const detector = RepetitionDetector.create("reasoning")
    const detected = feedInChunks(detector, prefix + cycle.repeat(6))

    expect(detected).toBeDefined()
    expect(detected?.kind).toBe("reasoning")
    expect(detected?.reason).toBe("exact-cycle")
    expect(detected?.period).toBe(cycle.length)
    expect(detected?.totalChars).toBeLessThan(prefix.length + cycle.length * 5)
    expect(detected?.sample).toContain("tuongo")
  })

  test("detects near-identical oscillating loops via low-entropy signal", () => {
    const base = [
      'I think the word is "tuongo" -> "tuongo" ->',
      'OK the correct Spanish: "tuongo" -> "tuongo" ->',
      "I'm going to fix it to:",
      '"tuongo sensacion de aburrimiento" ->',
      "",
    ]
    const variants = [
      [...base, "NO! The correct Spanish is:", '"tuongo" -> "tuongo" ->', ""].join("\n"),
      [...base, "NO. The correct Spanish is:", '"tuongo" -> "tuongo" ->', ""].join("\n"),
      [...base, "Wait, the correct Spanish is:", '"tuongo" -> "tuongo" ->', ""].join("\n"),
    ]
    const schedule = [0, 1, 0, 2, 1, 2, 0, 0, 1, 2, 1, 0, 2, 1, 0, 1, 2, 0, 2, 2, 1, 0, 1, 2, 0, 1, 1, 2, 0, 2]
    let text = Array.from(
      { length: 30 },
      (_, i) => `Initial normal analysis #${i + 1} of paragraph S051 checking nuance and glossary alignment.`,
    ).join(" ")
    for (const index of schedule) {
      text += variants[index]
    }

    const detector = RepetitionDetector.create("reasoning")
    const detected = feedInChunks(detector, text, 32)

    expect(detected).toBeDefined()
    expect(detected?.kind).toBe("reasoning")
    expect(detected?.reason).toBe("low-entropy")
    expect(detected?.totalChars).toBeLessThan(text.length)
  })

  test("detects text loops with stricter thresholds", () => {
    const block =
      "We should also verify that every invariant holds across all downstream consumers before continuing.\n"
    const detector = RepetitionDetector.create("text")
    const detected = feedInChunks(detector, block.repeat(35), 40)

    expect(detected).toBeDefined()
    expect(detected?.kind).toBe("text")
    expect(detected?.reason).toBe("exact-cycle")
  })

  test("does not trigger on varied long reasoning", () => {
    const detector = RepetitionDetector.create("reasoning")
    const text = Array.from(
      { length: 200 },
      (_, i) =>
        `Segment S${String(i + 1).padStart(3, "0")}: checking translation nuance #${i * 7 + 13} for dialogue pacing, idiomatic tone, and glossary term ${i % 19}.`,
    ).join("\n")

    expect(text.length).toBeGreaterThan(20_000)
    expect(feedInChunks(detector, text, 64)).toBeUndefined()
  })

  test("ignores trivial separator or whitespace repetitions", () => {
    const detector = RepetitionDetector.create("text")
    const divider = `${"=".repeat(80)}\n`.repeat(40)
    expect(feedInChunks(detector, divider, 64)).toBeUndefined()
  })
})
