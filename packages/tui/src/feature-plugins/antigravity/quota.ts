import type { AccountSummary } from "./account-rpc.js"

/** ANSI color helpers */
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const

/** Format a cached quota and reset countdown for an account menu row. */
export function formatQuotaDescription(quota: AccountSummary["quota"], now = Date.now()): string {
  if (!quota) return "no quota data"
  const percent = Math.round(quota.remainingFraction * 100)
  const description = `${percent}%`
  if (percent >= 100 || !quota.resetTime) return description

  const resetAt = Date.parse(quota.resetTime)
  if (!Number.isFinite(resetAt)) return description
  const minutes = Math.ceil((resetAt - now) / 60_000)
  if (minutes <= 0) return `${description} · reset due`

  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor(minutes / 60) % 24
  const duration = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  return `${description} · resets in ${duration}`
}

/** Get ANSI color code based on quota fraction (green > 50%, yellow 20-50%, red <= 20%). */
export function getQuotaColorCode(fraction: number): string {
  if (fraction > 0.5) return ANSI.green
  if (fraction > 0.2) return ANSI.yellow
  return ANSI.red
}

/** Format progress bar with solid and shaded block characters, exactly 50 blocks wide with dynamic colors. */
export function renderQuotaProgressBar(fraction: number, width = 50, colorize = true): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  const filled = Math.round(clamped * width)
  const empty = width - filled
  const percent = (clamped * 100).toFixed(2)

  if (!colorize) {
    return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${percent}%`
  }

  const fg = getQuotaColorCode(clamped)
  return `[${fg}${"█".repeat(filled)}${ANSI.dim}${"░".repeat(empty)}${ANSI.reset}] ${fg}${percent}%${ANSI.reset}`
}

/** Format reset countdown duration like "Refreshes in 94h 37m" or "Quota available". */
export function formatQuotaCountdown(resetTime?: string, remainingFraction?: number, now = Date.now()): string {
  if (remainingFraction !== undefined && remainingFraction >= 1) {
    return "Quota available"
  }
  if (!resetTime) {
    return "Quota available"
  }
  const resetAt = Date.parse(resetTime)
  if (!Number.isFinite(resetAt)) {
    return "Quota available"
  }
  const diffMinutes = Math.ceil((resetAt - now) / 60_000)
  if (diffMinutes <= 0) {
    return "Quota available"
  }
  const hours = Math.floor(diffMinutes / 60)
  const minutes = diffMinutes % 60
  if (hours > 0) {
    return `Refreshes in ${hours}h ${minutes}m`
  }
  return `Refreshes in ${minutes}m`
}

/** Wrap callout description paragraph with left vertical border '│'. */
export function wrapCalloutText(text: string, maxWidth = 80): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ""
  for (const w of words) {
    if (!current) {
      current = w
    } else if (current.length + 1 + w.length <= maxWidth - 3) {
      current += " " + w
    } else {
      lines.push(current)
      current = w
    }
  }
  if (current) lines.push(current)
  return lines.map(line => `  │${line}`).join("\n")
}
