/**
 * Date ranges, buckets and comparisons, in one reporting timezone.
 *
 * WHY A FIXED TIMEZONE. The old page rendered every date with
 * toLocaleDateString(), so "today" meant whatever the viewer's browser thought
 * it meant and two people could read the same dashboard differently. Every
 * bucket here is a calendar day in ONE zone, stated on the page.
 *
 * WHY CALENDAR KEYS AND NOT ARITHMETIC. A bucket key is produced by asking
 * Intl what calendar date an instant falls on in that zone, and every step
 * between buckets is taken at 12:00 UTC on a calendar date. Nothing ever adds
 * 24 hours to a local time, which is what breaks on the two days a year when a
 * local day is 23 or 25 hours long.
 */

export const REPORTING_TIMEZONE = 'America/New_York'

export type RangePreset = '7d' | '30d' | '90d' | 'custom' | 'all'
export type Bucket = 'day' | 'week' | 'month'

export type ResolvedRange = {
  readonly preset: RangePreset
  /** Inclusive start, ISO instant. Null means "everything up to `to`". */
  readonly from: string | null
  /** Exclusive end, ISO instant. */
  readonly to: string
  readonly bucket: Bucket
  readonly timezone: string
  readonly label: string
  /** The window of equal length immediately before `from`, when one applies. */
  readonly comparison: { readonly from: string; readonly to: string; readonly label: string } | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const PRESET_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 }

const dayFormatter = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })

/** The calendar date an instant falls on, in the reporting zone: 'YYYY-MM-DD'. */
export function dayKey(value: string | number | Date, timeZone: string = REPORTING_TIMEZONE): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new RangeError(`not a date: ${String(value)}`)
  return dayFormatter(timeZone).format(date)
}

/** Midday UTC on a calendar date — a safe anchor for calendar arithmetic. */
function anchor(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`)
}

function addDays(day: string, count: number): string {
  const next = new Date(anchor(day).getTime() + count * DAY_MS)
  return next.toISOString().slice(0, 10)
}

/** The Monday of the week a calendar date belongs to. */
export function weekStart(day: string): string {
  const date = anchor(day)
  const weekday = (date.getUTCDay() + 6) % 7 // Monday = 0
  return addDays(day, -weekday)
}

/** The bucket a calendar date belongs to. */
export function bucketOf(day: string, bucket: Bucket): string {
  if (bucket === 'day') return day
  if (bucket === 'week') return weekStart(day)
  return day.slice(0, 7)
}

/** The bucket an instant belongs to, in the reporting zone. */
export function bucketKey(
  value: string | number | Date,
  bucket: Bucket,
  timeZone: string = REPORTING_TIMEZONE
): string {
  return bucketOf(dayKey(value, timeZone), bucket)
}

/**
 * Every bucket between two instants, inclusive at both ends, oldest first.
 * An empty bucket has to exist for the chart to show a gap rather than close it.
 */
export function bucketKeys(
  from: string | number | Date,
  to: string | number | Date,
  bucket: Bucket,
  timeZone: string = REPORTING_TIMEZONE
): string[] {
  const first = dayKey(from, timeZone)
  const last = dayKey(to, timeZone)
  const keys: string[] = []
  const seen = new Set<string>()

  for (let day = first; day <= last; day = addDays(day, 1)) {
    const key = bucketOf(day, bucket)
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
    // Guard against a pathological range rather than looping forever.
    if (keys.length > 3700) break
  }
  return keys
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A short human label for a bucket key: '4 Sep', 'w/c 1 Sep', 'Sep 2026'. */
export function bucketLabel(key: string, bucket: Bucket): string {
  if (bucket === 'month') {
    const [year, month] = key.split('-')
    return `${MONTHS[Number(month) - 1] ?? month} ${year}`
  }
  const [, month, day] = key.split('-')
  const short = `${Number(day)} ${MONTHS[Number(month) - 1] ?? month}`
  return bucket === 'week' ? `w/c ${short}` : short
}

/** Days are readable up to a quarter; beyond that, weeks, then months. */
export function bucketFor(spanDays: number): Bucket {
  if (spanDays <= 92) return 'day'
  if (spanDays <= 400) return 'week'
  return 'month'
}

function startOfDayInstant(day: string, timeZone: string): Date {
  // Find the instant that begins this calendar day in the zone, by walking
  // back from midday UTC in hour steps until the date flips. Cheap, and immune
  // to the offset changing on the day itself.
  const noon = anchor(day)
  for (let hours = 0; hours <= 36; hours++) {
    const candidate = new Date(noon.getTime() - hours * 60 * 60 * 1000)
    const previous = new Date(candidate.getTime() - 60 * 60 * 1000)
    if (dayKey(candidate, timeZone) === day && dayKey(previous, timeZone) !== day) {
      return candidate
    }
  }
  return noon
}

export type RangeInput = {
  readonly preset?: string | null
  readonly from?: string | null
  readonly to?: string | null
  readonly now?: Date
  readonly timezone?: string
}

/**
 * Turns whatever the page asked for into a window, a bucket size and the
 * comparison window. Anything unrecognised falls back to 30 days rather than
 * failing: a dashboard that will not load teaches nobody anything.
 */
export function resolveRange(input: RangeInput = {}): ResolvedRange {
  const timeZone = input.timezone || REPORTING_TIMEZONE
  const now = input.now ?? new Date()
  const to = now.toISOString()

  const preset: RangePreset =
    input.preset === '7d' || input.preset === '90d' || input.preset === 'all' || input.preset === 'custom'
      ? input.preset
      : input.preset === '30d' || !input.preset
        ? '30d'
        : '30d'

  if (preset === 'all') {
    return {
      preset,
      from: null,
      to,
      bucket: 'month',
      timezone: timeZone,
      label: 'All time',
      comparison: null,
    }
  }

  if (preset === 'custom') {
    const fromDay = /^\d{4}-\d{2}-\d{2}$/.test(input.from ?? '') ? (input.from as string) : null
    const toDay = /^\d{4}-\d{2}-\d{2}$/.test(input.to ?? '') ? (input.to as string) : null
    if (fromDay && toDay && fromDay <= toDay) {
      const fromInstant = startOfDayInstant(fromDay, timeZone)
      // Exclusive end: the instant the day AFTER `toDay` begins.
      const toInstant = startOfDayInstant(addDays(toDay, 1), timeZone)
      const spanDays = Math.max(1, Math.round((toInstant.getTime() - fromInstant.getTime()) / DAY_MS))
      const previousFrom = new Date(fromInstant.getTime() - spanDays * DAY_MS)
      return {
        preset,
        from: fromInstant.toISOString(),
        to: toInstant.toISOString(),
        bucket: bucketFor(spanDays),
        timezone: timeZone,
        label: `${bucketLabel(fromDay, 'day')} – ${bucketLabel(toDay, 'day')}`,
        comparison: {
          from: previousFrom.toISOString(),
          to: fromInstant.toISOString(),
          label: `previous ${spanDays} days`,
        },
      }
    }
    // An unusable custom range behaves as the default window.
    return resolveRange({ ...input, preset: '30d' })
  }

  const days = PRESET_DAYS[preset]
  const firstDay = addDays(dayKey(now, timeZone), -(days - 1))
  const fromInstant = startOfDayInstant(firstDay, timeZone)
  const previousFrom = new Date(fromInstant.getTime() - days * DAY_MS)

  return {
    preset,
    from: fromInstant.toISOString(),
    to,
    bucket: bucketFor(days),
    timezone: timeZone,
    label: `Last ${days} days`,
    comparison: {
      from: previousFrom.toISOString(),
      to: fromInstant.toISOString(),
      label: `previous ${days} days`,
    },
  }
}

/** Whether an instant falls inside a window. `from: null` means no lower bound. */
export function within(value: string | Date, from: string | null, to: string): boolean {
  const at = value instanceof Date ? value.getTime() : Date.parse(value)
  if (Number.isNaN(at)) return false
  if (from !== null && at < Date.parse(from)) return false
  return at < Date.parse(to)
}
