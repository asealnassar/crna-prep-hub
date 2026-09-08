import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  subjectKeyOf, isNursingSubjectToken, deriveNursingSubjects,
  applyNursingSubjectClassification,
} from './classification.ts'
import { calculateGPA } from './engine.ts'
import type { Course, CourseCategory, Institution } from './types.ts'

const C = (o: Partial<Course> & { name: string; courseCode: string | null }): Course => ({
  id: o.id ?? o.name, institutionId: o.institutionId ?? 'I1', courseCode: o.courseCode,
  name: o.name, grade: o.grade ?? 'A', credits: o.credits ?? 3,
  year: o.year ?? '2021', term: o.term ?? 'Fall',
  categories: o.categories ?? ['general'], categorySource: o.categorySource ?? 'ai',
  level: 'undergraduate', levelSource: 'default',
  recordType: o.recordType ?? 'coursework', transferredIn: false,
  needsReview: false, reviewReasons: [],
})

// ------------------------------------------------------------------ parsing
test('D42: the subject key is the catalog number without its course number', () => {
  assert.equal(subjectKeyOf('NURS 310'), 'NURS')
  assert.equal(subjectKeyOf('BIOL-101'), 'BIOL')
  assert.equal(subjectKeyOf('BIOL101'), 'BIOL')
  assert.equal(subjectKeyOf('77:705:202'), '77 705')
  assert.equal(subjectKeyOf('77 705 202'), '77 705')
  assert.equal(subjectKeyOf('STAT 201'), 'STAT')
  // The same course filed with different separators groups together.
  assert.equal(subjectKeyOf('77:705:202'), subjectKeyOf('77 705 202'))
  assert.equal(subjectKeyOf(null), null)
  assert.equal(subjectKeyOf('705'), null, 'a bare number names no subject')
})

test('D42: only explicit nursing tokens name Nursing', () => {
  for (const t of ['NURS', 'NUR', 'NSG', 'NURSING']) assert.equal(isNursingSubjectToken(t), true)
  for (const t of ['STAT', 'BIOL', '705', '77 705', null]) assert.equal(isNursingSubjectToken(t), false)
})

// ------------------------------------------- 1. department beats generic title
test('D42: a generic title under an explicit Nursing subject counts as Nursing', () => {
  const courses = [C({ name: 'Trends in Society', courseCode: 'NURS 210', categories: ['general'] })]
  const { courses: out, changed } = applyNursingSubjectClassification(courses)
  assert.deepEqual(out[0].categories, ['nursing'])
  assert.equal(out[0].categorySource, 'deterministic')
  assert.equal(changed.length, 1)
  assert.match(changed[0].reason, /names Nursing/)
})

test('D42: a numeric subject is established by the transcript filing nursing courses under it', () => {
  const courses = [
    C({ name: 'Foundations of Nursing Practice', courseCode: '77 705 304', categories: ['nursing'] }),
    C({ name: 'Nursing Informatics', courseCode: '77 705 490', categories: ['nursing'] }),
    C({ name: 'Culture, Life & Health', courseCode: '77 705 202', categories: ['general'] }),
  ]
  const subjects = deriveNursingSubjects(courses)
  assert.equal(subjects.size, 1)
  const { courses: out, changed } = applyNursingSubjectClassification(courses)
  assert.ok(out[2].categories.includes('nursing'), 'the generic title joins its department')
  assert.equal(changed.length, 1)
  assert.match(changed[0].reason, /files 2 nursing course\(s\) under subject "77 705"/)
})

test('D42: one nursing course alone does NOT establish a numeric subject', () => {
  const courses = [
    C({ name: 'Nursing Informatics', courseCode: '77 705 490', categories: ['nursing'] }),
    C({ name: 'Culture, Life & Health', courseCode: '77 705 202', categories: ['general'] }),
  ]
  assert.equal(deriveNursingSubjects(courses).size, 0)
  assert.equal(applyNursingSubjectClassification(courses).changed.length, 0)
})

// ------------------------------ 2. non-nursing subject inside a nursing program
test('D42 LIMIT: a non-nursing subject does not become Nursing inside a nursing program', () => {
  const courses = [
    C({ name: 'Foundations of Nursing Practice', courseCode: '77 705 304', categories: ['nursing'] }),
    C({ name: 'Health Assessment', courseCode: '77 705 306', categories: ['nursing'] }),
    C({ name: 'Statistics', courseCode: 'STAT 201', categories: ['general'] }),
    C({ name: 'English Composition', courseCode: 'ENG 101', categories: ['general'] }),
    C({ name: 'Psychology', courseCode: 'PSY 100', categories: ['general'] }),
  ]
  const { courses: out } = applyNursingSubjectClassification(courses)
  for (const name of ['Statistics', 'English Composition', 'Psychology']) {
    const c = out.find(x => x.name === name)!
    assert.ok(!c.categories.includes('nursing'), `${name} must not become Nursing`)
    assert.deepEqual(c.categories, ['general'])
    assert.equal(c.categorySource, 'ai', 'untouched courses keep their source')
  }
})

test('D42 LIMIT: a nursing subject at one school does not classify another school', () => {
  const courses = [
    C({ name: 'Foundations of Nursing', courseCode: '77 705 304', categories: ['nursing'], institutionId: 'A' }),
    C({ name: 'Health Assessment', courseCode: '77 705 306', categories: ['nursing'], institutionId: 'A' }),
    // Same digits, different school, unrelated department.
    C({ name: 'Ceramics', courseCode: '77 705 110', categories: ['general'], institutionId: 'B' }),
  ]
  const { courses: out } = applyNursingSubjectClassification(courses)
  assert.ok(!out[2].categories.includes('nursing'), 'subjects are scoped per institution')
})

// ------------------------------------------------------------ 3. user override
test('D42 + D4: a user classification is never overwritten', () => {
  const courses = [
    C({ name: 'Foundations of Nursing', courseCode: 'NURS 304', categories: ['nursing'] }),
    C({ name: 'Health Assessment', courseCode: 'NURS 306', categories: ['nursing'] }),
    // The user has decided this one is NOT nursing, despite the subject code.
    C({ name: 'Nursing Elective', courseCode: 'NURS 250',
        categories: ['general'], categorySource: 'user' }),
  ]
  const { courses: out, changed } = applyNursingSubjectClassification(courses)
  const held = out.find(c => c.name === 'Nursing Elective')!
  assert.deepEqual(held.categories, ['general'], 'the user choice stands')
  assert.equal(held.categorySource, 'user')
  assert.ok(!changed.some(c => c.courseName === 'Nursing Elective'))
})

// -------------------------------------------------------------- 4. no hardcoding
test('D42: works on a synthetic non-Rutgers scheme with no shared literals', () => {
  const courses = [
    C({ name: 'Clinical Practice I', courseCode: 'AB-4410-101', categories: ['nursing'] }),
    C({ name: 'Clinical Practice II', courseCode: 'AB-4410-102', categories: ['nursing'] }),
    C({ name: 'Wellness Across the Lifespan', courseCode: 'AB-4410-115', categories: ['general'] }),
    C({ name: 'College Algebra', courseCode: 'AB-2200-101', categories: ['general'] }),
  ]
  const { courses: out, changed } = applyNursingSubjectClassification(courses)
  assert.ok(out.find(c => c.name === 'Wellness Across the Lifespan')!.categories.includes('nursing'))
  assert.ok(!out.find(c => c.name === 'College Algebra')!.categories.includes('nursing'))
  assert.equal(changed.length, 1)
  assert.equal(changed[0].subjectKey, 'AB 4410')
})

test('D42: a science classification survives being added to Nursing', () => {
  const courses = [
    C({ name: 'Foundations of Nursing', courseCode: '25 705 304', categories: ['nursing'] }),
    C({ name: 'Health Assessment', courseCode: '25 705 306', categories: ['nursing'] }),
    C({ name: 'Human Biology', courseCode: '25 705 210', categories: ['science'] }),
  ]
  const { courses: out } = applyNursingSubjectClassification(courses)
  const bio = out.find(c => c.name === 'Human Biology')!
  assert.deepEqual([...bio.categories].sort(), ['nursing', 'science'])
})

test('D42: reclassification is idempotent', () => {
  const courses = [
    C({ name: 'Foundations', courseCode: 'NURS 304', categories: ['nursing'] }),
    C({ name: 'Seminar', courseCode: 'NURS 250', categories: ['general'] }),
  ]
  const once = applyNursingSubjectClassification(courses)
  const twice = applyNursingSubjectClassification(once.courses)
  assert.equal(twice.changed.length, 0)
  assert.deepEqual(twice.courses.map(c => c.categories), once.courses.map(c => c.categories))
})

// ---------------------------------------------------- the acceptance arithmetic
test('D42: the Rutgers shape brings Nursing GPA into line with Overall', () => {
  const insts: Institution[] = [{
    id: 'R', name: 'Rutgers University', creditSystem: 'semester',
    gradingScale: { source: 'transcript',
      points: { A: 4.0, 'B+': 3.5, B: 3.0, 'C+': 2.5, C: 2.0, D: 1.0, F: 0.0 } },
  }]
  const rows: [string, string, string, number, CourseCategory[]][] = [
    ['Culture, Life & Health', '77 705 202', 'B', 3, ['general']],
    ['Pathophysiology', '77 705 245', 'A', 3, ['science', 'nursing']],
    ['Foundations of Nursing Practice', '77 705 304', 'A', 4, ['nursing']],
    ['Health Assessment', '77 705 306', 'A', 3, ['nursing']],
    ['Nursing Informatics', '77 705 490', 'A', 3, ['nursing']],
    ['Health & Illness Adult/OA I', '77 705 341', 'B', 5, ['nursing']],
    ['Psych Mental Health', '77 705 370', 'B+', 5, ['nursing']],
    ['Research & EBNP', '77 705 390', 'B+', 3, ['nursing']],
    ['Pharmacotherapeutics', '77 705 395', 'A', 3, ['science', 'nursing']],
    ['Trends in Health Care Delivery', '77 705 223', 'B', 3, ['nursing']],
    ['Health & Illness Inf-CH-AD', '77 705 312', 'B', 4, ['nursing']],
    ['Health & Illness Adult/OA II', '77 705 342', 'C+', 5, ['nursing']],
    ['Childbearing Family', '77 705 380', 'B', 4, ['nursing']],
    ['Capstone', '25 705 419', 'B+', 5, ['nursing']],
    ['Leadership & Management in Nursing', '25 705 425', 'A', 3, ['nursing']],
    ['Community Health Nursing', '25 705 444', 'C+', 6, ['nursing']],
  ]
  const courses = rows.map(([name, courseCode, grade, credits, categories]) =>
    C({ name, courseCode, grade, credits, categories, institutionId: 'R' }))
  const ctx = { institutions: insts, policies: { transfer: 'exclude' as const, retake: 'both' as const } }

  const before = calculateGPA(courses, 'nursing', ctx)
  assert.equal(before.display, '3.34', 'title-only classification leaves one course out')

  const { courses: after, changed } = applyNursingSubjectClassification(courses)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].courseName, 'Culture, Life & Health')

  const overall = calculateGPA(after, 'overall', ctx)
  const nursing = calculateGPA(after, 'nursing', ctx)
  const science = calculateGPA(after, 'science', ctx)
  assert.equal(overall.display, '3.32')
  assert.equal(overall.coursesCounted, 16)
  assert.equal(overall.creditsCounted, 62)
  assert.equal(nursing.display, '3.32')
  assert.equal(nursing.coursesCounted, 16)
  assert.equal(nursing.creditsCounted, 62)
  assert.equal(science.display, '4.00', 'science is untouched')
  assert.equal(science.coursesCounted, 2)
})
