import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  institutionsUsedIn, institutionsUnusedIn, legendNoteFor, retakeDisclaimer,
  GPA_DISCLAIMER_D43,
} from './presentation.ts'
import { calculateGPA } from './engine.ts'
import { DEFAULT_POLICIES, type Course, type GpaPolicies, type Institution } from './types.ts'

const I = (id: string, name: string): Institution =>
  ({ id, name, creditSystem: 'semester', gradingScale: null })

const C = (id: string, institutionId: string | null): Course => ({
  id, institutionId, courseCode: null, name: 'Course ' + id, grade: 'A', credits: 3,
  year: '2023', term: 'Fall', categories: ['general'], categorySource: 'ai',
  level: 'undergraduate', levelSource: 'default', recordType: 'coursework',
  transferredIn: false, needsReview: false, reviewReasons: [],
})

const RUTGERS = I('R', 'Rutgers University')
const MONTCLAIR = I('M', 'Montclair State University')
const ALL = [RUTGERS, MONTCLAIR]

// --------------------------------------------------- schools in this analysis
test('SCOPE: an analysis using one school lists exactly that school', () => {
  const courses = [C('a', 'M'), C('b', 'M')]
  assert.deepEqual(institutionsUsedIn(courses, ALL).map(i => i.name), ['Montclair State University'])
})

test('SCOPE: a school saved on the account but unused here does not appear', () => {
  const courses = [C('a', 'M')]
  const used = institutionsUsedIn(courses, ALL)
  assert.ok(!used.some(i => i.id === 'R'), 'Rutgers must not look like it takes part')
  assert.deepEqual(institutionsUnusedIn(courses, ALL).map(i => i.id), ['R'])
})

test('SCOPE: a combined analysis lists every school it actually uses', () => {
  const courses = [C('a', 'M'), C('b', 'R')]
  assert.deepEqual(institutionsUsedIn(courses, ALL).map(i => i.id).sort(), ['M', 'R'])
  assert.deepEqual(institutionsUnusedIn(courses, ALL), [])
})

test('SCOPE: the badge counts schools in this analysis, not the account', () => {
  const courses = [C('a', 'M')]
  assert.equal(institutionsUsedIn(courses, ALL).length, 1)
  assert.equal(ALL.length, 2, 'both are still saved on the account')
})

test('SCOPE: unassigned coursework contributes no school', () => {
  assert.deepEqual(institutionsUsedIn([C('a', null)], ALL), [])
  assert.deepEqual(institutionsUnusedIn([C('a', null)], ALL).length, 2)
})

test('SCOPE: transfer notation still counts as using its school', () => {
  const notation = { ...C('a', 'R'), recordType: 'transfer_notation' as const }
  assert.deepEqual(institutionsUsedIn([notation], ALL).map(i => i.id), ['R'])
})

test('SCOPE: filtering the display never changes the GPA or the settings', () => {
  const courses = [C('a', 'M'), C('b', 'R')]
  const ctx = { institutions: ALL, policies: { transfer: 'exclude' as const, retake: 'both' as const } }
  const before = calculateGPA(courses, 'overall', ctx)
  // The engine keeps receiving every institution; only the panel is scoped.
  const scoped = institutionsUsedIn([C('a', 'M')], ALL)
  const after = calculateGPA(courses, 'overall', ctx)
  assert.equal(before.display, after.display)
  assert.equal(before.creditsCounted, after.creditsCounted)
  assert.deepEqual(ALL.map(i => i.gradingScale), [null, null], 'settings untouched')
  assert.equal(scoped.length, 1)
})

// ------------------------------------------------------ grading-scale message
test('LEGEND: no legend found says so, and claims nothing else', () => {
  const n = legendNoteFor({ institutionName: 'Montclair State University', candidateCount: 0, applied: false })
  assert.equal(n.outcome, 'none')
  assert.equal(n.actionable, false)
  assert.match(n.text, /no explicit grading legend was found on this transcript/i)
  assert.match(n.text, /standard 4\.0 scale is being used until you confirm or edit it/i)
  // The wrong claim that prompted this fix.
  assert.ok(!/more than one grading system/i.test(n.text))
  assert.ok(!/could not be determined/i.test(n.text))
})

test('LEGEND: an ambiguity string alone cannot manufacture a multi-table claim', () => {
  const n = legendNoteFor({
    institutionName: 'Montclair State University', candidateCount: 0,
    ambiguity: 'several systems appear to be present', applied: false,
  })
  assert.equal(n.outcome, 'none', 'zero detected tables means zero, whatever was said')
  assert.ok(!/grading tables/i.test(n.text))
})

test('LEGEND: several real tables with no applicability gives the ambiguity message', () => {
  const n = legendNoteFor({ institutionName: 'Rutgers University', candidateCount: 5, applied: false })
  assert.equal(n.outcome, 'ambiguous')
  assert.equal(n.actionable, true)
  assert.match(n.text, /prints 5 grading tables/)
  assert.match(n.text, /none was applied/)
})

test('LEGEND: one table that nothing says governs is reported as such', () => {
  const n = legendNoteFor({ institutionName: 'A College', candidateCount: 1, applied: false })
  assert.equal(n.outcome, 'unestablished')
  assert.equal(n.actionable, true)
  assert.match(n.text, /does not say it governs this coursework/i)
  assert.ok(!/more than one|grading tables/i.test(n.text))
})

test('LEGEND: an applied table reports detection and needs no action', () => {
  const n = legendNoteFor({ institutionName: 'Rutgers University', candidateCount: 5, applied: true })
  assert.equal(n.outcome, 'applied')
  assert.equal(n.actionable, false)
  assert.match(n.text, /detected from the transcript/i)
})

// ---------------------------------------------------------- retake disclaimer
const P = (retake: GpaPolicies['retake']): GpaPolicies => ({ transfer: 'exclude', retake })

test('RETAKE COPY: "count both" says both attempts are included', () => {
  assert.equal(retakeDisclaimer(P('both')), 'Both attempts of repeated coursework are included.')
})

test('RETAKE COPY: "latest only" no longer claims both attempts count', () => {
  const text = retakeDisclaimer(P('latest'))
  assert.equal(text, 'Only the latest matched attempt of repeated coursework is included.')
  assert.ok(!/both/i.test(text), 'the stale sentence must be gone')
})

test('RETAKE COPY: an unresolved policy holding coursework says it is waiting', () => {
  assert.match(retakeDisclaimer(DEFAULT_POLICIES, 3), /awaiting your policy selection/i)
})

test('RETAKE COPY: an unset policy with nothing affected says nothing', () => {
  assert.equal(retakeDisclaimer(DEFAULT_POLICIES, 0), '')
})

test('RETAKE COPY: the sentence always matches the active policy', () => {
  for (const [policy, expected] of [['both', /both attempts/i], ['latest', /latest matched attempt/i]] as const) {
    assert.match(retakeDisclaimer(P(policy)), expected)
  }
})

// ------------------------------------------------------------------- D43
test('D43: the approved disclaimer wording is used verbatim', () => {
  assert.match(GPA_DISCLAIMER_D43, /^GPA results are estimates based on your coursework, selected calculation policies, and each institution’s detected or confirmed grading scale\./)
  assert.match(GPA_DISCLAIMER_D43, /When a school’s grading scale is unknown, CRNAPREPHUB uses the standard 4\.0 scale until confirmed\./)
  assert.match(GPA_DISCLAIMER_D43, /CRNA programs may recalculate GPA differently, so always verify each program’s requirements\.$/)
})

test('D43: the older generic wording is gone', () => {
  assert.ok(!/estimates on a standard 4\.0 scale/i.test(GPA_DISCLAIMER_D43))
  assert.ok(!/NursingCAS convention/i.test(GPA_DISCLAIMER_D43))
  // The retake claim is no longer baked into the disclaimer at all.
  assert.ok(!/repeated course/i.test(GPA_DISCLAIMER_D43))
})
