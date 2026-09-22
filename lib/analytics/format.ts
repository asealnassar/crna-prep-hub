import type { MetricStatus, MetricUnit } from './types'

/**
 * How a number becomes text.
 *
 * The rule the old dashboard broke: a missing value renders as an em dash and
 * a reason, NEVER as 0. Every formatter here returns the dash for null, and
 * nothing coerces null into a number on the way.
 */

export const MISSING = '—'

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING
  return Math.round(value).toLocaleString('en-US')
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING
  return `${value.toFixed(decimals)}%`
}

export function formatScore(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING
  return value.toFixed(decimals)
}

export function formatValue(value: number | null | undefined, unit: MetricUnit | undefined): string {
  if (unit === 'percent') return formatPercent(value)
  if (unit === 'score') return formatScore(value)
  if (unit === 'currency') {
    if (value === null || value === undefined || !Number.isFinite(value)) return MISSING
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  return formatNumber(value)
}

export type Delta = {
  readonly direction: 'up' | 'down' | 'flat'
  readonly label: string
  /** True when a rise is good. Registrations yes; failures no. */
  readonly meaningful: boolean
}

/**
 * The change against the previous window.
 *
 * Returns null rather than a percentage when there is nothing to compare
 * against, and says "from 0" rather than dividing by it — a jump from zero to
 * three is not a 300% rise.
 */
export function formatDelta(
  current: number | null | undefined,
  previous: number | null | undefined
): Delta | null {
  if (current === null || current === undefined || !Number.isFinite(current)) return null
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null

  const difference = current - previous
  const direction = difference > 0 ? 'up' : difference < 0 ? 'down' : 'flat'

  if (difference === 0) return { direction: 'flat', label: 'no change', meaningful: false }

  if (previous === 0) {
    return { direction, label: `${difference > 0 ? '+' : ''}${formatNumber(difference)} from 0`, meaningful: true }
  }

  const share = (difference / Math.abs(previous)) * 100
  const rounded = Math.abs(share) >= 10 ? share.toFixed(0) : share.toFixed(1)
  return {
    direction,
    label: `${difference > 0 ? '+' : ''}${rounded}%`,
    meaningful: true,
  }
}

export const STATUS_LABELS: Record<MetricStatus, string> = {
  ok: 'Live',
  partial: 'Partial',
  not_tracked: 'Not tracked yet',
  needs_migration: 'Needs a database function',
  error: 'Unavailable',
}

/** Tailwind classes per status, so one status always looks the same. */
export const STATUS_STYLES: Record<MetricStatus, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  partial: 'bg-amber-50 text-amber-700 ring-amber-200',
  not_tracked: 'bg-slate-100 text-slate-600 ring-slate-200',
  needs_migration: 'bg-violet-50 text-violet-700 ring-violet-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Month names are written here rather than taken from a locale: ICU spells
 * September as "Sept" in some versions of en-GB and "Sep" in others, and a
 * dashboard's dates should not change shape when the runtime updates.
 */
function parts(value: string, timeZone: string): { day: string; month: string; year: string } | null {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  const [year, month, day] = iso.split('-')
  return { day: String(Number(day)), month: MONTHS[Number(month) - 1] ?? month, year }
}

/** A date an admin can read at a glance, in the reporting zone. */
export function formatDate(value: string | null | undefined, timeZone = 'America/New_York'): string {
  if (!value) return MISSING
  const piece = parts(value, timeZone)
  return piece ? `${piece.day} ${piece.month} ${piece.year}` : MISSING
}

export function formatDateTime(value: string | null | undefined, timeZone = 'America/New_York'): string {
  if (!value) return MISSING
  const piece = parts(value, timeZone)
  if (!piece) return MISSING
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
  return `${piece.day} ${piece.month}, ${time}`
}

/** "3 days ago", for a last-seen column. */
export function formatAgo(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return 'never'
  const then = Date.parse(value)
  if (Number.isNaN(then)) return MISSING

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} mo ago`
  return `${Math.round(months / 12)} yr ago`
}
