/**
 * GPA Analyzer V2 — calculation engine.
 *
 * Pipeline, in order. Order matters: a transfer-notation row must be dropped
 * before retake grouping, or it would look like a second attempt.
 *
 *   1. drop transfer_notation rows          (always, any policy)
 *   2. drop quarter-credit coursework       (D5: flag, never convert)
 *   3. apply transfer policy                (D1)
 *   4. classify grade / validate credits
 *   5. apply retake policy                  (D7, conservative)
 *   6. apply the GPA-type filter            (incl. whole-term Last 60, D8)
 */

import {
  STANDARD_SCALE, RECOGNIZED_LETTER_GRADES, NON_GPA_GRADES, TERM_ORDER,
  LAST_60_CREDIT_WINDOW,
  DEFAULT_POLICIES,
  type Course, type Institution, type GpaPolicies, type GpaFilter,
  type GpaResult, type CourseIssue, type ExclusionReason, type IssueReason,
  type GradingScale,
} from './types.ts'
import { coursesAwaitingLinkReview } from './transferLinks.ts'

export type GradeKind = 'graded' | 'excluded' | 'unrecognized'

export function normalizeGrade(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

/**
 * Is this a real letter grade at all? Deliberately independent of any
 * institution's scale (D40) -- "recognised" and "scorable" are different
 * questions and conflating them is what would let a missing A- silently
 * borrow the standard 3.7.
 */
export function classifyGrade(raw: unknown): GradeKind {
  const g = normalizeGrade(raw)
  if (g === '') return 'unrecognized'
  if (RECOGNIZED_LETTER_GRADES.has(g)) return 'graded'
  if (NON_GPA_GRADES.has(g)) return 'excluded'
  return 'unrecognized'
}

/**
 * D38: the effective scale for an institution. null/absent -> the standard
 * fallback, marked unconfirmed so D39 can surface the assumption.
 */
export function effectiveScale(
  institutionId: string | null | undefined,
  institutions: readonly Institution[] | undefined
): GradingScale {
  if (!institutionId || !institutions) return STANDARD_SCALE
  return institutions.find(i => i.id === institutionId)?.gradingScale ?? STANDARD_SCALE
}

/**
 * THE single grade -> quality-points resolver. Every GPA type routes through
 * it, so no card can develop its own scale logic.
 *
 * Returns null when the grade is recognised but the institution's scale does
 * not define it (D40). Never falls back to the standard points in that case.
 */
export function resolveGradePoints(
  grade: unknown,
  institutionId: string | null | undefined,
  institutions: readonly Institution[] | undefined
): number | null {
  const g = normalizeGrade(grade)
  const scale = effectiveScale(institutionId, institutions)
  const pts = scale.points[g]
  return typeof pts === 'number' && Number.isFinite(pts) ? pts : null
}

export function normalizeCredits(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').trim())
  if (!Number.isFinite(n)) return null
  if (n < 0 || n > 24) return null
  return n
}

/** "BIO 101", "bio-101" and "Bio101" are the same code. */
export function normalizeCourseCode(raw: unknown): string | null {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s.length >= 3 ? s : null
}

export function yearOf(c: Course): number {
  const y = parseInt(String(c.year ?? '').trim().slice(0, 4), 10)
  return Number.isFinite(y) ? y : -Infinity
}

export function termRankOf(c: Course): number {
  return TERM_ORDER[String(c.term ?? '').trim().toUpperCase()] ?? -1
}

/** Stable identity for an academic term. Undated coursework shares one bucket. */
export function termKeyOf(c: Course): string {
  const y = yearOf(c)
  return y === -Infinity ? 'undated' : `${y}|${termRankOf(c)}`
}

/** Newest-first comparator over terms. Undated sorts oldest. */
function compareTermsDesc(a: string, b: string): number {
  if (a === b) return 0
  if (a === 'undated') return 1
  if (b === 'undated') return -1
  const [ay, at] = a.split('|').map(Number)
  const [by, bt] = b.split('|').map(Number)
  return by - ay || bt - at
}

export interface EngineContext {
  institutions?: readonly Institution[]
  policies?: GpaPolicies
}

function creditSystemOf(c: Course, institutions?: readonly Institution[]): string | null {
  if (!c.institutionId) return null
  const inst = institutions?.find(i => i.id === c.institutionId)
  return inst ? inst.creditSystem : null
}

export interface Eligibility {
  eligible: boolean
  reason?: ExclusionReason
  /** Set when the user must act before this course can ever count. */
  issue?: { reason: IssueReason; detail: string }
}

/**
 * THE single eligibility gate. Every GPA type routes through this, including
 * the Last-60 term grouping, so a course can never be blocked from one GPA
 * while quietly entering another.
 *
 * Order is deliberate: notation is dropped before anything else looks at it,
 * and credit-system checks precede transfer policy because an unsupported
 * credit system blocks a course under either transfer setting.
 */
export function courseEligibility(
  c: Course,
  institutions: readonly Institution[] | undefined,
  policies: GpaPolicies,
  /** D50: originating courses whose transfer link needs the user's answer. */
  awaitingLinkReview?: ReadonlySet<string>
): Eligibility {
  const name = c.name || 'Untitled course'

  // A receiving school's transfer-credit line duplicates the originating
  // graded attempt. Never GPA-bearing, under any policy (D1/D11).
  if (c.recordType === 'transfer_notation') {
    return { eligible: false, reason: 'transfer-notation' }
  }

  // D15/D16: with no institution there is no known credit system, so we
  // cannot assume semester weighting.
  const system = creditSystemOf(c, institutions)
  if (system === null) {
    return {
      eligible: false,
      reason: 'no-institution',
      issue: {
        reason: 'no-institution',
        detail: `"${name}" is not assigned to a school. Assign it and set that school's credit system before it can count toward your GPA.`,
      },
    }
  }

  // D15: quarter is unsupported. Never converted.
  if (system === 'quarter') {
    return {
      eligible: false,
      reason: 'unsupported-credit-system',
      issue: {
        reason: 'unsupported-credit-system',
        detail: `"${name}" is from a quarter-credit school. Quarter-credit coursework is not currently supported by the GPA Analyzer and is not counted. It is not converted.`,
      },
    }
  }

  // D15: unknown must NOT behave like semester.
  if (system !== 'semester') {
    return {
      eligible: false,
      reason: 'credit-system-unknown',
      issue: {
        reason: 'credit-system-unknown',
        detail: `Select the credit system for the school that "${name}" was taken at before its coursework can be included in your GPA.`,
      },
    }
  }

  // D50: a transfer link that stopped agreeing with this course is a question
  // about the RELATIONSHIP, not about policy. It is answered before Include or
  // Exclude gets a say, because neither answer would be honest yet.
  if (awaitingLinkReview?.has(c.id)) {
    return {
      eligible: false,
      reason: 'transfer-link-review-required',
      issue: {
        reason: 'transfer-link-review-required',
        detail: `"${name}" was linked to a transfer record that no longer matches its course code `
          + `or credits. Confirm which course that record represents, or say it is not in this `
          + `analysis, before it can count.`,
      },
    }
  }

  // D11: transferred coursework needs an explicit user choice first.
  if (c.transferredIn) {
    if (policies.transfer === null) {
      return {
        eligible: false,
        reason: 'transfer-policy-unset',
        issue: {
          reason: 'transfer-policy-unset',
          detail: `"${name}" was transferred in. Choose whether to include or exclude transfer coursework before it can count.`,
        },
      }
    }
    if (policies.transfer === 'exclude') {
      return { eligible: false, reason: 'transfer-policy' }
    }
  }

  return { eligible: true }
}

/**
 * Retake resolution (D7). Deliberately conservative: two courses are attempts
 * at the same course ONLY when they share an institution AND a course code.
 * Similar names are never enough. When attempts cannot be ordered in time, all
 * of them are kept and flagged rather than silently dropping one.
 */
function applyRetakePolicy(
  courses: Course[], policy: GpaPolicies['retake']
): { kept: Course[]; superseded: number; unresolved: number; issues: CourseIssue[] } {
  if (policy === 'both') return { kept: courses, superseded: 0, unresolved: 0, issues: [] }

  const groups = new Map<string, Course[]>()
  const ungrouped: Course[] = []
  for (const c of courses) {
    const code = normalizeCourseCode(c.courseCode)
    if (!code || !c.institutionId) { ungrouped.push(c); continue }
    const key = `${c.institutionId}::${code}`
    const g = groups.get(key)
    if (g) g.push(c); else groups.set(key, [c])
  }

  const kept = [...ungrouped]
  const issues: CourseIssue[] = []
  let superseded = 0
  let unresolved = 0

  // D21: with no policy chosen, courses whose result does NOT depend on the
  // choice pass through untouched. Only confirmed repeat groups are held back,
  // because those are the only ones where the answer would differ.
  if (policy === null) {
    for (const attempts of groups.values()) {
      if (attempts.length === 1) { kept.push(attempts[0]); continue }
      unresolved += attempts.length
      issues.push({
        courseId: attempts[0].id,
        courseName: attempts[0].name || 'Untitled course',
        reason: 'retake-policy-unset',
        detail: `"${attempts[0].name || 'This course'}" has ${attempts.length} attempts. Choose how repeated coursework should be counted before they can be included.`,
      })
    }
    return { kept, superseded: 0, unresolved, issues }
  }

  for (const attempts of groups.values()) {
    if (attempts.length === 1) { kept.push(attempts[0]); continue }
    const ranked = attempts.map(c => ({ c, y: yearOf(c), t: termRankOf(c) }))
    const best = ranked.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.t > a.t)) ? b : a)
    const tiedWithBest = ranked.filter(r => r.y === best.y && r.t === best.t)
    const undatable = ranked.some(r => r.y === -Infinity)

    // Cannot establish which attempt is latest -> keep everything, flag it.
    if (undatable || tiedWithBest.length > 1) {
      for (const r of ranked) kept.push(r.c)
      issues.push({
        courseId: attempts[0].id,
        courseName: attempts[0].name || 'Untitled course',
        reason: 'ambiguous-retake',
        detail: `${attempts.length} attempts of this course could not be ordered by term, so all attempts are counted. Add the year and term, or switch to "Both attempts".`,
      })
      continue
    }
    kept.push(best.c)
    superseded += attempts.length - 1
  }
  return { kept, superseded, unresolved: 0, issues }
}

export function calculateGPA(
  courseList: readonly Course[],
  filter: GpaFilter = 'overall',
  ctx: EngineContext = {}
): GpaResult {
  const policies = ctx.policies ?? DEFAULT_POLICIES
  const exclusions: Partial<Record<ExclusionReason, number>> = {}
  const issues: CourseIssue[] = []
  const bump = (r: ExclusionReason) => { exclusions[r] = (exclusions[r] ?? 0) + 1 }

  // D50: computed once for the whole list, because whether a course is waiting
  // on a link review is a fact about the analysis, not about the row alone.
  const awaitingLinkReview = coursesAwaitingLinkReview(courseList, ctx.institutions ?? [])

  // 1-3. Structural eligibility, via the single shared gate.
  const pool: Course[] = []
  for (const c of courseList) {
    const e = courseEligibility(c, ctx.institutions, policies, awaitingLinkReview)
    if (e.eligible) { pool.push(c); continue }
    if (e.reason) bump(e.reason)
    if (e.issue) {
      issues.push({
        courseId: c.id,
        courseName: c.name || 'Untitled course',
        reason: e.issue.reason,
        detail: e.issue.detail,
      })
    }
  }

  // 4. Grade + credit validation, so retake grouping never picks a junk row.
  const valid: Course[] = []
  for (const c of pool) {
    const kind = classifyGrade(c.grade)
    if (kind === 'excluded') { bump('non-gpa-grade'); continue }
    if (kind === 'unrecognized') {
      issues.push({
        courseId: c.id, courseName: c.name || 'Untitled course',
        reason: 'unrecognized-grade',
        // Copy only: a blank grade means the transcript printed none, which is
        // a different thing from a grade we failed to understand.
        detail: String(c.grade ?? '').trim() === ''
          ? 'No grade was found on the transcript, so this course is not counted.'
          : `Grade "${String(c.grade)}" was not recognized and is not counted.`,
      })
      continue
    }
    const credits = normalizeCredits(c.credits)
    if (credits === null) {
      issues.push({
        courseId: c.id, courseName: c.name || 'Untitled course',
        reason: 'invalid-credits',
        detail: `Credit value "${String(c.credits ?? '')}" is not usable and is not counted.`,
      })
      continue
    }
    if (credits === 0) { bump('zero-credit'); continue }

    // D40: recognised, but this institution's scale does not define it.
    // Excluded pending review -- never silently scored on the standard scale.
    if (resolveGradePoints(c.grade, c.institutionId, ctx.institutions) === null) {
      bump('grade-not-in-scale')
      const inst = ctx.institutions?.find(i => i.id === c.institutionId)
      issues.push({
        courseId: c.id, courseName: c.name || 'Untitled course',
        reason: 'grade-not-in-scale',
        detail: `Grade "${normalizeGrade(c.grade)}" is not defined in ${inst?.name ?? 'this school'}\u2019s grading scale, so this course is not counted. Add it to the scale or correct the grade.`,
      })
      continue
    }
    valid.push(c)
  }

  // 5. Retakes.
  const retake = applyRetakePolicy(valid, policies.retake)
  if (retake.superseded) exclusions['superseded-retake'] = retake.superseded
  if (retake.unresolved) exclusions['retake-policy-unset'] = retake.unresolved
  issues.push(...retake.issues)
  let selected = retake.kept

  // 6. GPA-type filter.
  if (filter === 'science') {
    selected = selected.filter(c => c.categories?.includes('science'))
  } else if (filter === 'nursing') {
    selected = selected.filter(c => c.categories?.includes('nursing'))
  } else if (filter === 'graduate') {
    selected = selected.filter(c => c.level === 'graduate')
  } else if (filter === 'last60') {
    // D8: whole terms, newest first, stop once the window is reached. Ordering
    // inside a term is irrelevant because terms are taken all-or-nothing.
    const byTerm = new Map<string, Course[]>()
    for (const c of selected) {
      const k = termKeyOf(c)
      const g = byTerm.get(k)
      if (g) g.push(c); else byTerm.set(k, [c])
    }
    const taken: Course[] = []
    let credits = 0
    for (const key of [...byTerm.keys()].sort(compareTermsDesc)) {
      if (credits >= LAST_60_CREDIT_WINDOW) break
      const group = byTerm.get(key)!
      taken.push(...group)
      credits += group.reduce((s, c) => s + (normalizeCredits(c.credits) ?? 0), 0)
    }
    selected = taken
  }

  let qualityPoints = 0
  let creditsCounted = 0
  for (const c of selected) {
    const credits = normalizeCredits(c.credits)!
    // D38: each course converts on ITS OWN institution's scale, so a mixed
    // analysis weights Rutgers' B+ = 3.50 and another school's B+ = 3.30
    // correctly within one GPA.
    const points = resolveGradePoints(c.grade, c.institutionId, ctx.institutions)
    if (points === null) continue          // guarded above; belt and braces
    qualityPoints += points * credits
    creditsCounted += credits
  }

  const value = creditsCounted > 0 ? qualityPoints / creditsCounted : null
  const coursesExcluded = Object.values(exclusions).reduce((a, b) => a + b, 0)
  return {
    value,
    display: value === null ? null : formatGpa(value),
    qualityPoints,
    creditsCounted,
    coursesCounted: selected.length,
    coursesExcluded,
    exclusions,
    issues,
  }
}

/**
 * Two decimals, rounding a half away from zero.
 *
 * toFixed rounds the BINARY value, so a GPA of exactly 3.255 -- 130.2 quality
 * points over 40 credits -- is held as 3.25499999999999989 and was shown as
 * 3.25. Scaling before rounding reports the number the arithmetic actually
 * produced. The GPA value itself is unchanged; this is only how it is written.
 */
export function formatGpa(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2)
}

export function collectIssues(
  courseList: readonly Course[], ctx: EngineContext = {}
): CourseIssue[] {
  const seen = new Set<string>()
  return calculateGPA(courseList, 'overall', ctx).issues.filter(i => {
    const k = `${i.courseId}|${i.reason}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ============================================================ D17 helpers
// Pure transformations backing the guided institution-assignment flow. Kept
// here (not in the component) so they are directly testable.

/** Courses that cannot yet contribute because they have no institution. */
export function unassignedCourses(courseList: readonly Course[]): Course[] {
  return courseList.filter(c =>
    c.recordType !== 'transfer_notation' && !c.institutionId)
}

/** Courses whose institution exists but has no credit system chosen yet. */
export function coursesAwaitingCreditSystem(
  courseList: readonly Course[], institutions: readonly Institution[]
): Course[] {
  return courseList.filter(c => {
    if (c.recordType === 'transfer_notation' || !c.institutionId) return false
    const inst = institutions.find(i => i.id === c.institutionId)
    return !inst || inst.creditSystem === 'unknown'
  })
}

/**
 * Assigns many courses to one institution in a single pass (D17 bulk assign).
 *
 * Preserves every course and every field except `institutionId` and the review
 * flags it clears. Courses are never dropped, reordered, or edited otherwise --
 * grades, credits, categories, level and term all survive untouched.
 */
export function assignInstitution(
  courseList: readonly Course[],
  courseIds: readonly string[],
  institutionId: string
): Course[] {
  const target = new Set(courseIds)
  return courseList.map(c => {
    if (!target.has(c.id)) return c
    const reasons = (c.reviewReasons ?? []).filter(r =>
      !r.startsWith('Unassigned:') &&
      !r.startsWith('Imported from a transcript. Confirm the institution'))
    return {
      ...c,
      institutionId,
      reviewReasons: reasons,
      needsReview: reasons.length > 0,
    }
  })
}
