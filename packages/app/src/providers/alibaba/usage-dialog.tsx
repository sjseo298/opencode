import { AlibabaUsageRpc, formatCycleProgress, formatQuotaPercent, type AlibabaUsage } from "@opencode/schema/alibaba-usage"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogTitle } from "@opencode/ui/dialog"
import { Show, createMemo, createSignal, onMount } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"

export function DialogAlibabaUsage(props: { directory?: string }) {
  const sdk = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const rpc = () => sdk.api.rpc(AlibabaUsageRpc)

  const [loading, setLoading] = createSignal(true)
  const [data, setData] = createSignal<AlibabaUsage.TokenPlan>()
  const [error, setError] = createSignal<string>()

  const load = async (refresh = false) => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await rpc().tokenPlan(
        { refresh },
        props.directory ? { location: { directory: props.directory } } : undefined,
      )
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void load(false)
  })

  const cycle = createMemo(() => {
    const resetAt = data()?.resetAt
    return resetAt !== undefined ? formatCycleProgress(resetAt) : undefined
  })

  return (
    <Dialog size="normal" fit>
      <div class="px-6 pt-5 pb-3">
        <DialogTitle>{language.t("dialog.alibabaUsage.title")}</DialogTitle>
      </div>
      <div class="flex flex-col gap-4 px-6 pb-6 text-13-regular text-text-base">
        <Show when={loading()}>
          <div class="text-text-muted">{language.t("dialog.alibabaUsage.loading")}</div>
        </Show>

        <Show when={!loading() && error()}>
          {(err) => <div class="text-v2-state-fg-danger">{err()}</div>}
        </Show>

        <Show when={!loading() && !error() && data()}>
          {(item) => (
            <Show
              when={item().ok}
              fallback={
                <div class="flex flex-col gap-2">
                  <div class="text-v2-state-fg-danger">{item().error}</div>
                  <Show when={item().hint}>{(hint) => <div class="text-text-muted">{hint()}</div>}</Show>
                </div>
              }
            >
              <div class="flex flex-col gap-3">
                <div class="flex items-center justify-between text-12-regular text-text-muted">
                  <span>{language.t("dialog.alibabaUsage.monthlyQuota")}</span>
                  <span>
                    {[item().site, item().region, item().profile].filter(Boolean).join(" · ")}
                  </span>
                </div>

                <div class="h-2.5 w-full overflow-hidden rounded-full bg-surface-raised-base">
                  <div
                    class="h-full rounded-full bg-text-interactive-base transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, item().usedPercent))}%` }}
                  />
                </div>

                <div class="flex items-center justify-between text-13-medium tabular-nums">
                  <span>
                    {formatQuotaPercent(item().usedPercent)} {language.t("dialog.alibabaUsage.used")}
                  </span>
                  <span class="text-text-muted">
                    {formatQuotaPercent(item().remainingPercent)} {language.t("dialog.alibabaUsage.left")}
                  </span>
                </div>

                <Show when={cycle()}>
                  {(c) => (
                    <div class="flex flex-col gap-1 rounded-md border border-border-base bg-surface-base p-3 text-12-regular">
                      <div>
                        {language.t("dialog.alibabaUsage.cyclePosition")}:{" "}
                        <strong>
                          Day {c().elapsedDays} / {c().cycleDays}
                        </strong>{" "}
                        <span class="text-text-muted">(expected pace ~{c().expectedPercent.toFixed(1)}%)</span>
                      </div>
                      <div>
                        {language.t("dialog.alibabaUsage.cutoff")}: <strong>{c().resetLabel}</strong>{" "}
                        <span class="text-text-muted">({c().countdownLabel})</span>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          )}
        </Show>

        <div class="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" size="small" disabled={loading()} onClick={() => void load(true)}>
            {language.t("dialog.alibabaUsage.refresh")}
          </Button>
          <Button variant="contrast" size="small" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
