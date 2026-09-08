/**
 * D44 - reconciling an extraction against the totals the transcript prints.
 *
 * A transcript that prints its own GPA hours and quality points is stating what
 * a complete reading of it should add up to. That is an integrity signal, and
 * nothing more: it NEVER becomes the user's GPA, and it never overwrites a
 * course. CRNAPrepHub still calculates from courses, grades, credits, the
 * institution's scale and the user's policies.
 *
 * The reconciliation is deliberately done on the TRANSCRIPT-NATIVE view --
 * every graded attempt at that institution -- and not on the user's policy
 * view. A user who later chooses "count both attempts" is intentionally
 * disagreeing with the registrar, and that disagreement must not be reported as
 * a failed import.
 */

import { normalizeGrade, resolveGradePoints } from './engine.ts'
import { NON_GPA_GRADES, RECOGNIZED_LETTER_GRADES, type Course, type Institution } from './types.ts'

export type TotalsScope = 'institution' | 'transfer' | 'overall'

export interface TranscriptTotals {
  scope: TotalsScope
  earnedHours?: number
  qualityPoints?: number
  gpaHours?: number
  gpa?: number
}

const NUM = '([0-9]+(?:\\.[0-9]+)?)'

/**
 * Reads the printed totals block. Only labelled, document-stated numbers are
 * returned; nothing is inferred, and term-level subtotals are ignored because
 * they cannot be matched to a scope.
 */
export function parseTranscriptTotals(text: string): TranscriptTotals[] {
  const raw = String(text ?? '')
  // Prefer the explicit totals section when the document marks one, so per-term
  // subtotals printed further up can never be mistaken for a document total.
  const marker = raw.search(/TRANSCRIPT\s+TOTALS/i)
  const region = marker >= 0 ? raw.slice(marker) : raw
  // Separators vary ("Ehrs: | 131.000", "Ehrs: 131.000"), so pipes and spaces
  // are both treated as whitespace before matching.
  const flat = region.replace(/\|/g, ' ').replace(/[ \t]+/g, ' ')

  const out: TranscriptTotals[] = []
  const scopeRe = /\b(INSTITUTION|TRANSFER|OVERALL)\b/gi
  const marks: { scope: TotalsScope; at: number }[] = []
  let m: RegExpExecArray | null
  while ((m = scopeRe.exec(flat))) {
    marks.push({ scope: m[1].toLowerCase() as TotalsScope, at: m.index })
  }
  for (let i = 0; i < marks.length; i++) {
    const slice = flat.slice(marks[i].at, marks[i + 1]?.at ?? flat.length)
    const ehrs = new RegExp(`Ehrs:?\\s*${NUM}`, 'i').exec(slice)
    const qpts = new RegExp(`QPts:?\\s*${NUM}`, 'i').exec(slice)
    const gpah = new RegExp(`GPA-?Hrs:?\\s*${NUM}`, 'i').exec(slice)
    const gpa = new RegExp(`GPA:?\\s*${NUM}`, 'i').exec(slice.replace(/GPA-?Hrs:?\s*[0-9.]+/i, ''))
    if (!ehrs && !qpts && !gpah && !gpa) continue
    const t: TranscriptTotals = { scope: marks[i].scope }
    if (ehrs) t.earnedHours = Number(ehrs[1])
    if (qpts) t.qualityPoints = Number(qpts[1])
    if (gpah) t.gpaHours = Number(gpah[1])
    if (gpa) t.gpa = Number(gpa[1])
    // A scope repeated later in the document supersedes an earlier partial one.
    const prev = out.findIndex(x => x.scope === t.scope)
    if (prev >= 0) out[prev] = t
    else out.push(t)
  }
  return out
}

/** Printed values carry three decimals, so this absorbs rounding, nothing more. */
export const QUALITY_POINT_TOLERANCE = 0.05
export const CREDIT_TOLERANCE = 0.001

export interface ReconcileCheck {
  name: string
  printed: number
  computed: number
  delta: number
  ok: boolean
  note?: string
}

export type ReconcileStatus = 'reconciled' | 'mismatch' | 'no-signal'

export interface ReconcileResult {
  status: ReconcileStatus
  checks: ReconcileCheck[]
  /** Credits we appear to be missing, when completeness fails. */
  missingCredits?: number
  message?: string
}

/** The transcript-native view: every graded attempt the registrar would count. */
export function transcriptNative(
  courses: readonly Course[],
  institutionId: string | null,
) {
  return courses.filter(c =>
    c.institutionId === institutionId &&
    c.recordType === 'coursework' &&
    !NON_GPA_GRADES.has(normalizeGrade(c.grade)))
}

/**
 * Compares an extraction against the printed totals.
 *
 * Two independent checks, because either one alone can be fooled:
 *
 *   quality points - exact. A repeat the registrar excluded is almost always an
 *                    F, contributing zero, so including it does not move this
 *                    number. Dropping a real course always does.
 *   completeness   - our graded credits must be at least the printed GPA hours.
 *                    Fewer means rows were lost.
 */
export function reconcile(
  courses: readonly Course[],
  institutionId: string | null,
  institutions: readonly Institution[] | undefined,
  totals: readonly TranscriptTotals[],
): ReconcileResult {
  const t = totals.find(x => x.scope === 'overall')
    ?? totals.find(x => x.scope === 'institution')
  if (!t || (t.qualityPoints === undefined && t.gpaHours === undefined)) {
    return { status: 'no-signal', checks: [] }
  }

  const native = transcriptNative(courses, institutionId)
  let credits = 0, qp = 0, unscored = 0
  for (const c of native) {
    const cr = Number(c.credits)
    if (!Number.isFinite(cr) || cr <= 0) continue
    const pts = resolveGradePoints(c.grade, c.institutionId, institutions)
    if (pts === null) { unscored++; continue }
    credits += cr
    qp += pts * cr
  }

  const checks: ReconcileCheck[] = []

  if (t.qualityPoints !== undefined) {
    const delta = qp - t.qualityPoints
    checks.push({
      name: 'quality points', printed: t.qualityPoints,
      computed: Number(qp.toFixed(3)), delta: Number(delta.toFixed(3)),
      ok: Math.abs(delta) <= QUALITY_POINT_TOLERANCE,
    })
  }

  let missingCredits: number | undefined
  if (t.gpaHours !== undefined) {
    const delta = credits - t.gpaHours
    const ok = delta >= -CREDIT_TOLERANCE
    if (!ok) missingCredits = Number((-delta).toFixed(3))
    checks.push({
      name: 'graded credits', printed: t.gpaHours, computed: Number(credits.toFixed(3)),
      delta: Number(delta.toFixed(3)), ok,
      note: delta > CREDIT_TOLERANCE
        ? 'more than the registrar counted, which is expected when the transcript excluded a repeated attempt'
        : undefined,
    })
  }

  if (unscored > 0) {
    checks.push({
      name: 'grades outside the scale', printed: 0, computed: unscored, delta: unscored,
      ok: false, note: 'these could not be scored, so the totals above are incomplete',
    })
  }

  const failed = checks.filter(c => !c.ok)
  if (failed.length === 0) return { status: 'reconciled', checks }

  return {
    status: 'mismatch', checks, missingCredits,
    message: missingCredits !== undefined
      ? `The transcript reports ${t.gpaHours} graded credits but only ${credits.toFixed(0)} were read, ` +
        `so about ${missingCredits} credits of coursework are missing.`
      : 'The coursework read from this transcript does not add up to the totals it prints.',
  }
}

/**
 * D44, applied to the grading scale: a detected scale must cover every grade
 * the coursework actually uses at that institution.
 *
 * A dense legend is sometimes transcribed only partway, and the result looks
 * plausible -- a scale with A, B+ and B but no C+ scores most courses and
 * silently drops the rest under D40. Comparing the scale against the grades in
 * hand catches that without inventing a single point value: the answer is to
 * read the document again, never to assume what C+ is worth.
 */
export function gradesMissingFromScale(
  courses: readonly Course[],
  institutionName: string | null | undefined,
  scalePoints: Readonly<Record<string, number>> | null | undefined,
): string[] {
  if (!scalePoints || Object.keys(scalePoints).length === 0) return []
  const missing = new Set<string>()
  for (const c of courses) {
    if (c.recordType === 'transfer_notation') continue
    const g = normalizeGrade(c.grade)
    if (!g || NON_GPA_GRADES.has(g)) continue
    if (!RECOGNIZED_LETTER_GRADES.has(g)) continue
    if (!(g in scalePoints)) missing.add(g)
  }
  return [...missing].sort()
}

/**
 * Ranks competing extraction attempts. Reconciliation is necessary but never
 * sufficient: an attempt is preferred only when its course-level content also
 * holds up, so a lucky aggregate can never beat a coherent reading.
 */
export interface AttemptScore {
  reconciled: boolean
  qualityPointDelta: number
  courses: number
  gpaBearing: number
  unknownTerms: number
  duplicates: number
}

export function scoreAttempt(
  courses: readonly Course[],
  institutionId: string | null,
  institutions: readonly Institution[] | undefined,
  totals: readonly TranscriptTotals[],
): AttemptScore {
  const r = reconcile(courses, institutionId, institutions, totals)
  const qpCheck = r.checks.find(c => c.name === 'quality points')
  const native = transcriptNative(courses, institutionId)
  const seen = new Set<string>()
  let duplicates = 0
  for (const c of courses) {
    const k = [c.institutionId, c.courseCode, c.name, c.grade, c.credits, c.term, c.year].join('|')
    if (seen.has(k)) duplicates++
    seen.add(k)
  }
  return {
    reconciled: r.status === 'reconciled',
    qualityPointDelta: qpCheck ? Math.abs(qpCheck.delta) : Number.POSITIVE_INFINITY,
    courses: courses.length,
    gpaBearing: native.length,
    unknownTerms: courses.filter(c => !c.term || !c.year).length,
    duplicates,
  }
}

/**
 * Picks between attempts. Order matters: a reconciled attempt wins, then the
 * one closest on quality points, then the one with cleaner structure. Course
 * count is the LAST tiebreak so "more rows" can never buy a win on its own --
 * that is how fabricated coursework would sneak in.
 */
export function pickBestAttempt<T>(
  attempts: readonly { value: T; score: AttemptScore }[],
): { value: T; score: AttemptScore } | null {
  if (attempts.length === 0) return null
  return [...attempts].sort((a, b) => {
    if (a.score.duplicates !== b.score.duplicates) return a.score.duplicates - b.score.duplicates
    if (a.score.reconciled !== b.score.reconciled) return a.score.reconciled ? -1 : 1
    if (a.score.qualityPointDelta !== b.score.qualityPointDelta)
      return a.score.qualityPointDelta - b.score.qualityPointDelta
    if (a.score.unknownTerms !== b.score.unknownTerms) return a.score.unknownTerms - b.score.unknownTerms
    return b.score.courses - a.score.courses
  })[0]
}
