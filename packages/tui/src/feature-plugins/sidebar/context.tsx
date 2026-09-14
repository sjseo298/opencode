import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { formatSessionUsage } from "../../util/session-usage"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))

  const state = createMemo(() => {
    const usage = formatSessionUsage({ messages: msg(), providers: props.api.state.provider, session: session() })
    if (!usage) return { tokens: "0", percent: "0", cost: money.format(session()?.cost ?? 0) }
    return {
      tokens: usage.tokens.toLocaleString(),
      percent: String(usage.percent ?? 0),
      cost: usage.cost ?? money.format(session()?.cost ?? 0),
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens} tokens</text>
      <text fg={theme().textMuted}>{state().percent}% used</text>
      <text fg={theme().textMuted}>{state().cost} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
