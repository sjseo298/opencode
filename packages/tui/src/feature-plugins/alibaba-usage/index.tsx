import { Plugin } from "@opencode/plugin/tui"
import {
  AlibabaUsageRpc,
  computeBudgetBreakdown,
  computeNightWindowInfo,
  formatQuotaPercent,
  type AlibabaUsage,
  type QuotaHealth,
  type QuotaPace,
} from "@opencode/schema/alibaba-usage"
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

function buildStackedBar(usedPercent: number, limitPercent: number, scaleMax: number): {
  base: string
  cushion: string
  empty: string
} {
  const safeMax = Math.max(1, scaleMax)
  const baseCount = Math.min(BAR_WIDTH, Math.round((Math.min(usedPercent, limitPercent) / safeMax) * BAR_WIDTH))
  const totalCount = Math.min(BAR_WIDTH, Math.round((limitPercent / safeMax) * BAR_WIDTH))
  const cushionCount = Math.max(0, totalCount - baseCount)
  return {
    base: "█".repeat(baseCount),
    cushion: "▓".repeat(cushionCount),
    empty: "░".repeat(Math.max(0, BAR_WIDTH - baseCount - cushionCount)),
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
  const [selectedAction, setSelectedAction] = createSignal<string>("agent")

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
      setSelectedAction(result.ok ? "refresh" : "agent")
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

  async function connectAgent() {
    const route = props.context.ui.router.current()
    if (route.type !== "session") {
      props.context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    dialog.clear()
    try {
      // The server command starts the callback login and hands the agent browse-driven instructions.
      await props.context.client.session.command({ sessionID: route.sessionID, name: "alibabaLogin", text: "" })
    } catch (error) {
      props.context.ui.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" })
    }
  }

  async function cancelConnect() {
    stopPolling()
    const active = loginSession()
    setLoginSession(undefined)
    setLoginStatusText(undefined)
    if (active) await rpc.cancelLogin({ state: active.state }, location()).catch(() => {})
    setSelectedAction(data()?.ok ? "refresh" : "agent")
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
      { id: "agent", label: "Connect via Agent Browser (Automatic)", primary: true, run: () => void connectAgent() },
      { id: "browser", label: "Connect with Browser (Local)", run: () => void startConnect() },
      { id: "manual", label: "Paste Redirect URL / Token (Manual)", run: () => void promptManualComplete() },
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

  const budget = createMemo(() => {
    const item = data()
    if (!item?.ok || item.resetAt === undefined) return undefined
    return computeBudgetBreakdown(item.usedPercent, item.resetAt)
  })

  const healthMeta = (health: QuotaHealth) => {
    if (health === "critical") return { label: "CRITICAL", color: theme.text.feedback.error.base }
    if (health === "caution") return { label: "CAUTION", color: theme.text.feedback.warning.base }
    return { label: "HEALTHY", color: theme.text.feedback.success.base }
  }

  const monthlyBar = createMemo(() => {
    const used = data()?.usedPercent ?? 0
    const filledCount = Math.round((Math.min(100, Math.max(0, used)) / 100) * BAR_WIDTH)
    return {
      filled: "█".repeat(filledCount),
      empty: "░".repeat(Math.max(0, BAR_WIDTH - filledCount)),
    }
  })

  const weeklyCap = createMemo(() => {
    const b = budget()
    if (!b) return 0
    return Math.min(b.remainingPercent, b.baseWeeklyPercent + Math.max(0, b.cushionPercent))
  })

  const weeklyBar = createMemo(() => {
    const b = budget()
    if (!b) return { base: "", cushion: "", empty: "░".repeat(BAR_WIDTH) }
    const scale = Math.max(b.estimatedWeeklyPercent, weeklyCap(), 25)
    return buildStackedBar(b.estimatedWeeklyPercent, weeklyCap(), scale)
  })

  const dailyBar = createMemo(() => {
    const b = budget()
    if (!b) return { base: "", cushion: "", empty: "░".repeat(BAR_WIDTH) }
    const scale = Math.max(b.estimatedDailyPercent, b.maxTodayWithCushion, 5)
    return buildStackedBar(b.estimatedDailyPercent, b.maxTodayWithCushion, scale)
  })

  const paceMeta = (pace: QuotaPace) => {
    if (pace === "over-pace") return { label: "OVER PACE", color: theme.text.feedback.error.base }
    if (pace === "within-budget") return { label: "UNDER PACE", color: theme.text.feedback.success.base }
    const b = budget()
    return {
      label: "IN QUOTA",
      color: b && b.cushionPercent < 0 ? theme.text.feedback.warning.base : theme.text.feedback.success.base,
    }
  }

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
                    <Show when={budget()}>
                      {(b) => (
                        <span style={{ fg: healthMeta(b().health).color }}>
                          {" "}
                          [{healthMeta(b().health).label}]
                        </span>
                      )}
                    </Show>
                  </text>
                  <text fg={theme.text.muted}>
                    {[item().site, item().region].filter(Boolean).join(" · ")}
                  </text>
                </box>

                <box flexDirection="row" gap={1}>
                  <text fg={budget() ? healthMeta(budget()!.health).color : theme.text.feedback.success.base}>
                    {monthlyBar().filled}
                  </text>
                  <text fg={theme.text.muted}>{monthlyBar().empty}</text>
                  <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                    {formatQuotaPercent(item().usedPercent)} used
                  </text>
                  <text fg={theme.text.muted}>({formatQuotaPercent(item().remainingPercent)} left)</text>
                </box>

                <Show when={budget()}>
                  {(b) => {
                    const statusColor = () => healthMeta(b().health).color
                    const cushionText = () =>
                      b().cushionPercent >= 0
                        ? `+${formatQuotaPercent(b().cushionPercent)} cushion`
                        : `${formatQuotaPercent(Math.abs(b().cushionPercent))} over pace`
                    return (
                      <box flexDirection="column" gap={1}>
                        <box flexDirection="column" gap={0}>
                          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                            Weekly Allowance (with cushion){" "}
                            <span style={{ fg: paceMeta(b().weeklyPace).color }}>[{paceMeta(b().weeklyPace).label}]</span>
                          </text>
                          <box flexDirection="row" gap={1}>
                            <text fg={paceMeta(b().weeklyPace).color}>{weeklyBar().base}</text>
                            <Show when={weeklyBar().cushion.length > 0}>
                              <text fg={theme.text.feedback.success.base}>{weeklyBar().cushion}</text>
                            </Show>
                            <text fg={theme.text.muted}>{weeklyBar().empty}</text>
                            <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                              avg {formatQuotaPercent(b().estimatedWeeklyPercent)}/wk
                            </text>
                            <text fg={theme.text.muted}>
                              (left ~{formatQuotaPercent(Math.max(0, weeklyCap() - b().estimatedWeeklyPercent))} ·
                              quota {formatQuotaPercent(weeklyCap())}/wk · base {formatQuotaPercent(b().baseWeeklyPercent)})
                            </text>
                          </box>
                        </box>

                        <box flexDirection="column" gap={0}>
                          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                            Daily Allowance{" "}
                            <span style={{ fg: paceMeta(b().dailyPace).color }}>[{paceMeta(b().dailyPace).label}]</span>{" "}
                            <span style={{ fg: b().cushionPercent >= 0 ? theme.text.feedback.success.base : statusColor() }}>
                              ({cushionText()})
                            </span>
                          </text>
                          <box flexDirection="row" gap={1}>
                            <text fg={paceMeta(b().dailyPace).color}>{dailyBar().base}</text>
                            <Show when={dailyBar().cushion.length > 0}>
                              <text fg={theme.text.feedback.success.base}>{dailyBar().cushion}</text>
                            </Show>
                            <text fg={theme.text.muted}>{dailyBar().empty}</text>
                            <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                              avg {formatQuotaPercent(b().estimatedDailyPercent)}/day
                            </text>
                            <text fg={theme.text.muted}>
                              (left ~{formatQuotaPercent(Math.max(0, b().maxTodayWithCushion - b().estimatedDailyPercent))} ·
                              cap {formatQuotaPercent(b().maxTodayWithCushion)}/day · base{" "}
                              {formatQuotaPercent(b().baseDailyPercent)})
                            </text>
                          </box>
                        </box>

                        <box flexDirection="column" gap={0}>
                          <text fg={theme.text.base}>
                            Cycle: <b>Day {b().cycle.elapsedDays} of {b().cycle.cycleDays}</b> ({b().cycle.remainingDays}d
                            left) · Expected: ~{b().cycle.expectedPercent.toFixed(1)}%
                          </text>
                          <Show when={b().daysUntilCycleExhaustion !== undefined}>
                            <text
                              fg={
                                b().daysUntilCycleExhaustion! < b().cycle.remainingDays
                                  ? statusColor()
                                  : theme.text.feedback.success.base
                              }
                            >
                              At avg pace the quota lasts ~{b().daysUntilCycleExhaustion!.toFixed(1)}d ·{" "}
                              {b().cycle.remainingDays}d left in cycle
                            </text>
                          </Show>
                          <text fg={theme.text.muted}>
                            Period: {b().cycle.startLabel} → {b().cycle.resetLabel} ({b().cycle.countdownLabel})
                          </text>
                        </box>
                      </box>
                    )
                  }}
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

function AlibabaDiscountsDialog(props: { context: Plugin.Context }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const rpc = props.context.client.rpc(AlibabaUsageRpc)
  const location = () => ({ location: props.context.location ?? props.context.data.location.default() })

  const [loading, setLoading] = createSignal(true)
  const [data, setData] = createSignal<AlibabaUsage.DiscountedModels>()
  const [rpcError, setRpcError] = createSignal<string>()
  const [loginSession, setLoginSession] = createSignal<{ url: string; state: string }>()
  const [loginStatusText, setLoginStatusText] = createSignal<string>()
  const [selectedAction, setSelectedAction] = createSignal<string>("agent")

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
      const result = await rpc.discountedModels({ refresh }, location())
      setData(result)
      setSelectedAction(result.ok ? "refresh" : "agent")
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

  async function connectAgent() {
    const route = props.context.ui.router.current()
    if (route.type !== "session") {
      props.context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    dialog.clear()
    try {
      // The server command starts the callback login and hands the agent browse-driven instructions.
      await props.context.client.session.command({ sessionID: route.sessionID, name: "alibabaLogin", text: "" })
    } catch (error) {
      props.context.ui.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" })
    }
  }

  async function cancelConnect() {
    stopPolling()
    const active = loginSession()
    setLoginSession(undefined)
    setLoginStatusText(undefined)
    if (active) await rpc.cancelLogin({ state: active.state }, location()).catch(() => {})
    setSelectedAction(data()?.ok ? "refresh" : "agent")
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
      { id: "agent", label: "Connect via Agent Browser (Automatic)", primary: true, run: () => void connectAgent() },
      { id: "browser", label: "Connect with Browser (Local)", run: () => void startConnect() },
      { id: "manual", label: "Paste Redirect URL / Token (Manual)", run: () => void promptManualComplete() },
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

  const nightWindow = createMemo(() => computeNightWindowInfo())

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
          fg={active() ? theme.text.action.primary.focused : action.primary ? theme.text.base : theme.text.muted}
          attributes={active() ? TextAttributes.BOLD : undefined}
        >
          {action.label}
        </text>
      </box>
    )
  }

  const renderModel = (model: AlibabaUsage.DiscountedModel) => (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          {model.name ?? model.modelId}
        </text>
        <Show when={model.percentOff !== undefined}>
          <text fg={theme.text.feedback.success.base} attributes={TextAttributes.BOLD}>
            {model.percentOff}% off
          </text>
        </Show>
        <Show when={model.nightOnly}>
          <text fg={theme.text.muted}>night only</text>
        </Show>
        <Show when={model.isNew}>
          <text fg={theme.text.feedback.success.base}>New</text>
        </Show>
        <text fg={theme.text.muted}>{model.provider}</text>
      </box>
    </box>
  )

  return (
    <DialogLayout
      header={
        <DialogHeader title="Alibaba Token Plan · Discounts" closeLabel="esc close" onClose={() => dialog.clear()} />
      }
    >
      <box flexDirection="column" gap={1}>
        <Show when={loading()}>
          <box flexDirection="row" gap={1}>
            <Spinner />
            <text fg={theme.text.muted}>Querying Token Plan discounts…</text>
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
                    Sign in once to see which Token Plan models are discounted and when the night window applies.
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
                    Discounted Models
                  </text>
                  <text fg={theme.text.muted}>{[item().site, item().region].filter(Boolean).join(" · ")}</text>
                </box>

                <text fg={theme.text.muted} wrapMode="word">
                  {nightWindow().isActive
                    ? `Night discounts active: ${nightWindow().label} (${nightWindow().countdown}).`
                    : `Night discounts: ${nightWindow().label}. Starts in ${nightWindow().countdown}.`}
                </text>

                <Show
                  when={item().models.length > 0}
                  fallback={<text fg={theme.text.muted}>No discounted models right now.</text>}
                >
                  <box flexDirection="column" gap={1}>
                    <For each={item().models}>{(model) => renderModel(model)}</For>
                  </box>
                </Show>

                <text fg={theme.text.muted}>
                  {item().models.length} of {item().total ?? item().models.length} models · checked{" "}
                  {new Date(item().checkedAt).toLocaleTimeString()}
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
        {
          id: "alibaba.discounts",
          title: "Alibaba Token Plan discounts",
          group: "Provider",
          palette: true,
          slash: { name: "alibabaDiscounts" },
          run: () => context.ui.dialog.show(() => <AlibabaDiscountsDialog context={context} />),
        },
      ],
    }))
  },
})
