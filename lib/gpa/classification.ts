/**
 * D42 - structured subject/department evidence for course classification.
 *
 * Titles are weak evidence. "Culture, Life & Health" reads like a general
 * education course, but a transcript that files it under the same subject
 * code as Foundations of Nursing Practice and Nursing Informatics is telling
 * you which department owns it. D42 makes that official designation outrank
 * the title.
 *
 * The rule deliberately keys on the SUBJECT/DEPARTMENT segment of the catalog
 * number, never on the school the student is enrolled in. A statistics course
 * taken inside a nursing program keeps its own subject and stays out.
 */

import type { Course, CourseCategory } from './types.ts'

/** Catalog prefixes that name Nursing outright. */
const NURSING_SUBJECT_TOKENS: ReadonlySet<string> = new Set([
  'NURS', 'NUR', 'NSG', 'NURSING',
])

/**
 * How many already-nursing courses must share a subject before that subject is
 * treated as a nursing department. Two, not one: a single course is a title
 * judgement, while a repeated pairing is the transcript's own filing system.
 */
const MIN_COURSES_FOR_DERIVED_SUBJECT = 2

/**
 * The subject/department part of a catalog number - everything before the
 * course number itself.
 *
 *   "NURS 310"     -> "NURS"
 *   "BIOL-101"     -> "BIOL"
 *   "77:705:202"   -> "77 705"     (school + subject; the course number drops)
 *   "77 705 202"   -> "77 705"
 *   "STAT 201"     -> "STAT"
 *
 * Separators are normalized away so the same course filed as "77:705:202" on
 * one page and "77 705 202" on another groups together.
 */
export function subjectKeyOf(courseCode: string | null | undefined): string | null {
  const raw = String(courseCode ?? '').toUpperCase().trim()
  if (!raw) return null
  const groups = raw.split(/[^A-Z0-9]+/).filter(Boolean)
  if (groups.length === 0) return null
  if (groups.length === 1) {
    // "BIOL101" - no separator, so split the letters from the number.
    const m = groups[0].match(/^([A-Z]{2,})\d+$/)
    return m ? m[1] : null
  }
  // The last group is the course number; everything before it identifies the
  // subject. Keeping the school segment is deliberate: two schools may reuse a
  // subject number for unrelated departments.
  return groups.slice(0, -1).join(' ')
}

/** True when the subject key itself names Nursing. */
export function isNursingSubjectToken(subjectKey: string | null): boolean {
  if (!subjectKey) return false
  return subjectKey.split(' ').some(t => NURSING_SUBJECT_TOKENS.has(t))
}

const groupKey = (institutionId: string | null, subjectKey: string) =>
  `${institutionId ?? '-'}::${subjectKey}`

export interface NursingSubject {
  institutionId: string | null
  subjectKey: string
  /** Why this subject counts as Nursing. Shown to the user, never invented. */
  reason: string
}

/**
 * Works out which subject/department codes this transcript establishes as
 * Nursing, using only what the document provides.
 *
 * Two kinds of evidence, both scoped to one institution:
 *   1. the subject code names Nursing (NURS / NUR / NSG / NURSING)
 *   2. several courses already classified as nursing share one subject code
 *
 * A numeric subject on its own proves nothing, which is why (2) needs company.
 */
export function deriveNursingSubjects(
  courses: readonly Course[]
): Map<string, NursingSubject> {
  const found = new Map<string, NursingSubject>()
  const nursingCounts = new Map<string, { n: number; names: string[]; inst: string | null; key: string }>()

  for (const c of courses) {
    const subjectKey = subjectKeyOf(c.courseCode)
    if (!subjectKey) continue
    const k = groupKey(c.institutionId, subjectKey)

    if (isNursingSubjectToken(subjectKey)) {
      if (!found.has(k)) {
        found.set(k, {
          institutionId: c.institutionId, subjectKey,
          reason: `the subject code "${subjectKey}" names Nursing`,
        })
      }
      continue
    }

    if (c.categories?.includes('nursing')) {
      const e = nursingCounts.get(k) ?? { n: 0, names: [], inst: c.institutionId, key: subjectKey }
      e.n += 1
      if (e.names.length < 3 && c.name) e.names.push(c.name)
      nursingCounts.set(k, e)
    }
  }

  for (const [k, e] of nursingCounts) {
    if (found.has(k)) continue
    if (e.n < MIN_COURSES_FOR_DERIVED_SUBJECT) continue
    found.set(k, {
      institutionId: e.inst, subjectKey: e.key,
      reason: `this transcript files ${e.n} nursing course(s) under subject "${e.key}" (${e.names.join(', ')})`,
    })
  }

  return found
}

export interface ReclassifiedCourse {
  courseId: string
  courseName: string
  subjectKey: string
  reason: string
}

/**
 * Adds the nursing category to coursework whose subject code the transcript
 * establishes as Nursing.
 *
 * D4 is untouched: a course the user has classified themselves is never
 * changed here, no matter what the subject code says.
 */
export function applyNursingSubjectClassification(
  courses: readonly Course[]
): { courses: Course[]; changed: ReclassifiedCourse[] } {
  const subjects = deriveNursingSubjects(courses)
  if (subjects.size === 0) return { courses: [...courses], changed: [] }

  const changed: ReclassifiedCourse[] = []
  const next = courses.map(c => {
    if (c.categorySource === 'user') return c          // D4: user wins, always
    if (c.categories?.includes('nursing')) return c
    const subjectKey = subjectKeyOf(c.courseCode)
    if (!subjectKey) return c
    const subject = subjects.get(groupKey(c.institutionId, subjectKey))
    if (!subject) return c

    // "general" means "nothing more specific applied", so it goes once
    // something specific does. A science classification is independent and
    // stays.
    const categories: CourseCategory[] = [
      ...(c.categories ?? []).filter(x => x !== 'general'),
      'nursing',
    ]
    changed.push({
      courseId: c.id, courseName: c.name, subjectKey, reason: subject.reason,
    })
    return { ...c, categories, categorySource: 'deterministic' as const }
  })

  return { courses: next, changed }
}

// ============================================================ D56 categories
/**
 * D56 - deterministic Science and Nursing classification.
 *
 * Categories used to come entirely from the model, which meant the same
 * transcript could file the same course differently on different imports, and
 * that a course was called Nursing because its title sounded clinical. Both
 * approved rules already say otherwise:
 *
 *   D42 - Nursing needs the transcript's own subject/department evidence.
 *         "Pharmacology" is a subject matter, not a department.
 *   D4  - deterministic evidence first, the model only where a case is
 *         genuinely ambiguous, and the user above both.
 *
 * So the classifier decides where an approved rule applies and stays out of the
 * way where none does. It never touches a course the user has classified, and
 * it never invents a category for a subject nobody has ruled on -- an unlisted
 * subject keeps whatever the model suggested.
 */

/** Subject codes that are Science on their own. Whole tokens, never substrings. */
const SCIENCE_SUBJECT_TOKENS: ReadonlySet<string> = new Set([
  'BIO', 'BIOL',
  'CHEM', 'CHM',
  'MIC', 'MICR', 'MICRO',
  'PHYS',
  'ANAT',
  'PHAR', 'PHARM',
  'BCHM', 'BIOC', 'BIOCHEM',
  'NUTR', 'NUTRITION',
])

/**
 * Subjects the Science GPA does not take by default.
 *
 * Not a claim that statistics is unscientific -- it is a claim about what
 * belongs in THIS number unless the user says otherwise.
 */
const NON_SCIENCE_SUBJECT_TOKENS: ReadonlySet<string> = new Set([
  'STAT', 'STATS',
  'MATH', 'MTH', 'MAT',
  'PSYC', 'PSY', 'PSYCH',
  'SOC', 'SOCI',
])

/**
 * Titles that name a science subject outright.
 *
 * Whole words, so "Biostatistics" is not Biology and "Pathophysiology" does
 * not match the bare Physiology rule -- it has its own. This is what lets
 * "ANES 501 Advanced Physiology" be Science without making every ANES course
 * Science.
 */
const SCIENCE_TITLE_CONCEPTS: readonly RegExp[] = [
  /\banatomy\b/i,
  /\bphysiology\b/i,
  /\bpathophysiology\b/i,
  /\bmicrobiology\b/i,
  /\bbiochemistry\b/i,
  /\bpharmacology\b/i,
  /\bchemistry\b/i,
  /\bbiology\b/i,
]

const subjectTokens = (subjectKey: string | null): string[] =>
  subjectKey ? subjectKey.split(' ').filter(Boolean) : []

/** True when the catalog subject names a science field. */
export function isScienceSubjectToken(subjectKey: string | null): boolean {
  return subjectTokens(subjectKey).some(t => SCIENCE_SUBJECT_TOKENS.has(t))
}

/** True when the catalog subject is one the Science GPA leaves out by default. */
export function isDefaultNonScienceSubject(subjectKey: string | null): boolean {
  const tokens = subjectTokens(subjectKey)
  if (tokens.length === 0) return false
  return tokens.some(t => NON_SCIENCE_SUBJECT_TOKENS.has(t))
    && !tokens.some(t => SCIENCE_SUBJECT_TOKENS.has(t))
}

/** True when the title names a science subject outright. */
export function hasScienceTitleConcept(title: string | null | undefined): boolean {
  const t = String(title ?? '')
  return SCIENCE_TITLE_CONCEPTS.some(re => re.test(t))
}

export type ScienceVerdict = 'science' | 'not-science' | 'unruled'

/**
 * What the approved rules say about Science for one course.
 *
 * 'unruled' is a real answer: no approved rule covers this subject, so the
 * model's suggestion stands rather than being replaced by a guess of our own.
 */
export function scienceVerdict(course: Course): ScienceVerdict {
  const subjectKey = subjectKeyOf(course.courseCode)
  if (isScienceSubjectToken(subjectKey)) return 'science'
  // The title is checked BEFORE any default, which is what lets "NURS 210
  // Pathophysiology" and "ANES 501 Advanced Physiology" be Science without
  // making every course under those subjects Science.
  if (hasScienceTitleConcept(course.name)) return 'science'
  if (isDefaultNonScienceSubject(subjectKey)) return 'not-science'
  // A nursing subject is a nursing department, not a science one. Nursing
  // coursework enters the Science GPA only where its own title names a science
  // subject -- which is exactly what the approved ground truth describes: of
  // seventeen NURS courses, the three called Pathophysiology, Pharmacology I
  // and Pharmacology II are Science, and "Evidence-Based Practice" is not.
  if (isNursingSubjectToken(subjectKey)) return 'not-science'
  return 'unruled'
}

export interface CategoryChange {
  courseId: string
  courseName: string
  added: CourseCategory[]
  removed: CourseCategory[]
  reason: string
}

/**
 * Applies both approved rules to a whole analysis, in the approved order.
 *
 * Nursing is decided from the subjects this transcript establishes -- which is
 * read from the categories as they arrive, so a transcript that files a cluster
 * of nursing courses under a numeric department still establishes it. A nursing
 * tag that no established subject supports is then removed, because under D42
 * clinical relevance was never evidence.
 *
 * Science is decided from the subject code and the title, and removed only for
 * the subjects the Science GPA leaves out by default. Everything else keeps
 * what it came in with.
 */
export function applyCategoryClassification(
  courses: readonly Course[]
): { courses: Course[]; changed: CategoryChange[] } {
  const nursingSubjects = deriveNursingSubjects(courses)
  const changed: CategoryChange[] = []

  const next = courses.map(course => {
    // D4: a category the user chose is not ours to revisit, in either
    // direction, by any rule.
    if (course.categorySource === 'user') return course

    const before = new Set(course.categories ?? [])
    const subjectKey = subjectKeyOf(course.courseCode)
    const reasons: string[] = []

    // ---- Nursing (D42), authoritative both ways.
    const establishedSubject = subjectKey
      ? nursingSubjects.get(groupKey(course.institutionId, subjectKey))
      : undefined
    const isNursing = !!establishedSubject
    if (isNursing && !before.has('nursing')) reasons.push(establishedSubject!.reason)
    if (!isNursing && before.has('nursing')) {
      reasons.push('no nursing subject or department evidence on this transcript')
    }

    // ---- Science (D56).
    const verdict = scienceVerdict(course)
    const isScience =
      verdict === 'science' ? true
      : verdict === 'not-science' ? false
      : before.has('science')          // unruled: the model's suggestion stands
    if (verdict === 'science' && !before.has('science')) {
      reasons.push(isScienceSubjectToken(subjectKey)
        ? `the subject code "${subjectKey}" names a science field`
        : 'the course title names a science subject')
    }
    if (verdict === 'not-science' && before.has('science')) {
      reasons.push(`"${subjectKey}" is not counted toward the Science GPA by default`)
    }

    const after: CourseCategory[] = []
    if (isScience) after.push('science')
    if (isNursing) after.push('nursing')
    if (after.length === 0) after.push('general')

    // A rule ruled on this course when Science was decided either way, or when
    // Nursing was established or withdrawn. Only then is the outcome recorded
    // as deterministic -- a course still carrying the model's suggestion keeps
    // saying so, so provenance stays honest in both directions.
    const decided = verdict !== 'unruled' || isNursing || before.has('nursing')
    const source = decided ? ('deterministic' as const) : course.categorySource

    const sameSet = after.length === before.size && after.every(c => before.has(c))
    if (sameSet) {
      return source === course.categorySource ? course : { ...course, categorySource: source }
    }

    const added = after.filter(c => !before.has(c))
    const removed = [...before].filter(c => !after.includes(c) && c !== 'general')
    if (added.length > 0 || removed.length > 0) {
      changed.push({
        courseId: course.id, courseName: course.name, added, removed,
        reason: reasons.join('; ') || 'category rules applied',
      })
    }
    return { ...course, categories: after, categorySource: source }
  })

  return { courses: next, changed }
}
