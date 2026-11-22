import { Plugin } from "@opencode/plugin/tui"
import { AlibabaUsageRpc, formatCycleProgress, formatQuotaPercent, type AlibabaUsage } from "@opencode/schema/alibaba-usage"
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useTheme } from "../../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "../../ui/dialog"

const BAR_WIDTH = 36

function buildBar(percent: number): { filled: string; empty: string } {
  const clamped = Math.min(100, Math.max(0, percent))
  const filledCount = Math.round((clamped / 100) * BAR_WIDTH)
  return {
    filled: "█".repeat(filledCount),
    empty: "░".repeat(Math.max(0, BAR_WIDTH - filledCount)),
  }
}

function AlibabaUsageDialog(props: { context: Plugin.Context }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const rpc = props.context.client.rpc(AlibabaUsageRpc)
  const location = () => ({ location: props.context.location ?? props.context.data.location.default() })

  const [loading, setLoading] = createSignal(true)
  const [data, setData] = createSignal<AlibabaUsage.TokenPlan>()
  const [rpcError, setRpcError] = createSignal<string>()
  const [loginSession, setLoginSession] = createSignal<{ url: string; state: string }>()
  const [loginStatusText, setLoginStatusText] = createSignal<string>()

  let pollTimer: ReturnType<typeof setInterval> | undefined

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  onCleanup(() => {
    stopPolling()
    const active = loginSession()
    if (active) void rpc.cancelLogin({ state: active.state }, location()).catch(() => {})
  })

  async function load(refresh = false) {
    setLoading(true)
    setRpcError(undefined)
    try {
      const result = await rpc.tokenPlan({ refresh }, location())
      setData(result)
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  async function startConnect() {
    stopPolling()
    setRpcError(undefined)
    setLoginStatusText("Starting Alibaba Cloud International login…")
    try {
      const started = await rpc.startLogin({}, location())
      setLoginSession({ url: started.url, state: started.state })
      setLoginStatusText("Waiting for browser login (or press m to paste redirect URL manually)…")

      const { openUrl } = await import("@opencode/util/open")
      openUrl(started.url).catch(() => {})

      pollTimer = setInterval(async () => {
        try {
          const status = await rpc.loginStatus({ state: started.state }, location())
          if (status.status === "complete") {
            stopPolling()
            setLoginSession(undefined)
            setLoginStatusText(undefined)
            props.context.ui.toast.show({ message: "Alibaba Cloud connected!", variant: "success" })
            await load(true)
          } else if (status.status === "expired" || status.status === "error") {
            stopPolling()
            setLoginSession(undefined)
            setLoginStatusText(status.message ?? "Login expired; press l to retry.")
          }
        } catch {
          // keep polling briefly
        }
      }, 1000)
    } catch (error) {
      setLoginStatusText(undefined)
      setRpcError(error instanceof Error ? error.message : String(error))
    }
  }

  async function promptManualComplete() {
    let active = loginSession()
    if (!active) {
      const started = await rpc.startLogin({}, location())
      active = { url: started.url, state: started.state }
      setLoginSession(active)
    }
    const pasted = await props.context.ui.dialog.prompt({
      title: "Manual Alibaba Cloud Login",
      description: `Open this URL in any browser (even on another machine):\n${active.url}\n\nAfter signing in, paste the redirected 127.0.0.1 URL (or access_token):`,
    })
    if (!pasted?.trim()) return
    const result = await rpc.completeLogin({ state: active.state, input: pasted.trim() }, location())
    if (!result.ok) {
      setRpcError(result.message ?? "Could not complete login")
      return
    }
    stopPolling()
    setLoginSession(undefined)
    setLoginStatusText(undefined)
    props.context.ui.toast.show({ message: "Alibaba Cloud connected!", variant: "success" })
    await load(true)
  }

  async function disconnect() {
    stopPolling()
    await rpc.logout({}, location())
    setLoginSession(undefined)
    setLoginStatusText(undefined)
    props.context.ui.toast.show({ message: "Alibaba Cloud session disconnected.", variant: "info" })
    await load(true)
  }

  onMount(() => {
    dialog.setSize("large")
    void load(false)
  })

  props.context.keymap.layer(() => ({
    commands: [
      { bind: "r", title: "Refresh", run: () => void load(true) },
      { bind: "l", title: "Login", run: () => void startConnect() },
      { bind: "m", title: "Manual paste", run: () => void promptManualComplete() },
      { bind: "x", title: "Logout", run: () => void disconnect() },
    ],
  }))

  const cycle = createMemo(() => {
    const resetAt = data()?.resetAt
    return resetAt !== undefined ? formatCycleProgress(resetAt) : undefined
  })

  const bar = createMemo(() => buildBar(data()?.usedPercent ?? 0))

  const barColor = createMemo(() => {
    const used = data()?.usedPercent ?? 0
    if (used >= 90) return theme.text.feedback.error.base
    if (used >= 70) return theme.text.feedback.warning.base
    return theme.text.feedback.success.base
  })

  const paceLabel = createMemo(() => {
    const currentCycle = cycle()
    const currentData = data()
    if (!currentCycle || !currentData) return undefined
    const delta = currentData.usedPercent - currentCycle.expectedPercent
    if (delta <= -10) return { text: "Well below expected pace", color: theme.text.feedback.success.base }
    if (delta <= 10) return { text: "On expected pace", color: theme.text.base }
    return { text: "Ahead of expected pace", color: theme.text.feedback.warning.base }
  })

  return (
    <DialogLayout
      header={
        <DialogHeader
          title="Alibaba Token Plan (International)"
          closeLabel="esc close · r refresh · l login · m manual"
          onClose={() => dialog.clear()}
        />
      }
    >
      <box flexDirection="column" gap={1}>
        <Show when={loading()}>
          <box flexDirection="row" gap={1}>
            <Spinner />
            <text fg={theme.text.muted}>Querying Alibaba Token Plan usage…</text>
          </box>
        </Show>

        <Show when={loginSession()}>
          {(session) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                Login URL (open locally or on another machine):
              </text>
              <text fg={theme.text.muted} wrapMode="word">
                {session().url}
              </text>
              <Show when={loginStatusText()}>
                {(msg) => <text fg={theme.text.base}>{msg()}</text>}
              </Show>
            </box>
          )}
        </Show>

        <Show when={!loading() && rpcError()}>
          {(err) => <text fg={theme.text.feedback.error.base}>{err()}</text>}
        </Show>

        <Show when={!loading() && !rpcError() && data()}>
          {(item) => (
            <Show
              when={item().ok}
              fallback={
                <box flexDirection="column" gap={1}>
                  <text fg={theme.text.feedback.error.base}>{item().error ?? "Unable to read Token Plan usage"}</text>
                  <Show when={item().hint}>{(hint) => <text fg={theme.text.muted}>{hint()}</text>}</Show>
                  <Show when={item().needsAuth}>
                    <text fg={theme.text.base}>
                      Press <b>l</b> to open browser login, or <b>m</b> to paste a redirected URL from another machine.
                    </text>
                  </Show>
                </box>
              }
            >
              <box flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                    Monthly Subscription Quota
                  </text>
                  <text fg={theme.text.muted}>
                    {[item().site, item().region].filter(Boolean).join(" · ")}
                  </text>
                </box>

                <box flexDirection="row" gap={1}>
                  <text fg={barColor()}>{bar().filled}</text>
                  <text fg={theme.text.muted}>{bar().empty}</text>
                  <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                    {formatQuotaPercent(item().usedPercent)} used
                  </text>
                  <text fg={theme.text.muted}>({formatQuotaPercent(item().remainingPercent)} left)</text>
                </box>

                <Show when={cycle()}>
                  {(c) => (
                    <box flexDirection="column" gap={0}>
                      <text fg={theme.text.base}>
                        Cycle position: <b>Day {c().elapsedDays} of {c().cycleDays}</b> ({c().remainingDays}d remaining)
                      </text>
                      <text fg={theme.text.muted}>
                        Expected pace by today: ~{c().expectedPercent.toFixed(1)}%
                        <Show when={paceLabel()}>
                          {(pace) => <span style={{ fg: pace().color }}> · {pace().text}</span>}
                        </Show>
                      </text>
                      <text fg={theme.text.base}>
                        Cutoff / Reset: <b>{c().resetLabel}</b>{" "}
                        <span style={{ fg: theme.text.muted }}>({c().countdownLabel})</span>
                      </text>
                    </box>
                  )}
                </Show>

                <text fg={theme.text.muted}>
                  Checked at {new Date(item().checkedAt).toLocaleTimeString()} · r refresh · l re-login · x logout
                </text>
              </box>
            </Show>
          )}
        </Show>
      </box>
    </DialogLayout>
  )
}

export default Plugin.define({
  id: "opencode.alibaba.usage",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "alibaba.usage",
          title: "Alibaba Token Plan usage",
          group: "Provider",
          palette: true,
          slash: { name: "alibabaUsage" },
          run: () => context.ui.dialog.show(() => <AlibabaUsageDialog context={context} />),
        },
      ],
    }))
  },
})
