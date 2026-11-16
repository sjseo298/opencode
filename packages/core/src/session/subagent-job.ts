export * as SubagentJob from "./subagent-job.js"

import { Context, Effect, Layer, Option } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { SessionExecution } from "./execution.js"
import { SessionInbox } from "./inbox.js"
import type { SessionMessage } from "./message.js"
import { SessionStore } from "./store.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

export interface Interface {
  readonly start: (recovery: Recovery) => Effect.Effect<Job.Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

const deliverCancelledPreStart = Effect.fnUntraced(function* (
  jobs: Job.Interface,
  execution: SessionExecution.Interface,
  recovery: Recovery,
  notificationID: SessionMessage.ID,
  store: SessionStore.Interface | undefined,
  inbox: SessionInbox.Interface | undefined,
) {
  if (!store || !inbox) {
    yield* jobs.completeBackground(notificationID)
    return
  }
  const parentID = recovery.parentSessionID
  if (!(yield* store.get(parentID))) {
    yield* jobs.completeBackground(notificationID)
    return
  }
  const delivered = yield* SubagentCompletion.deliver(
    {
      synthetic: (notice) =>
        inbox.admit({
          id: notice.id ?? notificationID,
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
    { status: "cancelled", notificationID, recovery },
  ).pipe(
    Effect.as(true),
    Effect.catchTag("SessionInbox.LifecycleConflict", (conflict) =>
      Effect.logWarning("Subagent report notification ID conflicted in parent inbox", {
        childSessionID: recovery.childSessionID,
        parentSessionID: parentID,
        notificationID,
        conflict,
      }).pipe(Effect.as(false)),
    ),
    Effect.catchDefect((defect) =>
      store
        .get(parentID)
        .pipe(
          Effect.flatMap((parent) =>
            parent === undefined ? jobs.completeBackground(notificationID).pipe(Effect.as(false)) : Effect.die(defect),
          ),
        ),
    ),
  )
  if (!delivered) return
  const parent = yield* store.get(parentID)
  if (parent && !parent.revert) yield* execution.wake(parentID)
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

  return Service.of({
    start: (recovery) =>
      start(jobs, execution, recovery, undefined, (notificationID) =>
        deliverCancelledPreStart(jobs, execution, recovery, notificationID, store, inbox),
      ).pipe(Effect.setContext(context)),
  })
})

export const layer = Layer.effect(Service, make)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionExecution.node, Job.node, SessionStore.node, SessionInbox.node],
})
