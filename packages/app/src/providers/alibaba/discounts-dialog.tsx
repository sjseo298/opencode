import { AlibabaUsageRpc, computeNightWindowInfo, type AlibabaUsage } from "@opencode/schema/alibaba-usage"
import { writeClipboard } from "@opencode/session-ui/copy"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogTitle } from "@opencode/ui/dialog"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { TextInput } from "@opencode/ui/text-input"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"

export function DialogAlibabaDiscounts(props: { directory?: string; sessionID?: string }) {
  const sdk = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const rpc = () => sdk.api.rpc(AlibabaUsageRpc)
  const callOpts = () => (props.directory ? { location: { directory: props.directory } } : undefined)

  const nightWindow = createMemo(() => computeNightWindowInfo())

  const [loading, setLoading] = createSignal(true)
  const [data, setData] = createSignal<AlibabaUsage.DiscountedModels>()
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
      const result = await rpc().discountedModels({ refresh }, callOpts())
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

  const connectAgent = async () => {
    const sessionID = props.sessionID

    if (!sessionID) return
    stopPolling()
    setError(undefined)

    try {
      // The server command starts the callback login and hands the agent browse-driven instructions.
      await sdk.api.session.command({ sessionID, name: "alibabaLogin", text: "" })
      dialog.close()
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

  const renderModel = (model: AlibabaUsage.DiscountedModel) => (
    <div class="flex flex-col gap-1 rounded-lg border border-border-base bg-surface-base px-3.5 py-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-13-medium text-text-base">{model.name ?? model.modelId}</span>
        <Show when={model.percentOff !== undefined}>
          <span class="rounded bg-v2-state-bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-v2-state-fg-success">
            {language.t("dialog.alibabaDiscounts.percentOff", { percent: model.percentOff ?? 0 })}
          </span>
        </Show>
        <Show when={model.nightOnly}>
          <span class="rounded bg-surface-raised-base px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
            {language.t("dialog.alibabaDiscounts.nightOnly")}
          </span>
        </Show>
        <Show when={model.isNew}>
          <span class="rounded bg-v2-state-bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-v2-state-fg-success">
            {language.t("dialog.alibabaDiscounts.new")}
          </span>
        </Show>
        <span class="ml-auto text-12-regular text-text-muted">{model.provider}</span>
      </div>
    </div>
  )

  return (
    <Dialog size="normal" fit>
      <div class="flex flex-col gap-4 px-6 pb-6 pt-6 text-13-regular text-text-base">
        <Show when={loading()}>
          <div class="py-6 text-center text-text-muted">{language.t("dialog.alibabaDiscounts.loading")}</div>
        </Show>

        <Show when={!loading() && error()}>
          {(err) => (
            <div class="rounded-md border border-border-base bg-surface-base px-3 py-2 text-12-regular text-v2-state-fg-danger">
              {err()}
            </div>
          )}
        </Show>

        {/* Connected Discounts View */}
        <Show when={!loading() && !loginSession() && data()?.ok && data()}>
          {(item) => (
            <div class="flex flex-col gap-4">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2.5">
                  <ProviderIcon id="alibaba" class="!size-6 text-v2-icon-icon-base" aria-hidden="true" />
                  <div>
                    <DialogTitle>{language.t("dialog.alibabaDiscounts.title")}</DialogTitle>
                    <div class="text-12-regular text-text-muted">
                      {[item().site, item().region].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </div>
                <Button variant="outline" size="small" disabled={loading()} onClick={() => void load(true)}>
                  {language.t("dialog.alibabaUsage.refresh")}
                </Button>
              </div>

              <div class="text-12-regular leading-5 text-text-muted">
                {nightWindow().isActive
                  ? language.t("dialog.alibabaDiscounts.nightWindowActive", { window: nightWindow().label, countdown: nightWindow().countdown })
                  : language.t("dialog.alibabaDiscounts.nightWindowInactive", { window: nightWindow().label, countdown: nightWindow().countdown })}
              </div>

              <div class="flex flex-col gap-2">
                <div class="text-12-medium text-text-muted">{language.t("dialog.alibabaDiscounts.heading")}</div>
                <Show
                  when={item().models.length > 0}
                  fallback={
                    <div class="rounded-lg border border-border-base bg-surface-base px-3.5 py-3 text-12-regular text-text-muted">
                      {language.t("dialog.alibabaDiscounts.empty")}
                    </div>
                  }
                >
                  <div class="flex max-h-[320px] flex-col gap-2 overflow-y-auto" data-scrollable>
                    <For each={item().models}>{(model) => renderModel(model)}</For>
                  </div>
                </Show>
              </div>

              <div class="flex items-center justify-between text-12-regular text-text-muted tabular-nums">
                <span>
                  {language.t("dialog.alibabaDiscounts.summary", {
                    count: item().models.length,
                    total: item().total ?? item().models.length,
                  })}
                </span>
                <span>
                  {language.t("dialog.alibabaDiscounts.checkedAt", {
                    time: new Date(item().checkedAt).toLocaleTimeString(),
                  })}
                </span>
              </div>

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
              {language.t("dialog.alibabaDiscounts.connectDescription")}
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
              <Show when={props.sessionID}>
                <Button variant="outline" size="large" class="w-full" onClick={() => void connectAgent()}>
                  {language.t("dialog.alibabaUsage.connectAgent")}
                </Button>
              </Show>
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