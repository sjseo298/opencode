export * as SubagentJob from "./subagent-job.js"

import { Clock, Context, Effect, Layer, Option } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { SessionExecution } from "./execution.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionStore } from "./store.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

const MAX_RESUME_ATTEMPTS = 10

export type EnsureOptions = {
  /** True when the caller already enqueued fresh work (e.g. a follow-up prompt) in the child's inbox. */
  readonly hasNewWork?: boolean
}

export type EnsureResult =
  | {
      readonly status: "running"
      readonly state: "active" | "queued" | "resumed"
      readonly info: Job.Info
    }
  | {
      readonly status: Exclude<Job.Status, "running">
      readonly state: "delivered" | "idle"
      readonly body: string
    }

export interface Interface {
  readonly start: (recovery: Recovery) => Effect.Effect<Job.Info>
  readonly ensure: (recovery: Recovery, options?: EnsureOptions) => Effect.Effect<EnsureResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

const deliverReportToParent = Effect.fnUntraced(function* (
  jobs: Job.Interface,
  execution: SessionExecution.Interface,
  recovery: Recovery,
  report: Pick<Job.Info, "status" | "output" | "error"> & { readonly notificationID: SessionMessage.ID },
  store: SessionStore.Interface | undefined,
  inbox: SessionInbox.Interface | undefined,
  wakeParent: boolean,
) {
  if (!store || !inbox) {
    yield* jobs.completeBackground(report.notificationID)
    return
  }
  const parentID = recovery.parentSessionID
  if (!(yield* store.get(parentID))) {
    yield* jobs.completeBackground(report.notificationID)
    return
  }
  const delivered = yield* SubagentCompletion.deliver(
    {
      synthetic: (notice) =>
        inbox.admit({
          id: notice.id ?? report.notificationID,
          sessionID: notice.sessionID,
          item: {
            type: "synthetic",
            payload: SessionInbox.SyntheticPayload.make({
              text: notice.text,
              description: notice.description,
              metadata: notice.metadata,
            }),
            delivery: "steer",
          },
        }),
    },
    jobs,
    { ...report, recovery },
  ).pipe(
    Effect.as(true),
    Effect.catchTag("SessionInbox.LifecycleConflict", (conflict) =>
      Effect.logWarning("Subagent report notification ID conflicted in parent inbox", {
        childSessionID: recovery.childSessionID,
        parentSessionID: parentID,
        notificationID: report.notificationID,
        conflict,
      }).pipe(Effect.as(false)),
    ),
    Effect.catchDefect((defect) =>
      store
        .get(parentID)
        .pipe(
          Effect.flatMap((parent) =>
            parent === undefined ? jobs.completeBackground(report.notificationID).pipe(Effect.as(false)) : Effect.die(defect),
          ),
        ),
    ),
  )
  if (!delivered || !wakeParent) return
  if (yield* execution.isActive(parentID)) return
  const parent = yield* store.get(parentID)
  if (parent && !parent.revert) yield* execution.wake(parentID)
})

const deliverCancelledPreStart = (
  jobs: Job.Interface,
  execution: SessionExecution.Interface,
  recovery: Recovery,
  notificationID: SessionMessage.ID,
  store: SessionStore.Interface | undefined,
  inbox: SessionInbox.Interface | undefined,
) => deliverReportToParent(jobs, execution, recovery, { status: "cancelled", notificationID }, store, inbox, true)

const fallbackRunningInfo = (recovery: Recovery, started_at: number): Job.Info => ({
  id: recovery.childSessionID,
  type: "subagent",
  title: recovery.description,
  status: "running",
  started_at,
  metadata: {},
})

const childAlreadySettled = Effect.fnUntraced(function* (
  store: SessionStore.Interface,
  sessionID: Recovery["childSessionID"],
) {
  const latest = (yield* store.messages({ sessionID, limit: 1, order: "desc" }).pipe(Effect.orElseSucceed(() => []))).at(
    0,
  )
  if (!latest) return false
  if (latest.type === "idle") return true
  if (latest.type === "assistant") {
    return latest.error === undefined && latest.finish !== undefined && latest.finish !== "tool-calls"
  }
  return false
})

export function start(
  jobs: Job.Interface,
  execution: SessionExecution.Interface,
  recovery: Recovery,
  notificationID?: Job.Background["notificationID"],
  cancelPreStart?: (notificationID: SessionMessage.ID) => Effect.Effect<void>,
) {
  const id = recovery.childSessionID
  let started = false
  return jobs.start({
    id,
    type: "subagent",
    title: recovery.description,
    metadata: notificationID === undefined ? {} : undefined,
    recovery,
    notificationID,
    background: true,
    // Wait until the parent session finishes its active execution and goes idle before
    // starting the subagent, guaranteeing parent and child never run concurrently.
    run: execution.awaitIdle(recovery.parentSessionID).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          started = true
          return execution.resume(id)
        }),
      ),
      // Only an explicit caller cancel releases the child's claim. A server shutdown
      // interrupts this job but must leave the child resumable on the next start.
      Effect.onInterrupt(() =>
        jobs.isCancelled(id).pipe(
          Effect.flatMap((cancelled) => {
            if (!cancelled) return Effect.void
            if (started) return execution.interrupt(id)
            return Effect.gen(function* () {
              const info = yield* jobs.get(id)
              if (!info?.notificationID) return
              if (cancelPreStart) return yield* cancelPreStart(info.notificationID)
              yield* jobs.completeBackground(info.notificationID)
            })
          }),
        ),
      ),
      Effect.as(""),
    ),
  })
}

const make = Effect.gen(function* () {
  const execution = yield* SessionExecution.Service
  const jobs = yield* Job.Service
  const store = Option.getOrUndefined(yield* Effect.serviceOption(SessionStore.Service))
  const inbox = Option.getOrUndefined(yield* Effect.serviceOption(SessionInbox.Service))
  // Jobs outlive the plugin that launched them. Fork with the global context too, rather
  // than retaining the caller's location.
  const context = yield* Effect.context<never>()

  const cancelPreStart = (recovery: Recovery) => (notificationID: SessionMessage.ID) =>
    deliverCancelledPreStart(jobs, execution, recovery, notificationID, store, inbox)

  const ensure: Interface["ensure"] = (recovery, options) =>
    Effect.gen(function* () {
      const id = recovery.childSessionID
      if (yield* execution.isActive(id)) {
        const info = (yield* jobs.get(id)) ?? fallbackRunningInfo(recovery, yield* Clock.currentTimeMillis)
        return { status: "running", state: "active", info } satisfies EnsureResult
      }
      const live = yield* jobs.get(id)
      if (live?.status === "running") {
        return { status: "running", state: "queued", info: live } satisfies EnsureResult
      }

      const pendingRows = yield* jobs.pendingBackgroundFor(id)
      const terminalRows = pendingRows.filter(
        (row): row is Job.Background & { readonly status: Exclude<Job.Status, "running"> } => row.status !== "running",
      )
      for (const row of terminalRows) {
        yield* deliverReportToParent(jobs, execution, recovery, row, store, inbox, false)
      }
      const orphanedRunning = pendingRows.findLast((row) => row.status === "running")

      const hasPendingInbox = inbox ? (yield* inbox.list(id)).length > 0 : false
      const isSuspended = store ? (yield* store.listSuspended()).includes(id) : false
      const lastTerminal = terminalRows.at(-1)

      if (
        !options?.hasNewWork &&
        !orphanedRunning &&
        !hasPendingInbox &&
        !isSuspended &&
        lastTerminal !== undefined
      ) {
        return {
          status: lastTerminal.status,
          state: "delivered",
          body: lastTerminal.output ?? lastTerminal.error ?? "Subagent cancelled",
        } satisfies EnsureResult
      }

      if (!options?.hasNewWork && !hasPendingInbox && !isSuspended && orphanedRunning && store) {
        if (yield* childAlreadySettled(store, id)) {
          const assistant = yield* store.lastAssistantAfter({ sessionID: id }).pipe(Effect.orElseSucceed(() => undefined))
          const body = SubagentCompletion.text(assistant)
          yield* deliverReportToParent(
            jobs,
            execution,
            recovery,
            { status: "completed", output: body, notificationID: orphanedRunning.notificationID },
            store,
            inbox,
            false,
          )
          return { status: "completed", state: "delivered", body } satisfies EnsureResult
        }
      }

      const shouldResume = Boolean(options?.hasNewWork || orphanedRunning || hasPendingInbox || isSuspended)
      if (!shouldResume) {
        const assistant = store
          ? yield* store.lastAssistantAfter({ sessionID: id }).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        return {
          status: "completed",
          state: "idle",
          body: SubagentCompletion.text(assistant),
        } satisfies EnsureResult
      }

      if (isSuspended && !hasPendingInbox && !options?.hasNewWork && store) {
        const attempts = yield* store.countResume(id)
        if (attempts !== undefined && attempts > MAX_RESUME_ATTEMPTS) {
          const body = "Execution was interrupted repeatedly and will not be resumed automatically."
          yield* store.release(id)
          if (orphanedRunning) {
            yield* deliverReportToParent(
              jobs,
              execution,
              recovery,
              { status: "error", error: body, notificationID: orphanedRunning.notificationID },
              store,
              inbox,
              false,
            )
          }
          return { status: "error", state: "delivered", body } satisfies EnsureResult
        }
        if (inbox) {
          yield* inbox
            .admit({
              id: SessionMessage.ID.create(),
              sessionID: id,
              item: {
                type: "synthetic",
                payload: SessionInbox.SyntheticPayload.make({
                  text: "Continuing subagent execution after interruption. Continue from where you left off without repeating completed work.",
                  description: "Continuing after interruption",
                  metadata: { notice: "restart" },
                }),
                delivery: "steer",
              },
            })
            .pipe(Effect.ignore)
        }
      }

      const info = yield* start(jobs, execution, recovery, orphanedRunning?.notificationID, cancelPreStart(recovery))
      return { status: "running", state: "resumed", info } satisfies EnsureResult
    }).pipe(Effect.setContext(context))

  return Service.of({
    start: (recovery) => start(jobs, execution, recovery, undefined, cancelPreStart(recovery)).pipe(Effect.setContext(context)),
    ensure,
  })
})

export const layer = Layer.effect(Service, make)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionExecution.node, Job.node, SessionStore.node, SessionInbox.node],
})
