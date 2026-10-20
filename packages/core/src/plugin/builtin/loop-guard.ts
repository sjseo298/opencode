import { createHash } from "node:crypto"
import { Plugin as OpenCodePlugin } from "@opencode/plugin"

type LoopGuardOptions = {
  mode?: "warn_only"
  doom_loop_threshold?: number
  warning_before_doom_loop?: number
  windowMs?: number
  /** When true, detect loops based only on identical arguments, ignoring results. */
  ignoreResults?: boolean
  cooldownMs?: number
  maxSessionStates?: number
  maxAttemptsPerSession?: number
  ignoreTools?: string[]
  volatileKeys?: string[]
}

type PendingCall = {
  ts: number
  tool: string
  signature: string
}

type Attempt = PendingCall & {
  outcomeHash: string
}

type TurnCall = {
  ts: number
  signature: string
  outcomeHash: string
}

type Guard = {
  text: string
  expiresAt: number
}

type SessionState = {
  pending: Map<string, PendingCall>
  attempts: Attempt[]
  turnCalls: TurnCall[]
  cooldownUntil: number
  pendingGuard?: Guard
  lastTouched: number
}

const defaultOptions: Required<LoopGuardOptions> = {
  mode: "warn_only",
  doom_loop_threshold: 4,
  warning_before_doom_loop: 1,
  windowMs: 30_000,
  ignoreResults: true,
  cooldownMs: 60_000,
  maxSessionStates: 200,
  maxAttemptsPerSession: 60,
  ignoreTools: [],
  volatileKeys: ["timestamp", "time", "nonce", "requestId", "requestID", "createdAt", "updatedAt"],
}

const guardText =
  "Loop guard detected: You are repeating the same tool call with equivalent arguments/results. Do not call that same tool with the same arguments again in this turn. Summarize what you learned, then choose a different action or ask for clarification."

function normalizeOptions(options: LoopGuardOptions | undefined): Required<LoopGuardOptions> {
  const doomLoopThreshold = readPositiveInt(options?.doom_loop_threshold, defaultOptions.doom_loop_threshold)
  const warningBeforeDoomLoop = readNonNegativeInt(
    options?.warning_before_doom_loop,
    defaultOptions.warning_before_doom_loop,
  )
  const windowMs = readPositiveInt(options?.windowMs, defaultOptions.windowMs)
  const cooldownMs = readNonNegativeInt(options?.cooldownMs, defaultOptions.cooldownMs)
  const maxSessionStates = readPositiveInt(options?.maxSessionStates, defaultOptions.maxSessionStates)
  const maxAttemptsPerSession = readPositiveInt(options?.maxAttemptsPerSession, defaultOptions.maxAttemptsPerSession)
  const mode = options?.mode === "warn_only" ? options.mode : defaultOptions.mode
  const ignoreResults = typeof options?.ignoreResults === "boolean"
    ? options.ignoreResults
    : defaultOptions.ignoreResults
  const ignoreTools = Array.isArray(options?.ignoreTools)
    ? options.ignoreTools.filter((item): item is string => typeof item === "string")
    : defaultOptions.ignoreTools
  const volatileKeys = Array.isArray(options?.volatileKeys)
    ? options.volatileKeys.filter((item): item is string => typeof item === "string")
    : defaultOptions.volatileKeys
  return {
    mode,
    doom_loop_threshold: doomLoopThreshold,
    warning_before_doom_loop: warningBeforeDoomLoop,
    windowMs,
    ignoreResults,
    cooldownMs,
    maxSessionStates,
    maxAttemptsPerSession,
    ignoreTools,
    volatileKeys,
  }
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback
  return value
}

function readNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return fallback
  return value
}

function warningThreshold(settings: Required<LoopGuardOptions>): number | undefined {
  const threshold = settings.doom_loop_threshold - settings.warning_before_doom_loop
  if (threshold <= 0) return undefined
  return threshold
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16)
}

function stableStringify(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : '"__non_finite__"'
  if (typeof value === "boolean") return value ? "true" : "false"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value !== "object") return JSON.stringify(String(value))
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
  return `{${entries.join(",")}}`
}

function normalizeValue(value: unknown, volatileKeys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, volatileKeys))
  if (value === null) return null
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ")
  if (typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    if (volatileKeys.has(key)) continue
    next[key] = normalizeValue(record[key], volatileKeys)
  }
  return next
}

function buildOutcomeHash(output: unknown, volatileKeys: Set<string>) {
  const normalized = normalizeValue(output, volatileKeys)
  return hash(normalized)
}

function pruneSession(state: SessionState, now: number, settings: Required<LoopGuardOptions>) {
  state.attempts = state.attempts
    .filter((attempt) => now - attempt.ts <= settings.windowMs)
    .slice(-settings.maxAttemptsPerSession)
  if (state.pendingGuard && state.pendingGuard.expiresAt <= now) state.pendingGuard = undefined
}

function repeatedTail(attempts: Attempt[], signature: string): Attempt[] {
  const tail: Attempt[] = []
  for (const attempt of attempts.toReversed()) {
    if (attempt.signature !== signature) break
    tail.push(attempt)
  }
  return tail.toReversed()
}

function hasNoProgress(attempts: Attempt[]) {
  if (attempts.length <= 1) return false
  const first = attempts[0]?.outcomeHash
  if (!first) return false
  return attempts.every((attempt) => attempt.outcomeHash === first)
}

function buildVirtualSignature(calls: TurnCall[]) {
  const signatures = calls.map((call) => call.signature).toSorted((a, b) => a.localeCompare(b))
  return `virtual:${hash(signatures)}`
}

function buildVirtualOutcomeHash(calls: TurnCall[]) {
  const outcomes = calls.map((call) => call.outcomeHash).toSorted((a, b) => a.localeCompare(b))
  return hash(outcomes)
}

function finalizeTurn(state: SessionState, now: number, settings: Required<LoopGuardOptions>) {
  if (!state.turnCalls.length) return
  const ts = state.turnCalls.reduce((min, call) => Math.min(min, call.ts), now)
  const signature = buildVirtualSignature(state.turnCalls)
  const outcomeHash = buildVirtualOutcomeHash(state.turnCalls)
  state.turnCalls = []
  state.attempts.push({
    ts,
    tool: "virtual",
    signature,
    outcomeHash,
  })
  pruneSession(state, now, settings)
  if (now < state.cooldownUntil) return

  const tail = repeatedTail(state.attempts, signature)
  const threshold = warningThreshold(settings)
  if (threshold === undefined) return
  if (tail.length < threshold) return
  if (!settings.ignoreResults && !hasNoProgress(tail)) return
  if (settings.mode !== "warn_only") return

  state.pendingGuard = {
    text: guardText,
    expiresAt: now + settings.windowMs,
  }
  state.cooldownUntil = now + settings.cooldownMs
}

export const Plugin = OpenCodePlugin.define({
  id: "loop-guard",
  async setup(ctx) {
    const settings = normalizeOptions(ctx.options as LoopGuardOptions | undefined)
    const volatileKeys = new Set(settings.volatileKeys)
    const states = new Map<string, SessionState>()

    const ensureState = (sessionID: string): SessionState => {
      const existing = states.get(sessionID)
      if (existing) {
        existing.lastTouched = Date.now()
        return existing
      }
      const next: SessionState = {
        pending: new Map(),
        attempts: [],
        turnCalls: [],
        cooldownUntil: 0,
        lastTouched: Date.now(),
      }
      states.set(sessionID, next)
      if (states.size <= settings.maxSessionStates) return next
      const oldest = Array.from(states.entries()).toSorted((a, b) => a[1].lastTouched - b[1].lastTouched)[0]
      if (!oldest) return next
      states.delete(oldest[0])
      return next
    }

    await ctx.session.hook("prompt", (event) => {
      const state = states.get(event.sessionID)
      if (!state) return
      state.pendingGuard = undefined
      state.cooldownUntil = 0
      state.attempts = []
      state.turnCalls = []
      state.pending.clear()
      state.lastTouched = Date.now()
    })

    await ctx.tool.hook("execute.before", (event) => {
      if (settings.ignoreTools.includes(event.tool)) return
      const state = ensureState(event.sessionID)
      const now = Date.now()
      pruneSession(state, now, settings)
      const normalized = normalizeValue(event.input, volatileKeys)
      const argsHash = hash(normalized)
      const signature = `${event.tool}:${argsHash}`
      state.pending.set(event.id, {
        ts: now,
        tool: event.tool,
        signature,
      })
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (settings.ignoreTools.includes(event.tool)) return
      const state = ensureState(event.sessionID)
      const now = Date.now()
      const pending = state.pending.get(event.id)
      const fallbackSignature = `${event.tool}:${hash(normalizeValue(event.input, volatileKeys))}`
      const signature = pending?.signature ?? fallbackSignature
      const ts = pending?.ts ?? now
      state.pending.delete(event.id)
      const outcome = event.status === "completed" ? event.result : event.error
      const outcomeHash = buildOutcomeHash(outcome, volatileKeys)
      state.turnCalls.push({
        ts,
        signature,
        outcomeHash,
      })
      state.lastTouched = now
    })

    await ctx.session.hook("context", (event) => {
      const sessionID = event.sessionID
      if (!sessionID) return
      const state = states.get(sessionID)
      if (!state) return
      const now = Date.now()
      finalizeTurn(state, now, settings)
      if (!state.pendingGuard) return
      if (state.pendingGuard.expiresAt <= Date.now()) {
        state.pendingGuard = undefined
        return
      }
      event.system.push({ type: "text", text: state.pendingGuard.text })
      state.pendingGuard = undefined
      state.lastTouched = Date.now()
    })
  },
})

export default Plugin
