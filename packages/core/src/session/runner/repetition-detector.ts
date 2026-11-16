export * as RepetitionDetector from "./repetition-detector.js"

export type Kind = "reasoning" | "text"

export interface Detection {
  readonly kind: Kind
  readonly reason: "exact-cycle" | "low-entropy"
  readonly period?: number
  readonly totalChars: number
  readonly sample: string
}

export interface Detector {
  readonly feed: (delta: string) => Detection | undefined
}

const WINDOW_CHARS = 16_384
const CHECK_INTERVAL = 512
const ANCHOR_LENGTH = 64
const MIN_PERIOD = 32
const MAX_PERIOD = 4_096
const ENTROPY_WINDOW = 4_096
const SHINGLE_WIDTH = 24
const SHINGLE_STRIDE = 4

const RULES = {
  reasoning: {
    minCycleTotal: 1_500,
    minShortCycleTotal: 900,
    minCycleRepeats: 3,
    minShortCycleRepeats: 6,
    minEntropyChars: 6_000,
    maxEntropyRatio: 0.25,
    entropyStreaks: 2,
  },
  text: {
    minCycleTotal: 2_400,
    minShortCycleTotal: 1_600,
    minCycleRepeats: 4,
    minShortCycleRepeats: 8,
    minEntropyChars: 10_000,
    maxEntropyRatio: 0.18,
    entropyStreaks: 3,
  },
} as const

export function create(kind: Kind): Detector {
  const rules = RULES[kind]
  let buffer = ""
  let totalChars = 0
  let pendingCheckChars = 0
  let lowEntropyStreak = 0
  let detected: Detection | undefined

  const feed = (delta: string): Detection | undefined => {
    if (detected) return detected
    if (delta.length === 0) return undefined

    totalChars += delta.length
    pendingCheckChars += delta.length
    buffer = appendBounded(buffer, delta)

    if (pendingCheckChars < CHECK_INTERVAL) return undefined
    pendingCheckChars = 0

    const cycle = findExactCycle(buffer, rules)
    if (cycle) {
      detected = {
        kind,
        reason: "exact-cycle",
        period: cycle.period,
        totalChars,
        sample: excerpt(cycle.block),
      }
      return detected
    }

    if (totalChars >= rules.minEntropyChars && buffer.length >= ENTROPY_WINDOW) {
      const slice = buffer.slice(-ENTROPY_WINDOW)
      const lowEntropy = hasSubstantialWords(slice) && shingleNoveltyRatio(slice) < rules.maxEntropyRatio
      lowEntropyStreak = lowEntropy ? lowEntropyStreak + 1 : 0
      if (lowEntropyStreak >= rules.entropyStreaks) {
        detected = {
          kind,
          reason: "low-entropy",
          totalChars,
          sample: excerpt(slice.slice(-320)),
        }
        return detected
      }
    }

    return undefined
  }

  return { feed }
}

function appendBounded(current: string, delta: string) {
  if (delta.length >= WINDOW_CHARS) return delta.slice(-WINDOW_CHARS)
  const combined = current + delta
  if (combined.length <= WINDOW_CHARS) return combined
  return combined.slice(-WINDOW_CHARS)
}

function findExactCycle(
  text: string,
  rules: (typeof RULES)[Kind],
): { readonly period: number; readonly block: string } | undefined {
  if (text.length < rules.minShortCycleTotal) return undefined
  const anchor = text.slice(-ANCHOR_LENGTH)
  let searchFrom = text.length - ANCHOR_LENGTH - MIN_PERIOD

  while (searchFrom >= 0) {
    const match = text.lastIndexOf(anchor, searchFrom)
    if (match === -1) return undefined

    const period = text.length - ANCHOR_LENGTH - match
    if (period > MAX_PERIOD) return undefined
    if (period >= MIN_PERIOD) {
      const block = text.slice(-period)
      if (isNonTrivialBlock(block)) {
        const repeats = countTrailingRepeats(text, block)
        const covered = repeats * period
        const longCycle = repeats >= rules.minCycleRepeats && covered >= rules.minCycleTotal
        const shortCycle = repeats >= rules.minShortCycleRepeats && covered >= rules.minShortCycleTotal
        if (longCycle || shortCycle) return { period, block }
      }
    }

    searchFrom = match - 1
  }

  return undefined
}

function countTrailingRepeats(text: string, block: string) {
  const period = block.length
  let repeats = 1
  let offset = text.length - period * 2
  while (offset >= 0 && text.startsWith(block, offset)) {
    repeats++
    offset -= period
  }
  return repeats
}

function isNonTrivialBlock(block: string) {
  let words = 0
  const distinct = new Set<string>()
  for (const ch of block) {
    distinct.add(ch)
    if (isWordChar(ch)) words++
    if (words >= 12 && distinct.size >= 8) return true
  }
  return false
}

function hasSubstantialWords(slice: string) {
  let words = 0
  for (const ch of slice) {
    if (isWordChar(ch)) words++
    if (words >= 512) return true
  }
  return false
}

function isWordChar(ch: string) {
  const code = ch.charCodeAt(0)
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code >= 128
  )
}

function shingleNoveltyRatio(slice: string) {
  const seen = new Set<string>()
  let total = 0
  for (let i = 0; i <= slice.length - SHINGLE_WIDTH; i += SHINGLE_STRIDE) {
    seen.add(slice.slice(i, i + SHINGLE_WIDTH))
    total++
  }
  if (total === 0) return 1
  return seen.size / total
}

function excerpt(block: string) {
  const normalized = block.trim().replace(/\s+/g, " ")
  if (normalized.length <= 120) return normalized
  return `${normalized.slice(0, 117)}...`
}
