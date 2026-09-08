/**
 * D50 - linking a receiving school's transfer notation to the originating
 * coursework it documents.
 *
 * Two transcripts imported separately each read correctly on their own terms:
 * Lakeshore says "these ten courses transferred in from Pine Valley", and Pine
 * Valley's own transcript says nothing about a later transfer, because Pine
 * Valley does not know. Only when both sit in one combined analysis does the
 * relationship exist -- and until it is recorded, those ten Pine Valley courses
 * count as ordinary coursework and the transfer policy governs nothing.
 *
 * The bar for an automatic link is deliberately high. It is drawn entirely from
 * what the documents print:
 *
 *   - the notation names an originating school,
 *   - that school is one of the institutions in this analysis,
 *   - the catalog number matches,
 *   - the credits match,
 *   - and exactly ONE course at that school satisfies all of it.
 *
 * Anything less stays unresolved for the user to confirm. Titles are supporting
 * context only: schools rename and abbreviate equivalent courses constantly, so
 * requiring a title match would miss real links, and matching ON title alone
 * would invent false ones. There is no fuzzy fallback here on purpose.
 *
 * Nothing in this module makes a GPA decision. It records a relationship; D1
 * and the user's transfer policy decide what that relationship means.
 */

import { normalizeName } from './institutions.ts'
import type { Course, Institution, TransferLink } from './types.ts'

/** Why a notation could not be linked without asking. */
export type UnresolvedReason =
  | 'origin-unknown'        // the notation names no originating school
  | 'origin-not-in-analysis' // it names one, but that school is not here
  | 'no-code'               // the notation prints no catalog number
  | 'no-candidate'          // nothing at that school matches code + credits
  | 'ambiguous'             // more than one course matches

export interface ProposedLink {
  notationId: string
  courseId: string
}

export interface UnresolvedNotation {
  notationId: string
  reason: UnresolvedReason
  /** Courses the user could reasonably choose from, for the picker. */
  candidates: Course[]
}

/** Why a link is being questioned, and how much it matters. */
export type ReviewReason = UnresolvedReason | 'stale'

/**
 * Required or not, decided by one deterministic question: is there coursework
 * in this analysis whose inclusion actually turns on the answer?
 *
 * If plausible originating coursework is present, leaving the relationship
 * unresolved changes the GPA -- that course is either governed by transfer
 * policy or it is not, and we cannot tell which. That is a decision the user
 * has to make. If no such coursework is here, there is nothing for the engine
 * to govern either way, so it is a note rather than a blocker.
 */
export type ReviewSeverity = 'required' | 'optional'

export interface TransferReview {
  notationId: string
  reason: ReviewReason
  severity: ReviewSeverity
  /** Best options for the picker, most likely first. */
  candidates: Course[]
  /** For a stale review: the course the link still points at. */
  linkedCourseId?: string
}

export interface TransferLinkPlan {
  links: ProposedLink[]
  unresolved: UnresolvedNotation[]
}

const normalizeCode = (raw: unknown): string =>
  String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

const creditsOf = (c: Course): number | null => {
  const n = typeof c.credits === 'number' ? c.credits : Number(c.credits)
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null
}

export function isTransferNotation(c: Course): boolean {
  return c.recordType === 'transfer_notation'
}

/** True once the notation has an answer -- a course, or a deliberate "none". */
export function isResolved(c: Course): boolean {
  return c.transferLink !== undefined && c.transferLink !== null
}

/**
 * The originating institution a notation points at, when it can be identified.
 *
 * A stored id wins; otherwise the printed name is resolved through the same
 * institution matching the rest of the import uses, and only an exact match
 * counts. "Related but possibly a different campus" is not evidence.
 */
export function originInstitutionOf(
  notation: Course, institutions: readonly Institution[],
): Institution | null {
  if (notation.transferredFromInstitutionId) {
    return institutions.find(i => i.id === notation.transferredFromInstitutionId) ?? null
  }
  const name = String(notation.transferredFromName ?? '').trim()
  if (!name) return null
  const key = normalizeName(name)
  const exact = institutions.filter(i => normalizeName(i.name) === key)
  return exact.length === 1 ? exact[0] : null
}

/**
 * Whether that school takes part in THIS analysis.
 *
 * Institutions are account-level, so a school can exist on the account while
 * its transcript is not part of the analysis in hand. Saying "no course
 * matches" in that situation would be misleading -- there is no coursework to
 * match against yet, and the honest answer is that the transcript is missing.
 */
function originIsPresent(
  courses: readonly Course[], originId: string,
): boolean {
  return courses.some(c => c.recordType === 'coursework' && c.institutionId === originId)
}

/**
 * Courses at the originating school that the notation could be documenting.
 *
 * Code AND credits, both. A code match with different credits is a different
 * course as far as this is concerned, and is offered to the user rather than
 * assumed.
 */
export function candidatesFor(
  notation: Course, courses: readonly Course[], originId: string,
): Course[] {
  const code = normalizeCode(notation.courseCode)
  const credits = creditsOf(notation)
  if (!code || credits === null) return []
  return courses.filter(c =>
    c.recordType === 'coursework' &&
    c.institutionId === originId &&
    normalizeCode(c.courseCode) === code &&
    creditsOf(c) === credits)
}

/**
 * Coursework in this analysis that could plausibly be what a notation
 * documents: a different school, the same catalog number, the same credits.
 *
 * Deterministic, and the same evidence the automatic rule uses -- this asks
 * whether any candidate exists at all, not which one is right.
 */
export function plausibleCandidates(
  notation: Course, courses: readonly Course[],
): Course[] {
  const code = normalizeCode(notation.courseCode)
  const credits = creditsOf(notation)
  if (!code || credits === null) return []
  return courses.filter(c =>
    c.recordType === 'coursework' &&
    c.institutionId !== notation.institutionId &&
    normalizeCode(c.courseCode) === code &&
    creditsOf(c) === credits)
}

/** Every course the user could pick for a notation, ordered most likely first. */
export function pickerOptionsFor(
  notation: Course, courses: readonly Course[], institutions: readonly Institution[],
): Course[] {
  const origin = originInstitutionOf(notation, institutions)
  const code = normalizeCode(notation.courseCode)
  const pool = courses.filter(c =>
    c.recordType === 'coursework' && c.id !== notation.id &&
    c.institutionId !== notation.institutionId)
  const score = (c: Course) =>
    (origin && c.institutionId === origin.id ? 4 : 0) +
    (code && normalizeCode(c.courseCode) === code ? 2 : 0) +
    (creditsOf(c) === creditsOf(notation) ? 1 : 0)
  return [...pool].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
}

/**
 * Plans links for every notation that has not been answered yet.
 *
 * Pure: nothing is written. A course already claimed -- by an existing link or
 * by another notation in this same pass -- cannot be claimed again, so two
 * notations can never both point at one attempt.
 */
export function planTransferLinks(
  courses: readonly Course[], institutions: readonly Institution[],
): TransferLinkPlan {
  const links: ProposedLink[] = []
  const unresolved: UnresolvedNotation[] = []

  // Courses already spoken for keep their link; they are not up for grabs.
  const claimed = new Set<string>()
  for (const c of courses) {
    if (isTransferNotation(c) && c.transferLink?.courseId) claimed.add(c.transferLink.courseId)
  }

  for (const notation of courses) {
    if (!isTransferNotation(notation)) continue
    // An answered notation is left exactly as it is -- including a user's
    // "none of them", which must never be quietly overturned.
    if (isResolved(notation)) continue

    const origin = originInstitutionOf(notation, institutions)
    if (!origin || !originIsPresent(courses, origin.id)) {
      const named = String(notation.transferredFromName ?? '').trim()
      unresolved.push({
        notationId: notation.id,
        reason: named ? 'origin-not-in-analysis' : 'origin-unknown',
        candidates: pickerOptionsFor(notation, courses, institutions),
      })
      continue
    }
    if (!normalizeCode(notation.courseCode)) {
      unresolved.push({
        notationId: notation.id, reason: 'no-code',
        candidates: pickerOptionsFor(notation, courses, institutions),
      })
      continue
    }

    const candidates = candidatesFor(notation, courses, origin.id)
      .filter(c => !claimed.has(c.id))
    if (candidates.length === 0) {
      unresolved.push({
        notationId: notation.id, reason: 'no-candidate',
        candidates: pickerOptionsFor(notation, courses, institutions),
      })
      continue
    }
    if (candidates.length > 1) {
      unresolved.push({ notationId: notation.id, reason: 'ambiguous', candidates })
      continue
    }

    links.push({ notationId: notation.id, courseId: candidates[0].id })
    claimed.add(candidates[0].id)
  }

  return { links, unresolved }
}

/**
 * Writes a plan onto a course list, and derives `transferredIn` from the links.
 *
 * The notation keeps its own record type and its printed grade: it is still a
 * notation, still never GPA-bearing, and no row is merged away. The only thing
 * that changes for the engine is the flag on the originating course, which is
 * what the user's transfer policy has always acted on.
 */
export function applyTransferLinks(
  courses: readonly Course[], plan: TransferLinkPlan,
): Course[] {
  const byNotation = new Map(plan.links.map(l => [l.notationId, l.courseId]))
  const withLinks = courses.map(c =>
    byNotation.has(c.id)
      ? { ...c, transferLink: { courseId: byNotation.get(c.id)!, source: 'auto' as const } }
      : c)
  return deriveTransferredIn(withLinks)
}

/**
 * Marks exactly the coursework that a link points at.
 *
 * Derived, never accumulated: a course whose link was removed stops being
 * transferred. Coursework a transcript itself declared transferred is left
 * alone, because that flag came from the document, not from a link.
 */
export function deriveTransferredIn(courses: readonly Course[]): Course[] {
  const linked = new Set<string>()
  const anyLink = courses.some(c => isTransferNotation(c) && c.transferLink !== undefined)
  for (const c of courses) {
    if (isTransferNotation(c) && c.transferLink?.courseId) linked.add(c.transferLink.courseId)
  }
  if (!anyLink) return [...courses]
  return courses.map(c => {
    if (c.recordType !== 'coursework') return c
    if (linked.has(c.id)) return c.transferredIn ? c : { ...c, transferredIn: true }
    return c
  })
}

/** Records the user's answer for one notation. Authoritative over automation. */
export function setTransferLink(
  courses: readonly Course[], notationId: string, courseId: string | null,
): Course[] {
  const next = courses.map(c => {
    if (c.id !== notationId) return c
    return { ...c, transferLink: { courseId, source: 'user' as const } satisfies TransferLink }
  })
  // A course released by this change must stop counting as transferred, and
  // nothing else may move, so the flag is recomputed from the links in hand.
  const stillLinked = new Set<string>()
  for (const c of next) if (isTransferNotation(c) && c.transferLink?.courseId) stillLinked.add(c.transferLink.courseId)
  return next.map(c => {
    if (c.recordType !== 'coursework') return c
    const should = stillLinked.has(c.id)
    if (should === c.transferredIn) return c
    return { ...c, transferredIn: should }
  })
}

/** Notations still waiting on the user, with the options to offer them. */
export function unresolvedTransfers(
  courses: readonly Course[], institutions: readonly Institution[],
): UnresolvedNotation[] {
  return planTransferLinks(courses, institutions).unresolved
}

/** How many originating courses are governed by transfer policy through a link. */
export function linkedTransferCount(courses: readonly Course[]): number {
  const linked = new Set<string>()
  for (const c of courses) {
    if (isTransferNotation(c) && c.transferLink?.courseId) linked.add(c.transferLink.courseId)
  }
  return linked.size
}

/**
 * A link whose evidence no longer holds, because the coursework was edited.
 *
 * Reported, never silently dropped: the safest thing to do with a relationship
 * that has stopped being true is to say so and let the user decide.
 */
export function staleLinks(
  courses: readonly Course[], institutions: readonly Institution[],
): { notationId: string; courseId: string; reason: 'missing' | 'code' | 'credits' | 'origin' }[] {
  const byId = new Map(courses.map(c => [c.id, c]))
  const out: { notationId: string; courseId: string; reason: 'missing' | 'code' | 'credits' | 'origin' }[] = []
  for (const n of courses) {
    if (!isTransferNotation(n) || !n.transferLink?.courseId) continue
    // A link the user chose themselves is their statement about their own
    // record, not an inference to be re-checked. Only automatic links are
    // validated against the evidence that produced them.
    if (n.transferLink.source === 'user') continue
    const target = byId.get(n.transferLink.courseId)
    if (!target) { out.push({ notationId: n.id, courseId: n.transferLink.courseId, reason: 'missing' }); continue }
    const origin = originInstitutionOf(n, institutions)
    if (origin && target.institutionId !== origin.id) {
      out.push({ notationId: n.id, courseId: target.id, reason: 'origin' }); continue
    }
    if (normalizeCode(target.courseCode) !== normalizeCode(n.courseCode)) {
      out.push({ notationId: n.id, courseId: target.id, reason: 'code' }); continue
    }
    if (creditsOf(target) !== creditsOf(n)) {
      out.push({ notationId: n.id, courseId: target.id, reason: 'credits' })
    }
  }
  return out
}

/**
 * The set of originating courses whose transfer relationship is in question.
 *
 * The engine withholds these: a stale link is neither "transferred" nor
 * "ordinary coursework" until the user says which, and letting Include or
 * Exclude decide it would answer a question nobody has asked yet.
 */
export function coursesAwaitingLinkReview(
  courses: readonly Course[], institutions: readonly Institution[],
): Set<string> {
  return new Set(staleLinks(courses, institutions).map(s => s.courseId))
}

/**
 * Everything about transfer links the interface needs to ask about, in one
 * list: links that stopped agreeing with their coursework, and notations that
 * were never resolved.
 */
export function transferReviews(
  courses: readonly Course[], institutions: readonly Institution[],
): TransferReview[] {
  const byId = new Map(courses.map(c => [c.id, c]))
  const out: TransferReview[] = []

  // A link whose evidence stopped holding always needs an answer: the
  // coursework it points at is being withheld until it gets one.
  for (const stale of staleLinks(courses, institutions)) {
    const notation = byId.get(stale.notationId)
    if (!notation) continue
    const valid = plausibleCandidates(notation, courses)
    out.push({
      notationId: stale.notationId,
      reason: 'stale',
      severity: 'required',
      linkedCourseId: stale.courseId,
      candidates: valid.length > 0 ? valid : pickerOptionsFor(notation, courses, institutions),
    })
  }

  for (const u of planTransferLinks(courses, institutions).unresolved) {
    const notation = byId.get(u.notationId)
    if (!notation) continue
    const plausible = plausibleCandidates(notation, courses)
    out.push({
      notationId: u.notationId,
      reason: u.reason,
      // Required only when coursework in this analysis actually hangs on it.
      severity: plausible.length > 0 ? 'required' : 'optional',
      candidates: u.candidates.length > 0 ? u.candidates : plausible,
    })
  }
  return out
}
