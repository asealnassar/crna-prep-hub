/**
 * Backward compatibility with V1 saved calculations.
 *
 * The 20 existing gpa_calculations rows hold JSONB course snapshots in the V1
 * shape. They are NOT migrated in the database (per D2) — they are adapted in
 * memory when opened, so old rows keep loading and their stored GPA numbers are
 * left exactly as they were.
 *
 * V1's `isTransfer` is genuinely ambiguous: it was set both for coursework
 * completed elsewhere and for a receiving school's transfer-credit notation.
 * We cannot tell them apart after the fact, so we take the interpretation that
 * preserves V1's arithmetic (treat as coursework, transferred in) and flag the
 * course for user review rather than guessing.
 */

import {
  type Course, type CourseCategory, type AcademicLevel,
  type ClassificationSource,
} from './types.ts'

export interface LegacyCourse {
  id?: string
  name?: string
  grade?: string
  credits?: unknown
  year?: string
  term?: string
  categories?: unknown
  isTransfer?: boolean
  /** Superseded single-category field found in the oldest snapshots. */
  type?: string | null
}

const VALID: CourseCategory[] = ['science', 'nursing', 'general']

function categoriesOf(raw: unknown, legacyType?: string | null): CourseCategory[] {
  const fromArray = Array.isArray(raw)
    ? raw.filter((x): x is CourseCategory => VALID.includes(x as CourseCategory))
    : []
  if (fromArray.length) return fromArray
  if (legacyType && VALID.includes(legacyType as CourseCategory)) {
    return [legacyType as CourseCategory]
  }
  return ['general']
}

let counter = 0
function stableId(existing: unknown): string {
  const s = String(existing ?? '')
  return s.length >= 6 ? s : `legacy-${Date.now()}-${counter++}`
}

/** Adapts one V1 course object into the V2 shape. Never throws. */
export function upgradeCourse(raw: LegacyCourse): Course {
  const reviewReasons: string[] = []
  const transferredIn = raw?.isTransfer === true
  if (transferredIn) {
    reviewReasons.push(
      'Imported from an older calculation where "transfer" could mean either ' +
      'coursework taken elsewhere or a transfer-credit notation. Confirm which.'
    )
  }

  const level: AcademicLevel = 'unknown'
  const levelSource: ClassificationSource = 'default'
  if (level === 'unknown') reviewReasons.push('Academic level was not recorded in the original calculation.')

  return {
    id: stableId(raw?.id),
    institutionId: null,
    courseCode: null,
    name: String(raw?.name ?? ''),
    grade: String(raw?.grade ?? ''),
    credits: typeof raw?.credits === 'number' ? raw.credits : parseFloat(String(raw?.credits ?? '')) || 0,
    year: raw?.year ? String(raw.year) : '',
    term: raw?.term ? String(raw.term) : '',
    categories: categoriesOf(raw?.categories, raw?.type),
    categorySource: 'default',
    level,
    levelSource,
    recordType: 'coursework',
    transferredIn,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  }
}

/** Adapts a whole V1 snapshot. Tolerates null/garbage without throwing. */
export function upgradeCourses(raw: unknown): Course[] {
  if (!Array.isArray(raw)) return []
  return raw.map(c => upgradeCourse((c ?? {}) as LegacyCourse))
}

/**
 * True when a stored row predates V2. Rows written by V2 carry
 * engine_version >= 2; every existing row has NULL.
 */
export function isLegacyCalculation(row: { engine_version?: number | null }): boolean {
  return (row?.engine_version ?? 1) < 2
}
