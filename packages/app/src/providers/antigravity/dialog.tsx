import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Loader } from "@opencode/ui/loader"
import { MenuScroll } from "@opencode/ui/menu-scroll"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"
import { showToast } from "@/shell/notifications/toast"
import { useWorkspaceLocation } from "@/workspaces/location"
import {
  AntigravityAccountsRpc,
  formatQuotaSummary,
  stripAnsiCodes,
  type AccountSummary,
} from "./account-rpc"
import {
  ANTIGRAVITY_TIMEOUT_MS,
  createAntigravityDialogState,
  transitionAntigravityDialog,
  type AntigravityDialogEffect,
  type AntigravityDialogEvent,
} from "./machine"

export function DialogAntigravity(props: { directory?: string }) {
  const sdk = useServerSDK()
  const platform = usePlatform()
  const workspace = useWorkspaceLocation()
  const dialog = useDialog()
  const language = useLanguage()

  const [state, setState] = createSignal(createAntigravityDialogState())
  const runs = new Map<number, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()

  const directory = () => props.directory ?? workspace().directory
  const locationOpt = () => ({ location: { directory: directory() } })
  const rpc = () => sdk.api.rpc(AntigravityAccountsRpc)

  const settle = (attempt: number) => {
    const entry = runs.get(attempt)

    if (!entry) return
    runs.delete(attempt)
    clearTimeout(entry.timer)

    return entry
  }

  const dispatch = (event: AntigravityDialogEvent) => {
    const next = transitionAntigravityDialog(state(), event)

    if (next.state !== state()) setState(next.state)
    next.effects.forEach((effect) =>
      Promise.try(() => run(effect)).catch((cause: unknown) => console.error("[antigravity]", cause)),
    )
  }

  const startGuard = (attempt: number, timeoutMs = ANTIGRAVITY_TIMEOUT_MS) => {
    const controller = new AbortController()

    const timer = setTimeout(
      () =>
        dispatch({
          type: "operation.failed",
          attempt,
          message: language.t("home.sessions.load.timeout"),
        }),
      timeoutMs,
    )

    runs.set(attempt, { controller, timer })

    return controller.signal
  }

  const run = async (effect: AntigravityDialogEffect) => {
    if (effect.type === "cancel.attempt") {
      settle(effect.attempt)?.controller.abort()

      return
    }

    if (effect.type === "cancel.oauth") {
      void sdk.api.integration.oauth
        .cancel({
          integrationID: "google",
          attemptID: effect.attemptID,
          ...locationOpt(),
        })
        .catch(() => {})

      return
    }

    if (effect.type === "toast.success") {
      showToast({ variant: "success", title: effect.message })

      return
    }

    if (effect.type === "toast.error") {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: effect.message })

      return
    }

    if (effect.type === "load.accounts") {
      const signal = startGuard(effect.attempt)

      try {
        const accounts = await rpc().list({}, { ...locationOpt(), signal })
        settle(effect.attempt)
        dispatch({ type: "accounts.loaded", attempt: effect.attempt, accounts })
      } catch (cause: unknown) {
        settle(effect.attempt)
        dispatch({
          type: "operation.failed",
          attempt: effect.attempt,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }

      return
    }

    if (effect.type === "load.quotas") {
      const signal = startGuard(effect.attempt)

      try {
        const res = await rpc().quotas(
          effect.accountID ? { id: effect.accountID } : {},
          { ...locationOpt(), signal },
        )

        const filtered = res.accounts.filter((acc) => Boolean(effect.accountID) || !acc.disabled)
        settle(effect.attempt)
        dispatch({
          type: "quotas.loaded",
          attempt: effect.attempt,
          report: stripAnsiCodes(res.report),
          accounts: filtered.map((acc) => ({
            ...acc,
            report: stripAnsiCodes(acc.report),
          })),
          selectedID: effect.accountID ?? filtered[0]?.id,
        })
      } catch (cause: unknown) {
        settle(effect.attempt)
        dispatch({
          type: "operation.failed",
          attempt: effect.attempt,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }

      return
    }

    if (effect.type === "refresh.models") {
      const signal = startGuard(effect.attempt)

      try {
        const res = await rpc().models({}, { ...locationOpt(), signal })
        settle(effect.attempt)
        dispatch({ type: "models.refreshed", attempt: effect.attempt, count: res.count })
      } catch (cause: unknown) {
        settle(effect.attempt)
        dispatch({
          type: "operation.failed",
          attempt: effect.attempt,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }

      return
    }

    if (effect.type === "update.account") {
      const signal = startGuard(effect.attempt)

      try {
        if (effect.action === "delete") {
          const conns = await rpc().connections({ id: effect.accountID }, { ...locationOpt(), signal })

          for (const credentialID of conns.ids) {
            await sdk.api.credential.remove({ credentialID }, { signal })
          }
        }

        const updated = await rpc().update(
          { id: effect.accountID, action: effect.action },
          { ...locationOpt(), signal },
        )

        const accounts = await rpc().list({}, { ...locationOpt(), signal })
        settle(effect.attempt)
        dispatch({
          type: "account.action.succeeded",
          attempt: effect.attempt,
          message: updated.message,
          accounts,
        })
      } catch (cause: unknown) {
        settle(effect.attempt)
        dispatch({
          type: "operation.failed",
          attempt: effect.attempt,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }

      return
    }

    if (effect.type === "start.oauth") {
      const signal = startGuard(effect.attempt)

      try {
        const { data: attempt } = await sdk.api.integration.oauth.connect(
          {
            integrationID: "google",
            methodID: "antigravity",
            answer: { manual: effect.manual },
            ...locationOpt(),
          },
          { signal },
        )

        platform.openExternal(attempt.url)
        settle(effect.attempt)
        dispatch({
          type: "oauth.started",
          attempt: effect.attempt,
          attemptID: attempt.attemptID,
          url: attempt.url,
          instructions: attempt.instructions ?? "",
          mode: attempt.mode === "code" || effect.manual ? "code" : "auto",
        })
      } catch (cause: unknown) {
        settle(effect.attempt)
        dispatch({
          type: "operation.failed",
          attempt: effect.attempt,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }

      return
    }

    if (effect.type === "poll.oauth") {
      const signal = startGuard(effect.attempt, 5 * 60 * 1000)

      try {
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1000))

          if (signal.aborted) return

          const status = await sdk.api.integration.oauth.status(
            {
              integrationID: "google",
              attemptID: effect.attemptID,
              ...locationOpt(),
            },
            { signal },
          )

          if (status.data.status === "complete") {
            await rpc().models({}, { ...locationOpt(), signal })
            const accounts = await rpc().list({}, { ...locationOpt(), signal })
            settle(effect.attempt)
            dispatch({ type: "oauth.completed", attempt: effect.attempt, accounts })

            return
          }

          if (status.data.status === "failed") {
            throw new Error(status.data.message ?? "Authorization failed")
          }

          if (status.data.status === "expired") {
            throw new Error("Authorization expired")
          }
        }
      } catch (cause: unknown) {
        settle(effect.attempt)
        dispatch({
          type: "operation.failed",
          attempt: effect.attempt,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }

      return
    }

    if (effect.type === "submit.oauth.code") {
      const signal = startGuard(effect.attempt)

      try {
        await sdk.api.integration.oauth.complete(
          {
            integrationID: "google",
            attemptID: effect.attemptID,
            code: effect.code,
            ...locationOpt(),
          },
          { signal },
        )

        await rpc().models({}, { ...locationOpt(), signal })
        const accounts = await rpc().list({}, { ...locationOpt(), signal })
        settle(effect.attempt)
        dispatch({ type: "oauth.completed", attempt: effect.attempt, accounts })
      } catch (cause: unknown) {
        settle(effect.attempt)
        dispatch({
          type: "operation.failed",
          attempt: effect.attempt,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
  }

  onMount(() => {
    void run({ type: "load.accounts", attempt: state().attempt })
  })

  createEffect(() => {
    if (dialog.closing) dispatch({ type: "disposed" })
  })

  onCleanup(() => dispatch({ type: "disposed" }))

  const busy = () => state().status === "busy" || state().status === "loading"

  const selectedQuotaReport = createMemo(() => {
    const view = state().view

    if (view.kind !== "quotas") return ""
    const match = view.accounts.find((a) => a.id === view.selectedID)

    return match?.report ?? view.report
  })

  return (
    <Dialog size="large" fit>
      <DialogHeader>
        <div class="flex items-center justify-between gap-2 w-full pe-6">
          <DialogTitle>{language.t("dialog.antigravity.title")}</DialogTitle>
          <Show when={state().view.kind !== "accounts"}>
            <Button size="small" variant="ghost" onClick={() => dispatch({ type: "view.back" })}>
              {language.t("dialog.antigravity.back")}
            </Button>
          </Show>
        </div>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-4 px-5 pb-5 pt-2">
          {/* Top Action Bar */}
          <Show when={state().view.kind === "accounts"}>
            <div class="flex items-center justify-between gap-2 flex-wrap border-b border-v2-border-border-base pb-3">
              <div class="flex items-center gap-1.5 flex-wrap">
                <Button
                  size="small"
                  variant="submit"
                  disabled={busy()}
                  onClick={() => dispatch({ type: "oauth.start.requested", manual: false })}
                >
                  {language.t("dialog.antigravity.addAuto")}
                </Button>
                <Button
                  size="small"
                  variant="outline"
                  disabled={busy()}
                  onClick={() => dispatch({ type: "oauth.start.requested", manual: true })}
                >
                  {language.t("dialog.antigravity.addManual")}
                </Button>
              </div>
              <div class="flex items-center gap-1.5 flex-wrap">
                <Button
                  size="small"
                  variant="outline"
                  disabled={busy() || state().accounts.length === 0}
                  onClick={() => dispatch({ type: "quotas.requested" })}
                >
                  {language.t("dialog.antigravity.checkQuotas")}
                </Button>
                <Button
                  size="small"
                  variant="outline"
                  disabled={busy()}
                  onClick={() => dispatch({ type: "models.refresh.requested" })}
                >
                  {language.t("dialog.antigravity.refreshModels")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={busy()}
                  onClick={() => dispatch({ type: "refresh.requested" })}
                >
                  {language.t("dialog.antigravity.reload")}
                </Button>
              </div>
            </div>
          </Show>

          {/* Main Content Switch */}
          <Switch>
            <Match when={state().view.kind === "oauth-auto" && state().view}>
              {(view) => (
                <div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
                  <Loader class="size-5" />
                  <div class="text-[14px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base">
                    {language.t("dialog.antigravity.oauth.waiting")}
                  </div>
                  <div class="flex items-center gap-2 pt-2">
                    <Button
                      size="small"
                      variant="outline"
                      onClick={() => {
                        const current = view()

                        if (current.kind === "oauth-auto") platform.openExternal(current.url)
                      }}
                    >
                      {language.t("dialog.antigravity.oauth.openBrowser")}
                    </Button>
                    <Button size="small" variant="ghost" onClick={() => dispatch({ type: "view.back" })}>
                      {language.t("common.cancel")}
                    </Button>
                  </div>
                </div>
              )}
            </Match>

            <Match when={state().view.kind === "oauth-manual" && state().view}>
              {(view) => {
                const manualView = () => {
                  const v = view()

                  return v.kind === "oauth-manual" ? v : undefined
                }

                return (
                  <Show when={manualView()}>
                    {(mv) => (
                      <div class="flex flex-col gap-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-4">
                        <div class="text-[13px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base">
                          {language.t("dialog.antigravity.oauth.manualTitle")}
                        </div>
                        <Show when={mv().instructions}>
                          <div class="text-[12px] leading-[var(--line-height-base)] text-v2-text-text-muted whitespace-pre-wrap">
                            {mv().instructions}
                          </div>
                        </Show>
                        <div class="flex items-center gap-2">
                          <Button
                            size="small"
                            variant="outline"
                            onClick={() => platform.openExternal(mv().url)}
                          >
                            {language.t("dialog.antigravity.oauth.openBrowser")}
                          </Button>
                        </div>
                        <div class="flex flex-col gap-1.5 pt-1">
                          <span class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-muted">
                            {language.t("dialog.antigravity.oauth.pastePrompt")}
                          </span>
                          <div class="flex items-center gap-2">
                            <TextInput
                              class="flex-1"
                              value={mv().code}
                              placeholder={language.t("dialog.antigravity.oauth.codePlaceholder")}
                              onInput={(e) => dispatch({ type: "oauth.code.changed", code: e.currentTarget.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.isComposing) {
                                  e.preventDefault()
                                  dispatch({ type: "oauth.code.submitted" })
                                }
                              }}
                            />
                            <Button
                              size="small"
                              variant="submit"
                              disabled={busy() || !mv().code.trim()}
                              onClick={() => dispatch({ type: "oauth.code.submitted" })}
                            >
                              {language.t("dialog.antigravity.oauth.connect")}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </Show>
                )
              }}
            </Match>

            <Match when={state().view.kind === "quotas" && state().view}>
              {(view) => {
                const quotasView = () => {
                  const v = view()

                  return v.kind === "quotas" ? v : undefined
                }

                return (
                  <Show when={quotasView()}>
                    {(qv) => (
                      <div class="flex flex-col gap-3">
                        <Show when={qv().accounts.length > 1}>
                          <div class="flex items-center gap-1.5 flex-wrap">
                            <For each={qv().accounts}>
                              {(acc) => (
                                <Button
                                  size="small"
                                  variant={qv().selectedID === acc.id ? "submit" : "outline"}
                                  onClick={() => dispatch({ type: "quota.account.selected", accountID: acc.id })}
                                >
                                  {acc.email}
                                </Button>
                              )}
                            </For>
                          </div>
                        </Show>
                        <MenuScroll
                          class="max-h-[420px] rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01"
                          viewportClass="p-4"
                        >
                          <pre class="font-mono text-[12px] leading-[var(--line-height-base)] text-v2-text-text-base whitespace-pre-wrap">
                            {selectedQuotaReport()}
                          </pre>
                        </MenuScroll>
                      </div>
                    )}
                  </Show>
                )
              }}
            </Match>

            <Match when={state().view.kind === "accounts"}>
              <Show
                when={state().status !== "loading" || state().accounts.length > 0}
                fallback={
                  <div class="flex items-center justify-center gap-2 py-12 text-v2-text-text-muted">
                    <Loader class="size-4" />
                    <span class="text-[13px] leading-[var(--line-height-base)]">
                      {language.t("dialog.antigravity.loading")}
                    </span>
                  </div>
                }
              >
                <Show
                  when={state().accounts.length > 0}
                  fallback={
                    <div class="flex flex-col items-center justify-center gap-2 py-10 text-center">
                      <div class="text-[14px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base">
                        {language.t("dialog.antigravity.empty.title")}
                      </div>
                      <div class="max-w-sm text-[12px] leading-[var(--line-height-base)] text-v2-text-text-muted">
                        {language.t("dialog.antigravity.empty.description")}
                      </div>
                    </div>
                  }
                >
                  <MenuScroll class="max-h-[380px]" viewportClass="flex flex-col gap-2 p-0.5">
                    <For each={state().accounts}>
                      {(account) => (
                        <AccountRow
                          account={account}
                          busy={busy()}
                          onSelect={() =>
                            dispatch({ type: "account.action.requested", accountID: account.id, action: "select" })
                          }
                          onToggleEnable={() =>
                            dispatch({
                              type: "account.action.requested",
                              accountID: account.id,
                              action: account.enabled ? "disable" : "enable",
                            })
                          }
                          onQuotas={() => dispatch({ type: "quotas.requested", accountID: account.id })}
                          onDelete={() =>
                            dispatch({ type: "account.action.requested", accountID: account.id, action: "delete" })
                          }
                        />
                      )}
                    </For>
                  </MenuScroll>
                </Show>
              </Show>
            </Match>
          </Switch>
        </div>
      </DialogBody>
    </Dialog>
  )
}

function AccountRow(props: {
  account: AccountSummary
  busy: boolean
  onSelect: () => void
  onToggleEnable: () => void
  onQuotas: () => void
  onDelete: () => void
}) {
  const language = useLanguage()
  const quotaText = () => formatQuotaSummary(props.account.quota)

  return (
    <div class="flex items-center justify-between gap-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3">
      <div class="flex flex-col gap-1 min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[13px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base truncate">
            {props.account.email}
          </span>
          <Show when={props.account.current}>
            <Badge>{language.t("dialog.antigravity.badge.current")}</Badge>
          </Show>
          <Show when={!props.account.enabled}>
            <Badge>{language.t("dialog.antigravity.badge.disabled")}</Badge>
          </Show>
          <Show when={props.account.verificationRequired}>
            <Badge>{language.t("dialog.antigravity.badge.verify")}</Badge>
          </Show>
        </div>
        <Show when={quotaText()}>
          {(q) => (
            <div class="text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
              {`${language.t("dialog.antigravity.quotaLabel")}: ${q()}`}
            </div>
          )}
        </Show>
      </div>

      <div class="flex items-center gap-1.5 shrink-0 flex-wrap">
        <Show when={props.account.enabled && !props.account.current}>
          <Button size="small" variant="submit" disabled={props.busy} onClick={props.onSelect}>
            {language.t("dialog.antigravity.action.use")}
          </Button>
        </Show>
        <Button size="small" variant="outline" disabled={props.busy} onClick={props.onQuotas}>
          {language.t("dialog.antigravity.action.quotas")}
        </Button>
        <Button size="small" variant="outline" disabled={props.busy} onClick={props.onToggleEnable}>
          {props.account.enabled
            ? language.t("dialog.antigravity.action.disable")
            : language.t("dialog.antigravity.action.enable")}
        </Button>
        <Button size="small" variant="ghost-danger" disabled={props.busy} onClick={props.onDelete}>
          {language.t("dialog.antigravity.action.delete")}
        </Button>
      </div>
    </div>
  )
}
