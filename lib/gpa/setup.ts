/**
 * Presentation layer for the post-import setup state.
 *
 * This module makes NO eligibility decisions. Every count it works from is
 * handed in already computed by the engine and the existing helpers, so the
 * rules about what counts toward a GPA live in exactly one place, as before.
 * All this does is group what is already true into three buckets the interface
 * can present calmly:
 *
 *   required       - blocks calculation, and the user can resolve it
 *   review         - excluded, resolvable per course, not an emergency
 *   informational  - excluded by a rule, nothing to resolve
 *
 * The page used to render each of those as its own full-width amber panel, so
 * one unset credit system produced four boxes that all said the same thing.
 */

import type { Course, CourseIssue, GpaPolicies, Institution } from './types.ts'

export type RequiredKind =
  | 'no-institution' | 'credit-system' | 'transfer-policy' | 'retake-policy'
  /** D50: a transfer relationship the GPA genuinely depends on. */
  | 'transfer-link'

export interface RequiredItem {
  kind: RequiredKind
  /** Courses held out by this item. */
  count: number
  institutionId?: string
  institutionName?: string
}

export interface ReviewItem {
  courseId: string
  courseName: string
  /** Two or three words, for the first level of the interface. */
  label: string
  /** The full sentence, kept for progressive disclosure. */
  detail: string
}

export interface InformationalItem {
  label: string
  detail: string
}

/**
 * D50: a transfer notation whose originating coursework is not established.
 *
 * Kept out of `required` on purpose. Nothing is blocked by it -- the notation
 * itself never counts under any policy, and the coursework it might refer to is
 * already being counted as ordinary coursework. It is a confirmation, not a
 * decision the calculation is waiting on, and calling it required would claim
 * more than the evidence supports.
 */
export interface TransferConfirmItem {
  notationId: string
  /** How many courses here the user could actually choose between. */
  candidateCount: number
  /** D50: required when coursework in this analysis hangs on the answer. */
  severity: 'required' | 'optional'
  courseName: string
  courseCode: string | null
  credits: number
  /** The grade as printed on the transfer record. Blank stays blank. */
  grade: string
  /** The school the notation says the credit came from, when it printed one. */
  fromName: string | null
  /** The school whose transcript printed the record. */
  receivingName: string | null
  label: string
  detail: string
}

/**
 * D53: optional transfer records, gathered by the school they came from.
 *
 * Ten records that all say the same thing -- "the transcript this came from is
 * not in this analysis" -- are one fact about one school, not ten problems.
 * Nothing here is withheld, blocked, or waiting on the user; the group exists
 * so the interface can say it once.
 */
/**
 * D57: quarter-credit coursework, gathered by the school it came from.
 *
 * Thirty-six courses excluded because their school uses quarter credits is one
 * fact about one school, not thirty-six problems. Nothing about these courses
 * is wrong and nothing about them can be fixed by editing them -- the analyzer
 * calculates on semester credits, and D5 says quarter credit is preserved and
 * never converted. So the interface says that once, and offers the list.
 */
export interface QuarterGroup {
  institutionId: string | null
  institutionName: string | null
  courses: {
    courseId: string
    courseCode: string | null
    courseName: string
    credits: number
    grade: string
  }[]
}

export interface TransferGroup {
  /** Stable key for rendering: the origin name, or a marker for none. */
  key: string
  originName: string | null
  records: TransferConfirmItem[]
}

export interface SetupState {
  required: RequiredItem[]
  review: ReviewItem[]
  informational: InformationalItem[]
  /** D50: transfer records the user still needs to confirm. */
  transferConfirms: TransferConfirmItem[]
  /** D53: the optional ones, grouped by originating school. */
  transferGroups: TransferGroup[]
  /** D57: quarter-credit coursework, grouped by school. Informational only. */
  quarterGroups: QuarterGroup[]
  /** True when something the user can fix is stopping the calculation. */
  blocked: boolean
}

/**
 * Short labels for the review list. The detail sentence stays available; this
 * is only what shows before the user asks for more.
 */
export function reviewLabel(issue: CourseIssue, course: Course | undefined): string {
  switch (issue.reason) {
    case 'unrecognized-grade':
      // A blank grade means the transcript printed none, which is a different
      // thing from a grade we could not understand.
      return String(course?.grade ?? '').trim() === '' ? 'No grade found' : 'Grade not recognized'
    case 'invalid-credits': return 'Credits need checking'
    case 'ambiguous-retake': return 'Repeat needs review'
    case 'grade-not-in-scale': return 'Grade not in school’s scale'
    case 'no-institution': return 'No school assigned'
    case 'credit-system-unknown': return 'School credit system not set'
    case 'unsupported-credit-system': return 'Quarter credits'
    case 'transfer-policy-unset': return 'Transfer policy not chosen'
    case 'retake-policy-unset': return 'Repeat policy not chosen'
    default: return 'Needs review'
  }
}

/** Items already represented by a required setup row, so they are not listed twice. */
const COVERED_BY_REQUIRED = new Set([
  'no-institution', 'credit-system-unknown', 'transfer-policy-unset', 'retake-policy-unset',
  // D57: quarter-credit coursework has its own section, which explains that
  // there is nothing to fix. Listing it as a course that "needs review" said
  // the opposite of what is true.
  'unsupported-credit-system',
])

export function deriveSetupState(input: {
  courses: readonly Course[]
  institutions: readonly Institution[]
  policies: GpaPolicies
  /** Counts produced by the engine / existing helpers. Never recomputed here. */
  unassignedCount: number
  transferUnset: number
  retakeUnresolved: number
  quarterExcluded: number
  issues: readonly CourseIssue[]
  /** D50: transfer relationships to confirm, already classified. */
  unresolvedTransfers?: readonly {
    notationId: string
    reason: string
    severity?: 'required' | 'optional'
    candidates?: readonly unknown[]
  }[]
}): SetupState {
  const {
    courses, institutions, policies,
    unassignedCount, transferUnset, retakeUnresolved, quarterExcluded, issues,
  } = input

  const required: RequiredItem[] = []

  if (unassignedCount > 0) {
    required.push({ kind: 'no-institution', count: unassignedCount })
  }

  // One row per school, so the fix sits next to the name it belongs to.
  for (const inst of institutions) {
    if (inst.creditSystem !== 'unknown') continue
    const count = courses.filter(c => c.institutionId === inst.id).length
    if (count === 0) continue
    required.push({
      kind: 'credit-system', count,
      institutionId: inst.id, institutionName: inst.name,
    })
  }

  if (policies.transfer === null && transferUnset > 0) {
    required.push({ kind: 'transfer-policy', count: transferUnset })
  }
  if (policies.retake === null && retakeUnresolved > 0) {
    required.push({ kind: 'retake-policy', count: retakeUnresolved })
  }

  const byId = new Map(courses.map(c => [c.id, c]))
  const review: ReviewItem[] = issues
    .filter(i => !COVERED_BY_REQUIRED.has(i.reason))
    .map(i => ({
      courseId: i.courseId,
      courseName: i.courseName,
      label: reviewLabel(i, byId.get(i.courseId)),
      detail: i.detail,
    }))

  // D57: one section per quarter-credit school, in place of the per-course
  // review rows. The count still comes from the engine; this only groups it.
  const quarterGroups = quarterExcluded > 0
    ? groupQuarterCoursework(courses, institutions)
    : []

  const informational: InformationalItem[] = []
  // A message is owed whenever coursework was excluded for this reason. The
  // grouped section covers it when the schools are known; this keeps the
  // explanation from disappearing entirely if they are not.
  if (quarterExcluded > 0 && quarterGroups.length === 0) {
    informational.push({
      label: `${quarterExcluded} course${quarterExcluded === 1 ? '' : 's'} on quarter credits`,
      detail: 'CRNAPREPHUB currently calculates GPA using semester-credit coursework only, so these '
        + 'are preserved but not included in GPA calculations. We do not automatically convert '
        + 'quarter credits.',
    })
  }

  const byIdAll = new Map(courses.map(c => [c.id, c]))
  const transferConfirms: TransferConfirmItem[] = (input.unresolvedTransfers ?? [])
    .map(u => {
      const n = byIdAll.get(u.notationId)
      if (!n) return null
      return {
        notationId: u.notationId,
        severity: u.severity ?? 'optional',
        candidateCount: u.candidates?.length ?? 0,
        courseName: n.name || 'Untitled course',
        courseCode: n.courseCode ?? null,
        credits: n.credits,
        grade: n.grade ?? '',
        fromName: n.transferredFromName ?? null,
        receivingName: institutions.find(i => i.id === n.institutionId)?.name ?? null,
        label: transferConfirmLabel(u.reason),
        detail: transferConfirmDetail(u.reason, n.transferredFromName ?? null),
      }
    })
    .filter(Boolean) as TransferConfirmItem[]

  // D50: only the ones the calculation actually waits on are counted as
  // required. A notation whose originating transcript simply is not here has
  // nothing for the engine to govern, so it is a note, not a blocker.
  const requiredTransfers = transferConfirms.filter(t => t.severity === 'required').length
  if (requiredTransfers > 0) {
    required.push({ kind: 'transfer-link', count: requiredTransfers })
  }

  return {
    required, review, informational, transferConfirms,
    transferGroups: groupTransferRecords(transferConfirms.filter(t => t.severity === 'optional')),
    quarterGroups,
    blocked: required.length > 0,
  }
}

/**
 * Groups quarter-credit coursework by school.
 *
 * Uses exactly the condition the engine excludes on -- the institution's own
 * credit system -- so the section can never describe a different set of
 * courses from the one being left out.
 */
export function groupQuarterCoursework(
  courses: readonly Course[], institutions: readonly Institution[],
): QuarterGroup[] {
  const quarter = new Set(
    institutions.filter(i => i.creditSystem === 'quarter').map(i => i.id))
  if (quarter.size === 0) return []

  const groups = new Map<string, QuarterGroup>()
  for (const c of courses) {
    if (c.recordType === 'transfer_notation') continue
    if (!c.institutionId || !quarter.has(c.institutionId)) continue
    const key = c.institutionId
    const group = groups.get(key) ?? {
      institutionId: c.institutionId,
      institutionName: institutions.find(i => i.id === c.institutionId)?.name ?? null,
      courses: [],
    }
    group.courses.push({
      courseId: c.id,
      courseCode: c.courseCode ?? null,
      courseName: c.name || 'Untitled course',
      credits: c.credits,
      grade: c.grade,
    })
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** The heading for one quarter-credit school. A fact, not a fault. */
export function quarterGroupTitle(): string {
  return 'Quarter-credit coursework detected'
}

/** What the section says, once, instead of once per course. */
export function quarterGroupDetail(group: QuarterGroup): string {
  const school = group.institutionName ?? 'This school'
  const n = group.courses.length
  return `${school} uses quarter credits. CRNAPREPHUB currently calculates GPA using `
    + `semester-credit coursework only, so ${n} course${n === 1 ? ' is' : 's are'} preserved but `
    + `not included in GPA calculations. We do not automatically convert quarter credits.`
}

const UNKNOWN_ORIGIN = '__unknown-origin__'

/**
 * Groups optional records by the school they came from.
 *
 * Separately per school, never one vague bucket: "records from Pine Valley"
 * and "records from Hudson County" are different facts, and a record whose
 * transcript never named a school is a third.
 */
export function groupTransferRecords(items: readonly TransferConfirmItem[]): TransferGroup[] {
  const byOrigin = new Map<string, TransferGroup>()
  for (const item of items) {
    const name = item.fromName?.trim() || null
    const key = name ? name.toLowerCase() : UNKNOWN_ORIGIN
    const existing = byOrigin.get(key)
    if (existing) existing.records.push(item)
    else byOrigin.set(key, { key, originName: name, records: [item] })
  }
  // Named schools first, in the order they appear; unknown origin last.
  return [...byOrigin.values()].sort((a, b) =>
    Number(a.key === UNKNOWN_ORIGIN) - Number(b.key === UNKNOWN_ORIGIN))
}

/** The heading for one group. A statement, not a problem. */
export function transferGroupTitle(group: TransferGroup): string {
  return group.originName
    ? `Transfer records from ${group.originName}`
    : 'Transfer records with unknown originating school'
}

/** What the group says, once, instead of once per record. */
export function transferGroupDetail(group: TransferGroup): string {
  const base = group.originName
    ? 'The originating transcript is not part of this analysis.'
    : 'These records do not name the school the credit came from.'
  return `${base} These records do not affect your GPA. Add or combine that transcript if you `
    + 'want CRNAPREPHUB to match the original coursework.'
}

/**
 * What the setup card calls itself.
 *
 * An analysis whose only remaining note is a set of transfer records nobody has
 * to act on should not be introduced as things to review -- nothing is wrong
 * with it, and nothing is waiting.
 */
export function setupHeading(state: SetupState): string {
  if (state.blocked) return 'Almost ready'
  if (state.review.length === 0 && state.informational.length === 0) {
    const hasTransfers = state.transferGroups.length > 0
    const hasQuarter = state.quarterGroups.length > 0
    if (hasTransfers && hasQuarter) return 'Transfer records and quarter credits'
    if (hasTransfers) return 'Transfer records'
    if (hasQuarter) return 'Quarter-credit coursework'
  }
  return 'A few things to review'
}

/** Short label for one unconfirmed transfer record. */
export function transferConfirmLabel(reason: string): string {
  switch (reason) {
    case 'stale': return 'Transfer link needs review'
    case 'origin-unknown': return 'No school named'
    case 'origin-not-in-analysis': return 'School not in this analysis'
    case 'no-code': return 'No course code printed'
    case 'ambiguous': return 'More than one match'
    default: return 'No match found'
  }
}

/** The sentence, which always says what was actually observed. */
export function transferConfirmDetail(reason: string, fromName: string | null): string {
  const from = fromName ? `“${fromName}”` : 'the originating school'
  switch (reason) {
    case 'stale':
      return 'The course this transfer record was linked to has been edited, and its course code or '
        + 'credits no longer match. That course is held out of your GPA until you confirm which '
        + 'course the record represents, or say it is not in this analysis.'
    case 'origin-unknown':
      return 'This transfer record does not name the school the credit came from, so we cannot tell '
        + 'which of your coursework it represents. Choose it yourself, or say it is not here.'
    case 'origin-not-in-analysis':
      return `This transfer record came from ${from}, which is not part of this analysis. Add that `
        + 'transcript, choose the matching coursework yourself, or say it is not here.'
    case 'no-code':
      return 'This transfer record prints no course code, so it cannot be matched automatically.'
    case 'ambiguous':
      return `More than one course at ${from} matches this record's code and credits, so we will not `
        + 'guess which attempt it documents.'
    default:
      return `No course at ${from} matches this record's code and credits. The coursework may not be `
        + 'in this analysis, or it may be printed differently.'
  }
}

/** Sentence for the setup card header. Counts, not adjectives. */
export function setupSummary(state: SetupState, courseCount: number): string {
  const n = state.required.length
  const imported = `${courseCount} course${courseCount === 1 ? '' : 's'} in this analysis`
  if (n === 0) return imported
  return `${imported}. Complete ${n} required item${n === 1 ? '' : 's'} to calculate your GPA.`
}
