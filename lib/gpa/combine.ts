/**
 * D47 - non-destructive combining.
 *
 * Someone who has analyzed Rutgers and Montclair separately should not have to
 * re-upload either PDF to see them together: the structured coursework is
 * already saved. Everything here is a pure, synchronous transformation of
 * coursework the user already owns -- no PDF extraction, no analyzer call, no
 * transcript-analysis cost.
 *
 * Two rules govern the whole module:
 *
 *   1. Combining CREATES. It never mutates a source. "Rutgers + Montclair" is a
 *      new, independent analysis; Rutgers still holds its own 27 rows and
 *      Montclair its own 45. (This replaced an earlier behavior that appended
 *      copied coursework into whichever analysis happened to be open, which
 *      turned a 27-course Rutgers analysis into a 72-course one.)
 *
 *   2. Combining COPIES. It does not link. Editing a source afterwards must
 *      never reach into a combined analysis built from it, and vice versa.
 *
 * Because every combination produces a new analysis, combined analyses can
 * themselves be combined -- so each copied row carries the trail of analyses it
 * came through, and overlapping sources are refused before anything is copied.
 */

import {
  MAX_ANALYSES_PER_USER, MAX_COURSES_PER_ANALYSIS,
  analysisNameFromInstitutions, resolveAnalysisName,
} from './analyses.ts'
import { applyTransferLinks, planTransferLinks } from './transferLinks.ts'
import { DEFAULT_POLICIES, type Course, type GpaPolicies, type Institution } from './types.ts'

export interface CombineSource {
  id: string
  name: string
  courses: readonly Course[]
  policies: GpaPolicies
}

/** Fresh, collision-proof ids for the destination analysis. */
export type MakeId = (index: number) => string

export const defaultMakeId: MakeId = i =>
  `c-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`

/**
 * The analyses a row has been copied from, oldest first.
 *
 * Falls back to the pre-D47 single-source marker so analyses created by the
 * older behavior are still protected against duplicate combining.
 */
export function provenanceOf(course: Course): readonly string[] {
  if (Array.isArray(course.provenance)) return course.provenance
  return course.copiedFrom ? [course.copiedFrom] : []
}

/**
 * Copies one analysis's coursework for another analysis.
 *
 * Every semantic field survives -- institution, code, title, credits, grade,
 * term, level, categories and their source, record type, transfer flags, review
 * state. Two things change: the generated id, because ids identify a row inside
 * one analysis and reusing them would collide, and the provenance trail, which
 * gains the analysis the row was taken from.
 */
export function copyCoursesFrom(
  source: CombineSource,
  makeId: MakeId = defaultMakeId,
  offset = 0,
): Course[] {
  const moved = new Map<string, string>()
  const copies = source.courses.map((c, i) => {
    const id = makeId(offset + i)
    moved.set(c.id, id)
    return { ...c, id, provenance: [...provenanceOf(c), source.id] }
  })
  return copies.map(c => remapTransferLink(c, moved))
}

/**
 * D55: a transfer link names its course by id, and every id here is new.
 *
 * Copying the old id verbatim left an established relationship pointing at a
 * course that exists only in the source analysis. Combining a 47-row analysis
 * that held eight valid links with a third transcript therefore produced eight
 * "the course this record was linked to has been edited" reviews, on an
 * analysis where nothing had been edited at all.
 *
 * The relationship travels; only its address is rewritten. What does not
 * change: whether the user or the automatic pass established it, a deliberate
 * "not in this analysis", and a link that was ALREADY pointing at nothing --
 * that one was stale before the copy and stays stale, because repairing it is
 * not this layer's business.
 */
function remapTransferLink(course: Course, moved: Map<string, string>): Course {
  const link = course.transferLink
  if (!link || link.courseId === null) return course
  const destination = moved.get(link.courseId)
  if (!destination) return course
  return { ...course, transferLink: { courseId: destination, source: link.source } }
}

/** How many rows in an analysis trace back to a given source analysis. */
export function copiedCountFrom(courses: readonly Course[], sourceId: string): number {
  return courses.filter(c => provenanceOf(c).includes(sourceId)).length
}

/**
 * Every analysis whose coursework this one holds, including itself.
 *
 * Derived from the rows that are actually present rather than from a stored
 * field, so it stays honest: if the user deletes all the Montclair rows out of
 * a combined analysis, Montclair is no longer part of it and may be combined in
 * again.
 */
export function analysisClosure(source: CombineSource): Set<string> {
  const ids = new Set<string>([source.id])
  for (const c of source.courses) for (const id of provenanceOf(c)) ids.add(id)
  return ids
}

export interface Overlap {
  /** 'contains': one source already holds the other's coursework. */
  kind: 'contains' | 'shared'
  container?: CombineSource
  contained?: CombineSource
  a?: CombineSource
  b?: CombineSource
  /** The analysis both sources drew from, for 'shared'. */
  sharedId?: string
}

/**
 * The first pair of sources that would duplicate coursework, if any.
 *
 * Compared by id, never by name, because analysis names are editable: renaming
 * "Rutgers + Montclair" to "Everything" must not make it look unrelated to
 * Montclair.
 */
export function findOverlap(sources: readonly CombineSource[]): Overlap | null {
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i], b = sources[j]
      const ca = analysisClosure(a), cb = analysisClosure(b)
      if (ca.has(b.id)) return { kind: 'contains', container: a, contained: b }
      if (cb.has(a.id)) return { kind: 'contains', container: b, contained: a }
      const sharedId = [...ca].find(id => cb.has(id))
      if (sharedId) return { kind: 'shared', a, b, sharedId }
    }
  }
  return null
}

/**
 * Policies for a NEW combined analysis.
 *
 * Deliberately conservative (D11/D21): a policy carries over only when every
 * source made the same explicit choice. Two analyses that disagree leave it
 * unset, so the user decides rather than inheriting whichever one happened to
 * be listed first. An unset policy holds coursework out; it never guesses.
 */
export function combinedPolicies(sources: readonly CombineSource[]): GpaPolicies {
  const agreed = <K extends keyof GpaPolicies>(key: K): GpaPolicies[K] => {
    const values = sources.map(s => s.policies?.[key] ?? null)
    if (values.length === 0) return DEFAULT_POLICIES[key]
    const first = values[0]
    if (first === null) return DEFAULT_POLICIES[key]
    return values.every(v => v === first) ? first : DEFAULT_POLICIES[key]
  }
  return { transfer: agreed('transfer'), retake: agreed('retake') }
}

/** "Rutgers + Montclair", with the existing unique-name suffixing. */
export function combinedNameFor(
  names: readonly string[],
  existing: readonly { name: string }[],
): string {
  const base = analysisNameFromInstitutions(names)
  return resolveAnalysisName(base, existing)
}

/**
 * D58: the schools a finished analysis actually contains, in a stable order.
 *
 * A combined analysis is named from THIS, never from the names of the analyses
 * it was built from. Those are one level of indirection away from the truth and
 * they lose history: combining "Ridgeview + Meridian" with Harbor named the
 * result from two labels and produced "Ridgeview + Harbor", which reads as if
 * Meridian had been dropped. The coursework knows better than the labels do.
 *
 * Ordered by where each school first appears in the coursework, so the same
 * sources in the same order always give the same name -- and so combining
 * A+B+C at once names identically to A+B then +C.
 */
export function institutionNamesInOrder(
  courses: readonly Course[], institutions: readonly Institution[],
): string[] {
  const byId = new Map(institutions.map(i => [i.id, i.name]))
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of courses) {
    if (!c.institutionId || seen.has(c.institutionId)) continue
    const name = byId.get(c.institutionId)
    if (!name) continue
    seen.add(c.institutionId)
    out.push(name)
  }
  return out
}

/**
 * The name for a finished combined analysis.
 *
 * Falls back to the source analyses' own names only when the institutions are
 * unknown -- with nothing else to go on, a label beats no name at all.
 */
function nameForCombined(input: {
  courses: readonly Course[]
  institutions?: readonly Institution[]
  fallbackNames: readonly string[]
  existingAnalyses: readonly { name: string }[]
}): string {
  const fromCoursework = institutionNamesInOrder(input.courses, input.institutions ?? [])
  const names = fromCoursework.length > 0 ? fromCoursework : input.fallbackNames
  return combinedNameFor(names, input.existingAnalyses)
}

export type CombineBlock =
  | 'too-few-sources'
  | 'self'
  | 'overlap'
  | 'analysis-limit'
  | 'course-limit'

export interface CombinePlan {
  ok: boolean
  block?: CombineBlock
  /** Short heading for the in-app message. Never a browser dialog. */
  title?: string
  message?: string
  courses?: Course[]
  policies?: GpaPolicies
  name?: string
  /** Rows the new analysis would hold once the plan is applied. */
  resultingCourses?: number
}

/** At least two analyses are needed before "combine" means anything. */
export const MIN_COMBINE_SOURCES = 2

/** Guards shared by both combine entry points. Returns null when clear. */
function refuse(
  sources: readonly CombineSource[],
  total: number,
  canCreate: boolean,
): CombinePlan | null {
  if (!canCreate) {
    return {
      ok: false, block: 'analysis-limit',
      title: 'Analysis limit reached',
      message: `Combining creates a new analysis, and you already have ` +
        `${MAX_ANALYSES_PER_USER}. Delete one first. Nothing was copied.`,
    }
  }
  if (total > MAX_COURSES_PER_ANALYSIS) {
    return {
      ok: false, block: 'course-limit', resultingCourses: total,
      title: 'Too many courses',
      message: `That combination would hold ${total} courses, which is more than the ` +
        `${MAX_COURSES_PER_ANALYSIS}-course limit for one analysis. Nothing was copied.`,
    }
  }
  return null
}

/**
 * Plans a NEW combined analysis from analyses the user already has.
 *
 * Nothing is written here; the caller applies the plan in one insert, so a
 * failure cannot leave a half-populated analysis, and cancelling can leave
 * nothing behind.
 */
export function planCombine(input: {
  sources: readonly CombineSource[]
  existingAnalyses: readonly { name: string }[]
  /** The user's institutions, so D50 can resolve an originating school. */
  institutions?: readonly Institution[]
  /** False once the 50-analysis cap is reached. */
  canCreate?: boolean
  makeId?: MakeId
  /** Names an ancestor analysis for the overlap message, when it is known. */
  nameFor?: (id: string) => string | null | undefined
}): CombinePlan {
  const { sources, existingAnalyses } = input

  if (sources.length < MIN_COMBINE_SOURCES) {
    return {
      ok: false, block: 'too-few-sources',
      message: `Choose at least ${MIN_COMBINE_SOURCES} analyses to combine.`,
    }
  }
  if (new Set(sources.map(s => s.id)).size !== sources.length) {
    return {
      ok: false, block: 'self',
      title: 'That is the same analysis',
      message: 'An analysis cannot be combined with itself.',
    }
  }

  const overlap = findOverlap(sources)
  if (overlap) {
    return {
      ok: false, block: 'overlap',
      title: 'These analyses overlap',
      message: overlapMessage(overlap, input.nameFor),
    }
  }

  const total = sources.reduce((n, s) => n + s.courses.length, 0)
  const refused = refuse(sources, total, input.canCreate !== false)
  if (refused) return refused

  const makeId = input.makeId ?? defaultMakeId
  const courses: Course[] = []
  for (const source of sources) courses.push(...copyCoursesFrom(source, makeId, courses.length))

  // D50: two transcripts only meet here, so this is where a receiving school's
  // transfer notation can finally be matched to the originating coursework it
  // documents. Only the NEW analysis is touched.
  const linked = linkTransfers(courses, input.institutions)

  return {
    ok: true,
    courses: linked,
    policies: combinedPolicies(sources),
    // D58: named from the schools the result actually holds, so a nested
    // combine names exactly as the same schools combined at once would.
    name: nameForCombined({
      courses: linked, institutions: input.institutions,
      fallbackNames: sources.map(s => s.name), existingAnalyses,
    }),
    resultingCourses: courses.length,
  }
}

/**
 * Runs D50 automatic linking over a freshly built combined analysis.
 *
 * Institutions are account-level, so the same rows the analysis already points
 * at are what an originating school resolves against. With none supplied
 * nothing is linked -- silence is the safe answer.
 */
function linkTransfers(courses: Course[], institutions?: readonly Institution[]): Course[] {
  if (!institutions || institutions.length === 0) return courses
  return applyTransferLinks(courses, planTransferLinks(courses, institutions))
}

/**
 * Plans a NEW combined analysis from the open analysis plus a transcript that
 * has just been analyzed.
 *
 * The uploaded PDF is analyzed once by the caller; the existing analysis is
 * never re-analyzed, because its coursework is already structured. The open
 * analysis is copied, not moved, so it survives unchanged.
 *
 * Policies start unset, exactly as a brand-new transcript analysis does: the
 * transcript itself carries no policy choice, so there is nothing for every
 * contributing source to agree on, and nothing is silently inherited.
 */
export function planCombineWithNewCourses(input: {
  current: CombineSource
  /** Freshly analyzed rows. They carry no provenance: they are new coursework. */
  incoming: readonly Course[]
  /** Institutions the transcript revealed, for naming. */
  incomingNames: readonly string[]
  existingAnalyses: readonly { name: string }[]
  /** The user's institutions, so D50 can resolve an originating school. */
  institutions?: readonly Institution[]
  canCreate?: boolean
  makeId?: MakeId
}): CombinePlan {
  const { current, incoming, existingAnalyses } = input

  const total = current.courses.length + incoming.length
  const refused = refuse([current], total, input.canCreate !== false)
  if (refused) return refused

  const makeId = input.makeId ?? defaultMakeId
  const copied = copyCoursesFrom(current, makeId, 0)
  // D50: the uploaded transcript may itself be the receiving school, or the
  // originating one. Either way the pair is only complete here.
  const linked = linkTransfers([...copied, ...incoming], input.institutions)

  return {
    ok: true,
    courses: linked,
    policies: DEFAULT_POLICIES,
    // D58: the same rule as any other combine -- the schools in the result.
    name: nameForCombined({
      courses: linked, institutions: input.institutions,
      fallbackNames: [current.name, ...input.incomingNames], existingAnalyses,
    }),
    resultingCourses: total,
  }
}

function overlapMessage(
  o: Overlap, nameFor?: (id: string) => string | null | undefined,
): string {
  if (o.kind === 'contains') {
    return `“${o.container!.name}” already contains coursework from “${o.contained!.name}.” ` +
      `Combining them again would duplicate coursework. Choose a different combination.`
  }
  const shared = o.sharedId ? nameFor?.(o.sharedId) : null
  return `“${o.a!.name}” and “${o.b!.name}” both contain coursework from ` +
    (shared ? `“${shared}.”` : 'the same earlier analysis.') +
    ` Combining them would duplicate coursework. Choose a different combination.`
}

/**
 * Institutions the combined coursework refers to.
 *
 * Institutions are account-level, so two analyses that both use Rutgers keep
 * pointing at the same row -- combining never duplicates a school.
 */
export function institutionsForCombined(
  courses: readonly Course[],
  institutions: readonly Institution[],
): Institution[] {
  const used = new Set<string>()
  for (const c of courses) if (c.institutionId) used.add(c.institutionId)
  return institutions.filter(i => used.has(i.id))
}
