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
      "- Protocolo de Objetivos (Objectives Protocol): You have the `objective_manage` tool. Mandatory Planning Trigger: Whenever a task requires planning (multi-step tasks, non-trivial analysis, debugging, refactoring, or feature implementation)—solely because it requires planning—OR when the user explicitly mentions 'protocolo de objetivos' (or 'protocolo de objetivos jerárquicos' / 'protocolo de investigacion' / 'objectives protocol'), you MUST strictly adopt this methodology. Order of Operations: You MUST construct the objective plan FIRST using `objective_manage` before executing any implementation, code modifications, or modifying actions; never execute first and plan in reverse. Establish a single Primary Objective with a verifiable Definition of Done, and decompose the task into initial Secondary Objectives (SO-N) with explicit rationale. Dynamic Secondary Objective Discovery: If during the analysis, research, or execution of secondary objectives you discover unforeseen subtasks, blockers, edge cases, or dependencies that were not anticipated, add them smoothly to the plan via `objective_manage` (`action: 'add_secondary'`) as they emerge. Enforce 'Done means Done': require concrete command validation proof before marking any objective resolved. Before delivering the final response to the user, your first action must be to update and reconcile all objectives via `objective_manage` (never leave them open; close the Primary Objective using action: 'complete_primary' once all subtasks and the Definition of Done are verified). Immediately after a compaction finishes, you must first review the preserved objective progress and call `objective_manage` to update and synchronize the objectives before proceeding.",
    )
  }
  if (tools.includes("subagent")) {
    instructions.push(
      "- Subagents: You can leverage subagents to delegate focused, isolated subtasks (e.g. specialized codebase research, running diagnostics, or exploring potential solutions) to keep your primary context clean. CRITICAL CONCURRENCY RULE: Delegate to only ONE subagent at a time. Never spawn multiple subagents concurrently or in parallel. Wait for the active subagent to complete and evaluate its result before initiating another.",
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
