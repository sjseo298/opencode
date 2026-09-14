import type { AssistantMessage, Message, Provider, Session } from "@opencode-ai/sdk/v2"
import { Locale } from "./locale"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function tokenCount(tokens: AssistantMessage["tokens"]) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function formatPercent(percent: number) {
  const rounded = Math.round(percent * 10) / 10
  const fixed = rounded.toFixed(1)
  if (fixed.endsWith(".0")) return fixed.slice(0, -2)
  return fixed
}

export type SessionUsage = {
  tokens: number
  percent?: number
  context: string
  contextLimit?: string
  cost?: string
}

export function formatSessionUsage(input: {
  messages: ReadonlyArray<Message>
  providers: ReadonlyArray<Provider>
  session?: Session
}): SessionUsage | undefined {
  const last = input.messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
  if (!last) return

  const tokens = tokenCount(last.tokens)
  if (tokens <= 0) return

  const providerID = input.session?.model?.providerID ?? last.providerID
  const modelID = input.session?.model?.id ?? last.modelID
  const model = input.providers.find((item) => item.id === providerID)?.models[modelID]
  const contextLimit = model?.limit.context
  const percent = contextLimit ? Math.round((tokens / contextLimit) * 1000) / 10 : undefined
  const cost = input.session?.cost ?? 0

  return {
    tokens,
    percent,
    contextLimit: contextLimit ? Locale.number(contextLimit) : undefined,
    context: percent === undefined ? Locale.number(tokens) : `${Locale.number(tokens)} (${formatPercent(percent)}%)`,
    cost: cost > 0 ? money.format(cost) : undefined,
  }
}

export * as SessionUsage from "./session-usage"
