import { AlibabaUsageRpc, formatCycleProgress, formatQuotaPercent, type AlibabaUsage } from "@opencode/schema/alibaba-usage"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogTitle } from "@opencode/ui/dialog"
import { TextInput } from "@opencode/ui/text-input"
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"

export function DialogAlibabaUsage(props: { directory?: string }) {
  const sdk = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const rpc = () => sdk.api.rpc(AlibabaUsageRpc)
  const callOpts = () => (props.directory ? { location: { directory: props.directory } } : undefined)

  const [loading, setLoading] = createSignal(true)
  const [data, setData] = createSignal<AlibabaUsage.TokenPlan>()
  const [error, setError] = createSignal<string>()
  const [loginSession, setLoginSession] = createSignal<{ url: string; state: string }>()
  const [manualInput, setManualInput] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  onCleanup(() => {
    stopPolling()
    const active = loginSession()
    if (active) void rpc().cancelLogin({ state: active.state }, callOpts()).catch(() => {})
  })

  const load = async (refresh = false) => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await rpc().tokenPlan({ refresh }, callOpts())
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const startLogin = async () => {
    stopPolling()
    setError(undefined)
    try {
      const started = await rpc().startLogin({}, callOpts())
      setLoginSession({ url: started.url, state: started.state })
      platform.openExternal(started.url)

      pollTimer = setInterval(async () => {
        try {
          const status = await rpc().loginStatus({ state: started.state }, callOpts())
          if (status.status === "complete") {
            stopPolling()
            setLoginSession(undefined)
            setManualInput("")
            await load(true)
          } else if (status.status === "expired" || status.status === "error") {
            stopPolling()
            setLoginSession(undefined)
            setError(status.message ?? "Login expired")
          }
        } catch {
          // continue polling
        }
      }, 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const submitManual = async () => {
    const active = loginSession()
    const raw = manualInput().trim()
    if (!active || !raw) return
    setSubmitting(true)
    setError(undefined)
    try {
      const result = await rpc().completeLogin({ state: active.state, input: raw }, callOpts())
      if (!result.ok) {
        setError(result.message ?? "Could not complete login")
        return
      }
      stopPolling()
      setLoginSession(undefined)
      setManualInput("")
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const logout = async () => {
    stopPolling()
    await rpc().logout({}, callOpts())
    setLoginSession(undefined)
    await load(true)
  }

  onMount(() => {
    void load(false)
  })

  const cycle = createMemo(() => {
    const resetAt = data()?.resetAt
    return resetAt !== undefined ? formatCycleProgress(resetAt) : undefined
  })

  return (
    <Dialog size="normal" fit>
      <div class="px-6 pt-5 pb-3">
        <DialogTitle>{language.t("dialog.alibabaUsage.title")}</DialogTitle>
      </div>
      <div class="flex flex-col gap-4 px-6 pb-6 text-13-regular text-text-base">
        <Show when={loading()}>
          <div class="text-text-muted">{language.t("dialog.alibabaUsage.loading")}</div>
        </Show>

        <Show when={!loading() && error()}>
          {(err) => <div class="text-v2-state-fg-danger">{err()}</div>}
        </Show>

        <Show when={!loading() && data()}>
          {(item) => (
            <Show
              when={item().ok}
              fallback={
                <div class="flex flex-col gap-2">
                  <div class="text-v2-state-fg-danger">{item().error}</div>
                  <Show when={item().hint}>{(hint) => <div class="text-text-muted">{hint()}</div>}</Show>
                </div>
              }
            >
              <div class="flex flex-col gap-3">
                <div class="flex items-center justify-between text-12-regular text-text-muted">
                  <span>{language.t("dialog.alibabaUsage.monthlyQuota")}</span>
                  <span>{[item().site, item().region].filter(Boolean).join(" · ")}</span>
                </div>

                <div class="h-2.5 w-full overflow-hidden rounded-full bg-surface-raised-base">
                  <div
                    class="h-full rounded-full bg-text-interactive-base transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, item().usedPercent))}%` }}
                  />
                </div>

                <div class="flex items-center justify-between text-13-medium tabular-nums">
                  <span>
                    {formatQuotaPercent(item().usedPercent)} {language.t("dialog.alibabaUsage.used")}
                  </span>
                  <span class="text-text-muted">
                    {formatQuotaPercent(item().remainingPercent)} {language.t("dialog.alibabaUsage.left")}
                  </span>
                </div>

                <Show when={cycle()}>
                  {(c) => (
                    <div class="flex flex-col gap-1 rounded-md border border-border-base bg-surface-base p-3 text-12-regular">
                      <div>
                        {language.t("dialog.alibabaUsage.cyclePosition")}:{" "}
                        <strong>
                          Day {c().elapsedDays} / {c().cycleDays}
                        </strong>{" "}
                        <span class="text-text-muted">(expected pace ~{c().expectedPercent.toFixed(1)}%)</span>
                      </div>
                      <div>
                        {language.t("dialog.alibabaUsage.cutoff")}: <strong>{c().resetLabel}</strong>{" "}
                        <span class="text-text-muted">({c().countdownLabel})</span>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          )}
        </Show>

        <Show when={loginSession()}>
          {(session) => (
            <div class="flex flex-col gap-2 rounded-md border border-border-base bg-surface-base p-3 text-12-regular">
              <div class="font-medium text-text-base">{language.t("dialog.alibabaUsage.loginUrlTitle")}</div>
              <div class="break-all select-all text-text-muted">{session().url}</div>
              <div class="text-text-muted">{language.t("dialog.alibabaUsage.manualHint")}</div>
              <div class="flex items-center gap-2 pt-1">
                <TextInput
                  class="flex-1"
                  value={manualInput()}
                  onChange={setManualInput}
                  placeholder={language.t("dialog.alibabaUsage.manualPlaceholder")}
                />
                <Button
                  variant="contrast"
                  size="small"
                  disabled={submitting() || !manualInput().trim()}
                  onClick={() => void submitManual()}
                >
                  {language.t("dialog.alibabaUsage.submitManual")}
                </Button>
              </div>
            </div>
          )}
        </Show>

        <div class="flex items-center justify-between gap-2 pt-2">
          <div class="flex items-center gap-2">
            <Button variant="outline" size="small" onClick={() => void startLogin()}>
              {data()?.ok ? language.t("dialog.alibabaUsage.reconnect") : language.t("dialog.alibabaUsage.connect")}
            </Button>
            <Show when={data()?.ok}>
              <Button variant="ghost-muted" size="small" onClick={() => void logout()}>
                {language.t("dialog.alibabaUsage.disconnect")}
              </Button>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <Button variant="outline" size="small" disabled={loading()} onClick={() => void load(true)}>
              {language.t("dialog.alibabaUsage.refresh")}
            </Button>
            <Button variant="contrast" size="small" onClick={() => dialog.close()}>
              {language.t("common.close")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
