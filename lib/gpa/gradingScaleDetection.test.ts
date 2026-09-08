import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateDetectedScale, planScaleMerge, sameScale, normalizeGradeSymbol,
  fromStoredScale, toStoredScale, parseScaleFromEvidence,
} from './gradingScale.ts'
import { calculateGPA } from './engine.ts'
import type { Course, GradingScale, Institution } from './types.ts'

const RUTGERS_POINTS = { A: 4.0, 'B+': 3.5, B: 3.0, 'C+': 2.5, C: 2.0, D: 1.0, F: 0.0 }
const ok = (points: Record<string, number>, extra: Record<string, unknown> = {}) =>
  ({ points, evidence: 'A | - Distinguished | 4.00', applicability: 'A. Standard (Exception: ...)', ...extra })

// ----------------------------------------------------------------- validation
test('SCALE: a legend with no quoted evidence is rejected', () => {
  const r = validateDetectedScale({ points: RUTGERS_POINTS, evidence: '', applicability: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.reason!, /evidence/i)
})

test('SCALE: out-of-range, non-numeric and empty point maps are rejected', () => {
  assert.equal(validateDetectedScale(ok({ A: 9 })).ok, false)
  assert.equal(validateDetectedScale(ok({ A: -1 })).ok, false)
  assert.equal(validateDetectedScale(ok({ A: 'four' as any })).ok, false)
  assert.equal(validateDetectedScale(ok({})).ok, false)
  assert.equal(validateDetectedScale(null).ok, false)
  assert.equal(validateDetectedScale([1, 2] as any).ok, false)
})

test('SCALE: grade symbols are normalized so "C -" and "C-" are one grade', () => {
  assert.equal(normalizeGradeSymbol(' c - '), 'C-')
  const r = validateDetectedScale(ok({ 'C -': 1.67 }))
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.scale!.points), ['C-'])
})

test('SCALE: the same symbol listed twice with different values is rejected', () => {
  const r = validateDetectedScale(ok({ 'B+': 3.5, 'b +': 3.3 }))
  assert.equal(r.ok, false)
})

// ----------------------------------------------------------------- precedence
const stored = (source: GradingScale['source'], points: Record<string, number>): GradingScale =>
  ({ source, points })

test('PRECEDENCE: null -> transcript is accepted', () => {
  const m = planScaleMerge(null, ok(RUTGERS_POINTS) as any)
  assert.equal(m.action, 'set')
  assert.equal(m.next!.source, 'transcript')
  assert.deepEqual(m.next!.points, RUTGERS_POINTS)
})

test('PRECEDENCE: default -> transcript is accepted (the default was an assumption)', () => {
  const m = planScaleMerge(stored('default', { 'B+': 3.3 }), ok(RUTGERS_POINTS) as any)
  assert.equal(m.action, 'set')
})

test('PRECEDENCE: transcript -> identical transcript is a no-op, not a rewrite', () => {
  const m = planScaleMerge(stored('transcript', RUTGERS_POINTS), ok({ ...RUTGERS_POINTS }) as any)
  assert.equal(m.action, 'noop')
  assert.equal(m.next, undefined)
})

test('PRECEDENCE: transcript -> conflicting transcript surfaces a conflict and writes nothing', () => {
  const m = planScaleMerge(stored('transcript', RUTGERS_POINTS), ok({ ...RUTGERS_POINTS, 'B+': 3.3 }) as any)
  assert.equal(m.action, 'conflict')
  assert.ok(m.current && m.next, 'both sides are offered to the user')
  assert.match(m.message!, /Nothing was changed/)
})

test('PRECEDENCE: a user-confirmed scale is NEVER overwritten by a transcript', () => {
  const m = planScaleMerge(stored('user', { 'B+': 3.3 }), ok(RUTGERS_POINTS) as any)
  assert.equal(m.action, 'blocked-user')
  assert.equal(m.next, undefined)
})

test('PRECEDENCE: no detected scale changes nothing', () => {
  assert.equal(planScaleMerge(null, null).action, 'none')
  assert.equal(planScaleMerge(stored('transcript', RUTGERS_POINTS), undefined).action, 'none')
})

test('SCALE: sameScale ignores key order but not values or size', () => {
  assert.equal(sameScale({ A: 4, B: 3 }, { B: 3, A: 4 }), true)
  assert.equal(sameScale({ A: 4, B: 3 }, { A: 4, B: 3.1 }), false)
  assert.equal(sameScale({ A: 4 }, { A: 4, B: 3 }), false)
})

// ------------------------------------------------------------ D39 null stays null
test('D39: a NULL stored scale reads back as null, never as source:"default"', () => {
  assert.equal(fromStoredScale(null), null)
  assert.equal(fromStoredScale(undefined), null)
  // and a null scale serializes back to NULL, so loading a page writes nothing
  assert.equal(toStoredScale(null), null)
  assert.equal(toStoredScale(fromStoredScale(null)), null)
})

test('D39: a malformed stored scale reads back as null rather than a partial scale', () => {
  assert.equal(fromStoredScale({ source: 'bogus', points: { A: 4 } }), null)
  assert.equal(fromStoredScale({ source: 'user' }), null)
  assert.equal(fromStoredScale('{"source":"user"}'), null)
})

test('STORAGE: a scale round-trips unchanged', () => {
  const s: GradingScale = { source: 'transcript', points: RUTGERS_POINTS }
  assert.deepEqual(fromStoredScale(toStoredScale(s)), s)
})

// ------------------------------------------------- cross-analysis recomputation
const C = (o: Partial<Course> & { grade: string; credits: number; institutionId: string }): Course => ({
  id: o.id ?? 'c' + Math.random(), institutionId: o.institutionId, courseCode: o.courseCode ?? null,
  name: o.name ?? 'Course', grade: o.grade, credits: o.credits, year: '2023', term: 'Fall',
  categories: ['general'], categorySource: 'default', level: 'undergraduate', levelSource: 'default',
  recordType: 'coursework', transferredIn: false, needsReview: false, reviewReasons: [],
})
const P = { transfer: 'exclude' as const, retake: 'both' as const }

test('CROSS-ANALYSIS: correcting a scale re-scores every analysis referencing it', () => {
  // Two separate analyses, same institution row.
  const analysisA = [C({ grade: 'B+', credits: 4, institutionId: 'R' })]
  const analysisB = [C({ grade: 'B+', credits: 3, institutionId: 'R' })]

  const before: Institution[] = [{ id: 'R', name: 'R', creditSystem: 'semester', gradingScale: null }]
  assert.equal(calculateGPA(analysisA, 'overall', { institutions: before, policies: P }).display, '3.30')
  assert.equal(calculateGPA(analysisB, 'overall', { institutions: before, policies: P }).display, '3.30')

  const after: Institution[] = [{ id: 'R', name: 'R', creditSystem: 'semester',
    gradingScale: { source: 'transcript', points: RUTGERS_POINTS } }]
  // No course was rewritten -- points resolve at calculation time, so both
  // analyses move together and neither can go stale.
  assert.equal(calculateGPA(analysisA, 'overall', { institutions: after, policies: P }).display, '3.50')
  assert.equal(calculateGPA(analysisB, 'overall', { institutions: after, policies: P }).display, '3.50')
})

test('MIXED SCALE: transfer notation rows never inherit the host scale', () => {
  const insts: Institution[] = [
    { id: 'R', name: 'Rutgers', creditSystem: 'semester',
      gradingScale: { source: 'transcript', points: RUTGERS_POINTS } },
  ]
  const courses = [
    C({ grade: 'B+', credits: 4, institutionId: 'R' }),
    // A Montclair row printed inside the Rutgers transcript as an accepted
    // transfer. It is not Rutgers coursework and carries no grade points.
    { ...C({ grade: 'B+', credits: 4, institutionId: 'R' }), recordType: 'transfer_notation' as const },
  ]
  const r = calculateGPA(courses, 'overall', { institutions: insts, policies: P })
  assert.equal(r.creditsCounted, 4, 'only the real Rutgers attempt counts')
  assert.equal(r.qualityPoints, 14)
  assert.equal(r.exclusions['transfer-notation'], 1)
})

// ------------------------------------------- evidence cross-check (C+ recovery)
const RUTGERS_LEGEND_ROWS =
  'A | - Distinguished | 4.00 | F | - Failing | 0.00\n' +
  'B+ | - Intermediate grade | 3.50 | Pass | - (A thru C)\n' +
  'B | - Good | 3.00 | NOCR - No credit (D & F)\n' +
  'C+ | - Intermediate grade | 2.50 | IN | - Incomplete\n' +
  'C | - Satisfactory | 2.00 | PIN | - Permanent incomplete\n' +
  'D | - Poor | 1.00 | TNC | - Temporary no credit'

test('EVIDENCE: grade/point pairs are read out of the quoted legend', () => {
  const parsed = parseScaleFromEvidence(RUTGERS_LEGEND_ROWS)
  assert.equal(parsed['A'], 4.0)
  assert.equal(parsed['B+'], 3.5)
  assert.equal(parsed['C+'], 2.5)
  assert.equal(parsed['D'], 1.0)
  assert.equal(parsed['F'], 0.0)
  assert.ok(!('IN' in parsed), 'non-graded symbols are not pairs')
  assert.ok(!('PASS' in parsed))
})

test('EVIDENCE: a row the model quoted but omitted from the map is recovered', () => {
  // The exact observed failure: C+ present in the quotation, absent from points.
  const r = validateDetectedScale({
    points: { A: 4.0, 'B+': 3.5, B: 3.0, C: 2.0, D: 1.0, F: 0.0 },
    evidence: RUTGERS_LEGEND_ROWS,
    applicability: 'A. Standard (Exception: ...)',
  })
  assert.equal(r.ok, true)
  assert.equal(r.scale!.points['C+'], 2.5, 'C+ comes back from the document’s own words')
  assert.deepEqual(r.recovered, ['C+'])
})

test('EVIDENCE: nothing is recovered when the quotation contradicts the map', () => {
  // Points say the Law table, the quotation is the Standard table: the two are
  // not the same reading, so no symbol may be carried across.
  const r = validateDetectedScale({
    points: { A: 4.0, 'B+': 3.33 },
    evidence: RUTGERS_LEGEND_ROWS,
    applicability: 'x',
  })
  assert.equal(r.ok, false)
  assert.match(r.reason!, /disagrees with the grades returned for B\+/)
})

test('EVIDENCE: a quotation sharing no symbols adds nothing', () => {
  const r = validateDetectedScale({
    points: { A: 4.0 }, evidence: 'Honors (H) and Credit (CR) are not graded.', applicability: 'x',
  })
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.scale!.points), ['A'], 'no invention from unrelated text')
})

test('EVIDENCE: recovery never overrides a value the model returned', () => {
  const r = validateDetectedScale({
    points: { A: 4.0, 'C+': 2.5 }, evidence: RUTGERS_LEGEND_ROWS, applicability: 'x',
  })
  assert.equal(r.ok, true)
  assert.equal(r.scale!.points['C+'], 2.5)
})
