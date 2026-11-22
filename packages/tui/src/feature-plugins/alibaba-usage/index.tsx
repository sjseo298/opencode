import { Plugin } from "@opencode/plugin/tui"
import { AlibabaUsageRpc, formatCycleProgress, formatQuotaPercent, type AlibabaUsage } from "@opencode/schema/alibaba-usage"
import { RGBA, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useTheme } from "../../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "../../ui/dialog"

const BAR_WIDTH = 36

type ButtonAction = {
  readonly id: string
  readonly label: string
  readonly primary?: boolean
  readonly run: () => void
}

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
  const [selectedAction, setSelectedAction] = createSignal<string>("browser")

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
      setSelectedAction(result.ok ? "refresh" : "browser")
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  async function ensureLoginSession() {
    const existing = loginSession()
    if (existing) return existing
    const started = await rpc.startLogin({}, location())
    const session = { url: started.url, state: started.state }
    setLoginSession(session)
    return session
  }

  async function startConnect() {
    stopPolling()
    setRpcError(undefined)
    setLoginStatusText("Opening Alibaba Cloud International login in browser…")
    try {
      const session = await ensureLoginSession()
      setLoginStatusText("Waiting for browser authorization…")
      setSelectedAction("manual")

      const { openUrl } = await import("@opencode/util/open")
      openUrl(session.url).catch(() => {})

      pollTimer = setInterval(async () => {
        try {
          const status = await rpc.loginStatus({ state: session.state }, location())
          if (status.status === "complete") {
            stopPolling()
            setLoginSession(undefined)
            setLoginStatusText(undefined)
            props.context.ui.toast.show({ message: "Alibaba Cloud connected!", variant: "success" })
            await load(true)
          } else if (status.status === "expired" || status.status === "error") {
            stopPolling()
            setLoginSession(undefined)
            setLoginStatusText(status.message ?? "Login expired. Try connecting again.")
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
    try {
      const active = await ensureLoginSession()
      const pasted = await props.context.ui.dialog.prompt({
        title: "Paste Redirect URL or Access Token",
        description: `Open this URL in any browser (including on another machine):\n${active.url}\n\nAfter signing in, copy the redirected 127.0.0.1 URL (or access_token) and paste it below:`,
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
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    }
  }

  async function cancelConnect() {
    stopPolling()
    const active = loginSession()
    setLoginSession(undefined)
    setLoginStatusText(undefined)
    if (active) await rpc.cancelLogin({ state: active.state }, location()).catch(() => {})
    setSelectedAction(data()?.ok ? "refresh" : "browser")
  }

  async function disconnect() {
    stopPolling()
    await rpc.logout({}, location())
    setLoginSession(undefined)
    setLoginStatusText(undefined)
    props.context.ui.toast.show({ message: "Alibaba Cloud session disconnected.", variant: "info" })
    await load(true)
  }

  const actions = createMemo<readonly ButtonAction[]>(() => {
    if (loginSession()) {
      return [
        { id: "manual", label: "Paste URL / Token", primary: true, run: () => void promptManualComplete() },
        { id: "reopen", label: "Reopen Browser", run: () => void startConnect() },
        { id: "cancel", label: "Cancel", run: () => void cancelConnect() },
      ]
    }
    if (data()?.ok) {
      return [
        { id: "refresh", label: "Refresh", primary: true, run: () => void load(true) },
        { id: "browser", label: "Reconnect", run: () => void startConnect() },
        { id: "logout", label: "Disconnect", run: () => void disconnect() },
        { id: "close", label: "Close", run: () => dialog.clear() },
      ]
    }
    return [
      { id: "browser", label: "Connect with Browser", primary: true, run: () => void startConnect() },
      { id: "manual", label: "Paste URL / Token (Manual)", run: () => void promptManualComplete() },
      { id: "close", label: "Close", run: () => dialog.clear() },
    ]
  })

  function stepAction(by: number) {
    const list = actions()
    if (!list.length) return
    const idx = Math.max(0, list.findIndex((item) => item.id === selectedAction()))
    const next = list[(idx + by + list.length) % list.length]
    if (next) setSelectedAction(next.id)
  }

  function runSelected() {
    const list = actions()
    const target = list.find((item) => item.id === selectedAction()) ?? list[0]
    target?.run()
  }

  onMount(() => {
    dialog.setSize("large")
    void load(false)
  })

  props.context.keymap.layer(() => ({
    commands: [
      { bind: "return", title: "Confirm", run: runSelected },
      { bind: "left", title: "Previous button", run: () => stepAction(-1) },
      { bind: "up", title: "Previous button", run: () => stepAction(-1) },
      { bind: "shift+tab", title: "Previous button", run: () => stepAction(-1) },
      { bind: "right", title: "Next button", run: () => stepAction(1) },
      { bind: "down", title: "Next button", run: () => stepAction(1) },
      { bind: "tab", title: "Next button", run: () => stepAction(1) },
      { bind: "r", title: "Refresh", run: () => void load(true) },
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

  const renderButton = (action: ButtonAction) => {
    const active = () => selectedAction() === action.id
    return (
      <box
        paddingLeft={2}
        paddingRight={2}
        paddingTop={0}
        paddingBottom={0}
        backgroundColor={active() ? theme.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
        onMouseOver={() => setSelectedAction(action.id)}
        onMouseUp={action.run}
      >
        <text
          fg={
            active()
              ? theme.text.action.primary.focused
              : action.primary
                ? theme.text.base
                : theme.text.muted
          }
          attributes={active() ? TextAttributes.BOLD : undefined}
        >
          {action.label}
        </text>
      </box>
    )
  }

  return (
    <DialogLayout
      header={
        <DialogHeader
          title="Alibaba Token Plan · International"
          closeLabel="esc close"
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
            <box flexDirection="column" gap={1}>
              <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                Sign in to Alibaba Cloud Model Studio
              </text>
              <text fg={theme.text.muted} wrapMode="word">
                Open this URL locally or on another machine, then paste the redirected URL if needed:
              </text>
              <text fg={theme.text.base} wrapMode="word">
                {session().url}
              </text>
              <Show when={loginStatusText()}>
                {(msg) => (
                  <box flexDirection="row" gap={1}>
                    <Spinner />
                    <text fg={theme.text.muted}>{msg()}</text>
                  </box>
                )}
              </Show>
            </box>
          )}
        </Show>

        <Show when={!loading() && rpcError()}>
          {(err) => <text fg={theme.text.feedback.error.base}>{err()}</text>}
        </Show>

        <Show when={!loading() && !loginSession() && !rpcError() && data()}>
          {(item) => (
            <Show
              when={item().ok}
              fallback={
                <box flexDirection="column" gap={1}>
                  <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                    Connect your Alibaba Cloud account
                  </text>
                  <text fg={theme.text.muted} wrapMode="word">
                    Sign in once to inspect your Token Plan monthly quota, billing cycle pace, and exact cutoff date.
                  </text>
                  <Show when={item().error && !item().needsAuth}>
                    <text fg={theme.text.feedback.error.base}>{item().error}</text>
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
                        Period: {c().startLabel} → {c().resetLabel}
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
                  Checked at {new Date(item().checkedAt).toLocaleTimeString()}
                </text>
              </box>
            </Show>
          )}
        </Show>

        <Show when={!loading()}>
          <box flexDirection="row" gap={1} paddingTop={1}>
            <For each={actions()}>{(action) => renderButton(action)}</For>
          </box>
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
