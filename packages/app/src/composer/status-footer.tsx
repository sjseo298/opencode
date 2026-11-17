import { createMemo, Show } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { formatContextLimitCompact, resolveModelContextLimit } from "@/providers/models/context-limit"
import type { ModelSelection } from "@/providers/models/selection"
import { useLanguage } from "@/runtime/i18n/language"

export function ComposerStatusBar(props: {
  model: ModelSelection
  tokens?: number
  autoApprove?: {
    active: boolean
    onToggle: () => void
  }
}) {
  const dialog = useDialog()
  const language = useLanguage()

  const activeModel = createMemo(() => props.model.current())

  const contextLimit = createMemo(() => resolveModelContextLimit(activeModel()))

  const percent = createMemo(() => {
    const limit = contextLimit()
    const used = props.tokens

    if (!limit || !used) return null

    return Math.round((used / limit) * 100)
  })

  const visible = createMemo(() => Boolean(contextLimit() || props.autoApprove?.active || (props.tokens ?? 0) > 0))

  const openContextLimit = async () => {
    const current = activeModel()
    const activeModelKey = current ? `${current.provider.id}/${current.id}` : undefined
    const { DialogSetContextLimit } = await import("@/session/commands/session-control-dialogs")
    void dialog.show(() => <DialogSetContextLimit activeModelKey={activeModelKey} />)
  }

  return (
    <Show when={visible()}>
      <div
        data-slot="composer-status-footer"
        class="flex min-h-7 shrink-0 items-center justify-between gap-2 border-t border-v2-border-border-base/60 px-3 py-1 text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-faint"
      >
        <div class="flex min-w-0 items-center gap-2">
          <Show when={contextLimit()}>
            {(limit) => (
              <Tooltip
                placement="top"
                value={language.t("composer.footer.maxContext.tooltip", {
                  limit: limit().toLocaleString(language.intl()),
                })}
              >
                <button
                  type="button"
                  data-action="composer-context-limit"
                  class="inline-flex h-5 items-center gap-1 rounded-[4px] px-1 font-mono text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-base focus-visible:outline-none"
                  onClick={() => void openContextLimit()}
                >
                  {language.t("composer.footer.maxContext", {
                    limit: formatContextLimitCompact(limit(), language.intl()),
                  })}
                </button>
              </Tooltip>
            )}
          </Show>
          <Show when={(props.tokens ?? 0) > 0}>
            <Show when={contextLimit()}>
              <span aria-hidden="true" class="text-v2-text-text-faint">
                ·
              </span>
            </Show>
            <span class="font-mono tabular-nums text-v2-text-text-faint">
              {formatContextLimitCompact(props.tokens ?? 0, language.intl())}
              <Show when={percent() !== null}>{` (${percent()}%)`}</Show>
            </span>
          </Show>
        </div>

        <Show when={props.autoApprove?.active}>
          <Tooltip placement="top" value={language.t("composer.footer.autoApprove.tooltip")}>
            <button
              type="button"
              data-action="composer-auto-approve"
              class="ms-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] border border-v2-state-border-warning bg-v2-state-bg-warning px-1.5 text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-state-fg-warning transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-state-border-warning"
              onClick={() => props.autoApprove?.onToggle()}
            >
              <Icon name="warning" size="small" class="size-3 shrink-0" />
              <span>{language.t("composer.footer.autoApprove")}</span>
            </button>
          </Tooltip>
        </Show>
      </div>
    </Show>
  )
}
