import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateGPA, resolveGradePoints, effectiveScale, classifyGrade } from './engine.ts'
import {
  STANDARD_SCALE, STANDARD_GRADE_POINTS, gradingScaleStatus,
  DEFAULT_POLICIES, type Course, type Institution, type GradingScale,
} from './types.ts'

const RUTGERS: GradingScale = { source: 'transcript',
  points: { 'A': 4.0, 'B+': 3.5, 'B': 3.0, 'C+': 2.5, 'C': 2.0, 'D': 1.0, 'F': 0.0 } }
const GENERIC: GradingScale = { source: 'user', points: { ...STANDARD_GRADE_POINTS } }

const inst = (id: string, name: string, scale: GradingScale | null = null): Institution =>
  ({ id, name, creditSystem: 'semester', gradingScale: scale })

const C = (o: Partial<Course> & { grade: string; credits: number; institutionId: string | null }): Course => ({
  id: o.id ?? 'c' + Math.random(), institutionId: o.institutionId, courseCode: o.courseCode ?? null,
  name: o.name ?? 'Course', grade: o.grade, credits: o.credits,
  year: o.year ?? '2023', term: o.term ?? 'Fall',
  categories: o.categories ?? ['general'], categorySource: 'default',
  level: o.level ?? 'undergraduate', levelSource: 'default',
  recordType: o.recordType ?? 'coursework', transferredIn: o.transferredIn ?? false,
  needsReview: false, reviewReasons: [],
})
const P = { transfer: 'exclude' as const, retake: 'both' as const }

// ------------------------------------------------------------------ D38
test('D38: MIXED SCALE — the same grade scores differently per institution', () => {
  const A = inst('A', 'Institution A', { source: 'user', points: { 'B+': 3.5 } })
  const B = inst('B', 'Institution B', { source: 'user', points: { 'B+': 3.3 } })
  const courses = [
    C({ grade: 'B+', credits: 4, institutionId: 'A' }),
    C({ grade: 'B+', credits: 4, institutionId: 'B' }),
  ]
  assert.equal(resolveGradePoints('B+', 'A', [A, B]), 3.5)
  assert.equal(resolveGradePoints('B+', 'B', [A, B]), 3.3)
  const r = calculateGPA(courses, 'overall', { institutions: [A, B], policies: P })
  // (3.5*4 + 3.3*4) / 8 = 3.40 -- neither institution's scale applied to both
  assert.equal(r.qualityPoints, 3.5 * 4 + 3.3 * 4)
  assert.equal(r.creditsCounted, 8)
  assert.equal(r.display, '3.40')
  assert.notEqual(r.display, '3.50')   // not all-A
  assert.notEqual(r.display, '3.30')   // not all-B
})

test('D38: mixed scale with different credits weights correctly', () => {
  const A = inst('A', 'A', { source: 'user', points: { 'B+': 3.5 } })
  const B = inst('B', 'B', { source: 'user', points: { 'B+': 3.3 } })
  const r = calculateGPA([
    C({ grade: 'B+', credits: 6, institutionId: 'A' }),
    C({ grade: 'B+', credits: 2, institutionId: 'B' }),
  ], 'overall', { institutions: [A, B], policies: P })
  assert.equal(r.display, ((3.5 * 6 + 3.3 * 2) / 8).toFixed(2))
})

test('D38: every GPA type uses the per-institution scale', () => {
  const R = inst('R', 'Rutgers', RUTGERS)
  const courses = [
    C({ grade: 'B+', credits: 4, institutionId: 'R', categories: ['science'] }),
    C({ grade: 'B+', credits: 4, institutionId: 'R', categories: ['nursing'] }),
    C({ grade: 'B+', credits: 4, institutionId: 'R', level: 'graduate' }),
  ]
  const ctx = { institutions: [R], policies: P }
  for (const f of ['overall', 'science', 'nursing', 'graduate', 'last60'] as const) {
    const r = calculateGPA(courses, f, ctx)
    if (r.value !== null) assert.equal(r.display, '3.50', `filter ${f} used the Rutgers scale`)
  }
})

test('D38: the Rutgers scale reproduces the transcript GPA', () => {
  const R = inst('R', 'Rutgers', RUTGERS)
  // 62 credits engineered to land on the transcript's reported 3.323.
  const courses = [
    C({ grade: 'A',  credits: 20, institutionId: 'R' }),
    C({ grade: 'B+', credits: 18, institutionId: 'R' }),
    C({ grade: 'B',  credits: 16, institutionId: 'R' }),
    C({ grade: 'C+', credits: 8,  institutionId: 'R' }),
  ]
  const r = calculateGPA(courses, 'overall', { institutions: [R], policies: P })
  assert.equal(r.creditsCounted, 62)
  const expected = (4 * 20 + 3.5 * 18 + 3 * 16 + 2.5 * 8) / 62
  assert.equal(r.display, expected.toFixed(2))
  // The same courses on the generic scale give a materially lower number.
  const G = inst('R', 'Rutgers', GENERIC)
  const generic = calculateGPA(courses, 'overall', { institutions: [G], policies: P })
  assert.notEqual(generic.display, r.display)
  assert.ok(Number(generic.display) < Number(r.display), 'generic under-reports')
})

// ------------------------------------------------------------------ D39
test('D39: no scale -> standard fallback, and it still calculates', () => {
  const U = inst('U', 'Unconfirmed U', null)
  assert.deepEqual(effectiveScale('U', [U]), STANDARD_SCALE)
  const r = calculateGPA([C({ grade: 'B+', credits: 3, institutionId: 'U' })],
    'overall', { institutions: [U], policies: P })
  assert.equal(r.display, '3.30', 'generic B+ applied')
  assert.equal(r.issues.length, 0, 'not blocked')
})

test('D39: status wording never leaks the raw enum', () => {
  assert.equal(gradingScaleStatus(null), 'Standard scale — unconfirmed')
  assert.equal(gradingScaleStatus({ source: 'default', points: {} }), 'Standard scale — unconfirmed')
  assert.equal(gradingScaleStatus({ source: 'transcript', points: {} }), 'Detected from transcript')
  assert.equal(gradingScaleStatus({ source: 'user', points: {} }), 'User confirmed')
})

test('D39: an unknown institution id falls back to standard, not to nothing', () => {
  assert.deepEqual(effectiveScale('missing', [inst('X', 'X')]), STANDARD_SCALE)
  assert.deepEqual(effectiveScale(null, []), STANDARD_SCALE)
})

// ------------------------------------------------------------------ D40
test('D40: recognised grade absent from the scale is NOT silently scored', () => {
  const R = inst('R', 'Rutgers', RUTGERS)          // has no A-
  assert.equal(classifyGrade('A-'), 'graded', 'A- is a real grade')
  assert.equal(resolveGradePoints('A-', 'R', [R]), null, 'but unscorable here')
  const r = calculateGPA([
    C({ grade: 'A',  credits: 4, institutionId: 'R' }),
    C({ grade: 'A-', credits: 4, institutionId: 'R' }),
  ], 'overall', { institutions: [R], policies: P })
  assert.equal(r.creditsCounted, 4, 'A- credits excluded from the denominator')
  assert.equal(r.qualityPoints, 16, 'and from the numerator')
  assert.equal(r.display, '4.00')
  assert.notEqual(r.display, ((16 + 3.7 * 4) / 8).toFixed(2), 'did NOT borrow generic 3.7')
  assert.equal(r.exclusions['grade-not-in-scale'], 1)
  const issue = r.issues.find(i => i.reason === 'grade-not-in-scale')
  assert.ok(issue, 'flagged for review')
  assert.match(issue!.detail, /Rutgers/)
  assert.match(issue!.detail, /A-/)
})

test('D40: adding the grade to the scale makes the course scorable immediately', () => {
  const before = inst('R', 'Rutgers', RUTGERS)
  const after  = inst('R', 'Rutgers', { source: 'user', points: { ...RUTGERS.points, 'A-': 3.7 } })
  const courses = [
    C({ grade: 'A',  credits: 4, institutionId: 'R' }),
    C({ grade: 'A-', credits: 4, institutionId: 'R' }),
  ]
  const r1 = calculateGPA(courses, 'overall', { institutions: [before], policies: P })
  assert.equal(r1.creditsCounted, 4)
  const r2 = calculateGPA(courses, 'overall', { institutions: [after], policies: P })
  assert.equal(r2.creditsCounted, 8, 'now counted')
  assert.equal(r2.display, ((16 + 3.7 * 4) / 8).toFixed(2))
  // Nothing was stored on the course; correcting the scale re-scored it.
  assert.equal(courses[1].grade, 'A-')
})

test('D40: unscorable courses are excluded from Last 60 too', () => {
  const R = inst('R', 'Rutgers', RUTGERS)
  const r = calculateGPA([
    C({ grade: 'A-', credits: 4, institutionId: 'R', year: '2025', term: 'Fall' }),
    C({ grade: 'A',  credits: 4, institutionId: 'R', year: '2024', term: 'Fall' }),
  ], 'last60', { institutions: [R], policies: P })
  assert.equal(r.creditsCounted, 4)
  assert.equal(r.display, '4.00')
})

test('D40: an unrecognised grade is still a different problem from unscorable', () => {
  const R = inst('R', 'Rutgers', RUTGERS)
  const r = calculateGPA([C({ grade: 'ZZ', credits: 3, institutionId: 'R' })],
    'overall', { institutions: [R], policies: P })
  assert.equal(r.issues[0].reason, 'unrecognized-grade')
  assert.equal(r.exclusions['grade-not-in-scale'], undefined)
})

test('D40: non-GPA grades are unaffected by scales', () => {
  const R = inst('R', 'Rutgers', RUTGERS)
  const r = calculateGPA([
    C({ grade: 'A', credits: 4, institutionId: 'R' }),
    C({ grade: 'W', credits: 3, institutionId: 'R' }),
  ], 'overall', { institutions: [R], policies: P })
  assert.equal(r.display, '4.00')
  assert.equal(r.creditsCounted, 4)
})

// --------------------------------------------------- precedence & transfer
test('scale precedence: user > transcript > default', () => {
  const order = (s: GradingScale | null) => gradingScaleStatus(s)
  assert.equal(order(null), 'Standard scale — unconfirmed')
  assert.equal(order({ source: 'transcript', points: { A: 4 } }), 'Detected from transcript')
  assert.equal(order({ source: 'user', points: { A: 4 } }), 'User confirmed')
  // A user scale must win even when a transcript scale exists for the same school.
  const userScale: GradingScale = { source: 'user', points: { 'B+': 3.9 } }
  const R = inst('R', 'Rutgers', userScale)
  assert.equal(resolveGradePoints('B+', 'R', [R]), 3.9)
})

test('transfer_notation never scores, whatever the scale says', () => {
  const R = inst('R', 'Rutgers', RUTGERS)
  const r = calculateGPA([
    C({ grade: 'A', credits: 4, institutionId: 'R', recordType: 'transfer_notation' }),
  ], 'overall', { institutions: [R], policies: P })
  assert.equal(r.value, null)
  assert.equal(r.exclusions['transfer-notation'], 1)
})

test('retake grouping is unchanged; each attempt uses its own scale', () => {
  const A = inst('A', 'A', { source: 'user', points: { 'C': 2.0, 'B+': 3.5 } })
  const B = inst('B', 'B', { source: 'user', points: { 'C': 2.0, 'B+': 3.3 } })
  const first  = C({ grade: 'C',  credits: 4, courseCode: 'BIO101', institutionId: 'A', year: '2021' })
  const second = C({ grade: 'B+', credits: 4, courseCode: 'BIO101', institutionId: 'B', year: '2023' })
  // Different institutions -> NOT a retake pair; both count, each on its own scale.
  const r = calculateGPA([first, second], 'overall',
    { institutions: [A, B], policies: { transfer: 'exclude', retake: 'latest' } })
  assert.equal(r.coursesCounted, 2)
  assert.equal(r.display, ((2.0 * 4 + 3.3 * 4) / 8).toFixed(2))
})
