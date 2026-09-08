import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  deriveSetupState, groupQuarterCoursework, quarterGroupDetail, quarterGroupTitle,
  setupHeading, setupSummary,
} from './setup.ts'
import { calculateGPA, collectIssues, unassignedCourses } from './engine.ts'
import { DEFAULT_POLICIES, type Course, type GpaPolicies, type Institution } from './types.ts'

const RP = 'inst-redwood', SM = 'inst-semester'
const INSTITUTIONS: Institution[] = [
  { id: RP, name: 'Redwood Pacific University', creditSystem: 'quarter', gradingScale: null },
  { id: SM, name: 'Semester State College', creditSystem: 'semester', gradingScale: null },
]

let seq = 0
const C = (o: Partial<Course> & { institutionId: string | null }): Course => ({
  id: o.id ?? 'c' + (++seq), institutionId: o.institutionId, courseCode: o.courseCode ?? null,
  name: o.name ?? 'Course', grade: o.grade ?? 'A', credits: o.credits ?? 4,
  term: o.term ?? 'Fall', year: o.year ?? '2023',
  categories: o.categories ?? ['general'], categorySource: 'ai',
  level: 'undergraduate', levelSource: 'ai', recordType: o.recordType ?? 'coursework',
  transferredIn: false, needsReview: false, reviewReasons: [],
})

/** Student D: 36 quarter-credit courses at one school. */
const redwood = (n = 36): Course[] =>
  Array.from({ length: n }, (_, i) =>
    C({ id: `rp-${i}`, institutionId: RP, courseCode: `BIO ${100 + i}`, name: `Course ${i}`,
        credits: 4, grade: i % 3 === 0 ? 'A' : 'B+' }))

const setupFor = (rows: Course[], policies: GpaPolicies = DEFAULT_POLICIES) => {
  const g = calculateGPA(rows, 'overall', { institutions: INSTITUTIONS, policies })
  return deriveSetupState({
    courses: rows, institutions: INSTITUTIONS, policies,
    unassignedCount: unassignedCourses(rows).length,
    transferUnset: g.exclusions['transfer-policy-unset'] ?? 0,
    retakeUnresolved: g.exclusions['retake-policy-unset'] ?? 0,
    quarterExcluded: g.exclusions['unsupported-credit-system'] ?? 0,
    issues: collectIssues(rows, { institutions: INSTITUTIONS, policies }),
  })
}

// ----------------------------------------------------------- the grouping
test('D57: 36 quarter-credit courses become one section, not 36 review rows', () => {
  const state = setupFor(redwood())
  assert.equal(state.quarterGroups.length, 1)
  assert.equal(state.quarterGroups[0].courses.length, 36)
  assert.equal(state.quarterGroups[0].institutionName, 'Redwood Pacific University')
  assert.equal(state.review.length, 0, 'nothing is listed as needing review')
})

test('D57: the copy explains the limit and promises no conversion', () => {
  const group = setupFor(redwood()).quarterGroups[0]
  assert.equal(quarterGroupTitle(), 'Quarter-credit coursework detected')
  const detail = quarterGroupDetail(group)
  assert.match(detail, /Redwood Pacific University uses quarter credits/)
  assert.match(detail, /semester-credit coursework only/)
  assert.match(detail, /36 courses are preserved but not included in GPA calculations/)
  assert.match(detail, /do not automatically convert quarter credits/i)
  // Nothing that implies the user broke something or can fix it.
  for (const wrong of [/need.{0,3} review/i, /until you fix/i, /error/i, /action required/i]) {
    assert.ok(!wrong.test(detail), String(wrong))
  }
})

test('D57: the card is not introduced as things to review', () => {
  const state = setupFor(redwood())
  assert.equal(setupHeading(state), 'Quarter-credit coursework')
  assert.equal(state.blocked, false)
  assert.ok(!/need.{0,3} review/i.test(setupSummary(state, 36)))
})

test('D57: every quarter course carries the context the list needs', () => {
  const rows = [C({ id: 'x', institutionId: RP, courseCode: 'CHEM 210',
    name: 'Organic Chemistry', credits: 5, grade: 'A-' })]
  const [entry] = groupQuarterCoursework(rows, INSTITUTIONS)[0].courses
  assert.deepEqual(entry, {
    courseId: 'x', courseCode: 'CHEM 210', courseName: 'Organic Chemistry',
    credits: 5, grade: 'A-',
  })
})

test('D57: separate schools on quarter credits are separate sections', () => {
  const other: Institution = { id: 'inst-2', name: 'Cascade College',
    creditSystem: 'quarter', gradingScale: null }
  const rows = [
    ...redwood(3),
    C({ id: 'o1', institutionId: 'inst-2', courseCode: 'ART 100', name: 'Art' }),
  ]
  const groups = groupQuarterCoursework(rows, [...INSTITUTIONS, other])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map(g => g.courses.length), [3, 1])
})

test('D57: a semester school produces no quarter section at all', () => {
  const rows = [C({ id: 's', institutionId: SM, courseCode: 'BIO 101', name: 'Biology' })]
  assert.deepEqual(groupQuarterCoursework(rows, INSTITUTIONS), [])
  assert.deepEqual(setupFor(rows).quarterGroups, [])
})

// --------------------------------------------------- the engine is untouched
test('D57: quarter coursework is still excluded, still preserved, never converted', () => {
  const rows = redwood()
  const gpa = calculateGPA(rows, 'overall', { institutions: INSTITUTIONS, policies: DEFAULT_POLICIES })
  assert.equal(gpa.exclusions['unsupported-credit-system'], 36)
  assert.equal(gpa.coursesCounted, 0)
  assert.equal(gpa.creditsCounted, 0)
  assert.equal(gpa.display, null, 'no number is invented from unsupported credits')
  // The courses themselves are untouched: same count, same credits, same grades.
  assert.equal(rows.length, 36)
  assert.deepEqual([...new Set(rows.map(c => c.credits))], [4], 'no conversion to semester hours')
})

test('D57: semester coursework alongside quarter still calculates', () => {
  const rows = [
    ...redwood(5),
    C({ id: 'sm1', institutionId: SM, courseCode: 'ENG 101', name: 'Composition', credits: 3, grade: 'A' }),
    C({ id: 'sm2', institutionId: SM, courseCode: 'MATH 110', name: 'Algebra', credits: 3, grade: 'B' }),
  ]
  const gpa = calculateGPA(rows, 'overall', { institutions: INSTITUTIONS, policies: DEFAULT_POLICIES })
  assert.equal(gpa.coursesCounted, 2, 'the semester courses count normally')
  assert.equal(gpa.creditsCounted, 6)
  assert.equal(gpa.display, '3.50')
  assert.equal(gpa.exclusions['unsupported-credit-system'], 5)

  const state = setupFor(rows)
  assert.equal(state.quarterGroups[0].courses.length, 5)
  assert.equal(state.blocked, false, 'valid semester coursework is never blocked by this')
})

test('D57: a transfer notation is not listed as quarter coursework', () => {
  const rows = [
    ...redwood(2),
    C({ id: 'n', institutionId: RP, courseCode: 'BIO 101', name: 'Biology',
        recordType: 'transfer_notation', grade: 'TR' }),
  ]
  assert.equal(groupQuarterCoursework(rows, INSTITUTIONS)[0].courses.length, 2)
})

// ------------------------------------------------------------- the UI shape
test('D57: the section is collapsed until the user opens it', () => {
  const ui = fs.readFileSync(
    path.join(process.cwd(), 'app/gpa-calculator/components/SetupCard.tsx'), 'utf8')
  assert.match(ui, /const \[expandedQuarter, setExpandedQuarter\] = useState<Record<string, boolean>>\(\{\}\)/)
  assert.match(ui, /const open = !!expandedQuarter\[key\]/)
  assert.match(ui, /\{open \? 'Hide courses' : `View \$\{n\} course/)
  assert.match(ui, /aria-expanded=\{open\}/)
  // No per-course review or fix control lives in this section.
  const section = ui.slice(ui.indexOf('D57: quarter credit'), ui.indexOf('excluded by rule'))
  assert.ok(!/Review courses|needs review|until you fix/i.test(section))
})
