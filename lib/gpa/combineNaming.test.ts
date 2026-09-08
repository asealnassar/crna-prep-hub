import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planCombine, planCombineWithNewCourses, institutionNamesInOrder, combinedNameFor,
  type CombineSource,
} from './combine.ts'
import { DEFAULT_POLICIES, type Course, type Institution } from './types.ts'

const A = 'inst-ridgeview', B = 'inst-meridian', C = 'inst-harbor', D = 'inst-cascade'
const INSTITUTIONS: Institution[] = [
  { id: A, name: 'Ridgeview State University', creditSystem: 'semester', gradingScale: null },
  { id: B, name: 'Meridian College of Nursing', creditSystem: 'semester', gradingScale: null },
  { id: C, name: 'Harbor Medical University', creditSystem: 'semester', gradingScale: null },
  { id: D, name: 'Cascade Community College', creditSystem: 'semester', gradingScale: null },
]

let seq = 0
const course = (institutionId: string, code: string): Course => ({
  id: 'c' + (++seq), institutionId, courseCode: code, name: 'Course', grade: 'A', credits: 3,
  term: 'Fall', year: '2022', categories: ['general'], categorySource: 'ai',
  level: 'undergraduate', levelSource: 'ai', recordType: 'coursework',
  transferredIn: false, needsReview: false, reviewReasons: [],
})

const school = (id: string, analysisId: string, analysisName: string, n = 3): CombineSource => ({
  id: analysisId, name: analysisName, policies: DEFAULT_POLICIES,
  courses: Array.from({ length: n }, (_, i) => course(id, `CRS ${100 + i}`)),
})

let k = 0
const combine = (sources: CombineSource[], existing: { name: string }[] = []) => {
  const plan = planCombine({
    sources, existingAnalyses: existing, institutions: INSTITUTIONS, makeId: () => `x${++k}`,
  })
  assert.equal(plan.ok, true, plan.message)
  return plan
}
const asSource = (plan: ReturnType<typeof combine>, id: string): CombineSource =>
  ({ id, name: plan.name!, policies: plan.policies!, courses: plan.courses! })

const ridgeview = () => school(A, 'a-rv', 'Ridgeview State University')
const meridian = () => school(B, 'a-mc', 'Meridian College of Nursing')
const harbor = () => school(C, 'a-hb', 'Harbor Medical University')
const cascade = () => school(D, 'a-cc', 'Cascade Community College')

// ------------------------------------------------------------ the basic case
test('D58: two schools give a two-school name', () => {
  assert.equal(combine([ridgeview(), meridian()]).name, 'Ridgeview + Meridian')
})

// ----------------------------------------------------------- the reported bug
test('D58: a nested combine names from all three schools, not the two inputs', () => {
  const first = combine([ridgeview(), meridian()])
  assert.equal(first.name, 'Ridgeview + Meridian')

  const second = combine([asSource(first, 'a-rvmc'), harbor()])
  assert.equal(second.name, 'Ridgeview + 2 others')
  // The failure this replaces: naming from the two parent labels lost a school.
  assert.notEqual(second.name, 'Ridgeview + Harbor')
  assert.notEqual(second.name, 'Meridian + Harbor')
})

test('D58: combining three at once names identically to combining in steps', () => {
  const atOnce = combine([ridgeview(), meridian(), harbor()]).name
  const stepwise = combine([asSource(combine([ridgeview(), meridian()]), 'a-1'), harbor()]).name
  assert.equal(stepwise, atOnce)
  assert.equal(atOnce, 'Ridgeview + 2 others')
})

test('D58: four levels name from all four schools', () => {
  const l2 = combine([ridgeview(), meridian()])
  const l3 = combine([asSource(l2, 'a-2'), harbor()])
  const l4 = combine([asSource(l3, 'a-3'), cascade()])
  assert.equal(l2.name, 'Ridgeview + Meridian')
  assert.equal(l3.name, 'Ridgeview + 2 others')
  assert.equal(l4.name, 'Ridgeview + 3 others')
  // And the same four combined at once agree.
  assert.equal(combine([ridgeview(), meridian(), harbor(), cascade()]).name, 'Ridgeview + 3 others')
})

// ------------------------------------------------------------ user renames
test('D58: a renamed source analysis does not leak into the combined name', () => {
  const renamed: CombineSource = { ...ridgeview(), name: 'My CRNA GPA' }
  const plan = combine([renamed, meridian()])
  assert.equal(plan.name, 'Ridgeview + Meridian')
  assert.ok(!/CRNA GPA/.test(plan.name!), 'the label is not an institution')
  assert.equal(renamed.name, 'My CRNA GPA', 'and the source keeps the name its owner gave it')
})

test('D58: a renamed combined analysis still names from its schools', () => {
  const first = combine([ridgeview(), meridian()])
  const renamed = { ...asSource(first, 'a-4'), name: 'Everything so far' }
  assert.equal(combine([renamed, harbor()]).name, 'Ridgeview + 2 others')
})

// ------------------------------------------------------------- ordering
test('D58: the order follows the coursework, so it is stable', () => {
  const courses = [...meridian().courses, ...ridgeview().courses, ...harbor().courses]
  assert.deepEqual(institutionNamesInOrder(courses, INSTITUTIONS), [
    'Meridian College of Nursing', 'Ridgeview State University', 'Harbor Medical University',
  ])
  // The same sources in the same order always produce the same name.
  const once = combine([harbor(), ridgeview()]).name
  const twice = combine([harbor(), ridgeview()]).name
  assert.equal(once, twice)
  assert.equal(once, 'Harbor + Ridgeview')
})

test('D58: one school referenced many times is still one school', () => {
  const many: CombineSource = {
    id: 'a-many', name: 'Ridgeview', policies: DEFAULT_POLICIES,
    courses: Array.from({ length: 12 }, (_, i) => course(A, `CRS ${i}`)),
  }
  assert.deepEqual(institutionNamesInOrder(many.courses, INSTITUTIONS), ['Ridgeview State University'])
  assert.equal(combine([many, meridian()]).name, 'Ridgeview + Meridian')
})

test('D58: coursework with no school assigned contributes no name', () => {
  const unassigned: CombineSource = {
    id: 'a-un', name: 'Loose coursework', policies: DEFAULT_POLICIES,
    courses: [{ ...course(A, 'CRS 1'), institutionId: null }],
  }
  assert.deepEqual(institutionNamesInOrder(unassigned.courses, INSTITUTIONS), [])
  // With nothing else to go on, the analysis labels are better than no name.
  const plan = planCombine({
    sources: [unassigned, { ...unassigned, id: 'a-un2', name: 'Other loose' }],
    existingAnalyses: [], institutions: INSTITUTIONS, makeId: () => `y${++k}`,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.name, 'Loose + Other')
})

// --------------------------------------------------------------- uniqueness
test('D58: a generated name that already exists gets the usual suffix', () => {
  const existing = [{ name: 'Ridgeview + 2 others' }]
  const first = combine([ridgeview(), meridian()])
  assert.equal(combine([asSource(first, 'a-5'), harbor()], existing).name, 'Ridgeview + 2 others (2)')
  assert.equal(
    combine([asSource(first, 'a-6'), harbor()],
      [...existing, { name: 'Ridgeview + 2 others (2)' }]).name,
    'Ridgeview + 2 others (3)')
  assert.deepEqual(existing, [{ name: 'Ridgeview + 2 others' }], 'nothing is renamed')
})

// ------------------------------------------------------- sources untouched
test('D58: naming never touches a source analysis', () => {
  const rv = ridgeview(), mc = meridian(), hb = harbor()
  const before = JSON.stringify([rv, mc, hb])
  const first = combine([rv, mc])
  combine([asSource(first, 'a-7'), hb])
  assert.equal(JSON.stringify([rv, mc, hb]), before)
  assert.deepEqual([rv.name, mc.name, hb.name],
    ['Ridgeview State University', 'Meridian College of Nursing', 'Harbor Medical University'])
})

// ------------------------------------------------- the upload-combine path
test('D58: an upload-combine names from the final school set too', () => {
  const first = combine([ridgeview(), meridian()])
  const incoming = [course(C, 'NURS 500'), course(C, 'NURS 501')]
  const plan = planCombineWithNewCourses({
    current: asSource(first, 'a-8'), incoming,
    incomingNames: ['Harbor Medical University'],
    existingAnalyses: [], institutions: INSTITUTIONS, makeId: () => `z${++k}`,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.name, 'Ridgeview + 2 others', 'all three, not the analysis label plus one')
})

// ---------------------------------------------------------- D47 unchanged
test('D58: overlap protection is unaffected by the naming change', () => {
  const first = combine([ridgeview(), meridian()])
  const blocked = planCombine({
    sources: [asSource(first, 'a-9'), meridian()], existingAnalyses: [], institutions: INSTITUTIONS })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.block, 'overlap')
  assert.equal(blocked.name, undefined, 'a refused combine is never even named')
})

test('D58: the display rule matches the approved shape at every size', () => {
  assert.equal(combinedNameFor(['Ridgeview State University'], []), 'Ridgeview State University')
  assert.equal(combinedNameFor(['Ridgeview State University', 'Meridian College of Nursing'], []),
    'Ridgeview + Meridian')
  assert.equal(combinedNameFor(['Ridgeview State University', 'B', 'C'], []), 'Ridgeview + 2 others')
  assert.equal(combinedNameFor(['Ridgeview State University', 'B', 'C', 'D'], []), 'Ridgeview + 3 others')
  assert.equal(combinedNameFor(['Ridgeview State University', 'B', 'C', 'D', 'E'], []),
    'Ridgeview + 4 others')
})
