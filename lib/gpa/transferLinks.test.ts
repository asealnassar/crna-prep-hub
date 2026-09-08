import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planTransferLinks, applyTransferLinks, setTransferLink, unresolvedTransfers,
  linkedTransferCount, originInstitutionOf, candidatesFor, staleLinks, deriveTransferredIn,
} from './transferLinks.ts'
import { planCombine, type CombineSource } from './combine.ts'
import { calculateGPA } from './engine.ts'
import { DEFAULT_POLICIES, type Course, type GpaPolicies, type Institution } from './types.ts'

const PV = 'inst-pine-valley', LU = 'inst-lakeshore'
const INSTITUTIONS: Institution[] = [
  { id: PV, name: 'Pine Valley Community College', creditSystem: 'semester', gradingScale: null },
  { id: LU, name: 'Lakeshore University', creditSystem: 'semester',
    gradingScale: { source: 'transcript', points: {
      A: 4.0, 'A-': 3.7, 'B+': 3.5, B: 3.0, 'C+': 2.5, C: 2.0, D: 1.0, F: 0.0 } } },
]

let seq = 0
const C = (o: Partial<Course> & { institutionId: string | null }): Course => ({
  id: o.id ?? 'c' + (++seq), institutionId: o.institutionId,
  courseCode: o.courseCode ?? null, name: o.name ?? 'Course', grade: o.grade ?? 'A',
  credits: o.credits ?? 3, term: o.term ?? 'Fall', year: o.year ?? '2020',
  categories: o.categories ?? ['general'], categorySource: 'ai',
  level: 'undergraduate', levelSource: 'ai',
  recordType: o.recordType ?? 'coursework', transferredIn: o.transferredIn ?? false,
  needsReview: false, reviewReasons: [],
  ...(o.transferredFromName !== undefined ? { transferredFromName: o.transferredFromName } : {}),
  ...(o.transferLink !== undefined ? { transferLink: o.transferLink } : {}),
})

const PINE = 'Pine Valley Community College'

/** The 22 Pine Valley rows, exactly as imported and verified in UAT. */
const pineCourses = (): Course[] => [
  C({ id: 'p1', institutionId: PV, courseCode: 'ENG 101', name: 'English Composition I', credits: 3, grade: 'A', term: 'Fall', year: '2019' }),
  C({ id: 'p2', institutionId: PV, courseCode: 'PSY 101', name: 'General Psychology', credits: 3, grade: 'B+', term: 'Fall', year: '2019' }),
  C({ id: 'p3', institutionId: PV, courseCode: 'BIO 101', name: 'General Biology', credits: 4, grade: 'B', term: 'Fall', year: '2019', categories: ['science'] }),
  C({ id: 'p4', institutionId: PV, courseCode: 'MAT 110', name: 'College Algebra', credits: 3, grade: 'B-', term: 'Fall', year: '2019' }),
  C({ id: 'p5', institutionId: PV, courseCode: 'CHM 101', name: 'General Chemistry I', credits: 4, grade: 'F', term: 'Spring', year: '2020', categories: ['science'] }),
  C({ id: 'p6', institutionId: PV, courseCode: 'SOC 101', name: 'Introduction to Sociology', credits: 3, grade: 'A', term: 'Spring', year: '2020' }),
  C({ id: 'p7', institutionId: PV, courseCode: 'ENG 102', name: 'English Composition II', credits: 3, grade: 'B+', term: 'Spring', year: '2020' }),
  C({ id: 'p8', institutionId: PV, courseCode: 'MAT 120', name: 'Statistics', credits: 3, grade: 'B', term: 'Spring', year: '2020' }),
  C({ id: 'p9', institutionId: PV, courseCode: 'CHM 101', name: 'General Chemistry I', credits: 4, grade: 'A', term: 'Summer', year: '2020', categories: ['science'] }),
  C({ id: 'p10', institutionId: PV, courseCode: 'PED 110', name: 'Lifetime Fitness', credits: 2, grade: 'P', term: 'Summer', year: '2020' }),
  C({ id: 'p11', institutionId: PV, courseCode: 'BIO 201', name: 'Anatomy & Physiology I', credits: 4, grade: 'A-', term: 'Fall', year: '2020', categories: ['science'] }),
  C({ id: 'p12', institutionId: PV, courseCode: 'BIO 202', name: 'Anatomy & Physiology II', credits: 4, grade: 'B+', term: 'Fall', year: '2020', categories: ['science'] }),
  C({ id: 'p13', institutionId: PV, courseCode: 'NTR 150', name: 'Human Nutrition', credits: 3, grade: 'A', term: 'Fall', year: '2020', categories: ['science'] }),
  C({ id: 'p14', institutionId: PV, courseCode: 'COM 101', name: 'Interpersonal Communication', credits: 3, grade: 'A-', term: 'Fall', year: '2020' }),
  C({ id: 'p15', institutionId: PV, courseCode: 'MIC 210', name: 'Microbiology', credits: 4, grade: 'A', term: 'Spring', year: '2021', categories: ['science'] }),
  C({ id: 'p16', institutionId: PV, courseCode: 'CHM 205', name: 'Organic & Biological Chemistry', credits: 4, grade: 'B+', term: 'Spring', year: '2021', categories: ['science'] }),
  C({ id: 'p17', institutionId: PV, courseCode: 'PSY 230', name: 'Developmental Psychology', credits: 3, grade: 'A', term: 'Spring', year: '2021' }),
  C({ id: 'p18', institutionId: PV, courseCode: 'ART 100', name: 'Art Appreciation', credits: 3, grade: 'P', term: 'Spring', year: '2021' }),
  C({ id: 'p19', institutionId: PV, courseCode: 'HIS 110', name: 'World History', credits: 3, grade: 'WD', term: 'Spring', year: '2021' }),
  C({ id: 'p20', institutionId: PV, courseCode: 'PHI 220', name: 'Health Care Ethics', credits: 3, grade: 'A-', term: 'Fall', year: '2021' }),
  C({ id: 'p21', institutionId: PV, courseCode: 'MAT 210', name: 'Applied Statistics', credits: 3, grade: 'A', term: 'Fall', year: '2021' }),
  C({ id: 'p22', institutionId: PV, courseCode: 'HLT 200', name: 'Health Promotion', credits: 3, grade: 'B+', term: 'Fall', year: '2021' }),
]

/** The 10 Lakeshore notation rows, two of them with a blank grade as printed. */
const notationRows = (): Course[] => ([
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
] as [string, string, number, string][]).map(([code, name, credits, grade], i) =>
  C({ id: 'n' + (i + 1), institutionId: LU, courseCode: code, name, credits, grade,
      term: '', year: '', recordType: 'transfer_notation', transferredFromName: PINE }))

/** The 15 Lakeshore GPA-bearing rows. */
const lakeshoreCourses = (): Course[] => ([
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

const pineSource = (): CombineSource => ({
  id: 'a-pine', name: 'Pine Valley Community College', policies: DEFAULT_POLICIES,
  courses: pineCourses(),
})
const lakeSource = (): CombineSource => ({
  id: 'a-lake', name: 'Lakeshore University', policies: DEFAULT_POLICIES,
  courses: [...notationRows(), ...lakeshoreCourses()],
})

/** Student B, combined under D47 with D50 linking applied. */
function combined(): Course[] {
  const plan = planCombine({
    sources: [pineSource(), lakeSource()], existingAnalyses: [],
    institutions: INSTITUTIONS, makeId: i => `x${i}`,
  })
  assert.equal(plan.ok, true, plan.message)
  return plan.courses!
}

const gpa = (courses: readonly Course[], filter: any, policies: GpaPolicies) =>
  calculateGPA(courses, filter, { institutions: INSTITUTIONS, policies })

// ------------------------------------------------- capturing the origin school
test('D50: the originating school is captured on the notation', () => {
  const n = notationRows()[0]
  assert.equal(n.transferredFromName, PINE)
  assert.equal(n.recordType, 'transfer_notation')
})

test('D50: the notation still belongs to the RECEIVING school', () => {
  for (const n of notationRows()) {
    assert.equal(n.institutionId, LU, 'the row is Lakeshore’s, not Pine Valley’s')
    assert.notEqual(n.institutionId, PV)
  }
  const origin = originInstitutionOf(notationRows()[0], INSTITUTIONS)
  assert.equal(origin?.id, PV, 'and the origin resolves separately')
})

test('D50: an origin name resolves through the existing institution matching', () => {
  const n = C({ institutionId: LU, courseCode: 'BIO 201', credits: 4,
    recordType: 'transfer_notation', transferredFromName: '  pine valley community college ' })
  assert.equal(originInstitutionOf(n, INSTITUTIONS)?.id, PV, 'case and spacing are absorbed')
})

// ----------------------------------------------------------- automatic linking
test('D50: a unique origin + code + credits match links automatically', () => {
  const rows = combined()
  const notations = rows.filter(c => c.recordType === 'transfer_notation')
  assert.equal(notations.length, 10)
  assert.equal(notations.filter(c => c.transferLink?.courseId).length, 10, 'all 10 link')
  assert.ok(notations.every(c => c.transferLink?.source === 'auto'))
})

test('D50: all 10 Student B links point at the right Pine Valley course', () => {
  const rows = combined()
  const byId = new Map(rows.map(c => [c.id, c]))
  for (const n of rows.filter(c => c.recordType === 'transfer_notation')) {
    const target = byId.get(n.transferLink!.courseId!)!
    assert.ok(target, n.courseCode!)
    assert.equal(target.courseCode, n.courseCode)
    assert.equal(target.credits, n.credits)
    assert.equal(target.institutionId, PV)
    assert.equal(target.recordType, 'coursework')
  }
  assert.equal(linkedTransferCount(rows), 10)
  assert.equal(rows.filter(c => c.transferredIn).length, 10, 'transfer affected count')
  assert.equal(rows.filter(c => c.transferredIn).reduce((n, c) => n + c.credits, 0), 34)
})

test('D50: a blank notation grade links exactly like a TR one', () => {
  const rows = combined()
  const byId = new Map(rows.map(c => [c.id, c]))
  const blanks = rows.filter(c => c.recordType === 'transfer_notation' && c.grade === '')
  assert.equal(blanks.length, 2, 'NTR 150 and PSY 230 print no grade')
  for (const b of blanks) {
    assert.ok(b.transferLink?.courseId, `${b.courseCode} still links`)
    assert.equal(byId.get(b.transferLink!.courseId!)!.courseCode, b.courseCode)
  }
  const tr = rows.filter(c => c.recordType === 'transfer_notation' && c.grade === 'TR')
  assert.equal(tr.length, 8)
  assert.ok(tr.every(c => c.transferLink?.courseId))
})

test('D50: a renamed or abbreviated title does not prevent a link', () => {
  const pine = pineSource()
  const notation = C({ institutionId: LU, courseCode: 'BIO 201', name: 'A&P I',
    credits: 4, grade: 'TR', recordType: 'transfer_notation', transferredFromName: PINE })
  const plan = planTransferLinks([...pine.courses, notation], INSTITUTIONS)
  assert.equal(plan.links.length, 1)
  assert.equal(plan.links[0].courseId, 'p11', 'code and credits are the evidence, not the title')
})

// ----------------------------------------------------------- ambiguity refusals
const unresolvedReason = (rows: Course[]) => {
  const u = planTransferLinks(rows, INSTITUTIONS).unresolved
  assert.equal(u.length, 1, JSON.stringify(u))
  return u[0].reason
}

test('D50: a notation naming no school stays unresolved', () => {
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'BIO 201', credits: 4,
    recordType: 'transfer_notation', transferredFromName: null })]
  assert.equal(unresolvedReason(rows), 'origin-unknown')
  assert.equal(planTransferLinks(rows, INSTITUTIONS).links.length, 0)
})

test('D50: an origin school not in the analysis stays unresolved', () => {
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'BIO 201', credits: 4,
    recordType: 'transfer_notation', transferredFromName: 'Harborview State College' })]
  assert.equal(unresolvedReason(rows), 'origin-not-in-analysis')
})

test('D50: a school on the account but absent from THIS analysis is not a match failure', () => {
  // Lakeshore standing alone: Pine Valley exists as an institution, but its
  // transcript is not part of this analysis, so there is nothing to match yet.
  const alone = [...notationRows(), ...lakeshoreCourses()]
  const u = planTransferLinks(alone, INSTITUTIONS).unresolved
  assert.equal(u.length, 10)
  assert.ok(u.every(x => x.reason === 'origin-not-in-analysis'),
    'the honest answer is that the transcript is missing, not that nothing matched')
  assert.equal(planTransferLinks(alone, INSTITUTIONS).links.length, 0)
})

test('D50: no candidate at that school stays unresolved', () => {
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'ZOO 900', credits: 3,
    recordType: 'transfer_notation', transferredFromName: PINE })]
  assert.equal(unresolvedReason(rows), 'no-candidate')
})

test('D50: more than one candidate stays unresolved, and is never guessed', () => {
  // CHM 101 was taken twice at Pine Valley, both 4 credits.
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'CHM 101', credits: 4,
    recordType: 'transfer_notation', transferredFromName: PINE })]
  assert.equal(unresolvedReason(rows), 'ambiguous')
  const u = planTransferLinks(rows, INSTITUTIONS).unresolved[0]
  assert.equal(u.candidates.length, 2, 'both attempts are offered to the user')
})

test('D50: a matching code with different credits does NOT link', () => {
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'BIO 201', credits: 3,
    recordType: 'transfer_notation', transferredFromName: PINE })]
  assert.equal(unresolvedReason(rows), 'no-candidate')
  assert.equal(candidatesFor(rows[rows.length - 1], rows, PV).length, 0)
})

test('D50: a title-only resemblance never links', () => {
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: null,
    name: 'Anatomy & Physiology I', credits: 4,
    recordType: 'transfer_notation', transferredFromName: PINE })]
  assert.equal(unresolvedReason(rows), 'no-code')
  assert.equal(planTransferLinks(rows, INSTITUTIONS).links.length, 0)
})

test('D50: two notations cannot both claim one attempt', () => {
  const twice = [...pineCourses(),
    C({ id: 'na', institutionId: LU, courseCode: 'BIO 201', credits: 4, recordType: 'transfer_notation', transferredFromName: PINE }),
    C({ id: 'nb', institutionId: LU, courseCode: 'BIO 201', credits: 4, recordType: 'transfer_notation', transferredFromName: PINE })]
  const plan = planTransferLinks(twice, INSTITUTIONS)
  assert.equal(plan.links.length, 1, 'the first claims it')
  assert.equal(plan.unresolved.length, 1, 'the second is left for the user')
  assert.equal(plan.unresolved[0].reason, 'no-candidate')
})

// ---------------------------------------------------- Student B unresolved state
test('D50: Student B before either policy is chosen', () => {
  const rows = combined()
  assert.equal(rows.length, 47)
  const p = DEFAULT_POLICIES
  const overall = gpa(rows, 'overall', p)
  assert.equal(overall.display, '3.66')
  assert.equal(overall.creditsCounted, 77)
  assert.equal(overall.coursesCounted, 22)

  const science = gpa(rows, 'science', p)
  assert.equal(science.display, '3.55')
  assert.equal(science.coursesCounted, 4)
  assert.equal(science.creditsCounted, 13)

  const nursing = gpa(rows, 'nursing', p)
  assert.equal(nursing.display, '3.74')
  assert.equal(nursing.coursesCounted, 15)

  const last60 = gpa(rows, 'last60', p)
  assert.equal(last60.display, '3.73')
  assert.equal(last60.creditsCounted, 61)

  assert.equal(overall.exclusions['transfer-policy-unset'], 10, 'transfer affected count')
  assert.equal(overall.exclusions['retake-policy-unset'], 2, 'repeat attempts awaiting review')
  assert.equal(overall.exclusions['transfer-notation'], 10, 'notation never counts')
})

// --------------------------------------------------------------- policy matrix
const MATRIX: [GpaPolicies, Record<string, [string, number, number]>][] = [
  [{ transfer: 'include', retake: 'latest' },
   { overall: ['3.65', 115, 33], science: ['3.62', 36, 10], nursing: ['3.74', 55, 15], last60: ['3.73', 64, 18] }],
  [{ transfer: 'include', retake: 'both' },
   { overall: ['3.53', 119, 34], science: ['3.26', 40, 11], nursing: ['3.74', 55, 15], last60: ['3.73', 64, 18] }],
  [{ transfer: 'exclude', retake: 'latest' },
   { overall: ['3.68', 81, 23], science: ['3.66', 17, 5], nursing: ['3.74', 55, 15], last60: ['3.73', 61, 17] }],
  [{ transfer: 'exclude', retake: 'both' },
   { overall: ['3.50', 85, 24], science: ['2.96', 21, 6], nursing: ['3.74', 55, 15], last60: ['3.73', 61, 17] }],
]

for (const [policies, expected] of MATRIX) {
  test(`D50: transfer ${policies.transfer} + retake ${policies.retake} matches the answer key`, () => {
    const rows = combined()
    for (const [filter, [display, credits, courses]] of Object.entries(expected)) {
      const g = gpa(rows, filter as any, policies)
      assert.equal(g.display, display, `${filter} GPA`)
      assert.equal(g.creditsCounted, credits, `${filter} credits`)
      if (filter !== 'last60') assert.equal(g.coursesCounted, courses, `${filter} courses`)
    }
    // A notation is never GPA-bearing under any combination.
    assert.equal(gpa(rows, 'overall', policies).exclusions['transfer-notation'], 10)
  })
}

// ------------------------------------------------------------ source safety
test('D50: linking never touches the source analyses', () => {
  const pine = pineSource(), lake = lakeSource()
  const before = JSON.stringify([pine, lake])
  const plan = planCombine({
    sources: [pine, lake], existingAnalyses: [], institutions: INSTITUTIONS, makeId: i => `x${i}` })
  assert.equal(plan.ok, true)
  assert.equal(JSON.stringify([pine, lake]), before, 'byte-identical afterwards')
  assert.equal(pine.courses.length, 22)
  assert.equal(lake.courses.length, 25)
  assert.equal(pine.courses.filter(c => c.transferredIn).length, 0, 'no flags leaked back')
  assert.ok(lake.courses.every(c => c.transferLink === undefined), 'no links leaked back')
})

test('D50: the notation and the original both survive as separate rows', () => {
  const rows = combined()
  assert.equal(rows.filter(c => c.recordType === 'transfer_notation').length, 10)
  assert.equal(rows.filter(c => c.recordType === 'coursework').length, 37)
  // The originating rows are still there, still coursework, still graded.
  const eng = rows.filter(c => c.courseCode === 'ENG 101')
  assert.equal(eng.length, 2, 'one notation, one real attempt -- neither deduplicated')
  assert.equal(eng.filter(c => c.recordType === 'coursework')[0].grade, 'A')
  assert.equal(eng.filter(c => c.recordType === 'transfer_notation')[0].grade, 'TR')
})

test('D50: notation grades are preserved exactly as printed', () => {
  const rows = combined().filter(c => c.recordType === 'transfer_notation')
  assert.deepEqual(rows.map(c => c.grade).sort(),
    ['', '', 'TR', 'TR', 'TR', 'TR', 'TR', 'TR', 'TR', 'TR'])
})

// --------------------------------------------------------- user corrections
test('D50: a user removing a link is respected and not re-linked', () => {
  const rows = combined()
  const notation = rows.find(c => c.recordType === 'transfer_notation' && c.courseCode === 'BIO 201')!
  const target = notation.transferLink!.courseId!
  const corrected = setTransferLink(rows, notation.id, null)

  const after = corrected.find(c => c.id === notation.id)!
  assert.equal(after.transferLink!.courseId, null)
  assert.equal(after.transferLink!.source, 'user')
  assert.equal(corrected.find(c => c.id === target)!.transferredIn, false,
    'the course stops being governed by transfer policy')
  assert.equal(linkedTransferCount(corrected), 9)

  // A second automatic pass must not quietly put it back.
  const again = applyTransferLinks(corrected, planTransferLinks(corrected, INSTITUTIONS))
  assert.equal(again.find(c => c.id === notation.id)!.transferLink!.courseId, null)
  assert.equal(linkedTransferCount(again), 9)
})

test('D50: a user choosing a different course is respected', () => {
  const rows = combined()
  const notation = rows.find(c => c.recordType === 'transfer_notation' && c.courseCode === 'MAT 120')!
  const other = rows.find(c => c.recordType === 'coursework' && c.courseCode === 'MAT 210')!
  const corrected = setTransferLink(rows, notation.id, other.id)
  assert.equal(corrected.find(c => c.id === notation.id)!.transferLink!.source, 'user')
  assert.equal(corrected.find(c => c.id === other.id)!.transferredIn, true)
  assert.equal(linkedTransferCount(corrected), 10)
})

test('D50: re-running the automatic pass creates no duplicate links', () => {
  const once = combined()
  const twice = applyTransferLinks(once, planTransferLinks(once, INSTITUTIONS))
  assert.equal(linkedTransferCount(twice), 10)
  assert.deepEqual(
    twice.filter(c => c.recordType === 'transfer_notation').map(c => c.transferLink!.courseId),
    once.filter(c => c.recordType === 'transfer_notation').map(c => c.transferLink!.courseId))
  assert.equal(twice.filter(c => c.transferredIn).length, 10)
})

test('D50: links survive a round trip through storage', () => {
  const rows = combined()
  const reloaded: Course[] = JSON.parse(JSON.stringify(rows))
  assert.equal(linkedTransferCount(reloaded), 10)
  assert.equal(reloaded.filter(c => c.transferredIn).length, 10)
  assert.equal(gpa(reloaded, 'overall', DEFAULT_POLICIES).display, '3.66')
  // And a user's "none" survives it too.
  const notation = rows.find(c => c.recordType === 'transfer_notation')!
  const saved: Course[] = JSON.parse(JSON.stringify(setTransferLink(rows, notation.id, null)))
  assert.equal(saved.find(c => c.id === notation.id)!.transferLink!.courseId, null)
  assert.equal(linkedTransferCount(saved), 9)
})

// ------------------------------------------------------------------ hygiene
test('D50: an analysis with no notations is completely unaffected', () => {
  const only = pineCourses()
  const plan = planTransferLinks(only, INSTITUTIONS)
  assert.deepEqual(plan.links, [])
  assert.deepEqual(plan.unresolved, [])
  assert.deepEqual(deriveTransferredIn(only), only, 'no flag is invented')
})

test('D50: coursework a transcript itself declared transferred is left alone', () => {
  const declared = [C({ institutionId: PV, courseCode: 'BIO 101', credits: 4, transferredIn: true })]
  assert.equal(deriveTransferredIn(declared)[0].transferredIn, true)
})

test('D50: a link whose evidence stopped holding is reported, not hidden', () => {
  const rows = combined()
  const notation = rows.find(c => c.recordType === 'transfer_notation' && c.courseCode === 'BIO 201')!
  const edited = rows.map(c =>
    c.id === notation.transferLink!.courseId ? { ...c, credits: 3 } : c)
  const stale = staleLinks(edited, INSTITUTIONS)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].reason, 'credits')
  assert.equal(staleLinks(rows, INSTITUTIONS).length, 0, 'a healthy analysis reports none')
})

test('D50: unresolvedTransfers is what the setup card is given', () => {
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'ZOO 900', credits: 3,
    recordType: 'transfer_notation', transferredFromName: PINE })]
  const u = unresolvedTransfers(rows, INSTITUTIONS)
  assert.equal(u.length, 1)
  assert.equal(u[0].reason, 'no-candidate')
  assert.equal(unresolvedTransfers(combined(), INSTITUTIONS).length, 0,
    'Student B has nothing left to confirm')
})

// ============================================ D50 follow-up: stale links (Rule 1)
import { transferReviews, coursesAwaitingLinkReview, plausibleCandidates } from './transferLinks.ts'
import { deriveSetupState } from './setup.ts'
import { collectIssues, unassignedCourses } from './engine.ts'

/** The combined analysis with one linked Pine Valley course edited. */
function edited(change: (c: Course) => Course): { rows: Course[]; notation: Course; targetId: string } {
  const rows = combined()
  const notation = rows.find(c => c.recordType === 'transfer_notation' && c.courseCode === 'BIO 201')!
  const targetId = notation.transferLink!.courseId!
  return { rows: rows.map(c => (c.id === targetId ? change(c) : c)), notation, targetId }
}

test('D50/R1: editing the linked course’s CODE makes the link stale', () => {
  const { rows, notation, targetId } = edited(c => ({ ...c, courseCode: 'BIO 999' }))
  const stale = staleLinks(rows, INSTITUTIONS)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].reason, 'code')
  assert.equal(stale[0].notationId, notation.id)
  assert.equal(stale[0].courseId, targetId)
})

test('D50/R1: editing the linked course’s CREDITS makes the link stale', () => {
  const { rows } = edited(c => ({ ...c, credits: 3 }))
  const stale = staleLinks(rows, INSTITUTIONS)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].reason, 'credits')
})

test('D50/R1: editing only the TITLE leaves the link alone', () => {
  const { rows, targetId } = edited(c => ({ ...c, name: 'Anatomy and Physiology I (Lecture)' }))
  assert.deepEqual(staleLinks(rows, INSTITUTIONS), [])
  assert.equal(coursesAwaitingLinkReview(rows, INSTITUTIONS).size, 0)
  assert.equal(rows.find(c => c.id === targetId)!.transferredIn, true, 'still transferred')
})

test('D50/R1: the edit itself is always allowed', () => {
  const { rows, targetId } = edited(c => ({ ...c, credits: 3 }))
  assert.equal(rows.find(c => c.id === targetId)!.credits, 3, 'the user’s edit stands')
  assert.equal(rows.length, 47, 'nothing was removed to protect a link')
})

test('D50/R1: a stale link withholds its course under its own reason', () => {
  const { rows, targetId } = edited(c => ({ ...c, credits: 3 }))
  for (const policies of [DEFAULT_POLICIES,
    { transfer: 'include', retake: 'both' } as GpaPolicies,
    { transfer: 'exclude', retake: 'latest' } as GpaPolicies]) {
    const g = gpa(rows, 'overall', policies)
    assert.equal(g.exclusions['transfer-link-review-required'], 1, JSON.stringify(policies))
    assert.ok(!g.issues.some(i => i.courseId === targetId && i.reason === 'transfer-policy-unset'),
      'not reported as an ordinary transfer-policy question')
  }
})

test('D50/R1: Include cannot force a stale course back into the GPA', () => {
  const { rows, targetId } = edited(c => ({ ...c, credits: 3 }))
  const included = gpa(rows, 'overall', { transfer: 'include', retake: 'latest' })
  const counted = calculateGPA(rows, 'overall',
    { institutions: INSTITUTIONS, policies: { transfer: 'include', retake: 'latest' } })
  assert.equal(included.exclusions['transfer-link-review-required'], 1)
  assert.ok(!counted.issues.some(i => i.courseId === targetId && i.reason === 'grade-not-in-scale'))
  // The clean analysis under the same policy counts one more course.
  const clean = gpa(combined(), 'overall', { transfer: 'include', retake: 'latest' })
  assert.equal(clean.coursesCounted - included.coursesCounted, 1, 'exactly the stale course is held out')
})

test('D50/R1: a stale link raises a REQUIRED setup item', () => {
  const { rows } = edited(c => ({ ...c, credits: 3 }))
  const reviews = transferReviews(rows, INSTITUTIONS)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].reason, 'stale')
  assert.equal(reviews[0].severity, 'required')

  const state = setupFor(rows, DEFAULT_POLICIES, reviews)
  assert.equal(state.required.filter(r => r.kind === 'transfer-link').length, 1)
  assert.equal(state.transferConfirms[0].label, 'Transfer link needs review')
  assert.ok(state.blocked)
})

test('D50/R1: re-confirming the right course clears the required state', () => {
  const { rows, notation, targetId } = edited(c => ({ ...c, credits: 3 }))
  const fixed = setTransferLink(rows, notation.id, targetId)
  assert.deepEqual(staleLinks(fixed, INSTITUTIONS), [], 'a user’s own choice is authoritative')
  assert.equal(transferReviews(fixed, INSTITUTIONS).length, 0)
  assert.equal(gpa(fixed, 'overall', DEFAULT_POLICIES).exclusions['transfer-link-review-required'], undefined)
  assert.equal(fixed.find(c => c.id === targetId)!.transferredIn, true, 'back under transfer policy')
  assert.equal(fixed.find(c => c.id === notation.id)!.transferLink!.source, 'user')
})

test('D50/R1: choosing a different valid candidate persists', () => {
  const { rows, notation, targetId } = edited(c => ({ ...c, credits: 3 }))
  const other = rows.find(c => c.recordType === 'coursework' && c.courseCode === 'BIO 202')!
  const fixed = setTransferLink(rows, notation.id, other.id)
  assert.equal(fixed.find(c => c.id === notation.id)!.transferLink!.courseId, other.id)
  assert.equal(fixed.find(c => c.id === other.id)!.transferredIn, true)
  assert.equal(fixed.find(c => c.id === targetId)!.transferredIn, false, 'the old target is released')
  assert.deepEqual(staleLinks(fixed, INSTITUTIONS), [])
})

test('D50/R1: "Not in this analysis" persists and is never auto-restored', () => {
  const { rows, notation, targetId } = edited(c => ({ ...c, credits: 3 }))
  const answered = setTransferLink(rows, notation.id, null)
  assert.equal(transferReviews(answered, INSTITUTIONS).length, 0)
  assert.equal(answered.find(c => c.id === targetId)!.transferredIn, false)
  assert.equal(gpa(answered, 'overall', DEFAULT_POLICIES).exclusions['transfer-link-review-required'], undefined)

  const reRun = applyTransferLinks(answered, planTransferLinks(answered, INSTITUTIONS))
  assert.equal(reRun.find(c => c.id === notation.id)!.transferLink!.courseId, null)
  const reloaded: Course[] = JSON.parse(JSON.stringify(reRun))
  assert.equal(reloaded.find(c => c.id === notation.id)!.transferLink!.courseId, null)
  assert.equal(transferReviews(reloaded, INSTITUTIONS).length, 0, 'survives a reload')
})

test('D50/R1: stale state itself survives a reload', () => {
  const { rows } = edited(c => ({ ...c, credits: 3 }))
  const reloaded: Course[] = JSON.parse(JSON.stringify(rows))
  assert.equal(staleLinks(reloaded, INSTITUTIONS).length, 1)
  assert.equal(gpa(reloaded, 'overall', DEFAULT_POLICIES).exclusions['transfer-link-review-required'], 1)
})

// ================================= D50 follow-up: required vs optional (Rule 2)
function setupFor(rows: Course[], policies: GpaPolicies, reviews = transferReviews(rows, INSTITUTIONS)) {
  const issues = collectIssues(rows, { institutions: INSTITUTIONS, policies })
  const g = calculateGPA(rows, 'overall', { institutions: INSTITUTIONS, policies })
  return deriveSetupState({
    courses: rows, institutions: INSTITUTIONS, policies,
    unassignedCount: unassignedCourses(rows).length,
    transferUnset: g.exclusions['transfer-policy-unset'] ?? 0,
    retakeUnresolved: g.exclusions['retake-policy-unset'] ?? 0,
    quarterExcluded: g.exclusions['unsupported-credit-system'] ?? 0,
    issues, unresolvedTransfers: reviews,
  })
}

test('D50/R2/B: several plausible candidates is a REQUIRED review', () => {
  // Two Pine Valley CHM 101 attempts, both 4 credits: we will not guess.
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'CHM 101', credits: 4,
    recordType: 'transfer_notation', transferredFromName: PINE })]
  const r = transferReviews(rows, INSTITUTIONS)
  assert.equal(r.length, 1)
  assert.equal(r[0].reason, 'ambiguous')
  assert.equal(r[0].severity, 'required')
  assert.equal(r[0].candidates.length, 2, 'both attempts are offered')
  assert.equal(setupFor(rows, DEFAULT_POLICIES).required.filter(x => x.kind === 'transfer-link').length, 1)
})

test('D50/R2/C: an origin school absent from the analysis is optional only', () => {
  const alone = [...notationRows(), ...lakeshoreCourses()]
  const r = transferReviews(alone, INSTITUTIONS)
  assert.equal(r.length, 10)
  assert.ok(r.every(x => x.severity === 'optional'), 'nothing here hangs on the answer')
  const state = setupFor(alone, DEFAULT_POLICIES)
  assert.equal(state.required.filter(x => x.kind === 'transfer-link').length, 0)
  assert.equal(state.transferConfirms.length, 10)
})

test('D50/R2/C: no candidate at all is optional only', () => {
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'ZOO 900', credits: 3,
    recordType: 'transfer_notation', transferredFromName: PINE })]
  const r = transferReviews(rows, INSTITUTIONS)
  assert.equal(r[0].reason, 'no-candidate')
  assert.equal(r[0].severity, 'optional')
  assert.equal(plausibleCandidates(rows[rows.length - 1], rows).length, 0)
  assert.equal(setupFor(rows, DEFAULT_POLICIES).required.filter(x => x.kind === 'transfer-link').length, 0)
})

test('D50/R2/C: an unknown origin with nothing plausible is optional only', () => {
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'ZOO 900', credits: 3,
    recordType: 'transfer_notation', transferredFromName: null })]
  const r = transferReviews(rows, INSTITUTIONS)
  assert.equal(r[0].reason, 'origin-unknown')
  assert.equal(r[0].severity, 'optional')
})

test('D50/R2/B: an unknown origin WITH plausible coursework is required', () => {
  // The school is not named, but a course here matches code and credits, so
  // whether it counts genuinely depends on the answer.
  const rows = [...pineCourses(), C({ institutionId: LU, courseCode: 'BIO 201', credits: 4,
    recordType: 'transfer_notation', transferredFromName: null })]
  const r = transferReviews(rows, INSTITUTIONS)
  assert.equal(r[0].reason, 'origin-unknown')
  assert.equal(r[0].severity, 'required')
  assert.equal(r[0].candidates.length > 0, true)
})

test('D50/R2/A: Student B’s 10 unique matches stay automatic, nothing to confirm', () => {
  const rows = combined()
  assert.equal(transferReviews(rows, INSTITUTIONS).length, 0)
  const state = setupFor(rows, DEFAULT_POLICIES)
  assert.equal(state.transferConfirms.length, 0)
  assert.deepEqual(state.required.map(r => r.kind).sort(), ['retake-policy', 'transfer-policy'],
    'exactly the two policy decisions')
})

test('D50/R2: a transfer notation still never counts, in every state', () => {
  const { rows } = edited(c => ({ ...c, credits: 3 }))
  for (const policies of [DEFAULT_POLICIES,
    { transfer: 'include', retake: 'both' } as GpaPolicies,
    { transfer: 'exclude', retake: 'both' } as GpaPolicies]) {
    assert.equal(gpa(rows, 'overall', policies).exclusions['transfer-notation'], 10)
  }
})

test('D50/R1: a stale link never reaches the source analyses', () => {
  const pine = pineSource(), lake = lakeSource()
  const plan = planCombine({ sources: [pine, lake], existingAnalyses: [],
    institutions: INSTITUTIONS, makeId: i => `x${i}` })
  const target = plan.courses!.find(c => c.recordType === 'transfer_notation')!.transferLink!.courseId!
  plan.courses!.map(c => (c.id === target ? { ...c, credits: 1 } : c))
  assert.equal(pine.courses.length, 22)
  assert.equal(lake.courses.length, 25)
  assert.equal(pine.courses.filter(c => c.transferredIn).length, 0)
  assert.ok(pine.courses.every(c => c.transferLink === undefined))
})
