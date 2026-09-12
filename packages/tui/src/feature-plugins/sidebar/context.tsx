import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)

    const sessionModel = session()?.model
    const providerID = sessionModel?.providerID
    const modelID = sessionModel?.id
    const sessionContextModel =
      providerID && modelID
        ? props.api.state.provider.find((item) => item.id === providerID)?.models[modelID]
        : undefined
    const lastContextModel = last
      ? props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
      : undefined
    const contextModel = sessionContextModel ?? lastContextModel
    const contextLimit = contextModel?.limit.context

    if (!last) {
      return {
        tokens: 0,
        percent: null,
        contextLimit,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    return {
      tokens,
      percent: contextLimit ? Math.round((tokens / contextLimit) * 100) : null,
      contextLimit,
    }
  })

  const usageText = createMemo(() => {
    const value = state()
    if (!value.contextLimit) return `${value.percent ?? 0}% used`
    return `${value.percent ?? 0}% used of ${value.contextLimit.toLocaleString()} tokens`
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{usageText()}</text>
      <Show when={state().contextLimit}>
        {(limit) => <text fg={theme().textMuted}>Detected limit {limit().toLocaleString()} tokens</text>}
      </Show>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
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
