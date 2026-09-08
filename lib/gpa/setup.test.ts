import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSetupState, reviewLabel, setupSummary } from './setup.ts'
import { DEFAULT_POLICIES, type Course, type CourseIssue, type Institution } from './types.ts'

const C = (o: Partial<Course> & { id: string }): Course => ({
  id: o.id, institutionId: o.institutionId ?? 'I1', courseCode: o.courseCode ?? null,
  name: o.name ?? 'Course', grade: o.grade ?? 'A', credits: o.credits ?? 3,
  year: '2023', term: 'Fall', categories: ['general'], categorySource: 'ai',
  level: 'undergraduate', levelSource: 'default', recordType: 'coursework',
  transferredIn: false, needsReview: false, reviewReasons: [],
})
const I = (id: string, name: string, creditSystem: Institution['creditSystem'] = 'unknown'): Institution =>
  ({ id, name, creditSystem, gradingScale: null })
const base = {
  unassignedCount: 0, transferUnset: 0, retakeUnresolved: 0, quarterExcluded: 0,
  issues: [] as CourseIssue[],
}

test('SETUP: an unset credit system is one required item per school, with its course count', () => {
  const s = deriveSetupState({
    ...base,
    courses: [C({ id: 'a' }), C({ id: 'b' }), C({ id: 'c', institutionId: 'I2' })],
    institutions: [I('I1', 'Rutgers University'), I('I2', 'Montclair State')],
    policies: DEFAULT_POLICIES,
  })
  assert.equal(s.required.length, 2)
  assert.equal(s.blocked, true)
  const rutgers = s.required.find(r => r.institutionId === 'I1')!
  assert.equal(rutgers.kind, 'credit-system')
  assert.equal(rutgers.institutionName, 'Rutgers University')
  assert.equal(rutgers.count, 2)
})

test('SETUP: a school with no coursework is not a required item', () => {
  const s = deriveSetupState({
    ...base, courses: [C({ id: 'a', institutionId: 'I1' })],
    institutions: [I('I1', 'A', 'semester'), I('I2', 'Unused')],
    policies: DEFAULT_POLICIES,
  })
  assert.equal(s.required.length, 0)
  assert.equal(s.blocked, false)
})

test('SETUP: a policy is required only while it is actually holding coursework out', () => {
  const withNone = deriveSetupState({
    ...base, courses: [], institutions: [], policies: DEFAULT_POLICIES,
  })
  assert.equal(withNone.required.length, 0, 'an unset policy with nothing affected is not a blocker')

  const withSome = deriveSetupState({
    ...base, transferUnset: 4, retakeUnresolved: 2,
    courses: [], institutions: [], policies: DEFAULT_POLICIES,
  })
  assert.deepEqual(withSome.required.map(r => r.kind), ['transfer-policy', 'retake-policy'])
  assert.equal(withSome.required[0].count, 4)
})

test('SETUP: items already shown as required are not repeated in the review list', () => {
  const issues: CourseIssue[] = [
    { courseId: 'a', courseName: 'Anatomy', reason: 'credit-system-unknown', detail: 'x' },
    { courseId: 'b', courseName: 'Nutrition', reason: 'unrecognized-grade', detail: 'y' },
  ]
  const s = deriveSetupState({
    ...base, issues, courses: [C({ id: 'a' }), C({ id: 'b', name: 'Nutrition', grade: '' })],
    institutions: [I('I1', 'Rutgers')], policies: DEFAULT_POLICIES,
  })
  assert.equal(s.review.length, 1, 'only the genuinely separate item survives')
  assert.equal(s.review[0].courseName, 'Nutrition')
})

test('SETUP: a blank grade reads differently from an unreadable one', () => {
  const blank = C({ id: 'a', grade: '' })
  const weird = C({ id: 'b', grade: 'ZZ' })
  const issue = (id: string): CourseIssue =>
    ({ courseId: id, courseName: 'x', reason: 'unrecognized-grade', detail: 'd' })
  assert.equal(reviewLabel(issue('a'), blank), 'No grade found')
  assert.equal(reviewLabel(issue('b'), weird), 'Grade not recognized')
})

test('SETUP: quarter credits are informational, not a required item or a review item', () => {
  // D57: with the schools unknown, the explanation still has to appear
  // somewhere -- it falls back to a single informational line.
  const s = deriveSetupState({
    ...base, quarterExcluded: 3,
    courses: [], institutions: [], policies: { transfer: 'exclude', retake: 'both' },
  })
  assert.equal(s.required.length, 0)
  assert.equal(s.review.length, 0)
  assert.equal(s.quarterGroups.length, 0, 'no school to group by')
  assert.equal(s.informational.length, 1)
  assert.match(s.informational[0].label, /3 courses on quarter credits/)
  assert.match(s.informational[0].detail, /not automatically convert/i)
  assert.equal(s.blocked, false, 'nothing the user can resolve, so nothing is blocked')
})

test('SETUP: resolving the credit system clears the blocked state', () => {
  const args = {
    ...base, courses: [C({ id: 'a' })], policies: { transfer: 'exclude' as const, retake: 'both' as const },
  }
  assert.equal(deriveSetupState({ ...args, institutions: [I('I1', 'R')] }).blocked, true)
  assert.equal(deriveSetupState({ ...args, institutions: [I('I1', 'R', 'semester')] }).blocked, false)
})

test('SETUP: the summary counts required items rather than describing them', () => {
  const blocked = deriveSetupState({
    ...base, courses: [C({ id: 'a' })], institutions: [I('I1', 'R')], policies: DEFAULT_POLICIES,
  })
  assert.equal(setupSummary(blocked, 27), '27 courses in this analysis. Complete 1 required item to calculate your GPA.')
  const clear = deriveSetupState({
    ...base, courses: [C({ id: 'a' })], institutions: [I('I1', 'R', 'semester')],
    policies: { transfer: 'exclude', retake: 'both' },
  })
  assert.equal(setupSummary(clear, 1), '1 course in this analysis')
})
