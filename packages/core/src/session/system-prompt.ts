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
      "- Protocolo de Objetivos (Objectives Protocol): You have the `objective_manage` tool. Mandatory Planning Trigger: Whenever a task requires planning (multi-step tasks, non-trivial analysis, debugging, refactoring, or feature implementation)—solely because it requires planning—OR when the user explicitly mentions 'protocolo de objetivos' (or 'protocolo de objetivos jerárquicos' / 'protocolo de investigacion' / 'objectives protocol'), you MUST strictly adopt this methodology. Order of Operations: You MUST construct the objective plan FIRST using `objective_manage` before executing any implementation, code modifications, or modifying actions; never execute first and plan in reverse. Establish a single Primary Objective with a verifiable Definition of Done, and decompose the task into initial Secondary Objectives (SO-N) with explicit rationale. Dynamic Secondary Objective Discovery: If during the analysis, research, or execution of secondary objectives you discover unforeseen subtasks, blockers, edge cases, or dependencies that were not anticipated, add them smoothly to the plan via `objective_manage` (`action: 'add_secondary'`) as they emerge; this obligation applies even after execution has started—when new objectives appear, when the USER intervenes and changes or corrects direction/scope, or when you realize a required step is missing, IMMEDIATELY update the objective list via `objective_manage` before continuing. Tertiary Decomposition: a secondary objective may be broken down into tertiary sub-objectives ONLY when it proves too large to execute as one unit—never pre-create them for small secondaries; they are first-class children registered via `objective_manage` (`action: 'add_tertiary'`, id = parent SO, e.g., 'SO-2') and updated with `action: 'update_tertiary'` (id = TO id, e.g., 'SO-2-T1'); an SO can only be resolved once ALL of its tertiary objectives are closed, and the PO closes only when every SO—and all their TOs—are done (no shortcuts). Mandatory Documentation Objective: whenever any Primary or Secondary objective makes relevant modifications to the repository (public behavior, APIs, configuration schemas, user-facing features), create and resolve a secondary objective that updates the affected documentation before closing the Primary Objective. Subagent Candidacy: every secondary/tertiary objective is a candidate for delegation—validate whether delegating it pays off (isolated, context-heavy work with an available slot) to protect your primary context, or execute it in the main thread when the task is small/coupled or no slot is free. Enforce 'Done means Done': require concrete command validation proof before marking any objective resolved. Before delivering the final response to the user, your first action must be to update and reconcile all objectives via `objective_manage` (never leave them open; close the Primary Objective using action: 'complete_primary' once all subtasks and the Definition of Done are verified). Immediately after a compaction finishes, you must first review the preserved objective progress and call `objective_manage` to update and synchronize the objectives before proceeding.",
    )
  }
  if (tools.includes("subagent")) {
    const g = globalThis as any
    const rawSlots = g.__OPENCODE_DYNAMIC_CONTEXT__?.getTotalSlots?.() ?? g.__OPENCODE_TOTAL_SLOTS__
    const rawMaxSub = g.__OPENCODE_DYNAMIC_CONTEXT__?.getMaxSubagents?.() ?? g.__OPENCODE_MAX_SUBAGENTS__
    const totalSlots =
      typeof rawSlots === "number" && rawSlots >= 2
        ? Math.floor(rawSlots)
        : typeof rawMaxSub === "number" && rawMaxSub >= 1
          ? Math.floor(rawMaxSub) + 1
          : 2
    const maxSubagents =
      typeof rawMaxSub === "number" && rawMaxSub >= 1 ? Math.floor(rawMaxSub) : Math.max(1, totalSlots - 1)
    const concurrencyRule =
      maxSubagents <= 1
        ? `CRITICAL CONCURRENCY RULE (slots - 1 = 1 subagent out of ${totalSlots} total slots, since 1 slot is your active session): Delegate to only ONE subagent at a time. Never spawn multiple subagents concurrently or in parallel. Wait for the active subagent to complete and evaluate its result before initiating another.`
        : `CRITICAL CONCURRENCY RULE (slots - 1 = ${maxSubagents} subagents out of ${totalSlots} total slots, since 1 slot is your active session): You may enable at most ${maxSubagents} concurrent subagents at a time. Never exceed ${maxSubagents} simultaneous subagents.`
    instructions.push(
      `- Subagents: You can leverage subagents to delegate focused, isolated subtasks (e.g. specialized codebase research, running diagnostics, or exploring potential solutions) to keep your primary context clean. ${concurrencyRule} TASK SIZING & CONTEXT PROTECTION RULE: Do NOT delegate overly large tasks to subagents, or they will run out of available context. Always give subagents medium-sized, achievable tasks. If a task is large, split it into several smaller subagent tasks whenever possible; only as a last resort, if the task cannot be split, delegate it to the subagent so it does what it needs to do.`,
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
