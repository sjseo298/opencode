/**
 * ============================================================================
 * Llama.cpp Slot KV Cache Offload and Swap Manager
 * ============================================================================
 *
 * Implements slot KV cache snapshotting, erasing and restoring to disk
 * via llama-server /slots endpoints (POST /slots/{id_slot}?action=save|restore|erase).
 * When running on llama.cpp, this saves and frees the parent session's KV cache
 * during subagent execution to prevent VRAM exhaustion, slot thrashing, and
 * premature subagent compaction, restoring the parent KV cache snapshot upon
 * subagent completion.
 * ============================================================================
 */

import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import { getObjectivesConfig } from "../plugin/builtin/objectives-model.js"

const LOCAL_KV_PROVIDERS = new Set(["llamacpp", "llama.cpp", "esca", "splash", "local"])

function getOffloadedSet(): Set<string> {
  const g = globalThis as any
  if (!g.__OPENCODE_KV_OFFLOADED_SESSIONS__) {
    g.__OPENCODE_KV_OFFLOADED_SESSIONS__ = new Set<string>()
  }
  return g.__OPENCODE_KV_OFFLOADED_SESSIONS__
}

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
        if (!LOCAL_KV_PROVIDERS.has(pId.toLowerCase())) continue
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

  /**
   * Helper that executes an operation with the parent session's KV cache offloaded to disk
   * and restored guaranteed via Effect.ensuring.
   */
  export function withOffloadedSlot<R, E, A>(
    sessionID: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    const cfg = getObjectivesConfig(sessionID)
    if (!cfg.llamacppKvOffload || !hasConfiguredLlamaCppOrigin()) {
      return operation
    }

    return Effect.gen(function* () {
      const origin = resolveOrigin()
      const slots = yield* Effect.promise(() => getSlots(origin))
      if (!slots || slots.length < 1) {
        return yield* operation
      }

      const parentSlotID = selectParentSlot(slots)
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
