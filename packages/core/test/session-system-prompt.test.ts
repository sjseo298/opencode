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
})

