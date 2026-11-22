import { Plugin } from "@opencode/plugin/tui"
import { AlibabaUsageRpc, formatCycleProgress, formatQuotaPercent, type AlibabaUsage } from "@opencode/schema/alibaba-usage"
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, onMount, Show } from "solid-js"
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

  onMount(() => {
    dialog.setSize("large")
    void load(false)
  })

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "r",
        title: "Refresh",
        run: () => void load(true),
      },
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
      header={<DialogHeader title="Alibaba Token Plan" closeLabel="esc close · r refresh" onClose={() => dialog.clear()} />}
    >
      <box flexDirection="column" gap={1}>
        <Show when={loading()}>
          <box flexDirection="row" gap={1}>
            <Spinner />
            <text fg={theme.text.muted}>Querying Alibaba Token Plan usage…</text>
          </box>
        </Show>

        <Show when={!loading() && rpcError()}>
          {(err) => (
            <box flexDirection="column" gap={1}>
              <text fg={theme.text.feedback.error.base}>{err()}</text>
            </box>
          )}
        </Show>

        <Show when={!loading() && !rpcError() && data()}>
          {(item) => (
            <Show
              when={item().ok}
              fallback={
                <box flexDirection="column" gap={1}>
                  <text fg={theme.text.feedback.error.base}>{item().error ?? "Unable to read Token Plan usage"}</text>
                  <Show when={item().hint}>
                    {(hint) => <text fg={theme.text.muted}>{hint()}</text>}
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
                    {[item().site, item().region, item().profile ? `profile: ${item().profile}` : undefined]
                      .filter(Boolean)
                      .join(" · ")}
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
                        Cutoff / Reset: <b>{c().resetLabel}</b> <span style={{ fg: theme.text.muted }}>({c().countdownLabel})</span>
                      </text>
                    </box>
                  )}
                </Show>

                <text fg={theme.text.muted}>
                  Checked at {new Date(item().checkedAt).toLocaleTimeString()} · Press r to refresh
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
