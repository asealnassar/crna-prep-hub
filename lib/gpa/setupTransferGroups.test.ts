import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  deriveSetupState, groupTransferRecords, setupHeading,
  transferGroupTitle, transferGroupDetail,
} from './setup.ts'
import { transferReviews, planTransferLinks } from './transferLinks.ts'
import { calculateGPA, collectIssues, unassignedCourses } from './engine.ts'
import { DEFAULT_POLICIES, type Course, type GpaPolicies, type Institution } from './types.ts'

const PV = 'inst-pine', LU = 'inst-lake', HC = 'inst-hudson'
const INSTITUTIONS: Institution[] = [
  { id: PV, name: 'Pine Valley Community College', creditSystem: 'semester', gradingScale: null },
  { id: HC, name: 'Hudson County College', creditSystem: 'semester', gradingScale: null },
  { id: LU, name: 'Lakeshore University', creditSystem: 'semester',
    gradingScale: { source: 'transcript', points: {
      A: 4.0, 'A-': 3.7, 'B+': 3.5, B: 3.0, 'C+': 2.5, C: 2.0, D: 1.0, F: 0.0 } } },
]
const PINE = 'Pine Valley Community College'

let seq = 0
const C = (o: Partial<Course> & { institutionId: string | null }): Course => ({
  id: o.id ?? 'c' + (++seq), institutionId: o.institutionId,
  courseCode: o.courseCode ?? null, name: o.name ?? 'Course', grade: o.grade ?? 'A',
  credits: o.credits ?? 3, term: o.term ?? '', year: o.year ?? '',
  categories: o.categories ?? ['general'], categorySource: 'ai',
  level: 'undergraduate', levelSource: 'ai',
  recordType: o.recordType ?? 'coursework', transferredIn: o.transferredIn ?? false,
  needsReview: false, reviewReasons: [],
  ...(o.transferredFromName !== undefined ? { transferredFromName: o.transferredFromName } : {}),
  ...(o.transferLink !== undefined ? { transferLink: o.transferLink } : {}),
})

/** The 10 Lakeshore transfer records, two printing no grade. */
const notations = (from: string | null = PINE): Course[] => ([
  ['ENG 101', 'English Composition I', 3, 'TR'],
  ['PSY 101', 'General Psychology', 3, 'TR'],
  ['BIO 101', 'General Biology', 4, 'TR'],
  ['MAT 120', 'Statistics', 3, 'TR'],
  ['BIO 201', 'Anatomy & Physiology I', 4, 'TR'],
  ['BIO 202', 'Anatomy & Physiology II', 4, 'TR'],
  ['NTR 150', 'Human Nutrition', 3, ''],
  ['MIC 210', 'Microbiology', 4, 'TR'],
  ['PSY 230', 'Developmental Psychology', 3, ''],
  ['PHI 220', 'Health Care Ethics', 3, 'TR'],
] as [string, string, number, string][]).map(([courseCode, name, credits, grade], i) =>
  C({ id: 'n' + (i + 1), institutionId: LU, courseCode, name, credits, grade,
      recordType: 'transfer_notation', transferredFromName: from }))

/** The 15 Lakeshore GPA-bearing rows. */
const lakeshore = (): Course[] => ([
  ['NURS 201', 'Foundations of Nursing Practice', 4, 'A', 'Spring', '2022', ['nursing']],
  ['NURS 205', 'Health Assessment', 3, 'B+', 'Spring', '2022', ['nursing']],
  ['NURS 210', 'Pathophysiology', 3, 'A', 'Spring', '2022', ['nursing', 'science']],
  ['NURS 215', 'Pharmacology I', 3, 'B', 'Spring', '2022', ['nursing', 'science']],
  ['NURS 220', 'Adult Health Nursing I', 5, 'B+', 'Spring', '2022', ['nursing']],
  ['NURS 230', 'Mental Health Nursing', 4, 'A', 'Fall', '2022', ['nursing']],
  ['NURS 235', 'Maternal-Newborn Nursing', 4, 'B+', 'Fall', '2022', ['nursing']],
  ['NURS 240', 'Pediatric Nursing', 4, 'A-', 'Fall', '2022', ['nursing']],
  ['NURS 245', 'Nursing Research', 3, 'A', 'Fall', '2022', ['nursing']],
  ['NURS 301', 'Adult Health Nursing II', 5, 'B+', 'Spring', '2023', ['nursing']],
  ['NURS 305', 'Community Health Nursing', 4, 'A', 'Spring', '2023', ['nursing']],
  ['NURS 310', 'Leadership & Management', 3, 'A-', 'Spring', '2023', ['nursing']],
  ['NURS 315', 'Pharmacology II', 3, 'A', 'Spring', '2023', ['nursing', 'science']],
  ['NURS 401', 'Critical Care Nursing', 4, 'A', 'Fall', '2023', ['nursing']],
  ['NURS 405', 'Nursing Capstone', 3, 'A-', 'Fall', '2023', ['nursing']],
] as [string, string, number, string, string, string, any[]][]).map(
  ([courseCode, name, credits, grade, term, year, categories], i) =>
    C({ id: 'l' + (i + 1), institutionId: LU, courseCode, name, credits, grade, term, year, categories }))

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

/** Student B2 standing on its own: Pine Valley's transcript is not here. */
const standalone = () => [...notations(), ...lakeshore()]

// ------------------------------------------------------------------ grouping
test('D53: ten records from one absent school become one group', () => {
  const state = setupFor(standalone())
  assert.equal(state.transferGroups.length, 1, 'one school, one group')
  assert.equal(state.transferGroups[0].records.length, 10)
  assert.equal(state.transferGroups[0].originName, PINE)
  assert.equal(transferGroupTitle(state.transferGroups[0]),
    'Transfer records from Pine Valley Community College')
})

test('D53: the group says it once, and says nothing is wrong', () => {
  const detail = transferGroupDetail(setupFor(standalone()).transferGroups[0])
  assert.match(detail, /originating transcript is not part of this analysis/i)
  assert.match(detail, /do not affect your GPA/i)
  assert.match(detail, /Add or combine that transcript/i)
  for (const alarming of [/error/i, /missing data/i, /action required/i, /needs confirmation/i]) {
    assert.ok(!alarming.test(detail), String(alarming))
  }
})

test('D53: every record is in the group, with its printed grade', () => {
  const records = setupFor(standalone()).transferGroups[0].records
  assert.equal(records.length, 10)
  assert.deepEqual(records.map(r => r.grade).sort(),
    ['', '', 'TR', 'TR', 'TR', 'TR', 'TR', 'TR', 'TR', 'TR'])
  const blank = records.filter(r => r.grade === '')
  assert.deepEqual(blank.map(r => r.courseCode).sort(), ['NTR 150', 'PSY 230'],
    'a blank grade stays blank -- no TR is invented')
  const ntr = records.find(r => r.courseCode === 'NTR 150')!
  assert.equal(ntr.credits, 3)
  assert.equal(ntr.courseName, 'Human Nutrition')
  assert.equal(ntr.receivingName, 'Lakeshore University')
  assert.equal(ntr.fromName, PINE)
})

test('D53: no record offers a picker when there is nothing to pick', () => {
  const state = setupFor(standalone())
  for (const r of state.transferGroups[0].records) {
    assert.equal(r.candidateCount, 0, `${r.courseCode} has no candidate coursework here`)
  }
})

test('D53: several absent schools are separate groups, never one bucket', () => {
  const rows = [
    ...notations(PINE).slice(0, 6),
    ...notations('Hudson County College').slice(0, 4).map((c, i) =>
      ({ ...c, id: 'h' + i })),
    ...lakeshore(),
  ]
  const groups = setupFor(rows).transferGroups
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map(g => g.originName), [PINE, 'Hudson County College'])
  assert.deepEqual(groups.map(g => g.records.length), [6, 4])
})

test('D53: records that name no school get their own group, listed last', () => {
  const rows = [
    ...notations(PINE).slice(0, 4),
    ...notations(null).slice(4, 7).map((c, i) => ({ ...c, id: 'u' + i })),
    ...lakeshore(),
  ]
  const groups = setupFor(rows).transferGroups
  assert.equal(groups.length, 2)
  assert.equal(groups[0].originName, PINE)
  assert.equal(groups[1].originName, null)
  assert.equal(groups[1].records.length, 3)
  assert.equal(transferGroupTitle(groups[1]), 'Transfer records with unknown originating school')
  assert.match(transferGroupDetail(groups[1]), /do not name the school/i)
})

test('D53: grouping is pure and keeps every record', () => {
  const state = setupFor(standalone())
  const grouped = state.transferGroups.flatMap(g => g.records).map(r => r.notationId).sort()
  const optional = state.transferConfirms.filter(t => t.severity === 'optional')
    .map(t => t.notationId).sort()
  assert.deepEqual(grouped, optional, 'nothing is dropped and nothing is duplicated')
  assert.deepEqual(groupTransferRecords([]), [])
})

// -------------------------------------------------- nothing is required here
test('D53: optional groups add no required item and block nothing', () => {
  const state = setupFor(standalone())
  assert.equal(state.required.filter(r => r.kind === 'transfer-link').length, 0)
  assert.equal(state.required.length, 0, 'nothing is waiting on the user')
  assert.equal(state.blocked, false)
  const gpa = calculateGPA(standalone(), 'overall',
    { institutions: INSTITUTIONS, policies: DEFAULT_POLICIES })
  assert.equal(gpa.display, '3.74', 'the GPA calculates normally')
})

test('D53: the card is not introduced as things to review', () => {
  const state = setupFor(standalone())
  assert.equal(setupHeading(state), 'Transfer records')
  assert.ok(!/review/i.test(setupHeading(state)))
})

test('D53: required items still dominate when they exist', () => {
  // Add an unassigned course, so something genuinely blocks.
  const rows = [...standalone(), C({ institutionId: null, courseCode: 'XYZ 1', credits: 3 })]
  const state = setupFor(rows)
  assert.ok(state.required.length > 0)
  assert.equal(state.blocked, true)
  assert.equal(setupHeading(state), 'Almost ready')
  assert.equal(state.transferGroups.length, 1, 'the optional group is still grouped')
})

// ------------------------------- required reviews are untouched by grouping
test('D53: an ambiguous match stays required, ungrouped, with its picker', () => {
  // Two Pine Valley CHM 101 attempts: plausible coursework is present here.
  const pine = [
    C({ id: 'p1', institutionId: PV, courseCode: 'CHM 101', name: 'General Chemistry I', credits: 4, grade: 'F' }),
    C({ id: 'p2', institutionId: PV, courseCode: 'CHM 101', name: 'General Chemistry I', credits: 4, grade: 'A' }),
  ]
  const rows = [...pine, C({ institutionId: LU, courseCode: 'CHM 101', credits: 4, grade: 'TR',
    recordType: 'transfer_notation', transferredFromName: PINE })]
  const state = setupFor(rows)
  assert.equal(state.transferGroups.length, 0, 'never collapsed into the passive group')
  const required = state.transferConfirms.filter(t => t.severity === 'required')
  assert.equal(required.length, 1)
  assert.equal(required[0].candidateCount, 2, 'the picker has real options')
  assert.equal(state.required.filter(r => r.kind === 'transfer-link').length, 1)
})

test('D53: a stale link stays required and ungrouped', () => {
  const target = C({ id: 'p1', institutionId: PV, courseCode: 'BIO 201',
    name: 'Anatomy & Physiology I', credits: 3, grade: 'A-' })
  const rows = [target, C({ institutionId: LU, courseCode: 'BIO 201', credits: 4, grade: 'TR',
    recordType: 'transfer_notation', transferredFromName: PINE,
    transferLink: { courseId: 'p1', source: 'auto' } })]
  const state = setupFor(rows)
  assert.equal(state.transferGroups.length, 0)
  assert.equal(state.transferConfirms.filter(t => t.severity === 'required')[0].label,
    'Transfer link needs review')
  assert.equal(state.blocked, true)
})

// ---------------------------------------------------- Student B2 unchanged
test('D53: Student B2 standalone calculates exactly as before', () => {
  const rows = standalone()
  const ctx = { institutions: INSTITUTIONS, policies: DEFAULT_POLICIES }
  const overall = calculateGPA(rows, 'overall', ctx)
  assert.equal(overall.display, '3.74')
  assert.equal(rows.length, 25)
  assert.equal(rows.filter(c => c.recordType === 'transfer_notation').length, 10)

  const science = calculateGPA(rows, 'science', ctx)
  assert.equal(science.display, '3.67')
  assert.equal(science.coursesCounted, 3)

  const nursing = calculateGPA(rows, 'nursing', ctx)
  assert.equal(nursing.display, '3.74')
  assert.equal(nursing.coursesCounted, 15)

  const last60 = calculateGPA(rows, 'last60', ctx)
  assert.equal(last60.display, '3.74')
  assert.equal(last60.creditsCounted, 55)

  assert.equal(overall.exclusions['transfer-notation'], 10, 'notations never count')
})

test('D53: grouping changes no record type, link, or transfer flag', () => {
  const before = JSON.stringify(standalone())
  const rows = standalone()
  setupFor(rows)
  assert.equal(JSON.stringify(rows), before, 'presentation only')
  assert.ok(rows.every(c => c.transferLink === undefined), 'no link was created')
  assert.equal(rows.filter(c => c.transferredIn).length, 0, 'no flag was set')
  assert.equal(planTransferLinks(rows, INSTITUTIONS).links.length, 0,
    'and nothing was auto-selected on the user’s behalf')
})

test('D53: once the originating transcript joins, linking is unchanged', () => {
  // The same records, with Pine Valley's coursework now present.
  const pine = [
    ['ENG 101', 'English Composition I', 3], ['PSY 101', 'General Psychology', 3],
    ['BIO 101', 'General Biology', 4], ['MAT 120', 'Statistics', 3],
    ['BIO 201', 'Anatomy & Physiology I', 4], ['BIO 202', 'Anatomy & Physiology II', 4],
    ['NTR 150', 'Human Nutrition', 3], ['MIC 210', 'Microbiology', 4],
    ['PSY 230', 'Developmental Psychology', 3], ['PHI 220', 'Health Care Ethics', 3],
  ].map(([courseCode, name, credits]: any, i) =>
    C({ id: 'p' + i, institutionId: PV, courseCode, name, credits, grade: 'A', term: 'Fall', year: '2020' }))
  const rows = [...pine, ...standalone()]
  const plan = planTransferLinks(rows, INSTITUTIONS)
  assert.equal(plan.links.length, 10, 'all ten still auto-link')
  assert.equal(plan.unresolved.length, 0)
  assert.equal(setupFor(rows).transferGroups.length, 0, 'and there is nothing left to group')
})

test('D53: the UI collapses these groups by default', () => {
  const ui = fs.readFileSync(
    path.join(process.cwd(), 'app/gpa-calculator/components/SetupCard.tsx'), 'utf8')
  // Expansion is per-group state that starts empty, so every group renders shut.
  assert.match(ui, /useState<Record<string, boolean>>\(\{\}\)/)
  assert.match(ui, /const open = !!expandedGroups\[group\.key\]/)
  assert.match(ui, /\{open \? 'Hide records' : `View \$\{n\} record/)
  assert.match(ui, /aria-expanded=\{open\}/)
  // The record list only exists while open, so a collapsed group renders none.
  assert.match(ui, /\{open && \(\s*<ul/)
})
