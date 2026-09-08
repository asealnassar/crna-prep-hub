import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planCombine, planCombineWithNewCourses, copyCoursesFrom, type CombineSource } from './combine.ts'
import {
  staleLinks, transferReviews, linkedTransferCount, planTransferLinks, setTransferLink,
} from './transferLinks.ts'
import { deriveSetupState } from './setup.ts'
import { calculateGPA, collectIssues, unassignedCourses } from './engine.ts'
import { DEFAULT_POLICIES, type Course, type GpaPolicies, type Institution } from './types.ts'

const RV = 'inst-ridgeview', MC = 'inst-meridian', HB = 'inst-harbor'
const INSTITUTIONS: Institution[] = [
  { id: RV, name: 'Ridgeview State University', creditSystem: 'semester', gradingScale: null },
  { id: MC, name: 'Meridian College of Nursing', creditSystem: 'semester', gradingScale: null },
  { id: HB, name: 'Harbor Medical University', creditSystem: 'semester', gradingScale: null },
]
const RIDGEVIEW = 'Ridgeview State University'

let n = 0
const C = (o: Partial<Course> & { institutionId: string | null }): Course => ({
  id: o.id ?? 'c' + (++n), institutionId: o.institutionId, courseCode: o.courseCode ?? null,
  name: o.name ?? 'Course', grade: o.grade ?? 'A', credits: o.credits ?? 3,
  term: o.term ?? 'Fall', year: o.year ?? '2020',
  categories: o.categories ?? ['general'], categorySource: 'ai',
  level: o.level ?? 'undergraduate', levelSource: 'ai', recordType: o.recordType ?? 'coursework',
  transferredIn: o.transferredIn ?? false, needsReview: false, reviewReasons: [],
  ...(o.transferredFromName !== undefined ? { transferredFromName: o.transferredFromName } : {}),
  ...(o.transferLink !== undefined ? { transferLink: o.transferLink } : {}),
})

/** The 8 Ridgeview courses Meridian accepted as transfer credit. */
const LINKED: [string, string, number][] = [
  ['BIO 201', 'Anatomy & Physiology I', 4], ['BIO 202', 'Anatomy & Physiology II', 4],
  ['CHM 101', 'General Chemistry', 4], ['ENG 101', 'English Composition I', 3],
  ['MAT 120', 'Statistics', 3], ['MIC 210', 'Microbiology', 4],
  ['PSY 101', 'General Psychology', 3], ['SOC 101', 'Introduction to Sociology', 3],
]

const ridgeview = (): CombineSource => ({
  id: 'a-ridgeview', name: 'Ridgeview State University', policies: DEFAULT_POLICIES,
  courses: [
    ...LINKED.map(([courseCode, name, credits], i) =>
      C({ id: `rv-${i}`, institutionId: RV, courseCode, name, credits, grade: 'A',
          categories: /BIO|CHM|MIC/.test(courseCode) ? ['science'] : ['general'] })),
    ...Array.from({ length: 14 }, (_, i) =>
      C({ id: `rvx-${i}`, institutionId: RV, courseCode: `GEN ${100 + i}`, name: `Ridgeview ${i}` })),
  ],
})

const meridian = (): CombineSource => ({
  id: 'a-meridian', name: 'Meridian College of Nursing', policies: DEFAULT_POLICIES,
  courses: [
    ...LINKED.map(([courseCode, name, credits], i) =>
      C({ id: `mc-n${i}`, institutionId: MC, courseCode, name, credits, grade: 'TR',
          term: '', year: '', recordType: 'transfer_notation', transferredFromName: RIDGEVIEW })),
    ...Array.from({ length: 17 }, (_, i) =>
      C({ id: `mc-${i}`, institutionId: MC, courseCode: `NURS ${200 + i}`, name: `Nursing ${i}`,
          categories: ['nursing'] })),
  ],
})

const harbor = (): CombineSource => ({
  id: 'a-harbor', name: 'Harbor Medical University', policies: DEFAULT_POLICIES,
  courses: Array.from({ length: 7 }, (_, i) =>
    C({ id: `hb-${i}`, institutionId: HB, courseCode: `NURS ${500 + i}`, name: `Graduate ${i}`,
        level: 'graduate', categories: ['nursing'] })),
})

let seq = 0
const combine = (sources: CombineSource[]) => {
  const plan = planCombine({
    sources, existingAnalyses: [], institutions: INSTITUTIONS, makeId: () => `k${++seq}`,
  })
  assert.equal(plan.ok, true, plan.message)
  return plan
}

/** Ridgeview + Meridian: the 47-row analysis with 8 established links. */
const combined47 = (): CombineSource => {
  const plan = combine([ridgeview(), meridian()])
  return { id: 'a-47', name: 'Ridgeview + Meridian', policies: plan.policies!, courses: plan.courses! }
}

const setupFor = (rows: Course[], policies: GpaPolicies = DEFAULT_POLICIES) => {
  const g = calculateGPA(rows, 'overall', { institutions: INSTITUTIONS, policies })
  return deriveSetupState({
    courses: rows, institutions: INSTITUTIONS, policies,
    unassignedCount: unassignedCourses(rows).length,
    transferUnset: g.exclusions['transfer-policy-unset'] ?? 0,
    retakeUnresolved: g.exclusions['retake-policy-unset'] ?? 0,
    quarterExcluded: g.exclusions['unsupported-credit-system'] ?? 0,
    issues: collectIssues(rows, { institutions: INSTITUTIONS, policies }),
    unresolvedTransfers: transferReviews(rows, INSTITUTIONS),
  })
}

// ------------------------------------------------------ the reported bug
test('D55: a valid auto-link survives a nested combine', () => {
  const first = combined47()
  assert.equal(linkedTransferCount(first.courses), 8, 'the 47-row analysis has its 8 links')
  assert.deepEqual(staleLinks(first.courses, INSTITUTIONS), [])

  const rows = combine([first, harbor()]).courses!
  assert.equal(rows.length, 54)
  assert.equal(linkedTransferCount(rows), 8, 'all 8 travel with the copy')
  assert.deepEqual(staleLinks(rows, INSTITUTIONS), [], 'and none arrives stale')
  assert.equal(transferReviews(rows, INSTITUTIONS).length, 0)
})

test('D55: the copied link points at the DESTINATION copy of its course', () => {
  const rows = combine([combined47(), harbor()]).courses!
  const byId = new Map(rows.map(c => [c.id, c]))
  const notations = rows.filter(c => c.recordType === 'transfer_notation')
  assert.equal(notations.length, 8)
  for (const notation of notations) {
    const target = byId.get(notation.transferLink!.courseId!)
    assert.ok(target, `${notation.courseCode} resolves inside this analysis`)
    assert.equal(target!.courseCode, notation.courseCode)
    assert.equal(target!.credits, notation.credits)
    assert.equal(target!.institutionId, RV, 'the Ridgeview original, not the notation')
    assert.equal(target!.recordType, 'coursework')
    assert.equal(target!.transferredIn, true, 'so transfer policy governs it again')
  }
})

test('D55: source ids are untouched, and the sources are byte-identical', () => {
  const rv = ridgeview(), mc = meridian(), hb = harbor()
  const first = combine([rv, mc])
  const source47: CombineSource = {
    id: 'a-47', name: 'Ridgeview + Meridian', policies: first.policies!, courses: first.courses! }
  const before47 = JSON.stringify(source47)
  const beforeHb = JSON.stringify(hb)

  combine([source47, hb])

  assert.equal(JSON.stringify(source47), before47, 'the 47-row analysis is unchanged')
  assert.equal(JSON.stringify(hb), beforeHb)
  assert.deepEqual(rv.courses.map(c => c.id), ridgeview().courses.map(c => c.id))
  assert.ok(rv.courses.every(c => c.transferLink === undefined), 'no link leaked back')
})

test('D55: no duplicate links are created by the copy', () => {
  const rows = combine([combined47(), harbor()]).courses!
  const targets = rows.filter(c => c.recordType === 'transfer_notation')
    .map(c => c.transferLink!.courseId!)
  assert.equal(new Set(targets).size, targets.length, 'each course is claimed once')
  assert.equal(rows.filter(c => c.transferredIn).length, 8)
  // A second automatic pass finds nothing left to do.
  const plan = planTransferLinks(rows, INSTITUTIONS)
  assert.equal(plan.links.length, 0)
  assert.equal(plan.unresolved.length, 0)
})

// ------------------------------------------------------- user overrides
test('D55: a user-chosen link survives, still marked as the user’s', () => {
  const first = combined47()
  const notation = first.courses.find(c => c.recordType === 'transfer_notation')!
  const target = notation.transferLink!.courseId!
  const withUser: CombineSource = {
    ...first, courses: setTransferLink(first.courses, notation.id, target),
  }
  assert.equal(withUser.courses.find(c => c.id === notation.id)!.transferLink!.source, 'user')

  const rows = combine([withUser, harbor()]).courses!
  const byId = new Map(rows.map(c => [c.id, c]))
  const copied = rows.filter(c => c.recordType === 'transfer_notation')
    .find(c => c.courseCode === notation.courseCode)!
  assert.equal(copied.transferLink!.source, 'user', 'authority is preserved')
  assert.ok(byId.has(copied.transferLink!.courseId!), 'and it points into this analysis')
  assert.equal(byId.get(copied.transferLink!.courseId!)!.courseCode, notation.courseCode)
})

test('D55: a user’s "not in this analysis" survives exactly, and is not re-linked', () => {
  const first = combined47()
  const notation = first.courses.find(c => c.recordType === 'transfer_notation')!
  const declined: CombineSource = {
    ...first, courses: setTransferLink(first.courses, notation.id, null),
  }
  const rows = combine([declined, harbor()]).courses!
  const copied = rows.filter(c => c.recordType === 'transfer_notation')
    .find(c => c.courseCode === notation.courseCode)!
  assert.equal(copied.transferLink!.courseId, null)
  assert.equal(copied.transferLink!.source, 'user')
  assert.equal(linkedTransferCount(rows), 7, 'the released course is not re-claimed')
  assert.equal(transferReviews(rows, INSTITUTIONS).length, 0, 'and it is not asked about again')
})

test('D55: a genuinely stale link stays stale after combining', () => {
  const first = combined47()
  const notation = first.courses.find(c => c.recordType === 'transfer_notation')!
  // Edit the linked course so the evidence genuinely stops holding.
  const brokenCourses = first.courses.map(c =>
    c.id === notation.transferLink!.courseId ? { ...c, credits: 1 } : c)
  const broken: CombineSource = { ...first, courses: brokenCourses }
  assert.equal(staleLinks(broken.courses, INSTITUTIONS).length, 1, 'stale before the combine')

  const rows = combine([broken, harbor()]).courses!
  const stale = staleLinks(rows, INSTITUTIONS)
  assert.equal(stale.length, 1, 'and stale after it')
  assert.equal(stale[0].reason, 'credits', 'for the real reason, not a missing id')
  const reviews = transferReviews(rows, INSTITUTIONS)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].severity, 'required')
})

// --------------------------------------------------- the other copy path
test('D55: an upload-combine preserves links the same way', () => {
  const first = combined47()
  const incoming = Array.from({ length: 5 }, (_, i) =>
    C({ id: `new-${i}`, institutionId: HB, courseCode: `NURS ${700 + i}`, name: `New ${i}` }))
  const plan = planCombineWithNewCourses({
    current: first, incoming, incomingNames: ['Harbor Medical University'],
    existingAnalyses: [], institutions: INSTITUTIONS, makeId: () => `u${++seq}`,
  })
  assert.equal(plan.ok, true)
  const rows = plan.courses!
  assert.equal(rows.length, 52)
  assert.equal(linkedTransferCount(rows), 8)
  assert.deepEqual(staleLinks(rows, INSTITUTIONS), [])
  const byId = new Map(rows.map(c => [c.id, c]))
  for (const nRow of rows.filter(c => c.recordType === 'transfer_notation')) {
    assert.ok(byId.has(nRow.transferLink!.courseId!), nRow.courseCode!)
  }
})

test('D55: copyCoursesFrom alone rewrites the address, nothing else', () => {
  const first = combined47()
  const copies = copyCoursesFrom(first, () => `q${++seq}`)
  const byId = new Map(copies.map(c => [c.id, c]))
  const original = new Map(first.courses.map(c => [c.id, c]))
  for (let i = 0; i < copies.length; i++) {
    const before = first.courses[i], after = copies[i]
    for (const f of ['courseCode', 'name', 'grade', 'credits', 'term', 'year',
                     'recordType', 'institutionId', 'transferredFromName'] as const) {
      assert.deepEqual(after[f], before[f], f)
    }
    if (before.transferLink?.courseId) {
      assert.notEqual(after.transferLink!.courseId, before.transferLink.courseId)
      assert.ok(byId.has(after.transferLink!.courseId!))
      assert.equal(after.transferLink!.source, before.transferLink.source)
      assert.equal(original.get(before.transferLink.courseId)!.courseCode,
        byId.get(after.transferLink!.courseId!)!.courseCode, 'the same course, new address')
    }
  }
})

// ------------------------------------------------------- D47 unchanged
test('D55: overlap protection is unaffected', () => {
  const first = combined47()
  const blocked = planCombine({
    sources: [first, meridian()], existingAnalyses: [], institutions: INSTITUTIONS })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.block, 'overlap')
  const fine = planCombine({
    sources: [first, harbor()], existingAnalyses: [], institutions: INSTITUTIONS })
  assert.equal(fine.ok, true)
})

// ----------------------------------------------------- Student C setup
test('D55: the nested analysis asks for one decision, not nine', () => {
  const rows = combine([combined47(), harbor()]).courses!
  const state = setupFor(rows)
  assert.equal(state.transferConfirms.length, 0, 'no transfer record needs review')
  assert.equal(state.transferGroups.length, 0)
  assert.deepEqual(state.required.map(r => r.kind), ['transfer-policy'],
    'the transfer Include/Exclude choice, and nothing else')
  assert.equal(state.required[0].count, 8, '8 transfer-controlled courses')
  assert.ok(!state.transferConfirms.some(t => t.label === 'Transfer link needs review'))
})

test('D55: the eight linked Ridgeview courses are governed by transfer policy', () => {
  const rows = combine([combined47(), harbor()]).courses!
  const unset = calculateGPA(rows, 'overall',
    { institutions: INSTITUTIONS, policies: DEFAULT_POLICIES })
  assert.equal(unset.exclusions['transfer-policy-unset'], 8)
  assert.equal(unset.exclusions['transfer-link-review-required'], undefined, 'nothing withheld for review')
  assert.equal(unset.exclusions['transfer-notation'], 8, 'notations never count')

  const included = calculateGPA(rows, 'overall',
    { institutions: INSTITUTIONS, policies: { transfer: 'include', retake: 'both' } })
  const excluded = calculateGPA(rows, 'overall',
    { institutions: INSTITUTIONS, policies: { transfer: 'exclude', retake: 'both' } })
  assert.equal(included.coursesCounted - excluded.coursesCounted, 8,
    'exactly the eight linked courses move with the policy')
})
