import { createMemo, lazy, onCleanup, Show, Suspense } from "solid-js"
import { Option, Schema } from "effect"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Badge } from "@opencode/ui/badge"
import { Tooltip } from "@opencode/ui/tooltip"
import { Command, MenuItem, Slot, usePanel, type MountedSession, type Plugin } from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

const ProgressSummarySchema = Schema.Struct({
  title: Schema.String,
  secondaries: Schema.optional(
    Schema.Array(
      Schema.Struct({
        status: Schema.optional(Schema.String),
      }),
    ),
  ),
})

const decodeProgressSummary = Schema.decodeUnknownOption(ProgressSummarySchema)

function objectiveProgress(session: MountedSession): { resolved: number; total: number } | undefined {
  if (!session.id) return undefined
  const decoded = decodeProgressSummary(session.server.data.session.get(session.id)?.metadata?.objectives)

  if (Option.isNone(decoded) || !decoded.value.title) return undefined
  const secondaries = decoded.value.secondaries ?? []
  const resolved = secondaries.filter((s) => s.status === "resolved").length

  return { resolved, total: secondaries.length }
}

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const key = `${ctx.id}:main`
  const SessionObjectivesTab = lazy(() => import("./tab"))
  onCleanup(onIdle(() => void SessionObjectivesTab.preload()))

  const open = (session: MountedSession) => {
    ctx.layout.open(key, session, ctx.layout.narrow() ? undefined : { tab: "select" })
  }

  const toggle = (session: MountedSession) => {
    if (!ctx.layout.narrow() && ctx.layout.state(key, session) === "visible") {
      ctx.layout.close(key, session)

      return
    }

    open(session)
  }

  const mac = /(Mac|iPhone|iPad)/.test(navigator.platform)

  const tab: BuiltinPanelTab = {
    id: "main",
    get title() {
      return ctx.t("tab.title")
    },
    label: (state) => {
      const progress = createMemo(() => objectiveProgress(state.session))

      return (
        <div class="flex items-center gap-1.5">
          <Icon name="checklist" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          <span>{ctx.t("tab.title")}</span>
          <Show when={progress()}>
            {(p) => (
              <Show when={p().total > 0}>
                <Badge>{`${p().resolved}/${p().total}`}</Badge>
              </Show>
            )}
          </Show>
        </div>
      )
    },
  }

  ctx.add(
    BuiltinPanel,
    (): BuiltinPanel => ({
      id: "main",
      region: "side",
      mobile: { title: ctx.t("mobile.title"), order: 45, kind: "menu", icon: "checklist" },
      list: (input) => (input.open.includes("main") ? [tab] : []),
      closed: () => ({ icon: "checklist" }),
      render: (props) => {
        const panel = usePanel()

        return (
          <Show
            when={panel.placement() !== "mobile"}
            fallback={
              <Suspense>
                <SessionObjectivesTab session={props.session} />
              </Suspense>
            }
          >
            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
              <Suspense>
                <SessionObjectivesTab session={props.session} />
              </Suspense>
            </div>
          </Show>
        )
      },
    }),
  )

  ctx.add(
    Command,
    (): Command => ({
      id: "toggle",
      title: ctx.t("command.toggle"),
      description: ctx.t("command.toggle.description"),
      group: ctx.t("command.category.view"),
      bind: mac ? "ctrl+meta+o" : "ctrl+alt+o",
      slash: { name: "objectives" },
      editable: true,
      enabled: !!ctx.sessions.current(),
      run() {
        const session = ctx.sessions.current()

        if (session) toggle(session)
      },
    }),
  )

  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = ctx.sessions.current()

    if (!session || ctx.layout.narrow()) return undefined
    const progress = objectiveProgress(session)

    return {
      menu: "session.panel",
      id: "open",
      title: ctx.t("tab.title"),
      opened: ctx.layout.state(key, session) !== "closed",
      description: progress && progress.total > 0 ? `${progress.resolved}/${progress.total}` : undefined,
      icon: "checklist",
      keybind: "objectives.toggle",
      order: 40,
      run: () => open(session),
    }
  })

  ctx.add(Slot, {
    at: "session.panel.end",
    render: (input) => {
      const progress = createMemo(() => objectiveProgress(input.session))
      const visible = createMemo(() => ctx.layout.state(key, input.session) === "visible")

      return (
        <Show when={progress()}>
          <Tooltip value={ctx.t("command.toggle")} placement="bottom">
            <IconButton
              type="button"
              variant="ghost-muted"
              size="large"
              icon={<Icon name="checklist" />}
              aria-label={ctx.t("command.toggle")}
              aria-pressed={visible()}
              onClick={() => toggle(input.session)}
            />
          </Tooltip>
        </Show>
      )
    },
  })
}

export default setup
