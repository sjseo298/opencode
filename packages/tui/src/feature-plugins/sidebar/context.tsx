import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { contextUsage } from "../../util/session"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function SidebarContext(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const [dynamicRev, setDynamicRev] = createSignal(0)

  onMount(() => {
    const store = (globalThis as any)?.__OPENCODE_DYNAMIC_CONTEXT__
    if (store?.subscribe) {
      const unsub = store.subscribe(() => setDynamicRev((r) => r + 1))
      onCleanup(unsub)
    }
  })

  const msg = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))

  const state = createMemo(() => {
    dynamicRev()
    return contextUsage(msg(), props.context.data.location.model.list(session()?.location), session()?.revert?.messageID)
  })

  return (
    <Show when={state() || cost() > 0}>
      <box>
        <text fg={theme.text.base}>
          <b>Context</b>
        </text>
        <Show when={state()}>
          {(value) => (
            <>
              <text fg={theme.text.muted}>{value().tokens.toLocaleString()} tokens</text>
              <Show when={value().percent !== undefined}>
                <text fg={theme.text.muted}>{value().percent}% used</text>
              </Show>
            </>
          )}
        </Show>
        <Show when={cost() > 0}>
          <text fg={theme.text.muted}>{money.format(cost())} spent</text>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.context",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarContext context={context} sessionID={props.sessionID} />,
    })
  },
})
