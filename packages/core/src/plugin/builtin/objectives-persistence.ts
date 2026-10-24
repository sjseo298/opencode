// Cross-session persistence for the Protocolo de Objetivos (F-1).
// The plugin context exposes a JSON key-value storage domain; the whole objective tree
// document is auto-persisted there on every mutation and auto-hydrated on session resume.
// Storage is the source of truth across compaction and process restarts; message-history
// reconstruction remains only as a last-resort fallback.

import { parseDocument, renderProjection, serializeDocument, type ProjectionDocLike } from "./objectives-model.js"

const KEY_PREFIX = "objectives/v1"

export interface JsonKvStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export interface ObjectivesStore {
  load(sessionID: string): Promise<Record<string, any> | undefined>
  loadByTopic(topicKey: string): Promise<Record<string, any> | undefined>
  save(sessionID: string, doc: Record<string, any>): Promise<boolean>
  remove(sessionID: string): Promise<void>
}

export function createObjectivesStore(kv: JsonKvStore): ObjectivesStore {
  return {
    async load(sessionID) {
      try {
        const raw = await kv.get(`${KEY_PREFIX}/${sessionID}`)
        return parseDocument(raw)
      } catch {
        return undefined
      }
    },
    async loadByTopic(topicKey) {
      try {
        const raw = await kv.get(`${KEY_PREFIX}/topic/${topicKey.trim()}`)
        return parseDocument(raw)
      } catch {
        return undefined
      }
    },
    async save(sessionID, doc) {
      try {
        const normalized = parseDocument(doc)
        if (!normalized) return false
        const json = serializeDocument(normalized)
        await kv.set(`${KEY_PREFIX}/${sessionID}`, json)
        const topicKey = typeof normalized.topicKey === "string" ? normalized.topicKey.trim() : ""
        if (topicKey) {
          await kv.set(`${KEY_PREFIX}/topic/${topicKey}`, json)
        }
        await kv.set(`${KEY_PREFIX}/${sessionID}/projection`, renderProjection(normalized as ProjectionDocLike))
        return true
      } catch {
        return false
      }
    },
    async remove(sessionID) {
      try {
        await kv.remove(`${KEY_PREFIX}/${sessionID}`)
        await kv.remove(`${KEY_PREFIX}/${sessionID}/projection`)
      } catch {
        // removal is best-effort
      }
    },
  }
}
