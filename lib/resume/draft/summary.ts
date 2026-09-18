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
  /**
   * How many pages the resume exports to, when the caller knows.
   *
   * OPTIONAL BECAUSE IT IS NOT DERIVABLE HERE. A page count comes from a
   * rendered document and a Strength score from the scorer; the list response
   * carries neither today. A card shows each one only when it is there, and
   * nothing below infers either -- "2 pages" on a resume nobody measured would
   * be a guess presented as a fact.
   */
  readonly pages?: number | null
  /** The stored Resume Strength headline, 0-100, when the caller knows it. */
  readonly strength?: number | null
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

/** "2 pages", or nothing at all when the page count is not known. */
export function pageCountLabel(pages: number | null | undefined): string | null {
  if (typeof pages !== 'number' || !Number.isFinite(pages)) return null
  const whole = Math.round(pages)
  if (whole < 1) return null
  return `${whole} page${whole === 1 ? '' : 's'}`
}

/**
 * The one line under a card's title: "Modern · 2 pages · Edited 9 minutes ago".
 *
 * Facts only, in a fixed order. A piece the summary does not carry is left out
 * rather than filled in, so the line shortens instead of lying.
 */
export function dashboardMeta(resume: ResumeSummary, now: number): string[] {
  return [
    templateLabel(String(resume.template)),
    pageCountLabel(resume.pages),
    lastEditedLabel(resume.updatedAt, now),
  ].filter((part): part is string => part !== null && part !== '')
}

/** The Strength headline as a card shows it, or nothing when there is none. */
export function strengthLabel(strength: number | null | undefined): string | null {
  if (typeof strength !== 'number' || !Number.isFinite(strength)) return null
  return `Strength ${Math.round(strength)}`
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

/** How the dashboard may order a group. Last edited is what it has always done. */
export const RESUME_SORTS = [
  { key: 'edited', label: 'Last edited' },
  { key: 'title', label: 'Title' },
] as const
export type ResumeSort = (typeof RESUME_SORTS)[number]['key']

/**
 * The list in the applicant's chosen order.
 *
 * Titles compare case-insensitively and fall back to the last-edited order, so
 * two resumes called "Duke" keep a stable, explainable position.
 */
export function sortResumes(list: readonly ResumeSummary[], sort: ResumeSort = 'edited'): ResumeSummary[] {
  const byDate = sortForDashboard(list)
  if (sort !== 'title') return byDate
  return byDate.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
}

/**
 * Drafts and complete resumes, each already sorted. Both lists are returned
 * even when empty, so the dashboard renders a stable shape.
 */
export function groupByStatus(list: readonly ResumeSummary[], sort: ResumeSort = 'edited'): {
  readonly drafts: ResumeSummary[]
  readonly complete: ResumeSummary[]
} {
  const sorted = sortResumes(list, sort)
  return {
    drafts: sorted.filter((r) => r.status !== 'complete'),
    complete: sorted.filter((r) => r.status === 'complete'),
  }
}
