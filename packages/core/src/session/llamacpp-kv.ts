/**
 * ============================================================================
 * Llama.cpp Slot KV Cache Offload and Swap Manager
 * ============================================================================
 *
 * Implements slot KV cache snapshotting, erasing and restoring to disk
 * via llama-server /slots endpoints (POST /slots/{id_slot}?action=save|restore|erase).
 * When running with parallel=2 on llama.cpp, this frees slot 0's KV cache
 * during subagent execution to prevent VRAM exhaustion and slot thrashing,
 * restoring the parent KV cache snapshot upon subagent completion.
 * ============================================================================
 */

import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { getObjectivesConfig } from "../plugin/builtin/objectives-model.js"

export namespace LlamaCppKV {
  export type SlotInfo = {
    id: number
    id_task?: number
    is_processing?: boolean
    n_ctx?: number
  }

  export function resolveOrigin(): string {
    const env =
      process.env.OPENCODE_LLAMACPP_BASE_URL ||
      process.env.LLAMACPP_BASE_URL ||
      process.env.LLAMACPP_URL
    if (env) return env.replace(/\/+$/, "")

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
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Checks if llama.cpp KV offloading should be performed:
   * - objectives configuration llamacppKvOffload is enabled (default: true)
   * - llama-server is reachable and reports parallel=2 (or slots.length >= 2)
   */
  export async function isKvOffloadApplicable(sessionID?: string): Promise<boolean> {
    const cfg = getObjectivesConfig(sessionID)
    if (!cfg.llamacppKvOffload) return false

    const slots = await getSlots()
    if (!slots || slots.length < 2) return false
    return true
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

  /**
   * Helper that executes an operation with slot 0 KV cache offloaded to disk
   * and restored guaranteed via Effect.ensuring.
   */
  export function withOffloadedSlot<R, E, A>(
    sessionID: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return Effect.gen(function* () {
      const applicable = yield* Effect.promise(() => isKvOffloadApplicable(sessionID))
      if (!applicable) {
        return yield* operation
      }

      const snapshotFilename = `opencode_kv_slot0_${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.bin`
      const origin = resolveOrigin()

      // 1. Guardar slot 0 a disco
      const saved = yield* Effect.promise(() => saveSlot(0, snapshotFilename, origin))
      if (saved) {
        // 2. Liberar memoria KV de slot 0 para permitir al subagente usar VRAM sin OOM
        yield* Effect.promise(() => eraseSlot(0, origin))
      }

      // 3. Ejecutar subagente garantizando restauración en el bloque ensuring
      return yield* operation.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (saved) {
              // 4. Limpiar slot 1 (subagente) si fuera necesario y restaurar slot 0
              yield* Effect.promise(() => eraseSlot(1, origin))
              yield* Effect.promise(() => restoreSlot(0, snapshotFilename, origin))

              // 5. Intentar eliminar snapshot temporal del disco si es accesible localmente
              const cfg = getObjectivesConfig(sessionID)
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
