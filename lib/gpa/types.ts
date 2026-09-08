/**
 * GPA Analyzer V2 — data model.
 *
 * V1 stored one overloaded boolean, `isTransfer`, which conflated two different
 * things: "coursework I completed at another school" and "my current school's
 * transcript line acknowledging that credit was accepted". Those need opposite
 * handling, so V2 splits them into `recordType` + `transferredIn`.
 */

export const ENGINE_VERSION = 2

export type CourseCategory = 'science' | 'nursing' | 'general'
export type AcademicLevel = 'undergraduate' | 'graduate' | 'unknown'
export type CreditSystem = 'semester' | 'quarter' | 'unknown'

/**
 * Where a classification came from. `user` is authoritative and must never be
 * overwritten by a later deterministic pass or AI import (D4).
 */
export type ClassificationSource = 'default' | 'deterministic' | 'ai' | 'user'

/**
 * `coursework`         — a real academic attempt with a real grade.
 * `transfer_notation`  — the receiving school's administrative acknowledgement
 *                        that credit was accepted. NEVER counted in any GPA
 *                        under any policy: it is a duplicate of the originating
 *                        institution's graded attempt, not a second attempt.
 */
export type RecordType = 'coursework' | 'transfer_notation'

export interface Institution {
  id: string
  name: string
  /** Gates D5: quarter coursework is flagged and excluded, never converted. */
  creditSystem: CreditSystem
  /**
   * D38. null means "not established" -- the standard scale is used and
   * surfaced as unconfirmed (D39). Points are resolved at calculation time,
   * never stored on courses, so correcting a scale re-scores every analysis
   * that references this institution.
   */
  gradingScale?: GradingScale | null
}

export interface Course {
  id: string
  /** Institution where the coursework was ACTUALLY taken. */
  institutionId: string | null
  /** e.g. "BIO 101". Required for conservative retake matching (D7). */
  courseCode: string | null
  name: string
  grade: string
  credits: number
  year?: string
  term?: string
  categories: CourseCategory[]
  categorySource: ClassificationSource
  level: AcademicLevel
  levelSource: ClassificationSource
  recordType: RecordType
  /** True when this coursework was transferred into another institution. */
  transferredIn: boolean
  /**
   * D50: the school a transfer notation says the credit came FROM, as printed.
   *
   * Only ever set on a `transfer_notation` row. It does not change that row's
   * institution -- the notation still belongs to the RECEIVING school whose
   * transcript printed it. Until now this was read off the transfer block
   * heading ("TRANSFER CREDIT ACCEPTED FROM ...") and then discarded, which is
   * why an originating course could never be recognised once the two
   * transcripts met in a combined analysis.
   */
  transferredFromName?: string | null
  /** The same school once it resolves to one of the user's institutions. */
  transferredFromInstitutionId?: string | null
  /**
   * D50: which originating coursework this notation documents.
   *
   * Lives on the notation because the notation is the thing that needs
   * resolving. `courseId: null` records a deliberate "no matching coursework
   * here", so an automatic pass never reinstates a link the user removed.
   * Absent means unresolved and open to automatic linking.
   */
  transferLink?: TransferLink | null
  needsReview: boolean
  reviewReasons: string[]
  /**
   * D47: every analysis this row has been copied from, oldest first.
   *
   * Combining always creates a NEW analysis, so a row copied out of a combined
   * analysis has to remember where its coursework originally came from --
   * otherwise "Rutgers + Montclair" plus "Montclair" would look like two
   * unrelated sources and silently duplicate 45 courses. Names are editable, so
   * provenance is recorded by analysis id and never by label.
   *
   * Internal only: never shown to the user, never used in any GPA decision.
   */
  provenance?: string[]
  /**
   * D60: the SERVER-ISSUED identity of the transcript this row was read from.
   *
   * Issued by /api/analyze-transcript once an analysis has actually succeeded,
   * never generated in the browser, and never written by hand. It travels with
   * the row through editing, copying, saving a snapshot and combining, so a
   * combined analysis truthfully holds courses from several sources -- and so
   * "this coursework came from a transcript" stops depending on classification
   * fields that later passes and user edits overwrite.
   *
   * Absent means manually entered, or imported before D60. Never used in any
   * GPA decision, and never an entitlement check on its own: the allowance is
   * decided from the server-side ledger, not from what any course claims.
   */
  transcriptSourceId?: string | null
  /**
   * Pre-D47 single-source marker. Still read, so analyses created by the
   * earlier "add existing analysis" behavior keep their overlap protection.
   */
  copiedFrom?: string
}

/**
 * D50: a receiving school's transfer notation and the originating coursework it
 * documents, in one analysis.
 *
 * Stored rather than recomputed so the app knows WHY an originating course is
 * treated as transferred, and so a user's correction survives.
 */
export interface TransferLink {
  /** The originating coursework row in this analysis. null = none of them. */
  courseId: string | null
  /** 'auto' was deterministic evidence; 'user' is authoritative over it. */
  source: 'auto' | 'user'
}

export type TransferPolicy = 'include' | 'exclude'
export type RetakePolicy = 'both' | 'latest'

export interface GpaPolicies {
  /**
   * D11: deliberately nullable. There is NO default. Until the user chooses,
   * coursework with transferredIn=true is held out of every GPA and flagged,
   * so an arbitrary default can never be mistaken for an admissions rule.
   * `transfer_notation` is excluded regardless of this setting.
   */
  transfer: TransferPolicy | null
  /**
   * D21: also deliberately nullable, for the same reason. Unlike transfer,
   * this only blocks coursework whose outcome actually depends on it -- i.e.
   * courses in a confirmed repeat group. A dataset with no repeats calculates
   * normally while this is unset.
   */
  retake: RetakePolicy | null
}

/** D11 + D21: nothing is chosen for the user. */
export const DEFAULT_POLICIES: GpaPolicies = Object.freeze({
  transfer: null,
  retake: null,
})

/**
 * The policy set that REPRODUCES V1 arithmetic. Used only to explain or
 * recompute a historical number for comparison -- never assigned to a user's
 * draft, because V1's behavior was a code path, not a choice they made.
 */
export const LEGACY_V1_POLICIES: GpaPolicies = Object.freeze({
  transfer: 'exclude',
  retake: 'both',
})

export const LAST_60_CREDIT_WINDOW = 60

export const TERM_ORDER: Readonly<Record<string, number>> = Object.freeze({
  WINTER: 0, SPRING: 1, SUMMER: 2, FALL: 3, AUTUMN: 3,
})

/**
 * D38: the STANDARD FALLBACK scale -- no longer universal truth.
 *
 * Institutions differ: Rutgers awards B+ = 3.50, plenty of schools use 3.30.
 * This table is only what we assume when an institution's real scale has not
 * been established, and D39 requires that assumption to be visible.
 */
export const STANDARD_GRADE_POINTS: Readonly<Record<string, number>> = Object.freeze({
  'A+': 4.0, 'A': 4.0, 'A-': 3.7,
  'B+': 3.3, 'B': 3.0, 'B-': 2.7,
  'C+': 2.3, 'C': 2.0, 'C-': 1.7,
  'D+': 1.3, 'D': 1.0, 'D-': 0.7,
  'F': 0.0, 'WF': 0.0,
})

/**
 * The globally RECOGNISED letter-grade vocabulary. Deliberately separate from
 * any scale's point map (D40): a grade can be a real grade that a particular
 * institution's scale simply does not define, which is a review item -- not an
 * unrecognised grade, and never a silent fall back to the standard points.
 */
export const RECOGNIZED_LETTER_GRADES: ReadonlySet<string> = new Set([
  'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', 'WF',
])

/** @deprecated Use resolveGradePoints(). Kept so legacy imports still compile. */
export const GRADE_POINTS = STANDARD_GRADE_POINTS

export type GradingScaleSource = 'default' | 'transcript' | 'user'

export interface GradingScale {
  source: GradingScaleSource
  points: Record<string, number>
}

/** The scale used when an institution has not established its own (D39). */
export const STANDARD_SCALE: GradingScale = Object.freeze({
  source: 'default' as const,
  points: { ...STANDARD_GRADE_POINTS },
})

/** Human-facing status text. Never expose the raw enum. */
export function gradingScaleStatus(scale: GradingScale | null | undefined): string {
  switch (scale?.source) {
    case 'user': return 'User confirmed'
    case 'transcript': return 'Detected from transcript'
    default: return 'Standard scale \u2014 unconfirmed'
  }
}

export const NON_GPA_GRADES: ReadonlySet<string> = new Set([
  'P', 'PASS', 'S', 'SAT', 'CR', 'NC', 'NP', 'U', 'UNSAT',
  'W', 'WP', 'WD', 'WITHDRAWN',
  'I', 'INC', 'INCOMPLETE', 'IP', 'NR', 'AU', 'AUDIT', 'T', 'TR', 'TRANSFER',
])

export const SELECTABLE_GRADES: readonly string[] = [
  'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F',
  'P', 'W', 'I',
]

export type ExclusionReason =
  | 'transfer-notation'
  | 'transfer-policy'
  | 'transfer-policy-unset'
  /** D50: a transfer link stopped agreeing with its coursework. */
  | 'transfer-link-review-required'
  | 'unsupported-credit-system'
  | 'credit-system-unknown'
  | 'no-institution'
  | 'superseded-retake'
  | 'retake-policy-unset'
  | 'grade-not-in-scale'
  | 'non-gpa-grade'
  | 'zero-credit'

export type IssueReason =
  | 'unrecognized-grade'
  | 'invalid-credits'
  | 'ambiguous-retake'
  | 'unsupported-credit-system'
  | 'credit-system-unknown'
  | 'no-institution'
  | 'transfer-policy-unset'
  | 'transfer-link-review-required'
  | 'retake-policy-unset'
  | 'grade-not-in-scale'

export interface CourseIssue {
  courseId: string
  courseName: string
  reason: IssueReason
  detail: string
}

export interface GpaResult {
  value: number | null
  display: string | null
  qualityPoints: number
  creditsCounted: number
  coursesCounted: number
  coursesExcluded: number
  exclusions: Partial<Record<ExclusionReason, number>>
  issues: CourseIssue[]
}

export type GpaFilter =
  | 'overall' | 'science' | 'nursing' | 'last60' | 'graduate'
