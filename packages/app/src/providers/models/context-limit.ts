import { batch } from "solid-js"
import { createStore } from "solid-js/store"

const [dynamicContextStore, setDynamicContextStore] = createStore<{
  limits: Record<string, number | undefined>
}>({
  limits: {},
})

export function setDynamicModelContextLimit(key: string, limit: number) {
  const slashIdx = key.indexOf("/")

  batch(() => {
    setDynamicContextStore("limits", key, limit)

    if (slashIdx !== -1) setDynamicContextStore("limits", key.slice(slashIdx + 1), limit)
  })
}

export function clearDynamicModelContextLimit(key: string) {
  const slashIdx = key.indexOf("/")

  batch(() => {
    setDynamicContextStore("limits", key, undefined)

    if (slashIdx !== -1) setDynamicContextStore("limits", key.slice(slashIdx + 1), undefined)
  })
}

export function getDynamicModelContextLimit(key: string): number | undefined {
  const direct = dynamicContextStore.limits[key]

  if (direct) return direct
  const slashIdx = key.indexOf("/")

  if (slashIdx !== -1) {
    const modelID = key.slice(slashIdx + 1)

    for (const [k, v] of Object.entries(dynamicContextStore.limits)) {
      if ((k === modelID || k.endsWith(`/${modelID}`) || modelID.endsWith(k)) && v) {
        return v
      }
    }
  }

  return undefined
}

export function resolveModelContextLimit(
  model: { providerID?: string; provider?: { id?: string }; id: string; limit?: { context?: number } } | undefined,
): number | undefined {
  if (!model) return undefined
  const providerID = model.provider?.id ?? model.providerID
  const key = providerID ? `${providerID}/${model.id}` : model.id

  return getDynamicModelContextLimit(key) ?? model.limit?.context
}

export function formatContextLimitCompact(limit: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(limit)
}
