// Enabled by default via local LM Studio (http://127.0.0.1:1234) or any OpenAI-compatible embeddings endpoint.
// Opt-out via OPENCODE_OBJECTIVES_EMBEDDINGS=false (or explicit opts.enabled = false).
// Falls back seamlessly to the default lexical scorer if LM Studio is unreachable or inactive.

import type { Finding, FindingScorer } from "./objectives-model.js"
import { setFindingScorer } from "./objectives-model.js"

export interface LmStudioEmbeddingsConfig {
  baseUrl?: string
  model?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 2500

/**
 * Resolves the LM Studio origin dynamically using OpenCode's standard environment variables:
 * 1. Explicit config.baseUrl
 * 2. LMSTUDIO_BASE_URL (standard OpenAI-like env)
 * 3. LMSTUDIO_URL
 * 4. OPENCODE_LMSTUDIO_URL
 * 5. OPENCODE_PROVIDER_LMSTUDIO_ORIGIN
 * 6. Fallback default origin: http://127.0.0.1:1234
 */
export function resolveLmStudioOrigin(explicitUrl?: string): string {
  const candidate =
    explicitUrl ||
    process.env.LMSTUDIO_BASE_URL ||
    process.env.LMSTUDIO_URL ||
    process.env.OPENCODE_LMSTUDIO_URL ||
    process.env.OPENCODE_PROVIDER_LMSTUDIO_ORIGIN ||
    "http://127.0.0.1:1234"
  return candidate.replace(/\/+$/, "")
}

// In-memory LRU-like cache of computed embeddings to avoid re-calling LM Studio for the same finding
const embeddingCache = new Map<string, number[]>()
const MAX_CACHE_SIZE = 500

function cacheKey(text: string): string {
  // Simple fast hash-like prefix
  return `${text.length}:${text.slice(0, 100)}`
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  const sim = dot / denom
  // Clamp between 0 and 1
  return Math.max(0, Math.min(1, Math.round(sim * 1000) / 1000))
}

/**
 * Discovers available embedding models from LM Studio dynamically.
 * Prioritizes ultra-lightweight embedding models (nomic, 0.6b, etc.) to keep latency minimal.
 */
export async function discoverLmStudioEmbeddingModel(baseUrl?: string): Promise<string | undefined> {
  const origin = resolveLmStudioOrigin(baseUrl)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    // 1. Check LM Studio native /api/v1/models endpoint
    const res = await fetch(`${origin}/api/v1/models`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.ok) {
      const json = (await res.json()) as any
      const models = Array.isArray(json?.models) ? json.models : []
      const embeddingModels = models.filter((m: any) => m.type === "embedding" && m.key)
      if (embeddingModels.length > 0) {
        // Prefer ultra-light models if present (e.g. nomic or 0.6B)
        const light = embeddingModels.find((m: any) => /nomic|0\.6b|mini/i.test(m.key))
        return light?.key || embeddingModels[0].key
      }
    }
  } catch {
    // continue to OpenAI v1 fallback
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    // 2. Fallback to OpenAI compatible /v1/models
    const res = await fetch(`${origin}/v1/models`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.ok) {
      const json = (await res.json()) as any
      const data = Array.isArray(json?.data) ? json.data : []
      const match = data.find((m: any) => typeof m?.id === "string" && /embed/i.test(m.id))
      if (match?.id) return match.id
    }
  } catch {
    // unreachable
  }
  return undefined
}

export async function fetchEmbedding(
  text: string,
  config: LmStudioEmbeddingsConfig = {},
): Promise<number[] | undefined> {
  const clean = text.trim()
  if (!clean) return undefined

  const key = cacheKey(clean)
  const cached = embeddingCache.get(key)
  if (cached) return cached

  const origin = resolveLmStudioOrigin(config.baseUrl)
  let model = config.model || process.env.OPENCODE_OBJECTIVES_EMBEDDINGS_MODEL
  if (!model) {
    model = (await discoverLmStudioEmbeddingModel(origin)) || "text-embedding-nomic-embed-text-v1.5"
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const res = await fetch(`${origin}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: clean }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) return undefined
    const json = (await res.json()) as any
    const vec = json?.data?.[0]?.embedding
    if (Array.isArray(vec) && vec.length > 0) {
      if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value
        if (firstKey) embeddingCache.delete(firstKey)
      }
      embeddingCache.set(key, vec)
      return vec
    }
  } catch {
    // LM Studio unreachable or timeout: return undefined so caller falls back
    return undefined
  }
  return undefined
}

export function createLmStudioFindingScorer(config: LmStudioEmbeddingsConfig = {}): FindingScorer {
  // Synchronous FindingScorer adapter with background pre-fetch:
  // Returns cosine similarity when embeddings are cached, or falls back dynamically.
  return {
    score(query: string, finding: Finding): number {
      const findingText = [finding.title, finding.result, finding.nextAction].join(" ").trim()
      const queryKey = cacheKey(query)
      const findingKey = cacheKey(findingText)

      const qVec = embeddingCache.get(queryKey)
      const fVec = embeddingCache.get(findingKey)

      if (qVec && fVec) {
        return cosineSimilarity(qVec, fVec)
      }

      // Pre-fetch asynchronously for subsequent queries/scoring passes
      if (!qVec) void fetchEmbedding(query, config)
      if (!fVec) void fetchEmbedding(findingText, config)

      // Fallback: default lexical coverage until embeddings resolve
      return -1 // signal to use default
    },
  }
}

/**
 * Pre-computes and caches embeddings for an array of findings in background.
 * Called automatically during session hydration so subsequent searches are instant.
 */
export async function warmUpFindingsEmbeddings(
  findings: Finding[],
  config: LmStudioEmbeddingsConfig = {},
): Promise<number> {
  if (!findings || findings.length === 0) return 0
  const origin = resolveLmStudioOrigin(config.baseUrl)
  const available = await isLmStudioAvailable(origin)
  if (!available) return 0

  let warmed = 0
  for (const f of findings) {
    if (f.lifecycle === "SUBSUMED") continue
    const text = [f.title, f.result, f.nextAction].join(" ").trim()
    const key = cacheKey(text)
    if (!embeddingCache.has(key)) {
      const vec = await fetchEmbedding(text, { ...config, baseUrl: origin })
      if (vec) warmed += 1
    }
  }
  return warmed
}
export async function isLmStudioAvailable(baseUrl?: string): Promise<boolean> {
  const origin = resolveLmStudioOrigin(baseUrl)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const res = await fetch(`${origin}/v1/models`, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return false
    const json = (await res.json()) as any
    return Array.isArray(json?.data) && json.data.length > 0
  } catch {
    return false
  }
}

/**
 * Enables LM Studio semantic embeddings for Finding search-before-write.
 * If LM Studio is not active or disabled by env, keeps the default lexical scorer.
 */
export async function autoConfigureEmbeddingsScorer(opts?: { enabled?: boolean; baseUrl?: string }): Promise<boolean> {
  const disabled = opts?.enabled === false || process.env.OPENCODE_OBJECTIVES_EMBEDDINGS === "false" || process.env.OPENCODE_OBJECTIVES_EMBEDDINGS === "0"
  if (disabled) {
    setFindingScorer(undefined)
    return false
  }

  const origin = resolveLmStudioOrigin(opts?.baseUrl)
  const available = await isLmStudioAvailable(origin)
  if (!available) {
    setFindingScorer(undefined)
    return false
  }

  const baseScorer = createLmStudioFindingScorer({ baseUrl: origin })
  // Composite scorer: if embeddings are available in cache use them, otherwise use lexical
  const { defaultFindingScore } = await import("./objectives-model.js")
  setFindingScorer({
    score(query, finding) {
      const embScore = baseScorer.score(query, finding)
      if (embScore >= 0) return embScore
      // fallback lexical
      return defaultFindingScore(query, finding)
    },
  })
  return true
}
