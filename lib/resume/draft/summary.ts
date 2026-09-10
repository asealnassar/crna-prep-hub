/**
 * What the dashboard shows about a resume, and how it phrases it.
 *
 * The list response deliberately carries no section content -- a dashboard has
 * no reason to ship an applicant's employment history to render a card. These
 * are the only fields the route returns and the only ones the cards read.
 *
 * The display rules live here rather than inside JSX so "lists drafts and
 * complete resumes with template and last-edited" is something tests can check.
 */

import type { ResumeStatus, ResumeTemplate } from '../model/types.ts'

export interface ResumeSummary {
  readonly id: string
  readonly title: string
  readonly status: ResumeStatus
  readonly template: ResumeTemplate | string
  /** The revision the server holds. A write must name it. */
  readonly revision: number
  readonly updatedAt: string
  readonly createdAt: string
}

/**
 * Blueprint decision 8: the applicant marks a resume complete themselves.
 * Nothing infers it, so these labels describe a choice rather than a guess.
 */
export function statusLabel(status: ResumeStatus): string {
  return status === 'complete' ? 'Complete' : 'Draft'
}

/** The word on the button that would flip it. */
export function statusToggleLabel(status: ResumeStatus): string {
  return status === 'complete' ? 'Mark as draft' : 'Mark as complete'
}

export function nextStatus(status: ResumeStatus): ResumeStatus {
  return status === 'complete' ? 'draft' : 'complete'
}

/** Title-cases the stored template id for display. Unknown ids pass through. */
export function templateLabel(template: string): string {
  if (!template) return 'No template'
  return template.charAt(0).toUpperCase() + template.slice(1).replace(/[-_]/g, ' ')
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "Edited 5 minutes ago", falling back to a date once it stops being useful.
 *
 * An unparseable or missing timestamp returns a neutral phrase rather than
 * "Invalid Date" -- V1's dashboard rendered exactly that for rows whose
 * updated_at was never maintained.
 */
export function lastEditedLabel(updatedAt: string | null | undefined, now: number): string {
  if (!updatedAt) return 'Never edited'
  const then = Date.parse(updatedAt)
  if (Number.isNaN(then)) return 'Never edited'

  const delta = now - then
  if (delta < 0) return 'Edited just now'
  if (delta < MINUTE) return 'Edited just now'
  if (delta < HOUR) {
    const mins = Math.floor(delta / MINUTE)
    return `Edited ${mins} minute${mins === 1 ? '' : 's'} ago`
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR)
    return `Edited ${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  if (delta < 7 * DAY) {
    const days = Math.floor(delta / DAY)
    return `Edited ${days} day${days === 1 ? '' : 's'} ago`
  }
  return `Edited ${new Date(then).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })}`
}

/** Most recently edited first; ties broken by id so the order never flickers. */
export function sortForDashboard(list: readonly ResumeSummary[]): ResumeSummary[] {
  return [...list].sort((a, b) => {
    const at = Date.parse(a.updatedAt)
    const bt = Date.parse(b.updatedAt)
    const av = Number.isNaN(at) ? 0 : at
    const bv = Number.isNaN(bt) ? 0 : bt
    if (av !== bv) return bv - av
    return a.id.localeCompare(b.id)
  })
}

/**
 * Drafts and complete resumes, each already sorted. Both lists are returned
 * even when empty, so the dashboard renders a stable shape.
 */
export function groupByStatus(list: readonly ResumeSummary[]): {
  readonly drafts: ResumeSummary[]
  readonly complete: ResumeSummary[]
} {
  const sorted = sortForDashboard(list)
  return {
    drafts: sorted.filter((r) => r.status !== 'complete'),
    complete: sorted.filter((r) => r.status === 'complete'),
  }
}
