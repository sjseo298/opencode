import { AlibabaUsageRpc, formatCycleProgress, formatQuotaPercent, type AlibabaUsage } from "@opencode/schema/alibaba-usage"
import { writeClipboard } from "@opencode/session-ui/copy"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogTitle } from "@opencode/ui/dialog"
import { ProviderIcon } from "@opencode/ui/provider-icon"
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
  const [copiedUrl, setCopiedUrl] = createSignal(false)

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

  const beginLogin = async (openBrowser: boolean) => {
    stopPolling()
    setError(undefined)
    setCopiedUrl(false)
    try {
      const started = await rpc().startLogin({}, callOpts())
      setLoginSession({ url: started.url, state: started.state })
      if (openBrowser) platform.openExternal(started.url)

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

  const copyUrl = async (url: string) => {
    const ok = await (
      platform.writeClipboardText ? platform.writeClipboardText(url).then(() => true) : writeClipboard(url)
    ).catch(() => false)
    if (ok) {
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 2000)
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

  const cancelLogin = async () => {
    stopPolling()
    const active = loginSession()
    setLoginSession(undefined)
    setManualInput("")
    if (active) await rpc().cancelLogin({ state: active.state }, callOpts()).catch(() => {})
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

  const progressBarClass = createMemo(() => {
    const used = data()?.usedPercent ?? 0
    if (used >= 90) return "bg-v2-state-bg-danger"
    if (used >= 70) return "bg-v2-state-bg-warning"
    return "bg-text-interactive-base"
  })

  return (
    <Dialog size="normal" fit>
      <div class="flex flex-col gap-4 px-6 pb-6 pt-6 text-13-regular text-text-base">
        <Show when={loading()}>
          <div class="py-6 text-center text-text-muted">{language.t("dialog.alibabaUsage.loading")}</div>
        </Show>

        <Show when={!loading() && error()}>
          {(err) => (
            <div class="rounded-md border border-border-base bg-surface-base px-3 py-2 text-12-regular text-v2-state-fg-danger">
              {err()}
            </div>
          )}
        </Show>

        {/* Connected Quota View */}
        <Show when={!loading() && !loginSession() && data()?.ok && data()}>
          {(item) => (
            <div class="flex flex-col gap-4">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2.5">
                  <ProviderIcon id="alibaba" class="!size-6 text-v2-icon-icon-base" aria-hidden="true" />
                  <div>
                    <DialogTitle>{language.t("dialog.alibabaUsage.title")}</DialogTitle>
                    <div class="text-12-regular text-text-muted">
                      {[item().site, item().region].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </div>
                <Button variant="outline" size="small" disabled={loading()} onClick={() => void load(true)}>
                  {language.t("dialog.alibabaUsage.refresh")}
                </Button>
              </div>

              <div class="flex flex-col gap-2.5 rounded-lg border border-border-base bg-surface-base p-4">
                <div class="flex items-center justify-between text-12-medium text-text-muted">
                  <span>{language.t("dialog.alibabaUsage.monthlyQuota")}</span>
                  <span class="tabular-nums text-text-base">
                    {formatQuotaPercent(item().usedPercent)} {language.t("dialog.alibabaUsage.used")}
                  </span>
                </div>

                <div class="h-2.5 w-full overflow-hidden rounded-full bg-surface-raised-base">
                  <div
                    class={`h-full rounded-full transition-all ${progressBarClass()}`}
                    style={{ width: `${Math.min(100, Math.max(0, item().usedPercent))}%` }}
                  />
                </div>

                <div class="flex items-center justify-between text-12-regular text-text-muted tabular-nums">
                  <span>
                    {formatQuotaPercent(item().remainingPercent)} {language.t("dialog.alibabaUsage.left")}
                  </span>
                  <span>
                    {new Date(item().checkedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>

              <Show when={cycle()}>
                {(c) => (
                  <div class="grid grid-cols-2 gap-3 rounded-lg border border-border-base bg-surface-base p-4 text-12-regular">
                    <div class="flex flex-col gap-0.5">
                      <span class="text-text-muted">{language.t("dialog.alibabaUsage.cyclePosition")}</span>
                      <span class="text-13-medium text-text-base">
                        Day {c().elapsedDays} / {c().cycleDays}
                      </span>
                      <span class="text-text-muted">Expected pace ~{c().expectedPercent.toFixed(1)}%</span>
                    </div>
                    <div class="flex flex-col gap-0.5">
                      <span class="text-text-muted">{language.t("dialog.alibabaUsage.cutoff")}</span>
                      <span class="text-13-medium text-text-base">{c().resetLabel}</span>
                      <span class="text-text-muted">{c().countdownLabel}</span>
                    </div>
                  </div>
                )}
              </Show>

              <div class="flex items-center justify-between pt-1">
                <div class="flex items-center gap-2">
                  <Button variant="outline" size="small" onClick={() => void beginLogin(true)}>
                    {language.t("dialog.alibabaUsage.reconnect")}
                  </Button>
                  <Button variant="ghost-muted" size="small" onClick={() => void logout()}>
                    {language.t("dialog.alibabaUsage.disconnect")}
                  </Button>
                </div>
                <Button variant="contrast" size="small" onClick={() => dialog.close()}>
                  {language.t("common.close")}
                </Button>
              </div>
            </div>
          )}
        </Show>

        {/* Rich Connect / Empty State */}
        <Show when={!loading() && !loginSession() && data() && !data()?.ok}>
          <div class="flex flex-col items-center px-2 pt-2 text-center">
            <ProviderIcon id="alibaba" class="!size-10 text-v2-icon-icon-base" aria-hidden="true" />
            <div class="mt-4 text-[18px] font-[530] leading-6 text-text-base">
              <DialogTitle>{language.t("dialog.alibabaUsage.connectTitle")}</DialogTitle>
            </div>
            <p class="mt-2 max-w-[360px] text-12-regular leading-5 text-text-muted">
              {language.t("dialog.alibabaUsage.connectDescription")}
            </p>
            <Show when={data()?.error && !data()?.needsAuth}>
              <div class="mt-3 w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-left text-12-regular text-v2-state-fg-danger">
                {data()?.error}
              </div>
            </Show>
            <div class="mt-6 flex w-full flex-col gap-2">
              <Button variant="contrast" size="large" class="w-full" onClick={() => void beginLogin(true)}>
                {language.t("dialog.alibabaUsage.connectBrowser")}
              </Button>
              <Button variant="outline" size="large" class="w-full" onClick={() => void beginLogin(false)}>
                {language.t("dialog.alibabaUsage.connectManual")}
              </Button>
            </div>
            <div class="mt-3 flex w-full justify-end">
              <Button variant="ghost-muted" size="small" onClick={() => dialog.close()}>
                {language.t("common.close")}
              </Button>
            </div>
          </div>
        </Show>

        {/* Active Login Session (Auto + Manual Paste) */}
        <Show when={loginSession()}>
          {(session) => (
            <div class="flex flex-col gap-4">
              <div class="flex items-center gap-2.5">
                <ProviderIcon id="alibaba" class="!size-6 text-v2-icon-icon-base" aria-hidden="true" />
                <div>
                  <DialogTitle>{language.t("dialog.alibabaUsage.connectTitle")}</DialogTitle>
                  <div class="text-12-regular text-text-muted">{language.t("dialog.alibabaUsage.waitingBrowser")}</div>
                </div>
              </div>

              <div class="flex flex-col gap-2 rounded-lg border border-border-base bg-surface-base p-3.5 text-12-regular">
                <div class="flex items-center justify-between">
                  <span class="font-medium text-text-base">{language.t("dialog.alibabaUsage.loginUrlTitle")}</span>
                  <div class="flex items-center gap-1.5">
                    <Button variant="outline" size="small" onClick={() => void copyUrl(session().url)}>
                      {copiedUrl() ? language.t("dialog.alibabaUsage.copied") : language.t("dialog.alibabaUsage.copyUrl")}
                    </Button>
                    <Button variant="outline" size="small" onClick={() => platform.openExternal(session().url)}>
                      {language.t("dialog.alibabaUsage.openBrowser")}
                    </Button>
                  </div>
                </div>
                <div class="break-all select-all rounded bg-surface-raised-base px-2.5 py-2 font-mono text-[11px] text-text-muted">
                  {session().url}
                </div>
              </div>

              <div class="flex flex-col gap-2 rounded-lg border border-border-base bg-surface-base p-3.5 text-12-regular">
                <div class="font-medium text-text-base">{language.t("dialog.alibabaUsage.manualTitle")}</div>
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

              <div class="flex items-center justify-end gap-2">
                <Button variant="ghost-muted" size="small" onClick={() => void cancelLogin()}>
                  {language.t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
