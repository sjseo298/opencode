import { Plugin as OpenCodePlugin } from "@opencode/plugin"
import { getObjectivesConfig } from "./objectives-model.js"

type Options = {
  orchestratorGuide?: string
  subagentProtocol?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR GUIDE
// Injected into Subagent tool description to guide the orchestrating agent
// ─────────────────────────────────────────────────────────────────────────────

export function getDetectedSubagentCapacity(): { totalSlots: number; maxSubagents: number } {
  const g = globalThis as any
  const rawSlots = g.__OPENCODE_DYNAMIC_CONTEXT__?.getTotalSlots?.() ?? g.__OPENCODE_TOTAL_SLOTS__
  const rawMaxSub = g.__OPENCODE_DYNAMIC_CONTEXT__?.getMaxSubagents?.() ?? g.__OPENCODE_MAX_SUBAGENTS__
  const totalSlots =
    typeof rawSlots === "number" && Number.isFinite(rawSlots) && rawSlots >= 2
      ? Math.floor(rawSlots)
      : typeof rawMaxSub === "number" && Number.isFinite(rawMaxSub) && rawMaxSub >= 1
        ? Math.floor(rawMaxSub) + 1
        : 2
  const maxSubagents =
    typeof rawMaxSub === "number" && Number.isFinite(rawMaxSub) && rawMaxSub >= 1
      ? Math.floor(rawMaxSub)
      : Math.max(1, totalSlots - 1)
  return { totalSlots, maxSubagents }
}

export function buildOrchestratorGuide(capacity = getDetectedSubagentCapacity()): string {
  const { totalSlots, maxSubagents } = capacity
  const concurrencyHeader =
    maxSubagents <= 1
      ? `## Subagent Delegation & Concurrency Policy: Strictly 1 Subagent At A Time (slots - 1 = 1 of ${totalSlots} slots)`
      : `## Subagent Delegation & Concurrency Policy: Up To ${maxSubagents} Subagents At A Time (slots - 1 = ${maxSubagents} of ${totalSlots} slots)`

  const concurrencyBullets =
    maxSubagents <= 1
      ? `- Server Capacity Rule (\`max_subagents = total_slots - 1\`): The server reports ${totalSlots} parallel slots; 1 slot is used by your active primary session, leaving **1 subagent slot** available.
- CRITICAL CONCURRENCY RULE: Delegate to only ONE subagent at a time. Never launch multiple subagents in parallel or concurrently.
- Wait for the active subagent to conclude, review its evidence and output, and integrate it into your active objective before delegating any subsequent task.`
      : `- Server Capacity Rule (\`max_subagents = total_slots - 1\`): The server reports ${totalSlots} parallel slots; 1 slot is used by your active primary session, leaving **up to ${maxSubagents} concurrent subagents** available.
- CRITICAL CONCURRENCY RULE: You may enable at most **${maxSubagents} subagents** concurrently (${totalSlots} total slots minus 1 active primary slot). Never exceed ${maxSubagents} simultaneous subagents.`

  return `${concurrencyHeader}
- You can leverage subagents to offload focused, deep investigations or isolated subtasks to preserve your context window.
${concurrencyBullets}
- TASK SIZING & CONTEXT PROTECTION RULE (MANDATORY):
  * Do NOT delegate overly large tasks to subagents, or they will run out of available context before completing their work.
  * Always assign **medium-sized, achievable tasks** (tareas medianas y realizables) with a bounded scope.
  * If a task is large, **split it into several smaller subagent tasks whenever possible** (partir las tareas grandes en varias subtareas si es posible).
  * Only as a **last resort** (en último caso)—when a task genuinely cannot be split—delegate the task to the subagent so it does what it needs to do.
- MANDATORY CONTEXT BUDGET VERIFICATION (GATEKEEPER):
  * You MUST invoke the \`context_budget\` tool BEFORE calling \`subagent\`.
  * Read \`availableHeadroom\` and \`maxRecommendedSubagentBudget\` (calculated dynamically based on available context and concurrency slots: \`(headroom - parentReserve) / maxSubagents\`).
  * Pass the measured value into \`subagent({ ..., contextBudget: { availableHeadroom: <number> } })\`. Omitting this parameter causes the tool to reject the delegation call.
  * If the task to delegate is estimated to exceed \`maxRecommendedSubagentBudget\`, you MUST decompose it into smaller Level-3 subtasks (SO-N-T1...SO-N-TN; create as many as needed, not limited to 3) rather than delegating an oversized monolithic task. (Note: 'Tertiary' denotes Level-3 hierarchy depth [PO -> SO -> TO], NEVER a fixed count of 3; create 2, 4, 6 or as many subtasks as required).

## Structured Prompt Format (Required)

When delegating to a subagent, your prompt MUST include these three sections:

### SCOPE
Define WHERE and WHAT the subagent can access:
- Location: local | reference:<name> | /specific/path
- Files: explicit paths or glob patterns to work with
- Constraints: read-only | can-modify | can-create

### OBJECTIVE
Define WHAT must be achieved:
- Goal: clear description of the expected outcome
- Success criteria: how to verify the task completed correctly
- Restrictions: what the subagent must NOT do

### OUTPUT
Define WHAT must be returned:
- Format: summary | list | code | detailed-analysis
- Include: specific data points or information required
- Detail: minimal | normal | exhaustive

### Example Prompt

\`\`\`
## SCOPE
- Location: local
- Files: packages/core/src/tool/*.ts
- Constraints: read-only

## OBJECTIVE
- Goal: Find all tools that accept a sessionID parameter
- Success criteria: Complete list with file:line references
- Restrictions: Do not modify any files

## OUTPUT
- Format: list
- Include: tool name, file path, line number, parameter signature
- Detail: normal
\`\`\`

If any section is missing or ambiguous, the subagent will return an <execution_blocked> response requesting the missing information. You must then relaunch with a clarified prompt.`
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBAGENT VALIDATION PROTOCOL
// Injected into subagent system prompt
// ─────────────────────────────────────────────────────────────────────────────

const defaultSubagentProtocol = `# SUBAGENT EXECUTION PROTOCOL

You are a subagent. Your orchestrating agent delegated a specific task to you.
Execute with strict precision. Do NOT assume anything outside explicit instructions.

## REQUIRED PROMPT STRUCTURE

Your orchestrator MUST provide a prompt with these three sections. If any is missing or unclear, you MUST block execution.

### SCOPE (Where and What)
Defines your operational boundaries:
- **Location**: Where files/resources exist (local workspace, remote reference, specific paths)
- **Files/Directories**: Explicit list or glob patterns you should work with
- **Constraints**: Your permissions (read-only, can-modify, can-create)

### OBJECTIVE (What to Achieve)
Defines your mission:
- **Goal**: Clear description of the expected outcome
- **Success criteria**: How to verify the task completed correctly
- **Restrictions**: What you must NOT do

### OUTPUT (What to Return)
Defines your deliverable:
- **Format**: The structure of your response (summary, list, code, analysis)
- **Include**: Specific data points required in your response
- **Detail level**: How comprehensive (minimal, normal, exhaustive)

## PRE-EXECUTION VALIDATION CHECKLIST

Before doing ANY work, you MUST verify:

### 1. SCOPE Validation
[ ] Location is explicitly stated (not implied or assumed)
[ ] If location is "local", verify referenced files/directories exist
[ ] If location is a "reference:<name>", confirm the reference is accessible
[ ] Constraints are clear (what you can/cannot modify)

**BLOCK IF:**
- Location says "local" but files don't exist in local workspace
- Files are mentioned but location is not specified
- You're asked to modify files but constraints say "read-only"
- Reference is mentioned but not available in your context

### 2. OBJECTIVE Validation
[ ] Goal is specific and achievable with the given scope
[ ] Success criteria is measurable or verifiable
[ ] Restrictions are compatible with the goal

**BLOCK IF:**
- Goal requires resources outside the defined scope
- Success criteria cannot be evaluated
- Restrictions contradict the goal
- Steps are mutually exclusive or contradictory

### 3. OUTPUT Validation
[ ] Format is explicitly specified
[ ] Required information is clearly listed
[ ] Detail level matches the task complexity

**BLOCK IF:**
- No output format specified (you don't know what to return)
- Required information is ambiguous
- You cannot produce the requested format with available data

## BLOCKING PROTOCOL

If ANY validation fails, DO NOT proceed with the task.
Return IMMEDIATELY with this structured response:

<execution_blocked>
  <aspect>[SCOPE | OBJECTIVE | OUTPUT]</aspect>
  <issue>[What is unclear, missing, or inconsistent]</issue>
  <evidence>
    <checked>[What you attempted to verify]</checked>
    <found>[What you actually found or determined]</found>
    <expected>[What the prompt implied should exist]</expected>
  </evidence>
  <missing>[Exact information or clarification needed]</missing>
  <suggested_relaunch>
[Provide a corrected prompt the orchestrator should use to relaunch this task.
Include all three sections (SCOPE, OBJECTIVE, OUTPUT) with the missing information filled in or marked with [FILL: description].]
  </suggested_relaunch>
</execution_blocked>

## EXAMPLES OF BLOCKING SITUATIONS

### Example 1: Ambiguous Location
Prompt says: "Review the TypeScript files for errors"
**Problem**: No location specified. Are these local files? A reference? Which directory?
**Block with**: aspect=SCOPE, missing="Location not specified. Provide: Location: local|reference:<name>|/path"

### Example 2: Non-existent Resources
Prompt says: "SCOPE: Location: local, Files: src/legacy/*.ts"
**Problem**: You check and src/legacy/ doesn't exist locally
**Block with**: aspect=SCOPE, checked="Existence of src/legacy/", found="Directory does not exist", expected="Directory with TypeScript files"

### Example 3: Contradictory Instructions
Prompt says: "Constraints: read-only" but Objective says "Fix all type errors"
**Problem**: Cannot fix errors without modifying files
**Block with**: aspect=OBJECTIVE, issue="Goal requires modification but constraints are read-only"

### Example 4: Missing Output Format
Prompt says: "Analyze the authentication flow"
**Problem**: No OUTPUT section. Should you return a summary? A diagram? Code suggestions?
**Block with**: aspect=OUTPUT, missing="Output format not specified"

### Example 5: Scope References Unavailable Data
Prompt says: "SCOPE: Location: reference:legacy-docs"
**Problem**: The reference "legacy-docs" is not available in your context
**Block with**: aspect=SCOPE, checked="Availability of reference:legacy-docs", found="Reference not accessible", missing="Provide accessible reference or change location to local path"

## EXECUTION RULES

1. **Never assume** missing information - always block and ask
2. **Never proceed** with ambiguous scope - location must be explicit
3. **Never guess** output format - it must be specified
4. **Always verify** file/path existence before working on them
5. **Always check** that referenced resources are accessible
6. **If in doubt**, block and request clarification

## SUCCESSFUL EXECUTION

If all validations pass:
1. Proceed with the task as specified
2. Follow the output format exactly
3. Include all requested information
4. Match the specified detail level
5. Respect all restrictions

## CONTEXT BUDGET & PRE-COMPACTION AWARENESS

You operate within a bounded context window. As you explore, read files, or run commands, context accumulates.
- **Normal Operation**: Complete your assigned task thoroughly within your SCOPE.
- **Pre-Compaction Advisory**: If you receive a [CRITICAL PRE-COMPACTION ADVISORY] notification block in your instructions, you have reached 90% of your context window ceiling before automatic compaction triggers (10% or less remaining).
- **Action Required on Advisory**:
  1. Immediately HALT new extensive explorations, directory crawls, or tool calls.
  2. Consolidate your current discoveries and partial results.
  3. Emit your structured deliverable (\`OUTPUT\`) to the orchestrator before compaction occurs so that your detailed analysis is not lost.`

export const SUBAGENT_PRE_COMPACTION_ADVISORY = `## ⚠️ CRITICAL PRE-COMPACTION ADVISORY (Context Limit Imminent)
You have reached 90% or more of your context window ceiling before automatic compaction occurs (10% or less context remaining).
To prevent the loss of intermediate discoveries, file analysis, or in-flight progress:
1. STOP: Do not execute new broad searches, heavy read actions, or open additional files.
2. CONSOLIDATE: Immediately organize, synthesize, and record your key findings, answers, and evidence.
3. CONCLUDE: Produce and return your final structured deliverable (<OUTPUT>) to the parent session now.`

export const PRIMARY_PRE_COMPACTION_ADVISORY = `## ⚠️ CRITICAL PRE-COMPACTION ADVISORY (Context Limit Imminent)
You have reached 85% or more of your available context window ceiling before automatic compaction occurs (15% or less context remaining).
To preserve fine-grained details, avoid mid-task disruption, and maintain complete control over what is summarized:
1. HALT NEW DISCOVERY: Do not open large new files, run expansive codebase searches, or start deep secondary investigations.
2. CONSOLIDATE STATE: Finish open file edits cleanly, commit any verified changes, and update your active objectives via \`objective_manage\`.
3. VOLUNTARY COMPACTION: Invoke the \`session_compact\` tool, supplying \`summaryNotes\` with your current state, key decisions, and immediate next move so they are explicitly preserved in the next checkpoint.
4. SAFETY FALLBACK: If you do not invoke \`session_compact\`, automatic compaction will trigger automatically as a safety net when the context ceiling is reached.`

export function estimateMessageTokens(messages?: ReadonlyArray<any>): number {
  if (!messages || !messages.length) return 0
  const anchor = messages.findLast((m) => m.type === "assistant" && m.tokens)
  if (anchor && anchor.tokens) {
    const t = anchor.tokens
    let total = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.output ?? 0)
    const anchorIdx = messages.indexOf(anchor)
    for (let i = anchorIdx + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === "text" && typeof p.text === "string") {
            total += Math.ceil(p.text.length / 4)
          }
        }
      } else if (typeof msg.text === "string") {
        total += Math.ceil(msg.text.length / 4)
      }
    }
    return total
  }

  let total = 0
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p.type === "text" && typeof p.text === "string") {
          total += Math.ceil(p.text.length / 4)
        }
      }
    } else if (typeof msg.text === "string") {
      total += Math.ceil(msg.text.length / 4)
    }
  }
  return total
}

export function getEffectiveContextLimit(
  model?: { providerID?: string; id?: string; limit?: { context?: number } },
): number {
  const g = globalThis as any
  const dynamicStore = g.__OPENCODE_DYNAMIC_CONTEXT__
  if (model?.providerID && model?.id) {
    const key = `${model.providerID}/${model.id}`
    const dynamicLimit = dynamicStore?.getLimit?.(key)
    if (typeof dynamicLimit === "number" && Number.isFinite(dynamicLimit) && dynamicLimit > 0) {
      return dynamicLimit
    }
  }
  if (typeof model?.limit?.context === "number" && Number.isFinite(model.limit.context) && model.limit.context > 0) {
    return model.limit.context
  }
  return 128_000
}

function normalizeString(input: unknown, fallback: string) {
  if (typeof input !== "string") return fallback
  const text = input.trim()
  if (!text.length) return fallback
  return text
}

export const Plugin = OpenCodePlugin.define({
  id: "subagent-mandatory-instruction",
  async setup(ctx) {
    const opts = ctx.options as Options | undefined
    const customOrchestratorGuide =
      typeof opts?.orchestratorGuide === "string" && opts.orchestratorGuide.trim().length > 0
        ? opts.orchestratorGuide.trim()
        : undefined
    const subagentProtocol = normalizeString(opts?.subagentProtocol, defaultSubagentProtocol)
    const sessionParentCache = new Map<string, boolean>()

    async function isSubagentSession(sessionID: string) {
      const cached = sessionParentCache.get(sessionID)
      if (cached !== undefined) return cached
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      const hasParent = typeof session?.parentID === "string" && session.parentID.length > 0
      sessionParentCache.set(sessionID, hasParent)
      return hasParent
    }

    // Inject structured prompt guide into subagent tool description for orchestrators
    await ctx.tool.transform((editor) => {
      editor.update("subagent", (tool) => {
        const guide = customOrchestratorGuide ?? buildOrchestratorGuide()
        if (tool.description && !tool.description.includes("## Structured Prompt Format")) {
          tool.description = [tool.description, guide].join("\n\n")
        }
      })
    })

    // Inject validation protocol into subagent system prompt, or update subagent tool capacity on parent context
    await ctx.session.hook("context", async (event) => {
      if (!event.sessionID) return
      if (!(await isSubagentSession(event.sessionID))) {
        // Para modelos locales que no sean llamacpp (ej. esca, mlx), preservar la invariancia
        // estricta del prefijo en la descripción de herramientas para evitar cache misses en cada turno.
        const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
        const modelId = session?.model?.id?.toLowerCase() ?? ""
        const isMlxOrEsca =
          modelId.startsWith("esca/") ||
          modelId.startsWith("escha/") ||
          modelId.startsWith("mlx/") ||
          modelId.includes("escha") ||
          modelId.includes("esca") ||
          modelId.includes("mlx")

        if (!isMlxOrEsca && !customOrchestratorGuide && (event as any).tools?.subagent?.description) {
          const desc: string = (event as any).tools.subagent.description
          const markerIdx = desc.indexOf("## Subagent Delegation & Concurrency Policy:")
          const guide = buildOrchestratorGuide()
          if (markerIdx !== -1) {
            ;(event as any).tools.subagent.description = desc.slice(0, markerIdx).trimEnd() + "\n\n" + guide
          } else if (!desc.includes("## Structured Prompt Format")) {
            ;(event as any).tools.subagent.description = [desc, guide].join("\n\n")
          }
        }

        if (event.messages && Array.isArray(event.messages) && event.messages.length > 0) {
          const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
          const limit = getEffectiveContextLimit(session?.model)
          const safetyBuffer = Math.min(15_000, Math.floor(limit * 0.15))
          const ceiling = Math.max(10_000, limit - safetyBuffer)
          const usedTokens = estimateMessageTokens(event.messages)
          const primaryPct = getObjectivesConfig(event.sessionID).primaryPreCompactionThreshold / 100
          const warningThreshold = Math.floor(ceiling * primaryPct)

          if (usedTokens >= warningThreshold) {
            if (!event.system.some((item) => (item.text ?? "").includes("## ⚠️ CRITICAL PRE-COMPACTION ADVISORY"))) {
              event.system.push({ type: "text", text: PRIMARY_PRE_COMPACTION_ADVISORY })
            }
          }
        }
        return
      }
      if (!event.system.some((item) => (item.text ?? "").includes("SUBAGENT EXECUTION PROTOCOL"))) {
        if (event.system.length > 0) {
          event.system[0] = { ...event.system[0], text: subagentProtocol + "\n\n" + event.system[0].text }
        } else {
          event.system.push({ type: "text", text: subagentProtocol })
        }
      }

      if (event.messages && Array.isArray(event.messages) && event.messages.length > 0) {
        const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
        const limit = getEffectiveContextLimit(session?.model)
        const safetyBuffer = Math.min(15_000, Math.floor(limit * 0.15))
        const ceiling = Math.max(10_000, limit - safetyBuffer)
        const usedTokens = estimateMessageTokens(event.messages)
        const subagentPct = getObjectivesConfig(event.sessionID).subagentPreCompactionThreshold / 100
        const warningThreshold = Math.floor(ceiling * subagentPct)

        if (usedTokens >= warningThreshold) {
          if (!event.system.some((item) => (item.text ?? "").includes("## ⚠️ CRITICAL PRE-COMPACTION ADVISORY"))) {
            event.system.push({ type: "text", text: SUBAGENT_PRE_COMPACTION_ADVISORY })
          }
        }
      }
    })
  },
})

export default Plugin
