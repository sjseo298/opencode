import type { AccountSummary, QuotaAccountReport } from "./account-rpc"

export const ANTIGRAVITY_TIMEOUT_MS = 45_000

export type AntigravityAccountAction = "select" | "enable" | "disable" | "delete" | "quotas"

export type AntigravityViewMode =
  | { readonly kind: "accounts" }
  | {
      readonly kind: "quotas"
      readonly report: string
      readonly accounts: readonly QuotaAccountReport[]
      readonly selectedID?: string
    }
  | {
      readonly kind: "oauth-manual"
      readonly attemptID: string
      readonly url: string
      readonly instructions: string
      readonly code: string
    }
  | {
      readonly kind: "oauth-auto"
      readonly attemptID: string
      readonly url: string
    }

export type AntigravityDialogState = {
  readonly status: "loading" | "idle" | "busy" | "closed"
  readonly attempt: number
  readonly busyLabel?: string
  readonly accounts: readonly AccountSummary[]
  readonly view: AntigravityViewMode
  readonly error?: string
}

export type AntigravityDialogEvent =
  | { readonly type: "refresh.requested" }
  | { readonly type: "accounts.loaded"; readonly attempt: number; readonly accounts: readonly AccountSummary[] }
  | { readonly type: "quotas.requested"; readonly accountID?: string }
  | {
      readonly type: "quotas.loaded"
      readonly attempt: number
      readonly report: string
      readonly accounts: readonly QuotaAccountReport[]
      readonly selectedID?: string
    }
  | { readonly type: "quota.account.selected"; readonly accountID: string }
  | { readonly type: "models.refresh.requested" }
  | { readonly type: "models.refreshed"; readonly attempt: number; readonly count: number }
  | {
      readonly type: "account.action.requested"
      readonly accountID: string
      readonly action: "select" | "enable" | "disable" | "delete"
    }
  | {
      readonly type: "account.action.succeeded"
      readonly attempt: number
      readonly message: string
      readonly accounts: readonly AccountSummary[]
    }
  | { readonly type: "oauth.start.requested"; readonly manual: boolean }
  | {
      readonly type: "oauth.started"
      readonly attempt: number
      readonly attemptID: string
      readonly url: string
      readonly instructions: string
      readonly mode: "auto" | "code"
    }
  | { readonly type: "oauth.code.changed"; readonly code: string }
  | { readonly type: "oauth.code.submitted" }
  | {
      readonly type: "oauth.completed"
      readonly attempt: number
      readonly accounts: readonly AccountSummary[]
    }
  | { readonly type: "view.back" }
  | { readonly type: "operation.failed"; readonly attempt: number; readonly message: string }
  | { readonly type: "disposed" }

export type AntigravityDialogEffect =
  | { readonly type: "load.accounts"; readonly attempt: number }
  | { readonly type: "load.quotas"; readonly attempt: number; readonly accountID?: string }
  | { readonly type: "refresh.models"; readonly attempt: number }
  | {
      readonly type: "update.account"
      readonly attempt: number
      readonly accountID: string
      readonly action: "select" | "enable" | "disable" | "delete"
    }
  | { readonly type: "start.oauth"; readonly attempt: number; readonly manual: boolean }
  | {
      readonly type: "poll.oauth"
      readonly attempt: number
      readonly attemptID: string
      readonly url: string
    }
  | {
      readonly type: "submit.oauth.code"
      readonly attempt: number
      readonly attemptID: string
      readonly code: string
    }
  | { readonly type: "cancel.oauth"; readonly attemptID: string }
  | { readonly type: "cancel.attempt"; readonly attempt: number }
  | { readonly type: "toast.success"; readonly message: string }
  | { readonly type: "toast.error"; readonly message: string }

export type AntigravityDialogTransition = {
  readonly state: AntigravityDialogState
  readonly effects: readonly AntigravityDialogEffect[]
}

const NO_EFFECTS: readonly AntigravityDialogEffect[] = []

export function createAntigravityDialogState(): AntigravityDialogState {
  return {
    status: "loading",
    attempt: 1,
    accounts: [],
    view: { kind: "accounts" },
  }
}

export function transitionAntigravityDialog(
  state: AntigravityDialogState,
  event: AntigravityDialogEvent,
): AntigravityDialogTransition {
  if (state.status === "closed") return { state, effects: NO_EFFECTS }

  if (event.type === "disposed") {
    const cancelOauth =
      state.view.kind === "oauth-auto" || state.view.kind === "oauth-manual"
        ? [{ type: "cancel.oauth" as const, attemptID: state.view.attemptID }]
        : []

    return {
      state: { ...state, status: "closed" },
      effects: [{ type: "cancel.attempt", attempt: state.attempt }, ...cancelOauth],
    }
  }

  if (event.type === "view.back") {
    const cancelOauth =
      state.view.kind === "oauth-auto" || state.view.kind === "oauth-manual"
        ? [{ type: "cancel.oauth" as const, attemptID: state.view.attemptID }]
        : []

    return {
      state: {
        ...state,
        status: "idle",
        busyLabel: undefined,
        view: { kind: "accounts" },
        error: undefined,
      },
      effects: cancelOauth,
    }
  }

  if (event.type === "quota.account.selected" && state.view.kind === "quotas") {
    return {
      state: {
        ...state,
        view: { ...state.view, selectedID: event.accountID },
      },
      effects: NO_EFFECTS,
    }
  }

  if (event.type === "oauth.code.changed" && state.view.kind === "oauth-manual") {
    return {
      state: {
        ...state,
        view: { ...state.view, code: event.code },
      },
      effects: NO_EFFECTS,
    }
  }

  if (event.type === "refresh.requested") {
    const attempt = state.attempt + 1

    return {
      state: { ...state, status: "loading", attempt, error: undefined },
      effects: [{ type: "load.accounts", attempt }],
    }
  }

  if (event.type === "quotas.requested") {
    if (state.status === "busy") return { state, effects: NO_EFFECTS }
    const attempt = state.attempt + 1

    return {
      state: { ...state, status: "busy", attempt, busyLabel: "quotas", error: undefined },
      effects: [{ type: "load.quotas", attempt, accountID: event.accountID }],
    }
  }

  if (event.type === "models.refresh.requested") {
    if (state.status === "busy") return { state, effects: NO_EFFECTS }
    const attempt = state.attempt + 1

    return {
      state: { ...state, status: "busy", attempt, busyLabel: "models", error: undefined },
      effects: [{ type: "refresh.models", attempt }],
    }
  }

  if (event.type === "account.action.requested") {
    if (state.status === "busy") return { state, effects: NO_EFFECTS }
    const attempt = state.attempt + 1

    return {
      state: { ...state, status: "busy", attempt, busyLabel: event.action, error: undefined },
      effects: [{ type: "update.account", attempt, accountID: event.accountID, action: event.action }],
    }
  }

  if (event.type === "oauth.start.requested") {
    if (state.status === "busy") return { state, effects: NO_EFFECTS }
    const attempt = state.attempt + 1

    return {
      state: { ...state, status: "busy", attempt, busyLabel: "oauth", error: undefined },
      effects: [{ type: "start.oauth", attempt, manual: event.manual }],
    }
  }

  if (event.type === "oauth.code.submitted") {
    if (state.status === "busy" || state.view.kind !== "oauth-manual") return { state, effects: NO_EFFECTS }
    const code = state.view.code.trim()

    if (!code) return { state, effects: NO_EFFECTS }
    const attempt = state.attempt + 1

    return {
      state: { ...state, status: "busy", attempt, busyLabel: "oauth-complete", error: undefined },
      effects: [{ type: "submit.oauth.code", attempt, attemptID: state.view.attemptID, code }],
    }
  }

  if ("attempt" in event && event.attempt !== state.attempt) {
    return { state, effects: NO_EFFECTS }
  }

  if (event.type === "accounts.loaded") {
    return {
      state: {
        ...state,
        status: "idle",
        busyLabel: undefined,
        accounts: event.accounts,
        error: undefined,
      },
      effects: NO_EFFECTS,
    }
  }

  if (event.type === "quotas.loaded") {
    const firstID = event.selectedID ?? event.accounts[0]?.id

    return {
      state: {
        ...state,
        status: "idle",
        busyLabel: undefined,
        view: {
          kind: "quotas",
          report: event.report,
          accounts: event.accounts,
          selectedID: firstID,
        },
        error: undefined,
      },
      effects: NO_EFFECTS,
    }
  }

  if (event.type === "models.refreshed") {
    return {
      state: {
        ...state,
        status: "idle",
        busyLabel: undefined,
        error: undefined,
      },
      effects: [{ type: "toast.success", message: `${event.count} available models loaded` }],
    }
  }

  if (event.type === "account.action.succeeded") {
    return {
      state: {
        ...state,
        status: "idle",
        busyLabel: undefined,
        accounts: event.accounts,
        error: undefined,
      },
      effects: [{ type: "toast.success", message: event.message }],
    }
  }

  if (event.type === "oauth.started") {
    if (event.mode === "code") {
      return {
        state: {
          ...state,
          status: "idle",
          busyLabel: undefined,
          view: {
            kind: "oauth-manual",
            attemptID: event.attemptID,
            url: event.url,
            instructions: event.instructions,
            code: "",
          },
          error: undefined,
        },
        effects: NO_EFFECTS,
      }
    }

    return {
      state: {
        ...state,
        status: "busy",
        busyLabel: "oauth-wait",
        view: {
          kind: "oauth-auto",
          attemptID: event.attemptID,
          url: event.url,
        },
        error: undefined,
      },
      effects: [{ type: "poll.oauth", attempt: state.attempt, attemptID: event.attemptID, url: event.url }],
    }
  }

  if (event.type === "oauth.completed") {
    return {
      state: {
        ...state,
        status: "idle",
        busyLabel: undefined,
        accounts: event.accounts,
        view: { kind: "accounts" },
        error: undefined,
      },
      effects: [{ type: "toast.success", message: "Google account connected successfully!" }],
    }
  }

  if (event.type === "operation.failed") {
    return {
      state: {
        ...state,
        status: "idle",
        busyLabel: undefined,
        error: event.message,
      },
      effects: [{ type: "toast.error", message: event.message }],
    }
  }

  return { state, effects: NO_EFFECTS }
}
