import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})

test("renders Protocolo de Objetivos guidance when objective_manage is present", () => {
  const prompt = SessionSystemPrompt.make(["objective_manage", "read"])
  expect(prompt).toContain("Protocolo de Objetivos (Objectives Protocol)")
  expect(prompt).toContain("protocolo de objetivos")
  expect(prompt).toContain("protocolo de investigacion")
  expect(prompt).toContain("Mandatory Planning Trigger")
  expect(prompt).toContain("Order of Operations: You MUST construct the objective plan FIRST")
  expect(prompt).toContain("Dynamic Secondary Objective Discovery")
  expect(prompt).toContain("Before delivering the final response to the user, your first action must be to update and reconcile all objectives")
  expect(prompt).toContain("complete_primary")
  expect(prompt).toContain("Immediately after a compaction finishes, you must first review the preserved objective progress")
  expect(prompt).toContain("Iterative Objective Sync")
  expect(prompt).toContain("preserving llama.cpp prefix caching across turns")
})

test("renders subagent concurrency (slots - 1) and task sizing guidance", () => {
  ;(globalThis as any).__OPENCODE_TOTAL_SLOTS__ = 3
  ;(globalThis as any).__OPENCODE_MAX_SUBAGENTS__ = 2
  const prompt3 = SessionSystemPrompt.make(["subagent"])
  expect(prompt3).toContain("slots - 1 = 2 subagents out of 3 total slots")
  expect(prompt3).toContain("Do NOT delegate overly large tasks to subagents")
  expect(prompt3).toContain("medium-sized, achievable tasks")
  expect(prompt3).toContain("split it into several smaller subagent tasks whenever possible")
  delete (globalThis as any).__OPENCODE_TOTAL_SLOTS__
  delete (globalThis as any).__OPENCODE_MAX_SUBAGENTS__
})
