import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Badge } from "@opencode/ui/badge"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Loader } from "@opencode/ui/loader"
import { MenuScroll } from "@opencode/ui/menu-scroll"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData, useServer } from "@/runtime/server/current"
import { showToast } from "@/shell/notifications/toast"
import { sessionHref } from "@/shell/routes/session"
import { useTabs } from "@/shell/tabs/tabs"
import { useWorkspaceLocation } from "@/workspaces/location"
import {
  cloneObjectivesForFreshSession,
  formatTreeSummary,
  normalizePrimaryObjectiveView,
  prepareRefinementMetadata,
  type PrimaryObjectiveView,
} from "./model"
import {
  createPlanApprovalState,
  selectPlanApprovalView,
  transitionPlanApproval,
  type PlanApprovalAction,
  type PlanApprovalEffect,
  type PlanApprovalEvent,
} from "./plan-approval-machine"

export type PlanApprovalOption = {
  readonly action: PlanApprovalAction
  readonly key: string
  readonly title: string
  readonly description: string
}

export function DialogPlanApproval(props: {
  sessionID: string
  po?: PrimaryObjectiveView
  onRefine?: () => void
}) {
  const data = useData()
  const server = useServer()
  const serverSDK = useServerSDK()
  const location = useWorkspaceLocation()
  const navigate = useNavigate()
  const tabs = useTabs()
  const dialog = useDialog()
  const language = useLanguage()

  const [machine, setMachine] = createSignal(createPlanApprovalState())

  const runs = new Map<
    number,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >()

  const sessionInfo = createMemo(() => data.session.get(props.sessionID))

  const po = createMemo(() => {
    const live = normalizePrimaryObjectiveView(sessionInfo()?.metadata)

    return live ?? props.po
  })

  const isAlreadyApproved = createMemo(() =>
    Boolean(po()?.approvedByUser && po()?.status !== "presented_awaiting_confirmation"),
  )

  const modelLabel = createMemo(() => {
    const model = sessionInfo()?.model

    if (!model) return language.t("dialog.planApproval.defaultModel")

    return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
  })

  const options = createMemo<readonly PlanApprovalOption[]>(() => {
    if (isAlreadyApproved()) {
      return [
        {
          action: "revoke_approval",
          key: "1",
          title: language.t("dialog.planApproval.option.revokeApproval.title"),
          description: language.t("dialog.planApproval.option.revokeApproval.description"),
        },
        {
          action: "refine_plan",
          key: "2",
          title: language.t("dialog.planApproval.option.refinePlan.title"),
          description: language.t("dialog.planApproval.option.refinePlan.description"),
        },
        {
          action: "close",
          key: "3",
          title: language.t("dialog.planApproval.option.close.title"),
          description: language.t("dialog.planApproval.option.close.description"),
        },
      ]
    }

    const recommended = Boolean(po()?.contextMetrics?.recommendFreshSession)

    return [
      {
        action: "fresh_session",
        key: "1",
        title: recommended
          ? language.t("dialog.planApproval.option.freshSession.recommended")
          : language.t("dialog.planApproval.option.freshSession.title"),
        description: language.t("dialog.planApproval.option.freshSession.description", {
          model: modelLabel(),
        }),
      },
      {
        action: "same_session",
        key: "2",
        title: language.t("dialog.planApproval.option.sameSession.title"),
        description: language.t("dialog.planApproval.option.sameSession.description"),
      },
      {
        action: "refine_plan",
        key: "3",
        title: language.t("dialog.planApproval.option.refinePlan.title"),
        description: language.t("dialog.planApproval.option.refinePlan.description"),
      },
    ]
  })

  const settle = (attempt: number) => {
    const entry = runs.get(attempt)

    if (!entry) return
    runs.delete(attempt)
    clearTimeout(entry.timer)

    return entry
  }

  const dispatch = (event: PlanApprovalEvent) => {
    const next = transitionPlanApproval(machine(), event)

    if (next.state !== machine()) setMachine(next.state)
    next.effects.forEach((effect) =>
      Promise.try(() => run(effect)).catch((cause: unknown) => console.error("[plan-approval]", cause)),
    )
  }

  const run = async (effect: PlanApprovalEffect) => {
    if (effect.type === "cancel") {
      settle(effect.attempt)?.controller.abort()

      return
    }

    if (effect.type === "dialog.close") {
      dialog.close()

      if (effect.refine) props.onRefine?.()

      return
    }

    if (effect.type === "toast.show") {
      if (effect.kind === "fresh") {
        showToast({ variant: "success", title: language.t("dialog.planApproval.toast.approvedFresh") })

        return
      }

      if (effect.kind === "same") {
        showToast({ variant: "success", title: language.t("dialog.planApproval.toast.approvedSame") })

        return
      }

      if (effect.kind === "refine") {
        showToast({ variant: "default", title: language.t("dialog.planApproval.toast.refining") })

        return
      }

      showToast({ variant: "default", title: language.t("dialog.planApproval.toast.revoked") })

      return
    }

    if (effect.type === "toast.error") {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: effect.message,
      })

      return
    }

    if (effect.type === "fresh.open") {
      settle(effect.attempt)
      const created = effect.newSession
      const oldSessionID = effect.oldSessionID

      data.session.remember(created)
      tabs.addSessionTab({
        server: server.key,
        sessionId: created.id,
      })
      navigate(sessionHref(server.key, created.id))

      tabs.removeSessionTab({
        server: server.key,
        sessionId: oldSessionID,
      })
      void serverSDK.api.session.remove({ sessionID: oldSessionID }).catch((err) => {
        console.error("Failed to remove old exploration session:", err)
      })

      return
    }

    const controller = new AbortController()
    runs.set(effect.attempt, {
      controller,
      timer: setTimeout(() => dispatch({ type: "action.timed-out", attempt: effect.attempt }), effect.timeoutMs),
    })

    if (effect.type === "same.run") {
      await serverSDK.api.session
        .prompt(
          {
            sessionID: effect.sessionID,
            text: "Plan aprobado explícitamente por el usuario. Procede con la ejecución de SO-1.",
            metadata: { planApproval: true },
          },
          { signal: controller.signal },
        )
        .then(
          () => {
            settle(effect.attempt)
            dispatch({ type: "same.succeeded", attempt: effect.attempt })
          },
          (cause: unknown) => {
            settle(effect.attempt)
            dispatch({
              type: "action.failed",
              attempt: effect.attempt,
              message: cause instanceof Error ? cause.message : String(cause),
            })
          },
        )

      return
    }

    if (effect.type === "revoke.run") {
      await serverSDK.api.session
        .prompt(
          {
            sessionID: effect.sessionID,
            text: "invalidar aprobacion",
            metadata: { planRevocation: true },
          },
          { signal: controller.signal },
        )
        .then(
          () => {
            settle(effect.attempt)
            dispatch({ type: "revoke.succeeded", attempt: effect.attempt })
          },
          (cause: unknown) => {
            settle(effect.attempt)
            dispatch({
              type: "action.failed",
              attempt: effect.attempt,
              message: cause instanceof Error ? cause.message : String(cause),
            })
          },
        )

      return
    }

    if (effect.type === "refine.run") {
      await serverSDK.api.session
        .update(
          {
            sessionID: effect.sessionID,
            metadata: prepareRefinementMetadata(sessionInfo()?.metadata),
          },
          { signal: controller.signal },
        )
        .then(
          () => {
            settle(effect.attempt)
            dispatch({ type: "refine.succeeded", attempt: effect.attempt })
          },
          (cause: unknown) => {
            settle(effect.attempt)
            dispatch({
              type: "action.failed",
              attempt: effect.attempt,
              message: cause instanceof Error ? cause.message : String(cause),
            })
          },
        )

      return
    }

    // fresh.run: Create standalone top-level session, migrate objectives tree, and enqueue initial sync prompt.
    try {
      const info = sessionInfo()
      const directory = info?.location.directory ?? location().directory
      const currentPo = po()
      const clonedTree = cloneObjectivesForFreshSession(info?.metadata, effect.sessionID)

      const created = await serverSDK.api.session.create(
        {
          title: currentPo?.title ? `[Ejecución] ${currentPo.title}` : "Sesión de Ejecución",
          parentID: undefined,
          location: { directory },
          agent: info?.agent,
          model: info?.model,
          metadata: {
            objectives: clonedTree,
          },
        },
        { signal: controller.signal },
      )

      const treeSummary = formatTreeSummary(currentPo)

      const initialPrompt = [
        "Plan de objetivos aprobado por el usuario.",
        treeSummary,
        "Instrucción: Sincronízate con el Protocolo de Objetivos (action: 'sync') y comienza la ejecución de las tareas planificadas.",
      ]
        .filter(Boolean)
        .join("\n\n")

      await serverSDK.api.session.prompt(
        {
          sessionID: created.id,
          text: initialPrompt,
        },
        { signal: controller.signal },
      )

      settle(effect.attempt)
      dispatch({
        type: "fresh.succeeded",
        attempt: effect.attempt,
        oldSessionID: effect.sessionID,
        newSession: created,
      })
    } catch (cause: unknown) {
      settle(effect.attempt)
      dispatch({
        type: "action.failed",
        attempt: effect.attempt,
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  createEffect(
    on(
      () => props.sessionID,
      () => dispatch({ type: "session.changed" }),
      { defer: true },
    ),
  )

  createEffect(() => {
    if (dialog.closing) dispatch({ type: "disposed" })
  })

  onCleanup(() => dispatch({ type: "disposed" }))

  const view = createMemo(() => selectPlanApprovalView(machine()))

  const selectAction = (action: PlanApprovalAction) => {
    dispatch({
      type: "action.selected",
      action,
      sessionID: props.sessionID,
    })
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (view().busy) return
    const list = options()

    if (event.key === "ArrowUp") {
      event.preventDefault()
      dispatch({ type: "index.moved", delta: -1, count: list.length })

      return
    }

    if (event.key === "ArrowDown") {
      event.preventDefault()
      dispatch({ type: "index.moved", delta: 1, count: list.length })

      return
    }

    if (event.key === "Enter" && !event.isComposing) {
      const opt = list[view().activeIndex]

      if (!opt) return
      event.preventDefault()
      selectAction(opt.action)

      return
    }

    if (event.key === "1" || event.key === "2" || event.key === "3") {
      const idx = Number(event.key) - 1
      const opt = list[idx]

      if (!opt) return
      event.preventDefault()
      dispatch({ type: "index.changed", index: idx, count: list.length })
      selectAction(opt.action)
    }
  }

  return (
    <Dialog size="large" fit>
      <DialogHeader>
        <DialogTitle>
          {isAlreadyApproved()
            ? language.t("dialog.planApproval.title.active")
            : language.t("dialog.planApproval.title.pending")}
        </DialogTitle>
      </DialogHeader>
      <DialogBody class="p-0">
        <div class="flex flex-col gap-4 px-5 pb-5 pt-2 outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
        <Show when={po()}>
          {(currentPo) => (
            <>
              <MenuScroll
                data-slot="plan-approval-scroll"
                class="max-h-[340px] rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01"
                viewportClass="p-4 flex flex-col gap-4"
              >
                {/* Primary Objective & DoD */}
                <div class="flex flex-col gap-1.5">
                  <div class="flex items-center gap-2">
                    <span class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-state-fg-warning">
                      {language.t("dialog.planApproval.primaryObjective")}
                    </span>
                  </div>
                  <div class="text-[14px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base" dir="auto">
                    {currentPo().title}
                  </div>
                  <Show when={currentPo().definitionOfDone}>
                    <div class="text-[12px] leading-[var(--line-height-base)] text-v2-text-text-muted" dir="auto">
                      <span class="font-medium text-v2-text-text-base">{`${language.t("dialog.planApproval.dod")}: `}</span>
                      {currentPo().definitionOfDone}
                    </div>
                  </Show>
                </div>

                {/* Secondary Objectives */}
                <Show when={currentPo().secondaries.length > 0}>
                  <div class="flex flex-col gap-2 border-t border-v2-border-border-base pt-3">
                    <div class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-muted">
                      {language.t("dialog.planApproval.secondaries", {
                        count: String(currentPo().secondaries.length),
                      })}
                    </div>
                    <div class="flex flex-col gap-2">
                      <For each={currentPo().secondaries}>
                        {(so) => (
                          <div class="flex flex-col gap-0.5 rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2.5">
                            <div class="flex items-center gap-1.5 flex-wrap">
                              <span class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-muted">
                                {so.id}
                              </span>
                              <Show when={so.delegation}>
                                {(del) => <Badge>{del().mode}</Badge>}
                              </Show>
                              <span
                                class="text-[13px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base"
                                dir="auto"
                              >
                                {so.title}
                              </span>
                            </div>
                            <Show when={so.rationale}>
                              <div
                                class="text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted"
                                dir="auto"
                              >
                                {`↳ ${so.rationale}`}
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Findings */}
                <Show when={currentPo().findings && currentPo().findings!.length > 0}>
                  <div class="flex flex-col gap-2 border-t border-v2-border-border-base pt-3">
                    <div class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-muted">
                      {language.t("dialog.planApproval.findings", {
                        count: String(currentPo().findings!.length),
                      })}
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <For each={currentPo().findings ?? []}>
                        {(finding) => (
                          <div class="flex flex-col gap-0.5 rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2">
                            <div class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-base" dir="auto">
                              <span class="text-v2-text-text-muted">{`${finding.id}: `}</span>
                              {finding.title}
                            </div>
                            <Show when={finding.result}>
                              <div
                                class="text-[11px] leading-[var(--line-height-compact)] text-v2-text-text-muted"
                                dir="auto"
                              >
                                {`↳ ${finding.result}`}
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Context Diagnostics */}
                <Show when={currentPo().contextMetrics}>
                  {(cm) => (
                    <div class="flex items-center gap-1.5 flex-wrap rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2 text-[12px] leading-[var(--line-height-compact)]">
                      <span class="font-medium text-v2-text-text-base">
                        {language.t("dialog.planApproval.contextDiagnostics")}
                      </span>
                      <span class="text-v2-text-text-muted">
                        {language.t("dialog.planApproval.tokensUsed", {
                          tokens: cm().tokensUsed !== undefined ? cm().tokensUsed!.toLocaleString() : "—",
                        })}
                      </span>
                      <Show when={cm().percentUsed !== undefined}>
                        <span class="text-v2-text-text-muted">
                          {language.t("dialog.planApproval.percentUsed", {
                            percent: String(cm().percentUsed),
                          })}
                        </span>
                      </Show>
                      <span
                        class={
                          cm().recommendFreshSession
                            ? "font-medium text-v2-state-fg-warning"
                            : "font-medium text-v2-state-fg-success"
                        }
                      >
                        {cm().recommendFreshSession
                          ? language.t("dialog.planApproval.recommendFresh")
                          : language.t("dialog.planApproval.sufficientHeadroom")}
                      </span>
                    </div>
                  )}
                </Show>
              </MenuScroll>

              {/* Options Selection Area */}
              <div class="flex flex-col gap-2">
                <div class="text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-muted">
                  {language.t("dialog.planApproval.chooseAction")}
                </div>
                <div role="listbox" class="flex flex-col gap-1.5">
                  <For each={options()}>
                    {(opt, index) => {
                      const selected = () => view().activeIndex === index()
                      const pending = () => view().pendingAction === opt.action

                      return (
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected()}
                          aria-busy={pending() || undefined}
                          disabled={view().busy}
                          data-slot="plan-approval-option"
                          data-action={opt.action}
                          class="flex w-full items-start justify-between gap-3 rounded-lg border p-3 text-start transition-colors"
                          classList={{
                            "border-v2-border-border-strong bg-v2-background-bg-layer-02": selected(),
                            "border-v2-border-border-base bg-v2-background-bg-base hover:bg-v2-background-bg-layer-01":
                              !selected(),
                          }}
                          onMouseEnter={() =>
                            !view().busy && dispatch({ type: "index.changed", index: index(), count: options().length })
                          }
                          onClick={() => selectAction(opt.action)}
                        >
                          <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <Badge>{opt.key}</Badge>
                              <span class="text-[13px] font-medium leading-[var(--line-height-base)] text-v2-text-text-base">
                                {opt.title}
                              </span>
                            </div>
                            <div class="ps-7 text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                              {opt.description}
                            </div>
                          </div>
                          <Show when={pending()}>
                            <Loader class="size-4 shrink-0 mt-0.5" />
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </div>
            </>
          )}
        </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}
