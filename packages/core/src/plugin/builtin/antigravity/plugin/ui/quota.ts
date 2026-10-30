import type { AccountSummary } from "../account-rpc.ts"
import type { AccountQuotaResult } from "../quota.ts"

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

/** Format progress bar with solid and shaded block characters, exactly 50 blocks wide. */
export function renderQuotaProgressBar(fraction: number, width = 50): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  const filled = Math.round(clamped * width)
  const empty = width - filled
  const percent = (clamped * 100).toFixed(2)
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${percent}%`
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

/**
 * Format complete graphical quota report for an account matching the native Antigravity CLI layout:
 *
 * Account: user@example.com
 *
 * GEMINI MODELS
 *   Models within this group: Gemini Flash, Gemini Pro
 *
 *   Weekly Limit Remaining
 *     [████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 39.10%
 *     Refreshes in 94h 37m
 *
 *   Five Hour Limit Remaining
 *     ...
 */
export function formatAccountQuotaReport(
  accountEmail: string,
  result: AccountQuotaResult,
  now = Date.now(),
): string {
  const lines: string[] = []
  const emailHeader = `Account: ${accountEmail}${result.disabled ? " [disabled]" : ""}`
  lines.push(emailHeader)

  if (result.status === "disabled") {
    lines.push("  Skipped (disabled)")
    return lines.join("\n")
  }

  if (result.error) {
    lines.push(`  ${result.error}`)
    return lines.join("\n")
  }

  const summary = result.quotaSummary
  if (summary?.groups && summary.groups.length > 0) {
    lines.push("")
    for (const group of summary.groups) {
      const groupTitle = (group.displayName ?? "MODELS").toUpperCase()
      lines.push(groupTitle)
      if (group.description) {
        lines.push(`  ${group.description}`)
      }
      lines.push("")

      for (const bucket of group.buckets ?? []) {
        const bucketName = bucket.displayName ?? "Limit"
        lines.push(`  ${bucketName}`)
        const fraction = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : 1
        lines.push(`    ${renderQuotaProgressBar(fraction)}`)
        lines.push(`    ${formatQuotaCountdown(bucket.resetTime, fraction, now)}`)
        lines.push("")
      }
    }

    if (summary.description) {
      lines.push(wrapCalloutText(summary.description))
    }
    return lines.join("\n").trimEnd()
  }

  // Fallback if quotaSummary was unavailable or error: synthesize from groups/cliQuota
  lines.push("")
  const fallbackGroups: Array<{
    title: string
    description?: string
    buckets: Array<{ name: string; fraction?: number; resetTime?: string }>
  }> = []

  const geminiFlash = result.quota?.groups?.["gemini-flash"]
  const geminiPro = result.quota?.groups?.["gemini-pro"]
  const geminiFraction = Math.min(
    geminiFlash?.remainingFraction ?? 1,
    geminiPro?.remainingFraction ?? 1,
  )
  const geminiReset = geminiFlash?.remainingFractionResetTime ?? geminiFlash?.resetTime ?? geminiPro?.resetTime

  fallbackGroups.push({
    title: "GEMINI MODELS",
    description: "Models within this group: Gemini Flash, Gemini Pro",
    buckets: [
      {
        name: "Five Hour Limit Remaining",
        fraction: geminiFraction,
        resetTime: geminiReset,
      },
    ],
  })

  const claude = result.quota?.groups?.claude
  fallbackGroups.push({
    title: "CLAUDE AND GPT MODELS",
    description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
    buckets: [
      {
        name: "Five Hour Limit Remaining",
        fraction: claude?.remainingFraction ?? 1,
        resetTime: claude?.remainingFractionResetTime ?? claude?.resetTime,
      },
    ],
  })

  for (const group of fallbackGroups) {
    lines.push(group.title)
    if (group.description) lines.push(`  ${group.description}`)
    lines.push("")
    for (const bucket of group.buckets) {
      lines.push(`  ${bucket.name}`)
      const fraction = bucket.fraction ?? 1
      lines.push(`    ${renderQuotaProgressBar(fraction)}`)
      lines.push(`    ${formatQuotaCountdown(bucket.resetTime, fraction, now)}`)
      lines.push("")
    }
  }

  const defaultDesc =
    "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier."
  lines.push(wrapCalloutText(defaultDesc))

  return lines.join("\n").trimEnd()
}
