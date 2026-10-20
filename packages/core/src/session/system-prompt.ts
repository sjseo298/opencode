export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"

export function make(tools: string[]) {
  return render(PROMPT, tools)
}

export function render(prompt: string, tools: string[]) {
  const instructions: string[] = []
  if (tools.includes("shell")) {
    instructions.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.includes("write")) {
    instructions.push(
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
    )
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  if (tools.includes("objective_manage")) {
    instructions.push(
      "- Protocolo de Objetivos (Objectives Protocol): You have the `objective_manage` tool. When instructed to follow or apply the 'protocolo de objetivos' (or 'protocolo de objetivos jerárquicos' / 'protocolo de investigacion' / 'objectives protocol'), you must strictly follow this methodology: establish a single Primary Objective with a verifiable Definition of Done, decompose the task into Secondary Objectives (SO-N) with explicit rationale, track blockers, and require concrete command validation proof before marking any objective resolved. Before delivering the final response to the user, your first action must be to update and reconcile all objectives via `objective_manage` (never leave them open). Immediately after a compaction finishes, you must first review the preserved objective progress and call `objective_manage` to update and synchronize the objectives before proceeding.",
    )
  }
  if (tools.includes("subagent")) {
    instructions.push(
      "- Subagents: You can leverage subagents to delegate focused, isolated subtasks (e.g. specialized codebase research, running diagnostics, or exploring potential solutions) to keep your primary context clean. CRITICAL CONCURRENCY RULE: Delegate to only ONE subagent at a time. Never spawn multiple subagents concurrently or in parallel. Wait for the active subagent to complete and evaluate its result before initiating another.",
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
