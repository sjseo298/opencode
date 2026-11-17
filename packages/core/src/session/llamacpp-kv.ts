/**
 * ============================================================================
 * Llama.cpp Slot KV Cache Offload and Swap Manager
 * ============================================================================
 *
 * Implements slot KV cache snapshotting, erasing and restoring to disk
 * via llama-server /slots endpoints (POST /slots/{id_slot}?action=save|restore|erase).
 * Exclusively when running on llama.cpp ("llamacpp" / "llama.cpp") with unified KV
 * (`kv_unified === true`), a mechanical overflow-risk model (`computeOffloadDecision`)
 * evaluates the probability that the subagent will overflow the remaining unified KV
 * ceiling based on:
 *   1. Parent session's occupied KV tokens and context window ceiling
 *   2. Expected subagent token consumption (`estimatedTaskTokens`)
 *   3. Rolling session telemetry of recent subagents (actual tokens used, estimation
 *      bias, and whether recent subagents suffered compaction or overflow)
 * When overflow probability >= 50%, the parent's KV cache is saved to disk and erased
 * from VRAM before the subagent starts, and restored upon subagent completion.
 * When both fit safely in memory, the KV cache stays in RAM with zero disk I/O.
 * ============================================================================
 */

import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import { getObjectivesConfig } from "../plugin/builtin/objectives-model.js"

const LLAMACPP_PROVIDERS = new Set(["llamacpp", "llama.cpp"])

function getOffloadedSet(): Set<string> {
  const g = globalThis as any
  if (!g.__OPENCODE_KV_OFFLOADED_SESSIONS__) {
    g.__OPENCODE_KV_OFFLOADED_SESSIONS__ = new Set<string>()
  }
  return g.__OPENCODE_KV_OFFLOADED_SESSIONS__
}

export type SubagentTelemetrySample = {
  childSessionID: string
  tokensUsed: number
  estimatedTokens?: number
  hadCompaction: boolean
  hadOverflow: boolean
  timestamp: number
}

function getTelemetryMap(): Map<string, SubagentTelemetrySample[]> {
  const g = globalThis as any
  if (!g.__OPENCODE_SUBAGENT_KV_TELEMETRY__) {
    g.__OPENCODE_SUBAGENT_KV_TELEMETRY__ = new Map<string, SubagentTelemetrySample[]>()
  }
  return g.__OPENCODE_SUBAGENT_KV_TELEMETRY__
}

function getPendingEstimateMap(): Map<string, number> {
  const g = globalThis as any
  if (!g.__OPENCODE_SUBAGENT_PENDING_ESTIMATES__) {
    g.__OPENCODE_SUBAGENT_PENDING_ESTIMATES__ = new Map<string, number>()
  }
  return g.__OPENCODE_SUBAGENT_PENDING_ESTIMATES__
}

const MAX_TELEMETRY_SAMPLES = 10

export namespace LlamaCppKV {
  export type SlotInfo = {
    id: number
    id_task?: number
    is_processing?: boolean
    n_ctx?: number
    n_past?: number
    used_tokens?: number
    context?: {
      used_tokens?: number
      total_tokens?: number
    }
  }

  export type OffloadDecisionInput = {
    sessionID?: string
    providerID?: string | null
    kvUnified?: boolean
    contextLimit: number
    parentUsedTokens: number
    otherActiveTokens?: number
    estimatedTaskTokens?: number
    minSubagentBudget?: number
  }

  export type OffloadDecision = {
    shouldOffload: boolean
    overflowProbability: number
    projectedDemandTokens: number
    expectedSubagentTokens: number
    demandStdDevTokens: number
    availableWithoutOffload: number
    ceilingTokens: number
    safetyReserveTokens: number
    historicalSampleCount: number
    historicalCompactionRate: number
    reason: string
  }

  /**
   * Returns true only when the provider ID is explicitly llama.cpp ("llamacpp" or "llama.cpp").
   */
  export function isLlamaCppProvider(providerID?: string | null): boolean {
    if (!providerID) return false
    return LLAMACPP_PROVIDERS.has(providerID.trim().toLowerCase())
  }

  /**
   * Stores or retrieves the caller-provided estimatedTaskTokens for a child subagent session.
   */
  export function setPendingTaskEstimate(childSessionID: string, estimatedTokens?: number): void {
    const map = getPendingEstimateMap()
    if (typeof estimatedTokens === "number" && Number.isFinite(estimatedTokens) && estimatedTokens > 0) {
      map.set(childSessionID, Math.floor(estimatedTokens))
    } else {
      map.delete(childSessionID)
    }
  }

  export function getPendingTaskEstimate(childSessionID: string): number | undefined {
    return getPendingEstimateMap().get(childSessionID)
  }

  /**
   * Records a completed subagent execution sample in the parent session's rolling telemetry window.
   */
  export function recordSubagentTelemetry(parentSessionID: string, sample: SubagentTelemetrySample): void {
    const map = getTelemetryMap()
    const list = map.get(parentSessionID) ?? []
    const existingIdx = list.findIndex((item) => item.childSessionID === sample.childSessionID)
    if (existingIdx !== -1) {
      list[existingIdx] = sample
    } else {
      list.push(sample)
    }
    if (list.length > MAX_TELEMETRY_SAMPLES) {
      list.splice(0, list.length - MAX_TELEMETRY_SAMPLES)
    }
    map.set(parentSessionID, list)
  }

  /**
   * Returns recorded subagent telemetry samples for a parent session.
   */
  export function getSubagentTelemetry(parentSessionID?: string): ReadonlyArray<SubagentTelemetrySample> {
    if (!parentSessionID) return []
    return getTelemetryMap().get(parentSessionID) ?? []
  }

  export function clearSubagentTelemetry(parentSessionID?: string): void {
    if (!parentSessionID) {
      getTelemetryMap().clear()
      getPendingEstimateMap().clear()
      return
    }
    getTelemetryMap().delete(parentSessionID)
  }

  /**
   * Mechanically computes the probability that running a subagent concurrently in unified KV memory
   * will overflow the context ceiling or force premature subagent compaction, deciding whether to
   * offload the parent's KV slot to disk.
   *
   * Factors:
   * 1. Provider must be llama.cpp ("llamacpp" / "llama.cpp") and kvUnified must be true.
   * 2. Available headroom without offload = ceiling - parentUsedTokens - otherActiveTokens.
   * 3. Expected subagent token demand combines:
   *    - Caller's `estimatedTaskTokens` (if provided)
   *    - Rolling historical mean + standard deviation of recent subagents in this session
   *    - Empirical estimation error ratio (actual / estimated) from previous runs
   *    - Compaction/overflow penalty if recent subagents had to compact or overflowed
   * 4. Computes continuous logistic overflow probability P(demand > availableWithoutOffload).
   *    When P(overflow) >= 0.5 (or upper confidence bound of demand >= availableWithoutOffload),
   *    returns `shouldOffload: true`.
   */
  export function computeOffloadDecision(input: OffloadDecisionInput): OffloadDecision {
    const cfg = getObjectivesConfig(input.sessionID)
    const minBudget = input.minSubagentBudget ?? cfg.minSubagentBudget ?? 16_000
    const contextLimit = Math.max(0, input.contextLimit)
    const safetyReserveTokens = Math.max(minBudget, Math.floor(contextLimit * 0.15))
    const ceilingTokens = Math.max(0, contextLimit - safetyReserveTokens)
    const parentUsed = Math.max(0, input.parentUsedTokens)
    const otherActive = Math.max(0, input.otherActiveTokens ?? 0)
    const availableWithoutOffload = Math.max(0, ceilingTokens - parentUsed - otherActive)

    if (!cfg.llamacppKvOffload) {
      return {
        shouldOffload: false,
        overflowProbability: 0,
        projectedDemandTokens: 0,
        expectedSubagentTokens: 0,
        demandStdDevTokens: 0,
        availableWithoutOffload,
        ceilingTokens,
        safetyReserveTokens,
        historicalSampleCount: 0,
        historicalCompactionRate: 0,
        reason: "llamacppKvOffload is disabled in configuration",
      }
    }

    if (input.providerID !== undefined && input.providerID !== null && !isLlamaCppProvider(input.providerID)) {
      return {
        shouldOffload: false,
        overflowProbability: 0,
        projectedDemandTokens: 0,
        expectedSubagentTokens: 0,
        demandStdDevTokens: 0,
        availableWithoutOffload,
        ceilingTokens,
        safetyReserveTokens,
        historicalSampleCount: 0,
        historicalCompactionRate: 0,
        reason: `provider "${input.providerID}" is not llamacpp`,
      }
    }

    if (input.kvUnified === false) {
      return {
        shouldOffload: false,
        overflowProbability: 0,
        projectedDemandTokens: 0,
        expectedSubagentTokens: 0,
        demandStdDevTokens: 0,
        availableWithoutOffload,
        ceilingTokens,
        safetyReserveTokens,
        historicalSampleCount: 0,
        historicalCompactionRate: 0,
        reason: "kv_unified is false (slots are isolated)",
      }
    }

    if (contextLimit <= 0 || parentUsed <= 0) {
      return {
        shouldOffload: false,
        overflowProbability: 0,
        projectedDemandTokens: minBudget,
        expectedSubagentTokens: minBudget,
        demandStdDevTokens: 0,
        availableWithoutOffload,
        ceilingTokens,
        safetyReserveTokens,
        historicalSampleCount: 0,
        historicalCompactionRate: 0,
        reason: "parent session has no active KV tokens to offload",
      }
    }

    const samples = getSubagentTelemetry(input.sessionID)
    const n = samples.length

    // Baseline cold-start subagent demand: a typical subagent (system prompt + tool schemas + exploration)
    // requires at least minSubagentBudget (16k) or ~20% of the context window.
    const coldStartDemand = Math.max(minBudget, Math.floor(contextLimit * 0.2))

    let histMean = coldStartDemand
    let histStdDev = Math.max(4_000, Math.floor(coldStartDemand * 0.25))
    let compactionCount = 0
    let estimationBias = 1.0

    if (n > 0) {
      let sum = 0
      let biasSum = 0
      let biasCount = 0
      for (const s of samples) {
        // If a previous subagent compacted, its true uncompacted pressure was higher than its final post-compaction token count
        const effectiveTokens = s.hadOverflow
          ? Math.max(s.tokensUsed, Math.floor(ceilingTokens * 0.6))
          : s.hadCompaction
            ? Math.floor(s.tokensUsed * 1.35)
            : s.tokensUsed
        sum += effectiveTokens
        if (s.hadCompaction || s.hadOverflow) compactionCount++
        if (s.estimatedTokens && s.estimatedTokens > 0) {
          biasSum += effectiveTokens / s.estimatedTokens
          biasCount++
        }
      }
      histMean = sum / n
      if (biasCount > 0) {
        estimationBias = Math.max(0.8, Math.min(2.5, biasSum / biasCount))
      }
      if (n >= 2) {
        let varSum = 0
        for (const s of samples) {
          const effectiveTokens = s.hadOverflow
            ? Math.max(s.tokensUsed, Math.floor(ceilingTokens * 0.6))
            : s.hadCompaction
              ? Math.floor(s.tokensUsed * 1.35)
              : s.tokensUsed
          varSum += (effectiveTokens - histMean) ** 2
        }
        histStdDev = Math.max(2_000, Math.sqrt(varSum / (n - 1)))
      } else {
        histStdDev = Math.max(3_000, Math.floor(histMean * 0.25))
      }
    }

    const historicalCompactionRate = n > 0 ? compactionCount / n : 0

    // Combine explicit task estimate (calibrated by historical estimation bias) with historical distribution
    const rawEstimate =
      typeof input.estimatedTaskTokens === "number" &&
      Number.isFinite(input.estimatedTaskTokens) &&
      input.estimatedTaskTokens > 0
        ? input.estimatedTaskTokens * estimationBias
        : undefined

    let expectedSubagentTokens: number
    if (rawEstimate !== undefined && n > 0) {
      // Blend caller estimate with empirical session history, and never drop below the worse of the two when history shows high usage
      expectedSubagentTokens = Math.max(minBudget, Math.round(0.6 * rawEstimate + 0.4 * histMean), Math.round(rawEstimate))
    } else if (rawEstimate !== undefined) {
      expectedSubagentTokens = Math.max(minBudget, Math.round(rawEstimate))
    } else if (n > 0) {
      expectedSubagentTokens = Math.max(minBudget, Math.round(histMean))
    } else {
      expectedSubagentTokens = coldStartDemand
    }

    // If recent subagents suffered compaction/overflow, inflate expected demand and uncertainty mechanically
    const compactionRiskMultiplier = 1 + historicalCompactionRate * 0.4
    const adjustedMean = Math.round(expectedSubagentTokens * compactionRiskMultiplier)
    const demandStdDevTokens = Math.max(2_000, Math.round(histStdDev * compactionRiskMultiplier))
    const projectedDemandTokens = adjustedMean + demandStdDevTokens

    // Logistic overflow probability P(Demand > availableWithoutOffload)
    // z = 0 when projectedDemandTokens == availableWithoutOffload -> P = 0.5
    const z = (projectedDemandTokens - availableWithoutOffload) / Math.max(1, demandStdDevTokens)
    const logisticProb = 1 / (1 + Math.exp(-1.7 * z))
    // Boost probability if recent subagents experienced compaction while sharing KV
    const overflowProbability = Math.min(
      1,
      Math.max(0, Number((logisticProb + historicalCompactionRate * 0.15 * (parentUsed / Math.max(1, ceilingTokens))).toFixed(4))),
    )

    const shouldOffload = overflowProbability >= 0.5 || projectedDemandTokens > availableWithoutOffload

    return {
      shouldOffload,
      overflowProbability,
      projectedDemandTokens,
      expectedSubagentTokens: adjustedMean,
      demandStdDevTokens,
      availableWithoutOffload,
      ceilingTokens,
      safetyReserveTokens,
      historicalSampleCount: n,
      historicalCompactionRate,
      reason: shouldOffload
        ? `overflow risk ${(overflowProbability * 100).toFixed(1)}% >= 50% (projected subagent demand ${projectedDemandTokens} tokens vs ${availableWithoutOffload} available in unified KV)`
        : `overflow risk ${(overflowProbability * 100).toFixed(1)}% < 50% (projected subagent demand ${projectedDemandTokens} tokens fits in ${availableWithoutOffload} available unified KV tokens)`,
    }
  }

  /**
   * Evaluates whether a live llama.cpp slot should be offloaded to disk using the mechanical
   * overflow risk model.
   */
  export function shouldOffloadSlot(
    slot?: SlotInfo,
    fallbackLimit?: number,
    options?: {
      sessionID?: string
      providerID?: string | null
      kvUnified?: boolean
      estimatedTaskTokens?: number
    },
  ): boolean {
    if (!slot) return false
    const used = slot.n_past ?? slot.used_tokens ?? slot.context?.used_tokens ?? 0
    const limit = slot.n_ctx ?? slot.context?.total_tokens ?? fallbackLimit ?? 0
    return computeOffloadDecision({
      sessionID: options?.sessionID,
      providerID: options?.providerID ?? "llamacpp",
      kvUnified: options?.kvUnified ?? true,
      contextLimit: limit,
      parentUsedTokens: used,
      estimatedTaskTokens: options?.estimatedTaskTokens,
    }).shouldOffload
  }

  /**
   * Marks a parent session as having its KV cache offloaded to disk (or clears the mark).
   */
  export function markSessionKvOffloaded(sessionID: string, offloaded: boolean): void {
    const set = getOffloadedSet()
    if (offloaded) {
      set.add(sessionID)
    } else {
      set.delete(sessionID)
    }
  }

  /**
   * Returns true if the given session currently has its KV cache offloaded to disk.
   */
  export function isSessionKvOffloaded(sessionID: string): boolean {
    return getOffloadedSet().has(sessionID)
  }

  function discoverBaseUrlFromConfig(): string | undefined {
    const extract = (obj: any): string | undefined => {
      if (!obj || typeof obj !== "object") return undefined
      const all = { ...(obj.providers ?? {}), ...(obj.provider ?? {}) }
      for (const [pId, pCfg] of Object.entries(all) as [string, any][]) {
        if (!LLAMACPP_PROVIDERS.has(pId.toLowerCase())) continue
        const bUrl = pCfg?.settings?.baseURL ?? pCfg?.options?.baseURL
        if (typeof bUrl === "string" && bUrl.trim()) return bUrl.trim()
      }
      return undefined
    }

    try {
      if (process.env.OPENCODE_CONFIG_CONTENT) {
        const found = extract(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT))
        if (found) return found
      }
    } catch {}

    const home = os.homedir?.() ?? process.env.HOME ?? ""
    const candidateFiles = [
      process.env.OPENCODE_CONFIG,
      home ? path.join(home, ".config/opencode/opencode.jsonc") : "",
      home ? path.join(home, ".config/opencode/opencode.json") : "",
      path.join(process.cwd(), "opencode.jsonc"),
      path.join(process.cwd(), "opencode.json"),
      path.join(process.cwd(), ".opencode/opencode.jsonc"),
      path.join(process.cwd(), ".opencode/opencode.json"),
    ].filter(Boolean) as string[]

    for (const f of candidateFiles) {
      try {
        if (fsSync.existsSync(f)) {
          const raw = fsSync.readFileSync(f, "utf-8")
          const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
          const found = extract(JSON.parse(stripped))
          if (found) return found
        }
      } catch {}
    }
    return undefined
  }

  export function resolveOrigin(): string {
    const env =
      process.env.OPENCODE_LLAMACPP_BASE_URL ||
      process.env.LLAMACPP_BASE_URL ||
      process.env.LLAMACPP_URL
    if (env) return env.replace(/\/+$/, "")

    const g = globalThis as any
    const dynamicUrl =
      g.__OPENCODE_DYNAMIC_CONTEXT__?.getBaseURL?.() ??
      g.__OPENCODE_LLAMACPP_BASE_URL__
    if (typeof dynamicUrl === "string" && dynamicUrl.trim()) {
      return dynamicUrl.trim().replace(/\/+$/, "")
    }

    const configUrl = discoverBaseUrlFromConfig()
    if (configUrl) return configUrl.replace(/\/+$/, "")

    return "http://127.0.0.1:29991"
  }

  /**
   * Queries llama-server to check if slots endpoint is active and inspect slot count.
   */
  export async function getSlots(origin = resolveOrigin()): Promise<SlotInfo[] | undefined> {
    try {
      const slotsUrl = origin.endsWith("/v1") ? `${origin.slice(0, -3)}/slots` : `${origin}/slots`
      const res = await fetch(slotsUrl, { signal: AbortSignal.timeout(1200) })
      if (!res.ok) return undefined
      const json = await res.json()
      if (Array.isArray(json)) return json
      if (Array.isArray((json as any)?.slots)) return (json as any).slots
      if (Array.isArray((json as any)?.items)) return (json as any).items
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Checks if llama.cpp KV offloading should be performed:
   * - objectives configuration llamacppKvOffload is enabled (default: true)
   * - llama-server is reachable and reports at least 1 slot via /slots
   */
  export async function isKvOffloadApplicable(sessionID?: string): Promise<boolean> {
    const cfg = getObjectivesConfig(sessionID)
    if (!cfg.llamacppKvOffload) return false

    const slots = await getSlots()
    if (!slots || slots.length < 1) return false
    return true
  }

  /**
   * Selects the slot ID that holds the parent session's KV cache (defaults to 0).
   */
  export function selectParentSlot(slots?: SlotInfo[]): number {
    if (!slots || slots.length === 0) return 0
    let bestSlot = slots[0]?.id ?? 0
    let maxTokens = -1
    for (const s of slots) {
      const used = s.n_past ?? s.used_tokens ?? s.context?.used_tokens ?? 0
      if (typeof used === "number" && used > maxTokens) {
        maxTokens = used
        bestSlot = typeof s.id === "number" ? s.id : 0
      }
    }
    return bestSlot
  }

  /**
   * Saves slot KV cache state to disk.
   * llama-server endpoint: POST /slots/{id_slot}?action=save
   */
  export async function saveSlot(
    slotID: number,
    filename: string,
    origin = resolveOrigin(),
  ): Promise<boolean> {
    try {
      const url = `${origin.endsWith("/v1") ? origin.slice(0, -3) : origin}/slots/${slotID}?action=save`
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
        signal: AbortSignal.timeout(15000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Restores slot KV cache state from disk.
   * llama-server endpoint: POST /slots/{id_slot}?action=restore
   */
  export async function restoreSlot(
    slotID: number,
    filename: string,
    origin = resolveOrigin(),
  ): Promise<boolean> {
    try {
      const url = `${origin.endsWith("/v1") ? origin.slice(0, -3) : origin}/slots/${slotID}?action=restore`
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
        signal: AbortSignal.timeout(15000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Clears/erases slot memory (frees KV cache sequence tokens).
   * llama-server endpoint: POST /slots/{id_slot}?action=erase
   */
  export async function eraseSlot(
    slotID: number,
    origin = resolveOrigin(),
  ): Promise<boolean> {
    try {
      const url = `${origin.endsWith("/v1") ? origin.slice(0, -3) : origin}/slots/${slotID}?action=erase`
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  export function hasConfiguredLlamaCppOrigin(): boolean {
    if (
      process.env.OPENCODE_LLAMACPP_BASE_URL ||
      process.env.LLAMACPP_BASE_URL ||
      process.env.LLAMACPP_URL
    ) {
      return true
    }

    const g = globalThis as any
    if (typeof g.__OPENCODE_TEST_LLAMACPP_KV__ === "boolean") {
      return g.__OPENCODE_TEST_LLAMACPP_KV__
    }

    const isTest =
      typeof process !== "undefined" &&
      (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test" || Boolean(process.env.VITEST))
    if (isTest) {
      return false
    }

    const dynamicUrl =
      g.__OPENCODE_DYNAMIC_CONTEXT__?.getBaseURL?.() ??
      g.__OPENCODE_LLAMACPP_BASE_URL__
    if (typeof dynamicUrl === "string" && dynamicUrl.trim()) {
      return true
    }

    return Boolean(discoverBaseUrlFromConfig())
  }

  export type OffloadOptions = {
    providerID?: string
    kvUnified?: boolean
    parentUsedTokens?: number
    otherActiveTokens?: number
    contextLimit?: number
    estimatedTaskTokens?: number
  }

  /**
   * Helper that executes an operation with the parent session's KV cache offloaded to disk
   * and restored guaranteed via Effect.ensuring.
   * Mechanically decides whether to offload based on:
   * 1. Provider is strictly llama.cpp ("llamacpp" / "llama.cpp") and kv_unified is true
   * 2. Probability of unified KV overflow given parent tokens, estimatedTaskTokens, and historical subagent telemetry
   */
  export function withOffloadedSlot<R, E, A>(
    sessionID: string,
    operation: Effect.Effect<A, E, R>,
    options?: OffloadOptions,
  ): Effect.Effect<A, E, R> {
    const cfg = getObjectivesConfig(sessionID)
    if (!cfg.llamacppKvOffload || !hasConfiguredLlamaCppOrigin()) {
      return operation
    }
    if (options?.providerID !== undefined && !isLlamaCppProvider(options.providerID)) {
      return operation
    }
    if (options?.kvUnified === false) {
      return operation
    }

    // Pre-flight mechanical decision if caller supplied parentUsedTokens and contextLimit
    const preDecision =
      options?.parentUsedTokens !== undefined &&
      options?.contextLimit !== undefined &&
      options.contextLimit > 0
        ? computeOffloadDecision({
            sessionID,
            providerID: options.providerID ?? "llamacpp",
            kvUnified: options.kvUnified ?? true,
            contextLimit: options.contextLimit,
            parentUsedTokens: options.parentUsedTokens,
            otherActiveTokens: options.otherActiveTokens,
            estimatedTaskTokens: options.estimatedTaskTokens,
          })
        : undefined

    if (preDecision && !preDecision.shouldOffload) {
      return operation
    }

    return Effect.gen(function* () {
      const origin = resolveOrigin()
      const slots = yield* Effect.promise(() => getSlots(origin))
      if (!slots || slots.length < 1) {
        return yield* operation
      }

      const parentSlotID = selectParentSlot(slots)
      const parentSlot = slots.find((s) => s.id === parentSlotID) ?? slots[0]

      // Evaluate mechanical decision on the live slot if preDecision was not already computed
      if (
        !preDecision &&
        !shouldOffloadSlot(parentSlot, options?.contextLimit, {
          sessionID,
          providerID: options?.providerID,
          kvUnified: options?.kvUnified,
          estimatedTaskTokens: options?.estimatedTaskTokens,
        })
      ) {
        return yield* operation
      }

      const snapshotFilename = `opencode_kv_slot${parentSlotID}_${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.bin`

      // 1. Guardar slot del hilo padre a disco
      const saved = yield* Effect.promise(() => saveSlot(parentSlotID, snapshotFilename, origin))
      if (saved) {
        // 2. Liberar memoria KV del slot del padre para permitir al subagente usar toda la ventana KV sin OOM ni compactación prematura
        yield* Effect.promise(() => eraseSlot(parentSlotID, origin))
        markSessionKvOffloaded(sessionID, true)
      }

      // 3. Ejecutar subagente garantizando restauración en el bloque ensuring
      return yield* operation.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            markSessionKvOffloaded(sessionID, false)
            if (saved) {
              // 4. Limpiar los slots que haya usado el subagente y restaurar el snapshot del padre
              for (const s of slots) {
                if (typeof s.id === "number" && s.id !== parentSlotID) {
                  yield* Effect.promise(() => eraseSlot(s.id, origin))
                }
              }
              yield* Effect.promise(() => eraseSlot(parentSlotID, origin))
              yield* Effect.promise(() => restoreSlot(parentSlotID, snapshotFilename, origin))

              // 5. Intentar eliminar snapshot temporal del disco si es accesible localmente
              const saveDir = cfg.llamacppSlotSavePath || process.env.OPENCODE_LLAMACPP_SLOT_SAVE_PATH
              if (saveDir) {
                const fullPath = path.join(saveDir, snapshotFilename)
                yield* Effect.promise(() => fs.unlink(fullPath).catch(() => {}))
              }
            }
          }),
        ),
      )
    })
  }
}
