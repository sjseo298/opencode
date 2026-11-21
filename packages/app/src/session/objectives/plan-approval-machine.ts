import type { SessionInfo } from "@opencode/client/promise"

export const PLAN_APPROVAL_TIMEOUT_MS = 30_000

export type PlanApprovalAction =
  | "fresh_session"
  | "same_session"
  | "refine_plan"
  | "revoke_approval"
  | "close"

export type PlanApprovalState =
  | {
      readonly status: "idle"
      readonly attempt: number
      readonly activeIndex: number
    }
  | {
      readonly status: "submitting"
      readonly attempt: number
      readonly activeIndex: number
      readonly action: PlanApprovalAction
      readonly sessionID: string
    }
  | {
      readonly status: "closed"
      readonly attempt: number
      readonly activeIndex: number
    }

export type PlanApprovalEvent =
  | { readonly type: "index.changed"; readonly index: number; readonly count: number }
  | { readonly type: "index.moved"; readonly delta: -1 | 1; readonly count: number }
  | {
      readonly type: "action.selected"
      readonly action: PlanApprovalAction
      readonly sessionID: string
    }
  | {
      readonly type: "fresh.succeeded"
      readonly attempt: number
      readonly oldSessionID: string
      readonly newSession: SessionInfo
    }
  | {
      readonly type: "same.succeeded"
      readonly attempt: number
    }
  | {
      readonly type: "revoke.succeeded"
      readonly attempt: number
    }
  | {
      readonly type: "refine.succeeded"
      readonly attempt: number
    }
  | {
      readonly type: "action.failed"
      readonly attempt: number
      readonly message: string
    }
  | {
      readonly type: "action.timed-out"
      readonly attempt: number
    }
  | { readonly type: "session.changed" }
  | { readonly type: "disposed" }

export type PlanApprovalEffect =
  | {
      readonly type: "fresh.run"
      readonly attempt: number
      readonly sessionID: string
      readonly timeoutMs: number
    }
  | {
      readonly type: "same.run"
      readonly attempt: number
      readonly sessionID: string
      readonly timeoutMs: number
    }
  | {
      readonly type: "revoke.run"
      readonly attempt: number
      readonly sessionID: string
      readonly timeoutMs: number
    }
  | {
      readonly type: "refine.run"
      readonly attempt: number
      readonly sessionID: string
      readonly timeoutMs: number
    }
  | {
      readonly type: "fresh.open"
      readonly attempt: number
      readonly oldSessionID: string
      readonly newSession: SessionInfo
    }
  | { readonly type: "cancel"; readonly attempt: number }
  | { readonly type: "dialog.close"; readonly refine?: boolean }
  | { readonly type: "toast.show"; readonly kind: "same" | "fresh" | "revoked" | "refine" }
  | { readonly type: "toast.error"; readonly message?: string }

export type PlanApprovalTransition = {
  readonly state: PlanApprovalState
  readonly effects: readonly PlanApprovalEffect[]
}

const NO_EFFECTS: readonly PlanApprovalEffect[] = []

export function createPlanApprovalState(): PlanApprovalState {
  return { status: "idle", attempt: 0, activeIndex: 0 }
}

export function selectPlanApprovalView(state: PlanApprovalState) {
  return {
    busy: state.status === "submitting",
    pendingAction: state.status === "submitting" ? state.action : undefined,
    activeIndex: state.activeIndex,
  }
}

export function transitionPlanApproval(
  state: PlanApprovalState,
  event: PlanApprovalEvent,
): PlanApprovalTransition {
  if (state.status === "closed") return { state, effects: NO_EFFECTS }

  if (event.type === "disposed") {
    return {
      state: { status: "closed", attempt: state.attempt, activeIndex: state.activeIndex },
      effects: state.status === "submitting" ? [{ type: "cancel", attempt: state.attempt }] : NO_EFFECTS,
    }
  }

  if (event.type === "session.changed") {
    return {
      state: { status: "closed", attempt: state.attempt, activeIndex: state.activeIndex },
      effects: [
        ...(state.status === "submitting" ? [{ type: "cancel" as const, attempt: state.attempt }] : []),
        { type: "dialog.close" },
      ],
    }
  }

  if (event.type === "index.changed") {
    if (state.status !== "idle" || event.count <= 0) return { state, effects: NO_EFFECTS }
    const clamped = Math.max(0, Math.min(event.count - 1, event.index))

    if (clamped === state.activeIndex) return { state, effects: NO_EFFECTS }

    return { state: { ...state, activeIndex: clamped }, effects: NO_EFFECTS }
  }

  if (event.type === "index.moved") {
    if (state.status !== "idle" || event.count <= 0) return { state, effects: NO_EFFECTS }
    const clamped = Math.max(0, Math.min(event.count - 1, state.activeIndex + event.delta))

    if (clamped === state.activeIndex) return { state, effects: NO_EFFECTS }

    return { state: { ...state, activeIndex: clamped }, effects: NO_EFFECTS }
  }

  if (event.type === "action.selected") {
    if (state.status !== "idle") return { state, effects: NO_EFFECTS }

    if (event.action === "close") {
      return {
        state: { status: "closed", attempt: state.attempt, activeIndex: state.activeIndex },
        effects: [{ type: "dialog.close" }],
      }
    }

    const attempt = state.attempt + 1

    const next: PlanApprovalState = {
      status: "submitting",
      attempt,
      activeIndex: state.activeIndex,
      action: event.action,
      sessionID: event.sessionID,
    }

    if (event.action === "refine_plan") {
      return {
        state: next,
        effects: [{ type: "refine.run", attempt, sessionID: event.sessionID, timeoutMs: PLAN_APPROVAL_TIMEOUT_MS }],
      }
    }

    if (event.action === "fresh_session") {
      return {
        state: next,
        effects: [{ type: "fresh.run", attempt, sessionID: event.sessionID, timeoutMs: PLAN_APPROVAL_TIMEOUT_MS }],
      }
    }

    if (event.action === "same_session") {
      return {
        state: next,
        effects: [{ type: "same.run", attempt, sessionID: event.sessionID, timeoutMs: PLAN_APPROVAL_TIMEOUT_MS }],
      }
    }

    return {
      state: next,
      effects: [{ type: "revoke.run", attempt, sessionID: event.sessionID, timeoutMs: PLAN_APPROVAL_TIMEOUT_MS }],
    }
  }

  if (state.status !== "submitting" || event.attempt !== state.attempt) {
    return { state, effects: NO_EFFECTS }
  }

  if (event.type === "fresh.succeeded") {
    return {
      state: { status: "closed", attempt: state.attempt, activeIndex: state.activeIndex },
      effects: [
        { type: "fresh.open", attempt: state.attempt, oldSessionID: event.oldSessionID, newSession: event.newSession },
        { type: "dialog.close" },
        { type: "toast.show", kind: "fresh" },
      ],
    }
  }

  if (event.type === "same.succeeded") {
    return {
      state: { status: "closed", attempt: state.attempt, activeIndex: state.activeIndex },
      effects: [
        { type: "dialog.close" },
        { type: "toast.show", kind: "same" },
      ],
    }
  }

  if (event.type === "revoke.succeeded") {
    return {
      state: { status: "closed", attempt: state.attempt, activeIndex: state.activeIndex },
      effects: [
        { type: "dialog.close" },
        { type: "toast.show", kind: "revoked" },
      ],
    }
  }

  if (event.type === "refine.succeeded") {
    return {
      state: { status: "closed", attempt: state.attempt, activeIndex: state.activeIndex },
      effects: [
        { type: "dialog.close", refine: true },
        { type: "toast.show", kind: "refine" },
      ],
    }
  }

  return {
    state: { status: "idle", attempt: state.attempt, activeIndex: state.activeIndex },
    effects: [{ type: "toast.error", message: event.type === "action.failed" ? event.message : undefined }],
  }
}
