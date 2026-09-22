import { bucketKey, type Bucket } from './range'

/**
 * Counting, grouping and comparing. Pure, so the arithmetic behind every
 * number on the dashboard can be tested without a database.
 */

/** Rows counted into their buckets, aligned to `keys` and zero-filled. */
export function countByBucket<T>(
  rows: readonly T[],
  at: (row: T) => string | null | undefined,
  keys: readonly string[],
  bucket: Bucket,
  timeZone?: string
): number[] {
  const index = new Map(keys.map((key, position) => [key, position]))
  const counts = new Array(keys.length).fill(0)
  for (const row of rows) {
    const value = at(row)
    if (!value) continue
    let key: string
    try {
      key = bucketKey(value, bucket, timeZone)
    } catch {
      continue
    }
    const position = index.get(key)
    if (position !== undefined) counts[position] += 1
  }
  return counts
}

/** Distinct users per bucket: the same person twice in a day counts once. */
export function distinctByBucket<T>(
  rows: readonly T[],
  at: (row: T) => string | null | undefined,
  who: (row: T) => string | null | undefined,
  keys: readonly string[],
  bucket: Bucket,
  timeZone?: string
): number[] {
  const index = new Map(keys.map((key, position) => [key, position]))
  const seen: Set<string>[] = keys.map(() => new Set())
  for (const row of rows) {
    const value = at(row)
    const id = who(row)
    if (!value || !id) continue
    let key: string
    try {
      key = bucketKey(value, bucket, timeZone)
    } catch {
      continue
    }
    const position = index.get(key)
    if (position !== undefined) seen[position].add(id)
  }
  return seen.map((set) => set.size)
}

/** A running total, for the cumulative line beside a bar series. */
export function cumulative(values: readonly number[], startingAt = 0): number[] {
  let total = startingAt
  return values.map((value) => (total += value))
}

/** Counts per key, with nulls collected under a stated label. */
export function countBy<T>(
  rows: readonly T[],
  key: (row: T) => string | null | undefined,
  nullLabel = '(not recorded)'
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const value = key(row)
    const label = value === null || value === undefined || value === '' ? nullLabel : value
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return counts
}

/** Distinct values, ignoring blanks. */
export function distinctSet<T>(rows: readonly T[], key: (row: T) => string | null | undefined): Set<string> {
  const found = new Set<string>()
  for (const row of rows) {
    const value = key(row)
    if (value) found.add(value)
  }
  return found
}

/** A percentage, or null when the denominator cannot support one. */
export function percent(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null
  return (part / whole) * 100
}

/** Mean of the values that exist. Null when there are none. */
export function mean(values: readonly (number | null | undefined)[]): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (numbers.length === 0) return null
  return numbers.reduce((total, value) => total + value, 0) / numbers.length
}

/**
 * Sorted counts for a breakdown, largest first, with a stable tie-break so the
 * same data always draws the same order.
 */
export function rank(counts: Map<string, number>): { key: string; value: number }[] {
  return [...counts.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
}

/**
 * The earliest timestamp in a set of rows, as a calendar-agnostic ISO string.
 * Used to state when a source actually starts rather than assuming a date.
 */
export function earliest<T>(rows: readonly T[], at: (row: T) => string | null | undefined): string | null {
  let best: number | null = null
  for (const row of rows) {
    const value = at(row)
    if (!value) continue
    const time = Date.parse(value)
    if (Number.isNaN(time)) continue
    if (best === null || time < best) best = time
  }
  return best === null ? null : new Date(best).toISOString()
}
