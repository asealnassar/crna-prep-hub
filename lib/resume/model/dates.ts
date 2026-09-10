/**
 * Legacy-safe dates.
 *
 * V1 stored every date as a bare string and handed it straight to
 * `new Date(...)`, which is why `Invalid Date` reached printed PDFs and why a
 * missing end date produced `NaN` years of experience. That is not an edge
 * case in this data: Phase 0 measured empty or unparseable values on 9 of 41
 * ICU start dates, 9 of 41 end dates, and 6 of 17 graduation dates -- roughly
 * a fifth of positions and a third of degrees.
 *
 * So a date here is one of three things, and the third is a first-class state
 * rather than a failure:
 *
 *   absent    -- nothing was entered
 *   exact     -- a real calendar date, to month or day precision
 *   unparsed  -- something was entered that is not a date, KEPT VERBATIM
 *
 * `unparsed` is the whole point. The raw text survives so the applicant can be
 * shown what they typed and asked to fix it. Nothing here corrects, guesses or
 * discards a value, and no function in this file can produce an Invalid Date
 * or a NaN.
 */

/** Month precision is enough for a resume; day precision is kept when given. */
export type ResumeDate =
  | { readonly kind: 'absent' }
  | { readonly kind: 'exact'; readonly year: number; readonly month: number; readonly day: number | null; readonly raw: string }
  | { readonly kind: 'unparsed'; readonly raw: string }

export const ABSENT_DATE: ResumeDate = { kind: 'absent' }

/**
 * A start/end pair. `isCurrent` is stored rather than inferred from a missing
 * end date, because "still here" and "never filled it in" are different facts
 * and V1 conflated them.
 */
export interface ResumeDateRange {
  readonly start: ResumeDate
  readonly end: ResumeDate
  readonly isCurrent: boolean
}

export const EMPTY_RANGE: ResumeDateRange = {
  start: ABSENT_DATE,
  end: ABSENT_DATE,
  isCurrent: false,
}

/** ISO-ish inputs only. Deliberately NOT `new Date(s)`, which accepts almost
 *  anything and silently reinterprets it by locale. */
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/
const YM = /^(\d{4})-(\d{2})$/

/** True calendar validity, so 2024-02-30 and 2023-13-01 are rejected. */
function isRealDate(year: number, month: number, day: number | null): boolean {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (day === null) return true
  if (!Number.isInteger(day) || day < 1) return false
  // Day 0 of the next month is the last day of this one.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Reads whatever V1 stored. Never throws, never returns Invalid Date.
 *
 * Anything that is not recognisably a date -- "Spring 2019", "n/a", "05/2019",
 * a stray word -- becomes `unparsed` with its text intact. Recognising more
 * formats later is a safe, additive change; guessing at them now is not.
 */
export function parseResumeDate(input: unknown): ResumeDate {
  if (typeof input !== 'string') return ABSENT_DATE
  const raw = input.trim()
  if (raw === '') return ABSENT_DATE

  const ymd = YMD.exec(raw)
  if (ymd) {
    const [, y, m, d] = ymd
    const year = Number(y), month = Number(m), day = Number(d)
    if (isRealDate(year, month, day)) return { kind: 'exact', year, month, day, raw }
    return { kind: 'unparsed', raw }
  }

  const ym = YM.exec(raw)
  if (ym) {
    const [, y, m] = ym
    const year = Number(y), month = Number(m)
    if (isRealDate(year, month, null)) return { kind: 'exact', year, month, day: null, raw }
    return { kind: 'unparsed', raw }
  }

  return { kind: 'unparsed', raw }
}

export function parseResumeDateRange(input: {
  start?: unknown
  end?: unknown
  isCurrent?: unknown
}): ResumeDateRange {
  return {
    start: parseResumeDate(input.start),
    end: input.isCurrent === true ? ABSENT_DATE : parseResumeDate(input.end),
    isCurrent: input.isCurrent === true,
  }
}

/** True only for a date we can actually reason about. */
export function isUsableDate(d: ResumeDate): d is Extract<ResumeDate, { kind: 'exact' }> {
  return d.kind === 'exact'
}

/** What the applicant typed, for showing back to them. Empty when absent. */
export function rawDateText(d: ResumeDate): string {
  return d.kind === 'absent' ? '' : d.raw
}

/** Months since year zero -- an ordering key, not a duration. */
function ordinal(d: Extract<ResumeDate, { kind: 'exact' }>): number {
  return d.year * 12 + (d.month - 1)
}

/**
 * Ordering of two dates, or null when either is not exact.
 *
 * Returning null rather than a number is what stops an unparseable date from
 * silently sorting as if it were January 1970.
 */
export function compareResumeDates(a: ResumeDate, b: ResumeDate): number | null {
  if (!isUsableDate(a) || !isUsableDate(b)) return null
  const byMonth = ordinal(a) - ordinal(b)
  if (byMonth !== 0) return byMonth
  return (a.day ?? 0) - (b.day ?? 0)
}

/**
 * Whether a range is coherent. `indeterminate` is not a failure -- it means
 * one end is absent or unparsed, so the question cannot be answered yet.
 *
 * Note this reports the state; it does not decide what the product does about
 * it. Whether an end-before-start range blocks a save is a rule for later.
 */
export type RangeOrder = 'ok' | 'end-before-start' | 'indeterminate'

export function rangeOrder(range: ResumeDateRange): RangeOrder {
  if (range.isCurrent) return isUsableDate(range.start) ? 'ok' : 'indeterminate'
  const cmp = compareResumeDates(range.start, range.end)
  if (cmp === null) return 'indeterminate'
  return cmp <= 0 ? 'ok' : 'end-before-start'
}

/**
 * Whole months covered, or null when it cannot be known.
 *
 * The null is the point. V1 computed years of experience from raw strings and
 * fed the result into an AI prompt, so a bad date produced a confidently wrong
 * claim about someone's career. A caller here has to handle "unknown".
 *
 * `asOf` is passed in rather than read from the clock so the result is
 * deterministic and testable.
 */
export function monthsInRange(range: ResumeDateRange, asOf: ResumeDate): number | null {
  if (!isUsableDate(range.start)) return null
  const end = range.isCurrent ? asOf : range.end
  if (!isUsableDate(end)) return null
  const months = ordinal(end) - ordinal(start(range))
  return months < 0 ? null : months
}

function start(range: ResumeDateRange): Extract<ResumeDate, { kind: 'exact' }> {
  // Guarded by the isUsableDate check in every caller.
  return range.start as Extract<ResumeDate, { kind: 'exact' }>
}

/** Convenience for building an `asOf` from a real clock at the call site. */
export function resumeDateFromParts(year: number, month: number, day: number | null = null): ResumeDate {
  if (!isRealDate(year, month, day)) {
    return { kind: 'unparsed', raw: `${year}-${String(month).padStart(2, '0')}` }
  }
  const raw = day === null
    ? `${year}-${String(month).padStart(2, '0')}`
    : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { kind: 'exact', year, month, day, raw }
}
