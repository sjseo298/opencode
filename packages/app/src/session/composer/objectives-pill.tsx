import { Popover } from "@kobalte/core/popover"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { MenuScroll } from "@opencode/ui/menu-scroll"
import { createEffect, createMemo, For, Match, on, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import {
  activeSecondaryObjective,
  type ObjectiveStatus,
  type PrimaryObjectiveStatus,
  type PrimaryObjectiveView,
  type SecondaryObjectiveView,
  type TertiaryObjectiveView,
} from "../objectives/model"
import { composerLanePlacement, useComposerLaneAlignment } from "./composer-lane"
import "./objectives-pill.css"

export function SessionObjectivesPill(props: {
  objectives: PrimaryObjectiveView
  onReviewPlan?: () => void
  onOpenPanel?: () => void
  defaultOpen?: boolean
}) {
  const language = useLanguage()
  const alignment = useComposerLaneAlignment()
  const [state, setState] = createStore({ open: props.defaultOpen ?? false })

  const total = createMemo(() => props.objectives.secondaries.length)
  const resolved = createMemo(() => props.objectives.secondaries.filter((s) => s.status === "resolved").length)
  const current = createMemo(() => activeSecondaryObjective(props.objectives))

  const label = () =>
    language.t("session.objectives.label", {
      resolved: String(resolved()),
      total: String(total()),
    })

  const pillText = createMemo(() => {
    const status = props.objectives.status

    if (status === "presented_awaiting_confirmation") return language.t("session.objectives.awaitingApproval")

    if (status === "investigating") return `${language.t("session.objectives.investigating")}: ${props.objectives.title}`

    if (status === "resolved") return `${language.t("session.objectives.resolved")}: ${props.objectives.title}`

    const active = current()

    if (active) return `${active.id}: ${active.title}`

    return props.objectives.title
  })

  const glyphStatus = createMemo((): ObjectiveStatus | PrimaryObjectiveStatus => {
    const status = props.objectives.status

    if (
      status === "presented_awaiting_confirmation" ||
      status === "investigating" ||
      status === "resolved"
    ) {
      return status
    }

    return current()?.status ?? "exploring"
  })

  return (
    <div
      data-component="session-objectives-pill"
      class="flex min-w-0 shrink"
      classList={{ "-order-1": alignment() === "end", "order-1": alignment() !== "end" }}
    >
      <Popover
        open={state.open}
        onOpenChange={(open) => setState("open", open)}
        placement={composerLanePlacement(alignment())}
        gutter={8}
      >
        <Popover.Trigger
          as="button"
          type="button"
          data-slot="session-objectives-pill"
          data-status={props.objectives.status}
          data-composer-pill
          aria-label={label()}
        >
          <ObjectiveGlyph status={glyphStatus()} />
          <span dir="auto" class="min-w-0 max-w-[260px] truncate">
            {pillText()}
          </span>
          <Show when={total() > 0}>
            <Badge data-slot="session-objectives-progress" dir="ltr" class="shrink-0">
              {`${resolved()}/${total()}`}
            </Badge>
          </Show>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content data-slot="session-objectives-panel" data-composer-pill-panel aria-label={label()}>
            <ObjectivesPopoverContent
              objectives={props.objectives}
              onReviewPlan={() => {
                setState("open", false)
                props.onReviewPlan?.()
              }}
              onOpenPanel={() => {
                setState("open", false)
                props.onOpenPanel?.()
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </div>
  )
}

function ObjectivesPopoverContent(props: {
  objectives: PrimaryObjectiveView
  onReviewPlan: () => void
  onOpenPanel: () => void
}) {
  const language = useLanguage()
  let list: HTMLDivElement | undefined

  createEffect(
    on(
      () => props.objectives.secondaries.findIndex((s) => s.status === "exploring" || s.status === "blocked"),
      (index) => {
        if (index < 0 || !list) return
        list.querySelectorAll('[data-slot="session-objective-row"]')[index]?.scrollIntoView({ block: "nearest" })
      },
    ),
  )

  return (
    <div class="flex flex-col gap-1 p-1.5">
      <div class="flex flex-col gap-0.5 px-1.5 py-1 border-b border-v2-border-border-base">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-base" dir="auto">
            {props.objectives.title}
          </span>
          <span class="shrink-0 text-[11px] leading-[var(--line-height-tight)] text-v2-text-text-muted">
            {`${props.objectives.secondaries.filter((s) => s.status === "resolved").length}/${props.objectives.secondaries.length}`}
          </span>
        </div>
        <Show when={props.objectives.definitionOfDone}>
          <div
            class="line-clamp-2 text-[11px] leading-[var(--line-height-compact)] text-v2-text-text-muted"
            dir="auto"
          >
            {language.t("session.objectives.dod", { dod: props.objectives.definitionOfDone })}
          </div>
        </Show>
      </div>

      <Show when={props.objectives.secondaries.length > 0}>
        <MenuScroll
          data-slot="session-objectives-list"
          class="max-h-[240px]"
          viewportClass="p-1"
          viewportRef={(element) => (list = element)}
        >
          <For each={props.objectives.secondaries}>
            {(so) => <SecondaryObjectiveRow item={so} />}
          </For>
        </MenuScroll>
      </Show>

      <div class="flex items-center justify-end gap-1.5 pt-1 px-1 border-t border-v2-border-border-base">
        <Button size="small" variant="ghost" onClick={props.onOpenPanel}>
          {language.t("session.objectives.openPanel")}
        </Button>
        <Button
          size="small"
          variant={props.objectives.status === "presented_awaiting_confirmation" ? "submit" : "outline"}
          onClick={props.onReviewPlan}
        >
          {language.t("session.objectives.reviewPlan")}
        </Button>
      </div>
    </div>
  )
}

function SecondaryObjectiveRow(props: { item: SecondaryObjectiveView }) {
  return (
    <div class="flex flex-col gap-0.5">
      <div
        data-slot="session-objective-row"
        data-status={props.item.status}
        class="flex shrink-0 items-start gap-2 rounded-[4px] px-1.5 py-1"
      >
        <span class="flex h-5 shrink-0 items-center">
          <ObjectiveGlyph status={props.item.status} />
        </span>
        <div class="min-w-0 flex-1 flex flex-col gap-0.5">
          <span
            dir="auto"
            data-slot="session-objective-text"
            class="text-[13px] leading-[var(--line-height-base)] tracking-[-0.04px]"
          >
            <span class="font-medium text-v2-text-text-muted">{props.item.id}</span>
            <Show when={props.item.delegation}>
              {(del) => (
                <span class="text-[11px] text-v2-text-text-faint">{` [${del().mode}]`}</span>
              )}
            </Show>
            {`: ${props.item.title}`}
          </span>
          <Show when={props.item.blocker}>
            {(blocker) => (
              <span class="text-[11px] leading-[var(--line-height-compact)] text-v2-state-fg-danger" dir="auto">
                {blocker()}
              </span>
            )}
          </Show>
        </div>
      </div>
      <Show when={props.item.children && props.item.children.length > 0}>
        <div class="ps-5 flex flex-col gap-0.5">
          <For each={props.item.children ?? []}>
            {(to) => <TertiaryObjectiveRow item={to} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

function TertiaryObjectiveRow(props: { item: TertiaryObjectiveView }) {
  return (
    <div
      data-slot="session-objective-row"
      data-status={props.item.status}
      class="flex shrink-0 items-start gap-2 rounded-[4px] px-1.5 py-0.5"
    >
      <span class="flex h-4 shrink-0 items-center">
        <ObjectiveGlyph status={props.item.status} />
      </span>
      <span
        dir="auto"
        data-slot="session-objective-text"
        class="min-w-0 flex-1 text-[12px] leading-[var(--line-height-compact)] tracking-[-0.04px]"
      >
        <span class="font-medium text-v2-text-text-muted">{props.item.id}</span>
        {`: ${props.item.title}`}
      </span>
    </div>
  )
}

export function ObjectiveGlyph(props: { status: ObjectiveStatus | PrimaryObjectiveStatus }) {
  return (
    <svg
      data-slot="session-objective-glyph"
      data-status={props.status}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
      class="shrink-0"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
      <Switch>
        <Match when={props.status === "exploring" || props.status === "investigating"}>
          <path d="M8 4a4 4 0 0 0 0 8V4Z" fill="currentColor" />
        </Match>
        <Match when={props.status === "presented_awaiting_confirmation"}>
          <path d="M6.5 5.5v5M9.5 5.5v5" stroke="currentColor" stroke-linecap="round" />
        </Match>
        <Match when={props.status === "blocked"}>
          <path d="M8 4.5v4M8 11v.5" stroke="currentColor" stroke-linecap="round" />
        </Match>
        <Match when={props.status === "resolved"}>
          <path d="M5 8 7.5 11 11 5.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
        </Match>
        <Match when={props.status === "cancelled" || props.status === "discarded"}>
          <path d="M3.5 12.5 12.5 3.5" stroke="currentColor" />
        </Match>
      </Switch>
    </svg>
  )
}
