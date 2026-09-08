import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTranscriptTotals, reconcile, transcriptNative, scoreAttempt, pickBestAttempt,
  gradesMissingFromScale,
} from './reconcile.ts'
import type { Course, Institution } from './types.ts'

const INST: Institution[] = [{ id: 'M', name: 'Montclair State University', creditSystem: 'semester', gradingScale: null }]

const C = (o: Partial<Course> & { grade: string; credits: number }): Course => ({
  id: o.id ?? 'c' + Math.random(), institutionId: o.institutionId ?? 'M',
  courseCode: o.courseCode ?? null, name: o.name ?? 'Course',
  grade: o.grade, credits: o.credits, year: o.year ?? '2018', term: o.term ?? 'Fall',
  categories: ['general'], categorySource: 'ai', level: 'undergraduate', levelSource: 'default',
  recordType: o.recordType ?? 'coursework', transferredIn: false, needsReview: false, reviewReasons: [],
})

// The real block, verbatim from the extracted Montclair payload.
const MONTCLAIR_TOTALS = `
Ehrs: | 12.000 QPts: | 48.000
GPA-Hrs: | 12.000 GPA: | 4.000
********************** TRANSCRIPT TOTALS ***********************
INSTITUTION | Ehrs: | 131.000 QPts: | 448.900
GPA-Hrs: | 128.000 GPA: | 3.507
TRANSFER | Ehrs: | 0.000 QPts: | 0.000
GPA-Hrs: | 0.000 GPA: | 0.000
OVERALL | Ehrs: | 131.000 QPts: | 448.900
GPA-Hrs: | 128.000 GPA: | 3.507
`

// --------------------------------------------------------------- parsing
test('D44: printed totals are read from the transcript totals block', () => {
  const t = parseTranscriptTotals(MONTCLAIR_TOTALS)
  const overall = t.find(x => x.scope === 'overall')!
  assert.equal(overall.earnedHours, 131)
  assert.equal(overall.qualityPoints, 448.9)
  assert.equal(overall.gpaHours, 128)
  assert.equal(overall.gpa, 3.507)
})

test('D44: per-term subtotals above the totals block are never mistaken for document totals', () => {
  const t = parseTranscriptTotals(MONTCLAIR_TOTALS)
  assert.ok(!t.some(x => x.gpaHours === 12), 'the Fall term subtotal is not a document total')
  assert.equal(t.length, 3)
})

test('D44: a transcript printing no totals yields no signal, not a failure', () => {
  assert.deepEqual(parseTranscriptTotals('BIOL 101 General Biology 3.000 A'), [])
  const r = reconcile([C({ grade: 'A', credits: 3 })], 'M', INST, [])
  assert.equal(r.status, 'no-signal')
  assert.equal(r.checks.length, 0)
})

// ---------------------------------------------------- the real Montclair case
/**
 * A complete reading: 128 graded credits worth exactly 448.900 quality points.
 * 64.9 cr at A (4.0) = 259.60 and 63.1 cr at B (3.0) = 189.30.
 */
const COMPLETE = () => [
  C({ name: 'A block', grade: 'A', credits: 64.9 }),
  C({ name: 'B block', grade: 'B', credits: 63.1 }),
]

test('D44: a complete Montclair reading reconciles on both checks', () => {
  const r = reconcile(COMPLETE(), 'M', INST, parseTranscriptTotals(MONTCLAIR_TOTALS))
  assert.equal(r.status, 'reconciled')
  const qp = r.checks.find(c => c.name === 'quality points')!
  assert.equal(qp.printed, 448.9)
  assert.ok(Math.abs(qp.delta) <= 0.05, `quality points off by ${qp.delta}`)
  const cr = r.checks.find(c => c.name === 'graded credits')!
  assert.equal(cr.computed, 128)
  assert.equal(cr.ok, true)
})

test('D44: the reported 121-credit run is caught as an incomplete read', () => {
  // The bad run lost 7 graded credits: 61.4 cr A + 59.6 cr B = 424.40 qp.
  const courses = [
    C({ name: 'A block', grade: 'A', credits: 61.4 }),
    C({ name: 'B block', grade: 'B', credits: 59.6 }),
  ]
  const totals = parseTranscriptTotals(MONTCLAIR_TOTALS)
  const r = reconcile(courses, 'M', INST, totals)
  assert.equal(r.status, 'mismatch')
  assert.equal(r.missingCredits, 7)
  assert.match(r.message!, /128 graded credits but only 121 were read/)
  assert.equal(r.checks.find(c => c.name === 'quality points')!.ok, false)
  assert.equal(r.checks.find(c => c.name === 'graded credits')!.ok, false)
})

test('D44: extra credits from a registrar-excluded repeat do NOT fail completeness', () => {
  // 128 counted by the registrar + a 3-credit F the transcript excluded.
  const courses = [...COMPLETE(), C({ name: 'excluded repeat', grade: 'F', credits: 3 })]
  const totals = parseTranscriptTotals(MONTCLAIR_TOTALS)
  const r = reconcile(courses, 'M', INST, totals)
  const credits = r.checks.find(c => c.name === 'graded credits')!
  assert.equal(credits.computed, 131)
  assert.equal(credits.ok, true, 'more than the registrar counted is fine')
  assert.match(credits.note!, /excluded a repeated attempt/)
  assert.equal(r.status, 'reconciled', 'the F adds zero quality points, so this still reconciles')
})

test('D44: transfer notation and non-GPA grades are outside the native view', () => {
  const courses = [
    C({ name: 'graded', grade: 'A', credits: 3 }),
    C({ name: 'withdrew', grade: 'WD', credits: 3 }),
    C({ name: 'pass', grade: 'P', credits: 3 }),
    { ...C({ name: 'notation', grade: 'TR', credits: 3 }), recordType: 'transfer_notation' as const },
    C({ name: 'other school', grade: 'A', credits: 3, institutionId: 'OTHER' }),
  ]
  const native = transcriptNative(courses, 'M')
  assert.deepEqual(native.map(c => c.name), ['graded'])
})

test('D44: printed totals never become the GPA - reconcile returns no course data', () => {
  const totals = parseTranscriptTotals(MONTCLAIR_TOTALS)
  const r = reconcile(COMPLETE(), 'M', INST, totals)
  assert.ok(!('gpa' in r), 'the result carries checks, never a GPA to display')
  assert.ok(!('courses' in r), 'reconciliation never returns coursework')
})

test('D44: grades the scale cannot score make the totals untrustworthy', () => {
  const courses = [...COMPLETE(), C({ name: 'odd', grade: 'ZZ', credits: 3 })]
  const totals = parseTranscriptTotals(MONTCLAIR_TOTALS)
  const r = reconcile(courses, 'M', INST, totals)
  const check = r.checks.find(c => c.name === 'grades outside the scale')
  assert.ok(check, 'unscoreable grades are reported')
  assert.equal(r.status, 'mismatch')
})

// ------------------------------------------------------- attempt selection
const totals = parseTranscriptTotals(MONTCLAIR_TOTALS)
const attempt = (courses: Course[]) =>
  ({ value: courses, score: scoreAttempt(courses, 'M', INST, totals) })

test('D44: a reconciling attempt beats a non-reconciling one', () => {
  const bad = attempt([
    C({ name: 'A block', grade: 'A', credits: 61.4 }),
    C({ name: 'B block', grade: 'B', credits: 59.6 }),
  ])
  const good = attempt([...COMPLETE(), C({ name: 'f', grade: 'F', credits: 3 })])
  assert.equal(pickBestAttempt([bad, good])!.value, good.value)
  assert.equal(pickBestAttempt([good, bad])!.value, good.value, 'order does not matter')
})

test('D44: more rows alone never wins - fabrication cannot buy the choice', () => {
  const honest = attempt(COMPLETE())
  // Same reading plus invented coursework that pushes the totals past the truth.
  const padded = attempt([...COMPLETE(),
    C({ name: 'invented1', grade: 'A', credits: 4 }), C({ name: 'invented2', grade: 'A', credits: 4 })])
  assert.ok(padded.score.courses > honest.score.courses)
  assert.ok(padded.score.qualityPointDelta > honest.score.qualityPointDelta,
    'invented credits move quality points away from the printed value')
  assert.equal(pickBestAttempt([padded, honest])!.value, honest.value)
})

test('D44: duplicated rows disqualify an attempt outright', () => {
  const dup = C({ id: 'x', name: 'dup', grade: 'A', credits: 64.9, courseCode: 'X 1' })
  const withDupes = attempt([dup, { ...dup, id: 'y' }, C({ name: 'B block', grade: 'B', credits: 63.1 })])
  const clean = attempt(COMPLETE())
  assert.equal(withDupes.score.duplicates, 1)
  assert.equal(pickBestAttempt([withDupes, clean])!.value, clean.value)
})

test('D44: among reconciling attempts, cleaner term data wins', () => {
  const base = COMPLETE()
  const withUnknown = attempt(base.map(c => ({ ...c, term: undefined, year: undefined })))
  const withTerms = attempt(base)
  assert.equal(withUnknown.score.unknownTerms, 2)
  assert.equal(pickBestAttempt([withUnknown, withTerms])!.value, withTerms.value)
})

// ------------------------------------- scale completeness as a retry trigger
test('D44/scale: a scale that cannot score the coursework in hand is incomplete', () => {
  const courses = [
    C({ name: 'a', grade: 'A', credits: 3 }),
    C({ name: 'b', grade: 'B+', credits: 3 }),
    C({ name: 'c', grade: 'C+', credits: 5 }),
  ]
  const partial = { A: 4.0, 'B+': 3.5, B: 3.0 }
  assert.deepEqual(gradesMissingFromScale(courses, 'R', partial), ['C+'])
  const full = { ...partial, 'C+': 2.5 }
  assert.deepEqual(gradesMissingFromScale(courses, 'R', full), [])
})

test('D44/scale: non-GPA grades and notation rows never demand a scale entry', () => {
  const courses = [
    C({ name: 'w', grade: 'WD', credits: 3 }),
    C({ name: 'p', grade: 'P', credits: 3 }),
    { ...C({ name: 'n', grade: 'TR', credits: 3 }), recordType: 'transfer_notation' as const },
  ]
  assert.deepEqual(gradesMissingFromScale(courses, 'R', { A: 4.0 }), [])
})

test('D44/scale: no detected scale is not an incomplete scale', () => {
  const courses = [C({ name: 'c', grade: 'C+', credits: 3 })]
  assert.deepEqual(gradesMissingFromScale(courses, 'R', null), [])
  assert.deepEqual(gradesMissingFromScale(courses, 'R', {}), [])
})
