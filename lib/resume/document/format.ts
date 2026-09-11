/**
 * Turning canonical values into the strings a resume prints.
 *
 * Pure and display-only. Nothing here parses, validates or decides what may be
 * shown -- `formatGpa` is the one function that can withhold a value, and it
 * does so by reading the flag the model already carries.
 *
 * Every function returns '' rather than a placeholder for a value that is not
 * there, so a presenter can filter on emptiness and never print "undefined",
 * "Invalid Date" or a stray separator. V1's preview printed all three.
 */

import type { GpaValue, ResumeContact } from '../model/types.ts'
import type { ResumeDate, ResumeDateRange } from '../model/dates.ts'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** En dash with hair spaces: what typesetting a date range looks like. */
export const RANGE_SEPARATOR = ' – '

/**
 * "Mar 2024". An unparsed date prints exactly what the applicant typed --
 * "Spring 2024" is a real thing people write and is better than nothing.
 */
export function formatResumeDate(date: ResumeDate): string {
  if (date.kind === 'absent') return ''
  if (date.kind === 'unparsed') return date.raw.trim()
  const month = MONTHS[date.month - 1]
  return month ? `${month} ${date.year}` : String(date.year)
}

/**
 * "Mar 2021 – Present", "Mar 2021 – Jun 2023", or just "Mar 2021".
 *
 * `isCurrent` is honoured over a missing end date, because the model stores
 * "still here" and "never filled it in" separately and they read differently.
 */
export function formatDateRange(range: ResumeDateRange): string {
  const start = formatResumeDate(range.start)
  const end = range.isCurrent ? 'Present' : formatResumeDate(range.end)
  if (start && end) return `${start}${RANGE_SEPARATOR}${end}`
  if (start) return start
  if (end) return end
  return ''
}

/**
 * "GPA 3.85", or nothing at all.
 *
 * Returns '' unless the applicant chose to show it. The raw text is printed
 * rather than the parsed number, so "3.4/4.0" and "3.85 (major)" survive.
 */
export function formatGpa(gpa: GpaValue, label = 'GPA'): string {
  if (!gpa.showOnResume) return ''
  const raw = gpa.raw.trim()
  if (raw === '') return ''
  return `${label} ${raw}`
}

/** "Newark, NJ" — and never a dangling comma when one half is missing. */
export function formatLocation(city: string, state: string): string {
  return join([city, state], ', ')
}

/** "Jane Doe, BSN, RN, CCRN" */
export function formatName(contact: ResumeContact): string {
  return join([contact.fullName, contact.credentials], ', ')
}

/**
 * The contact pieces, in the order they read, with the blanks removed. Returned
 * as an array so a template can choose its own separator -- or wrap them.
 */
export function contactPieces(contact: ResumeContact): string[] {
  return [
    contact.email,
    contact.phone,
    formatLocation(contact.city, contact.state),
    contact.linkedin,
    contact.website,
  ]
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
}

/** Joins the non-empty parts. The reason no presenter builds strings by hand. */
export function join(parts: readonly (string | null | undefined)[], separator: string): string {
  return parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(separator)
}

/** Splits authored prose into paragraphs, dropping blank runs. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s*\n\s*/g, ' ').trim())
    .filter((block) => block !== '')
}
