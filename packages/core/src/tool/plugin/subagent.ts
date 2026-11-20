export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Predicate, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Model } from "../../model.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentDepth } from "../../session/subagent-depth.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { LlamaCppKV } from "../../session/llamacpp-kv.js"
import { getObjectivesConfig } from "../../plugin/builtin/objectives-model.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is queued to start working in the background once this session stops and becomes idle (sessionID: ${sessionID}). You will receive a <background-result kind="subagent"> message when it goes idle, and again after each later round of work.`,
    "DO NOT sleep, poll, proactively check on its progress, or duplicate this subagent's work.",
    "Briefly tell the user what you launched and end your response so the subagent can start.",
    "To send it follow-ups or change its instructions, call subagent again with this sessionID. If a subagent stalls or fails to start after a restart, call subagent with action: \"resume\" and this sessionID.",
  ].join("\n"),
})

const resumeResult = (sessionID: SessionSchema.ID, ensured: SubagentJob.EnsureResult) => {
  if (ensured.status === "running") {
    if (ensured.state === "active") {
      return {
        sessionID,
        status: "running" as const,
        output: [
          `Subagent is already running (sessionID: ${sessionID}).`,
          "End your response and wait for its <subagent> completion message.",
        ].join("\n"),
      }
    }
    if (ensured.state === "queued") {
      return {
        sessionID,
        status: "running" as const,
        output: [
          `Subagent is already queued to start working in the background once this session becomes idle (sessionID: ${sessionID}).`,
          "Briefly end your response so the subagent can start.",
        ].join("\n"),
      }
    }
    return {
      sessionID,
      status: "running" as const,
      output: [
        `Subagent recovery queued to start working in the background once this session becomes idle (sessionID: ${sessionID}).`,
        "End your response immediately so the subagent can resume.",
      ].join("\n"),
    }
  }
  const verb = ensured.state === "delivered" ? "already finished and its report has been delivered" : "already settled"
  return {
    sessionID,
    status: ensured.status,
    output: [
      `Subagent ${sessionID} ${verb} (status: ${ensured.status}).`,
      "",
      ensured.body,
    ].join("\n"),
  }
}

export const Input = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["start", "resume"])).annotate({
    description:
      'Action to perform: "start" (default: spawn a new subagent or send a follow-up prompt) or "resume" (idempotently start, resume, or collect status of an existing subagent by sessionID without duplicating prompts or requiring contextBudget).',
  }),
  agent: Schema.optionalKey(Schema.String).annotate({
    description:
      "The type of specialized agent to use for this task (required for action \"start\"). If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: 'A short 3-5 word label for the task, displayed to the user (required for action "start")',
  }),
  prompt: Schema.optionalKey(Schema.String).annotate({
    description: 'The task for the subagent to perform (required for action "start"; optional for action "resume")',
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can\'t run subagents. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      'Existing subagent sessionID. Omit to start a new subagent; pass with action "start" for a follow-up, or with action "resume" to idempotently ensure it starts/recovers.',
  }),
  contextBudget: Schema.optionalKey(
    Schema.Struct({
      availableHeadroom: Schema.Number.annotate({
        description:
          "Available context headroom measured via the context_budget tool. MANDATORY: You must call context_budget first and pass the verified number.",
      }),
      estimatedTaskTokens: Schema.optionalKey(Schema.Number).annotate({
        description:
          "Optional estimate of tokens this delegated subtask will consume (reads, logs, output).",
      }),
    }),
  ).annotate({
    description:
      'MANDATORY context verification for action "start": You must run context_budget before spawning/prompting a subagent.',
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task, or idempotently resumes an existing child session.",
  'Subagents always run in the background after the parent stops: the call returns immediately with a sessionID, the child begins once this parent session reaches idle, and you receive a `<background-result kind="subagent">` message each time the child goes idle, including after later work.',
  "Briefly tell the user what you launched and end your response so the child can start. Do not sleep, poll, or proactively check on the child's progress.",
  "If an existing subagent appears stalled or failed to resume (for instance after a restart), call `subagent` with `action: \"resume\"` and its `sessionID` (idempotent; no duplicate prompt or `context_budget` required) to ensure it starts or retrieve its settled state.",
  "MANDATORY REQUIREMENT for `action: \"start\"`: You MUST invoke the `context_budget` tool BEFORE calling this tool, and provide `contextBudget: { availableHeadroom: <number> }`.",
  "Verify that the task fits into `maxRecommendedSubagentBudget`. If it exceeds that budget, decompose the task into smaller Level-3 subtasks (SO-N-T1...SO-N-TN; create as many as needed, not limited to 3) instead of spawning an oversized subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Pass the returned sessionID to continue that specific child conversation. A follow-up to a running child joins its current run.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (model === undefined) {
        const other = (yield* models.available(["image", "video", "decision"])).find(
          (model) => model.providerID === ref.providerID && model.id === ref.id,
        )
        return yield* new ToolFailure({
          message: other
            ? `Model "${ref.providerID}/${ref.id}" is ${other.type === "image" ? "an image" : other.type === "video" ? "a video" : "a decision"} model; subagents need a chat model. Use the models tool to find one.`
            : `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      }
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const mode = input.action ?? "start"
              if (mode === "resume") {
                if (input.sessionID === undefined) {
                  return yield* new ToolFailure({
                    message: 'Parameter "sessionID" is required when action is "resume".',
                  })
                }
                const existing = yield* sessions
                  .get(input.sessionID)
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                    ),
                  )
                if (existing.parentID !== context.sessionID)
                  return yield* new ToolFailure({
                    message: `Session ${existing.id} is not a child of the current session`,
                  })
                const agentName = input.agent ?? existing.agent ?? "general"
                const agent = yield* agents.resolve(agentName)
                if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${agentName}` })
                if (agent.mode === "primary")
                  return yield* new ToolFailure({ message: `Agent ${agentName} cannot run as a subagent` })
                yield* permission
                  .assert({
                    action: name,
                    resources: [agent.id],
                    save: [agent.id],
                    ...Permission.invocation(context),
                  })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

                const override = input.model === undefined ? undefined : yield* resolveModel(input.model)
                const switched = input.agent !== undefined && existing.agent !== agent.id
                const model = override ?? (switched ? agent.model : undefined)
                if (switched || model !== undefined) {
                  yield* Effect.all([
                    switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                    model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                  ]).pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                    ),
                  )
                }

                const promptText = input.prompt?.trim()
                const active = (yield* sessions.active).has(existing.id)
                if (promptText) {
                  yield* sessions
                    .prompt({
                      sessionID: existing.id,
                      text: promptText,
                      ...(active ? {} : { resume: false }),
                    })
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: `Failed to prompt subagent: ${existing.id}`, error }),
                      ),
                    )
                }

                const ensured = yield* subagents.ensure(
                  {
                    kind: "subagent",
                    parentSessionID: context.sessionID,
                    childSessionID: existing.id,
                    agent: agent.name,
                    description: input.description ?? existing.title ?? "Subagent",
                  },
                  { hasNewWork: Boolean(promptText) },
                )
                if (ensured.status === "running") {
                  yield* context.progress({ sessionID: existing.id, status: "running" })
                }
                return resumeResult(existing.id, ensured)
              }

              if (
                input.contextBudget?.availableHeadroom === undefined ||
                typeof input.contextBudget.availableHeadroom !== "number" ||
                input.contextBudget.availableHeadroom <= 0
              ) {
                return yield* new ToolFailure({
                  message: [
                    "Delegation blocked: Missing context headroom verification.",
                    "Before delegating work to any subagent, you MUST call the `context_budget` tool to inspect available tokens and task sizing limits.",
                    "Then invoke `subagent` including `contextBudget: { availableHeadroom: <measured_number> }`.",
                    "If the intended task exceeds `maxRecommendedSubagentBudget`, decompose the objective into smaller Level-3 subtasks (SO-N-T1...SO-N-TN; create as many as needed, not limited to 3) first.",
                  ].join("\n"),
                })
              }

              const MIN_SUBAGENT_BUDGET = 16_000
              if (input.contextBudget.availableHeadroom < MIN_SUBAGENT_BUDGET) {
                return yield* new ToolFailure({
                  message: [
                    `Delegation rejected: Insufficient context budget (${input.contextBudget.availableHeadroom} tokens available, minimum required is ${MIN_SUBAGENT_BUDGET} tokens).`,
                    "The server cannot allocate a safe KV context for a subagent without risking immediate context exhaustion.",
                    "You must perform this task directly in the main thread (mode: 'main'), or voluntarily trigger compaction on the parent session first to reclaim working context.",
                  ].join("\n"),
                })
              }

              if (!input.agent || !input.description || input.prompt === undefined) {
                return yield* new ToolFailure({
                  message: 'Parameters "agent", "description", and "prompt" are required when action is "start".',
                })
              }
              const agentInput = input.agent
              const taskDescription = input.description
              const taskPrompt = input.prompt

              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              const limit = yield* SubagentDepth.reached(parent, sessions, config).pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Parent session not found: ${error.sessionID}`, error }),
                ),
              )
              if (limit !== undefined)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                })
              const agent = yield* agents.resolve(agentInput)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${agentInput}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${agentInput} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  ...Permission.invocation(context),
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              const objectivesCfg = getObjectivesConfig(context.sessionID)
              const configuredSubagentModel =
                objectivesCfg.subagentModel !== undefined
                  ? yield* resolveModel(objectivesCfg.subagentModel)
                  : undefined

              const override =
                input.model === undefined
                  ? configuredSubagentModel
                  : yield* resolveModel(input.model)
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              if (existing !== undefined) {
                const switched = existing.agent !== agent.id
                const model = override ?? (switched ? agent.model : undefined)
                yield* Effect.all([
                  switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                  model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                ]).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              const model = override ?? agent.model ?? parent.model
              const child =
                existing ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: taskDescription,
                    agent: agent.id,
                    model,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))

              // Only wake an already-draining child directly; an idle child or one still waiting
              // for the parent to go idle must be admitted without waking so the job owns its start.
              const active = existing !== undefined && (yield* sessions.active).has(existing.id)
              yield* context.progress({ sessionID: child.id, status: "running" })

              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? ["You are a subagent spawned by another session.", taskPrompt].join("\n")
                      : taskPrompt,
                  ...(active ? {} : { resume: false }),
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const recovery = {
                kind: "subagent" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agent.name,
                description: taskDescription,
              }
              LlamaCppKV.setPendingTaskEstimate(child.id, input.contextBudget.estimatedTaskTokens)
              if (existing !== undefined) yield* subagents.ensure(recovery, { hasNewWork: true })
              else yield* subagents.start(recovery)
              return backgroundResult(child.id)
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
