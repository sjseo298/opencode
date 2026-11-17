import { createMemo, lazy, onCleanup, Show, Suspense } from "solid-js"
import { Option, Schema } from "effect"
import { Icon } from "@opencode/ui/icon"
import { Badge } from "@opencode/ui/badge"
import { usePanel, type MountedSession, type Plugin } from "@opencode/plugin/gui"
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
  const SessionObjectivesTab = lazy(() => import("./tab"))
  onCleanup(onIdle(() => void SessionObjectivesTab.preload()))

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
}

export default setup
