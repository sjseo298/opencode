import { describe, expect, test } from "bun:test"
import {
  PLAN_APPROVAL_TIMEOUT_MS,
  createPlanApprovalState,
  selectPlanApprovalView,
  transitionPlanApproval,
} from "./plan-approval-machine"

describe("plan-approval-machine", () => {
  test("refine_plan submits refine.run effect and closes with refine=true on refine.succeeded", () => {
    const initial = createPlanApprovalState()

    const selected = transitionPlanApproval(initial, {
      type: "action.selected",
      action: "refine_plan",
      sessionID: "ses_1",
    })

    expect(selected.state).toEqual({
      status: "submitting",
      attempt: 1,
      activeIndex: 0,
      action: "refine_plan",
      sessionID: "ses_1",
    })
    expect(selectPlanApprovalView(selected.state)).toEqual({
      busy: true,
      pendingAction: "refine_plan",
      activeIndex: 0,
    })
    expect(selected.effects).toEqual([
      { type: "refine.run", attempt: 1, sessionID: "ses_1", timeoutMs: PLAN_APPROVAL_TIMEOUT_MS },
    ])

    const succeeded = transitionPlanApproval(selected.state, {
      type: "refine.succeeded",
      attempt: 1,
    })

    expect(succeeded.state).toEqual({ status: "closed", attempt: 1, activeIndex: 0 })
    expect(succeeded.effects).toEqual([
      { type: "dialog.close", refine: true },
      { type: "toast.show", kind: "refine" },
    ])
  })

  test("ignores stale refine.succeeded attempts and recovers to idle on failure", () => {
    const initial = createPlanApprovalState()

    const submitting = transitionPlanApproval(initial, {
      type: "action.selected",
      action: "refine_plan",
      sessionID: "ses_1",
    }).state

    const stale = transitionPlanApproval(submitting, { type: "refine.succeeded", attempt: 99 })

    expect(stale.state).toBe(submitting)
    expect(stale.effects).toEqual([])

    const failed = transitionPlanApproval(submitting, {
      type: "action.failed",
      attempt: 1,
      message: "network error",
    })

    expect(failed.state).toEqual({ status: "idle", attempt: 1, activeIndex: 0 })
    expect(failed.effects).toEqual([{ type: "toast.error", message: "network error" }])
  })

  test("close action closes dialog without setting refine flag", () => {
    const initial = createPlanApprovalState()

    const closed = transitionPlanApproval(initial, {
      type: "action.selected",
      action: "close",
      sessionID: "ses_1",
    })

    expect(closed.state).toEqual({ status: "closed", attempt: 0, activeIndex: 0 })
    expect(closed.effects).toEqual([{ type: "dialog.close" }])
  })
})
