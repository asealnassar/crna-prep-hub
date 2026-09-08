import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  applyCategoryClassification, scienceVerdict, isScienceSubjectToken,
  isDefaultNonScienceSubject, hasScienceTitleConcept,
} from './classification.ts'
import { planCombine, type CombineSource } from './combine.ts'
import { calculateGPA } from './engine.ts'
import { DEFAULT_POLICIES, type Course, type CourseCategory, type Institution } from './types.ts'

const RV = 'inst-ridgeview', MC = 'inst-meridian', HB = 'inst-harbor'
const INSTITUTIONS: Institution[] = [
  { id: RV, name: 'Ridgeview State University', creditSystem: 'semester', gradingScale: null },
  { id: MC, name: 'Meridian College of Nursing', creditSystem: 'semester', gradingScale: null },
  { id: HB, name: 'Harbor Medical University', creditSystem: 'semester',
    // The Graduate Health Sciences Scale this transcript says applies.
    gradingScale: { source: 'transcript', points: {
      A: 4.0, 'A-': 3.7, 'B+': 3.33, B: 3.0, 'B-': 2.67,
      'C+': 2.33, C: 2.0, 'C-': 1.67, F: 0.0 } } },
]

let seq = 0
const C = (o: Partial<Course> & { institutionId: string | null }): Course => ({
  id: o.id ?? 'c' + (++seq), institutionId: o.institutionId, courseCode: o.courseCode ?? null,
  name: o.name ?? 'Course', grade: o.grade ?? 'A', credits: o.credits ?? 3,
  term: o.term ?? 'Fall', year: o.year ?? '2024',
  categories: o.categories ?? ['general'], categorySource: o.categorySource ?? 'ai',
  level: o.level ?? 'undergraduate', levelSource: 'ai', recordType: o.recordType ?? 'coursework',
  transferredIn: o.transferredIn ?? false, needsReview: false, reviewReasons: [],
})

/** Categories after the deterministic pass, as a sorted set. */
const cats = (courses: readonly Course[], id: string): CourseCategory[] => {
  const out = applyCategoryClassification(courses).courses.find(c => c.id === id)!
  return [...out.categories].sort()
}
const one = (course: Course, rest: Course[] = []) => cats([course, ...rest], course.id)

// -------------------------------------------------------- Nursing (D42)
test('D42: a NURS subject is Nursing', () => {
  assert.deepEqual(one(C({ id: 'x', institutionId: MC, courseCode: 'NURS 201', name: 'Foundations' })),
    ['nursing'])
})

test('D42: NUR and NSG subjects are Nursing too', () => {
  assert.deepEqual(one(C({ id: 'x', institutionId: MC, courseCode: 'NUR 210', name: 'Care' })), ['nursing'])
  assert.deepEqual(one(C({ id: 'x', institutionId: MC, courseCode: 'NSG 310', name: 'Care' })), ['nursing'])
})

test('D42: PHAR is Science and NOT Nursing, even tagged nursing on arrival', () => {
  const course = C({ id: 'x', institutionId: HB, courseCode: 'PHAR 510',
    name: 'Advanced Pharmacology', categories: ['science', 'nursing'] })
  assert.deepEqual(one(course), ['science'])
})

test('D42: a Pharmacology TITLE alone never makes a course Nursing', () => {
  const course = C({ id: 'x', institutionId: HB, courseCode: 'ANES 505',
    name: 'Clinical Pharmacology', categories: ['science', 'nursing'] })
  assert.deepEqual(one(course), ['science'], 'science from the title, nursing needs a department')
})

test('D42: enrollment in a nursing program cannot create Nursing', () => {
  // Every companion is nursing; this one's own subject is not.
  const program = Array.from({ length: 6 }, (_, i) =>
    C({ institutionId: MC, courseCode: `NURS ${200 + i}`, name: `Nursing ${i}`, categories: ['nursing'] }))
  const statistics = C({ id: 'x', institutionId: MC, courseCode: 'STAT 220',
    name: 'Statistics for Health Sciences', categories: ['nursing'] })
  assert.deepEqual(one(statistics, program), ['general'])
})

test('D42: a user’s Nursing choice is never undone', () => {
  const course = C({ id: 'x', institutionId: HB, courseCode: 'PHAR 510',
    name: 'Advanced Pharmacology', categories: ['nursing'], categorySource: 'user' })
  assert.deepEqual(one(course), ['nursing'])
  assert.equal(applyCategoryClassification([course]).courses[0].categorySource, 'user')
})

test('D42: a derived nursing department still stands', () => {
  // The Rutgers shape: a numeric subject the transcript files nursing under.
  const rows = [
    C({ id: 'a', institutionId: 'r', courseCode: '77 705 304', name: 'Found Nsg Practice', categories: ['nursing'] }),
    C({ id: 'b', institutionId: 'r', courseCode: '77 705 305', name: 'Nursing Informatics', categories: ['nursing'] }),
    C({ id: 'x', institutionId: 'r', courseCode: '77 705 202', name: 'Culture, Life & Health' }),
  ]
  assert.deepEqual(cats(rows, 'x'), ['nursing'], 'the department carries the generic title')
})

// -------------------------------------------------------- Science (D56)
test('D56: BIO and BIOL subjects are Science', () => {
  for (const code of ['BIO 101', 'BIOL 111']) {
    assert.deepEqual(one(C({ id: 'x', institutionId: RV, courseCode: code, name: 'Life' })), ['science'])
  }
})

test('D56: CHEM, CHM, MIC, MICR, MICRO, PHAR and NUTR are Science', () => {
  for (const code of ['CHEM 101', 'CHM 210', 'MIC 210', 'MICR 210', 'MICRO 210', 'PHAR 510', 'NUTR 220']) {
    assert.deepEqual(one(C({ id: 'x', institutionId: RV, courseCode: code, name: 'Course' })),
      ['science'], code)
  }
})

test('D56: a science title classifies without the subject code', () => {
  for (const [code, title] of [
    ['ANES 501', 'Advanced Physiology'], ['ANES 520', 'Advanced Pathophysiology'],
    ['XYZ 100', 'Human Anatomy'], ['XYZ 200', 'Clinical Biochemistry'],
    ['XYZ 300', 'General Microbiology'], ['XYZ 400', 'Organic Chemistry'],
    ['XYZ 500', 'Clinical Pharmacology'], ['XYZ 600', 'General Biology'],
  ] as const) {
    assert.deepEqual(one(C({ id: 'x', institutionId: HB, courseCode: code, name: title })),
      ['science'], title)
  }
})

test('D56: STAT, MATH, PSYC and SOC are not Science by default', () => {
  for (const code of ['STAT 515', 'MATH 110', 'MAT 120', 'PSYC 101', 'SOC 101', 'SOCI 210']) {
    assert.deepEqual(
      one(C({ id: 'x', institutionId: RV, courseCode: code, name: 'Course', categories: ['science'] })),
      ['general'], code)
  }
})

test('D56: Biostatistics is not Biology, and not Science', () => {
  assert.equal(hasScienceTitleConcept('Biostatistics'), false, 'a substring is not a subject')
  assert.equal(hasScienceTitleConcept('Advanced Physiology'), true)
  assert.deepEqual(
    one(C({ id: 'x', institutionId: HB, courseCode: 'STAT 515', name: 'Biostatistics',
      categories: ['science'] })), ['general'])
})

test('D56: a user’s Science choice is never undone', () => {
  const course = C({ id: 'x', institutionId: HB, courseCode: 'STAT 515', name: 'Biostatistics',
    categories: ['science'], categorySource: 'user' })
  assert.deepEqual(one(course), ['science'])
})

test('D56: an unruled subject keeps the model’s suggestion', () => {
  assert.equal(scienceVerdict(C({ institutionId: HB, courseCode: 'ANES 501', name: 'Simulation Lab' })),
    'unruled')
  assert.deepEqual(
    one(C({ id: 'x', institutionId: HB, courseCode: 'ANES 501', name: 'Simulation Lab',
      categories: ['science'] })), ['science'], 'AI fallback stands where no rule applies')
  assert.deepEqual(
    one(C({ id: 'x', institutionId: HB, courseCode: 'ANES 502', name: 'Simulation Lab' })),
    ['general'])
})

test('D56: a deterministic classification is not left labelled as the model’s', () => {
  const rows = [
    C({ id: 'sci', institutionId: RV, courseCode: 'BIOL 111', name: 'Biology', categories: ['science'] }),
    C({ id: 'amb', institutionId: HB, courseCode: 'ANES 501', name: 'Simulation', categories: ['science'] }),
  ]
  const out = applyCategoryClassification(rows).courses
  assert.equal(out.find(c => c.id === 'sci')!.categorySource, 'deterministic', 'a rule decided it')
  assert.equal(out.find(c => c.id === 'amb')!.categorySource, 'ai', 'nothing ruled on this one')
})

test('D56: both categories need their own evidence', () => {
  assert.deepEqual(
    one(C({ id: 'x', institutionId: MC, courseCode: 'NURS 210', name: 'Pathophysiology' })),
    ['nursing', 'science'], 'NURS for nursing, pathophysiology for science')
  assert.deepEqual(
    one(C({ id: 'x', institutionId: MC, courseCode: 'NURS 530', name: 'Evidence-Based Practice' })),
    ['nursing'])
})

test('D56: classification is idempotent', () => {
  const rows = [
    C({ id: 'a', institutionId: HB, courseCode: 'PHAR 510', name: 'Advanced Pharmacology', categories: ['science', 'nursing'] }),
    C({ id: 'b', institutionId: HB, courseCode: 'STAT 515', name: 'Biostatistics', categories: ['science'] }),
    C({ id: 'c', institutionId: MC, courseCode: 'NURS 210', name: 'Pathophysiology' }),
  ]
  const once = applyCategoryClassification(rows)
  const twice = applyCategoryClassification(once.courses)
  assert.deepEqual(twice.courses, once.courses)
  assert.equal(twice.changed.length, 0, 'a second pass changes nothing')
})

// ------------------------------------------------------------- Student C3
/** Harbor Medical University, as the transcript prints it. */
const harborRows = (aiCategories: Record<string, CourseCategory[]> = {}): Course[] => ([
  ['ANES 501', 'Advanced Physiology', 'A'], ['PHAR 510', 'Advanced Pharmacology', 'A-'],
  ['STAT 515', 'Biostatistics', 'B+'], ['NURS 520', 'Advanced Pathophysiology', 'A'],
  ['CHEM 525', 'Clinical Biochemistry', 'B+'], ['NURS 530', 'Evidence-Based Practice', 'A-'],
  ['NURS 540', 'Advanced Health Assessment', 'A'],
] as [string, string, string][]).map(([courseCode, name, grade]) =>
  C({ id: courseCode, institutionId: HB, courseCode, name, grade, credits: 3,
      level: 'graduate', categories: aiCategories[courseCode] ?? ['general'] }))

const C3_EXPECTED: Record<string, CourseCategory[]> = {
  'ANES 501': ['science'],
  'PHAR 510': ['science'],
  'STAT 515': ['general'],
  'NURS 520': ['nursing', 'science'],
  'CHEM 525': ['science'],
  'NURS 530': ['nursing'],
  'NURS 540': ['nursing'],
}

test('D56: Student C3 lands on the approved category set', () => {
  const out = applyCategoryClassification(harborRows()).courses
  for (const c of out) assert.deepEqual([...c.categories].sort(), C3_EXPECTED[c.courseCode!], c.courseCode!)
  assert.equal(out.filter(c => c.categories.includes('science')).length, 4)
  assert.equal(out.filter(c => c.categories.includes('nursing')).length, 3)
  assert.equal(out.filter(c => c.level === 'graduate').length, 7)
})

test('D56: Student C3 is the same whatever the model suggested', () => {
  // Three plausible model outputs, including the two wrong ones seen live.
  const variants: Record<string, CourseCategory[]>[] = [
    {},
    { 'PHAR 510': ['science', 'nursing'], 'STAT 515': ['science'] },
    { 'ANES 501': ['general'], 'CHEM 525': ['general'], 'NURS 530': ['science', 'nursing'],
      'NURS 540': ['science', 'nursing'], 'STAT 515': ['science'], 'PHAR 510': ['nursing'] },
  ]
  const results = variants.map(v =>
    JSON.stringify(applyCategoryClassification(harborRows(v)).courses
      .map(c => [c.courseCode, [...c.categories].sort()])))
  assert.equal(new Set(results).size, 1, 'the deterministic layer erases the difference')

  const out = applyCategoryClassification(harborRows(variants[2])).courses
  for (const c of out) assert.deepEqual([...c.categories].sort(), C3_EXPECTED[c.courseCode!], c.courseCode!)
})

test('D56: Student C3 GPA cards match the answer key', () => {
  const rows = applyCategoryClassification(harborRows()).courses
  const ctx = { institutions: INSTITUTIONS, policies: DEFAULT_POLICIES }
  const science = calculateGPA(rows, 'science', ctx)
  assert.equal(science.coursesCounted, 4)
  assert.equal(science.creditsCounted, 12)
  assert.equal(science.display, '3.76')
  const nursing = calculateGPA(rows, 'nursing', ctx)
  assert.equal(nursing.coursesCounted, 3)
  assert.equal(nursing.creditsCounted, 9)
  assert.equal(nursing.display, '3.90')
  const overall = calculateGPA(rows, 'overall', ctx)
  assert.equal(overall.display, '3.72')
  assert.equal(overall.creditsCounted, 21)
  assert.equal(overall.coursesCounted, 7)
  assert.equal(calculateGPA(rows, 'graduate', ctx).coursesCounted, 7)
})

// --------------------------------------------------- C1 and C2 ground truth
test('D56: Ridgeview yields exactly 9 Science and no Nursing', () => {
  const sciences = ['BIOL 111', 'CHEM 101', 'BIOL 201', 'CHEM 102', 'BIOL 202',
                    'MICR 210', 'NUTR 220', 'BIOL 230', 'CHEM 210']
  const others = ['ENGL 101', 'PSYC 101', 'MATH 110', 'STAT 200', 'SOCI 101',
                  'HIST 110', 'ARTS 100', 'PHIL 210', 'ENGL 102', 'COMM 101',
                  'HLTH 120', 'GEOG 101', 'ECON 101']
  const rows = [
    ...sciences.map(code => C({ id: code, institutionId: RV, courseCode: code, name: 'Course' })),
    ...others.map(code => C({ id: code, institutionId: RV, courseCode: code, name: 'Course' })),
  ]
  const out = applyCategoryClassification(rows).courses
  assert.equal(out.filter(c => c.categories.includes('science')).length, 9)
  assert.equal(out.filter(c => c.categories.includes('nursing')).length, 0)
})

test('D56: Meridian yields 17 Nursing, of which 3 are also Science', () => {
  const nursing = [
    ['NURS 201', 'Foundations of Nursing Practice'], ['NURS 205', 'Health Assessment'],
    ['NURS 210', 'Pathophysiology'], ['NURS 215', 'Pharmacology I'],
    ['NURS 220', 'Adult Health Nursing I'], ['NURS 230', 'Mental Health Nursing'],
    ['NURS 235', 'Maternal-Newborn Nursing'], ['NURS 240', 'Pediatric Nursing'],
    ['NURS 245', 'Nursing Research'], ['NURS 301', 'Adult Health Nursing II'],
    ['NURS 305', 'Community Health Nursing'], ['NURS 310', 'Leadership & Management'],
    ['NURS 315', 'Pharmacology II'], ['NURS 320', 'Gerontological Nursing'],
    ['NURS 401', 'Critical Care Nursing'], ['NURS 405', 'Nursing Capstone'],
    ['NURS 410', 'Professional Transitions'],
  ]
  const rows = nursing.map(([courseCode, name]) =>
    C({ id: courseCode, institutionId: MC, courseCode, name }))
  const out = applyCategoryClassification(rows).courses
  assert.equal(out.filter(c => c.categories.includes('nursing')).length, 17)
  const science = out.filter(c => c.categories.includes('science')).map(c => c.courseCode).sort()
  assert.deepEqual(science, ['NURS 210', 'NURS 215', 'NURS 315'])
})

// ------------------------------------------------- combined Student C totals
test('D56: the combined analysis counts 11 Science and 20 Nursing', () => {
  // The counted figures, not raw category tallies: the eight Ridgeview courses
  // Meridian accepted are governed by an unset transfer policy, so they are
  // held out -- five of them Science, none of them Nursing.
  const TRANSFERRED = ['BIOL 111', 'CHEM 101', 'BIOL 201', 'BIOL 202', 'MICR 210',
                       'ENGL 101', 'PSYC 101', 'MATH 110']
  const ridgeview = [
    ...['BIOL 111', 'CHEM 101', 'BIOL 201', 'CHEM 102', 'BIOL 202', 'MICR 210',
        'NUTR 220', 'BIOL 230', 'CHEM 210'],
    ...['ENGL 101', 'PSYC 101', 'MATH 110', 'STAT 200', 'SOCI 101', 'HIST 110',
        'ARTS 100', 'PHIL 210', 'ENGL 102', 'COMM 101', 'HLTH 120', 'GEOG 101',
        'ECON 101'],
  ].map(code => C({
    id: `rv-${code}`, institutionId: RV, courseCode: code, name: 'Course',
    // What a resolved transfer link produces on the originating course.
    transferredIn: TRANSFERRED.includes(code),
  }))

  const meridian = [
    ['NURS 201', 'Foundations'], ['NURS 205', 'Health Assessment'], ['NURS 210', 'Pathophysiology'],
    ['NURS 215', 'Pharmacology I'], ['NURS 220', 'Adult Health I'], ['NURS 230', 'Mental Health'],
    ['NURS 235', 'Maternal-Newborn'], ['NURS 240', 'Pediatric'], ['NURS 245', 'Research'],
    ['NURS 301', 'Adult Health II'], ['NURS 305', 'Community Health'], ['NURS 310', 'Leadership'],
    ['NURS 315', 'Pharmacology II'], ['NURS 320', 'Gerontological'], ['NURS 401', 'Critical Care'],
    ['NURS 405', 'Capstone'], ['NURS 410', 'Transitions'],
  ].map(([courseCode, name]) => C({ id: `mc-${courseCode}`, institutionId: MC, courseCode, name }))

  const notations = TRANSFERRED.map(code => C({
    id: `mc-n-${code}`, institutionId: MC, courseCode: code, name: 'Course', grade: 'TR',
    term: '', year: '', recordType: 'transfer_notation',
  }))

  const rows = applyCategoryClassification(
    [...ridgeview, ...meridian, ...notations, ...harborRows()]).courses

  // Categories first: what the transcripts say, before any policy.
  assert.equal(rows.filter(c => c.recordType === 'coursework' && c.categories.includes('science')).length, 16)
  assert.equal(rows.filter(c => c.recordType === 'coursework' && c.categories.includes('nursing')).length, 20)

  // Then what the GPA counts with the transfer policy still unset.
  const ctx = { institutions: INSTITUTIONS, policies: DEFAULT_POLICIES }
  assert.equal(calculateGPA(rows, 'science', ctx).coursesCounted, 11)
  assert.equal(calculateGPA(rows, 'nursing', ctx).coursesCounted, 20)
  assert.equal(calculateGPA(rows, 'graduate', ctx).coursesCounted, 7)

  // And with transfer coursework included, the five held-out Science courses return.
  const included = { institutions: INSTITUTIONS, policies: { transfer: 'include' as const, retake: null } }
  assert.equal(calculateGPA(rows, 'science', included).coursesCounted, 16)
  assert.equal(calculateGPA(rows, 'nursing', included).coursesCounted, 20, 'no notation ever counts')
})

// ---------------------------------------- four-level nested combine (D55)
test('D55: transfer links survive A + B → + C → + D', () => {
  const link = (rows: Course[]) => rows
  const A: CombineSource = {
    id: 'a-A', name: 'School A', policies: DEFAULT_POLICIES,
    courses: ['BIOL 111', 'CHEM 101', 'MICR 210'].map(code =>
      C({ id: `A-${code}`, institutionId: RV, courseCode: code, name: 'Course', credits: 4 })),
  }
  const B: CombineSource = {
    id: 'a-B', name: 'School B', policies: DEFAULT_POLICIES,
    courses: [
      ...['BIOL 111', 'CHEM 101', 'MICR 210'].map(code =>
        C({ id: `B-n-${code}`, institutionId: MC, courseCode: code, name: 'Course', credits: 4,
            grade: 'TR', term: '', year: '', recordType: 'transfer_notation' })),
      ...['NURS 201', 'NURS 205'].map(code =>
        C({ id: `B-${code}`, institutionId: MC, courseCode: code, name: 'Course' })),
    ].map(c => c.recordType === 'transfer_notation'
      ? { ...c, transferredFromName: 'Ridgeview State University' } : c),
  }
  const C_ = (id: string, inst: string): CombineSource => ({
    id: `a-${id}`, name: `School ${id}`, policies: DEFAULT_POLICIES,
    courses: [C({ id: `${id}-1`, institutionId: inst, courseCode: 'NURS 601', name: 'Course' })],
  })

  let k = 0
  const step = (sources: CombineSource[], id: string): CombineSource => {
    const plan = planCombine({ sources, existingAnalyses: [], institutions: INSTITUTIONS,
      makeId: () => `n${++k}` })
    assert.equal(plan.ok, true, plan.message)
    return { id, name: id, policies: plan.policies!, courses: plan.courses! }
  }

  const level2 = step([A, B], 'a-AB')
  const level3 = step([level2, C_('C', HB)], 'a-ABC')
  const level4 = step([level3, C_('D', 'inst-d')], 'a-ABCD')

  for (const [name, analysis] of [['A+B', level2], ['+C', level3], ['+D', level4]] as const) {
    const byId = new Map(analysis.courses.map(c => [c.id, c]))
    const notations = analysis.courses.filter(c => c.recordType === 'transfer_notation')
    assert.equal(notations.length, 3, name)
    for (const n of notations) {
      const target = byId.get(n.transferLink!.courseId!)
      assert.ok(target, `${name}: ${n.courseCode} resolves inside this analysis`)
      assert.equal(target!.courseCode, n.courseCode, name)
      assert.equal(target!.institutionId, RV, name)
      assert.equal(target!.transferredIn, true, name)
    }
  }
  assert.equal(level4.courses.length, 3 + 5 + 1 + 1)
  // The sources at every level are untouched.
  assert.deepEqual(A.courses.map(c => c.id), ['A-BIOL 111', 'A-CHEM 101', 'A-MICR 210'])
  assert.ok(A.courses.every(c => !c.transferredIn))
  assert.ok(B.courses.every(c => c.transferLink === undefined))
})

// ------------------------------------------------------------ prompt hygiene
test('D56: the prompt no longer contains the rule D42 supersedes', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'app/api/analyze-transcript/route.ts'), 'utf8')
  assert.ok(!/Pathophysiology and Pharmacology are \[/.test(prompt),
    'the title-only nursing rule is gone')
  assert.match(prompt, /NOT nursing merely because it is pharmacology/i)
  assert.match(prompt, /Statistics and Biostatistics are NOT science/i)
})
