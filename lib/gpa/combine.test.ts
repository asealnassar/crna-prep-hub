import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  planCombine, planCombineWithNewCourses, copyCoursesFrom, combinedPolicies, combinedNameFor,
  copiedCountFrom, provenanceOf, analysisClosure, findOverlap, institutionsForCombined,
  MIN_COMBINE_SOURCES, type CombineSource,
} from './combine.ts'
import { calculateGPA } from './engine.ts'
import { institutionsUsedIn } from './presentation.ts'
import { MAX_COURSES_PER_ANALYSIS, canCreateAnalysis, MAX_ANALYSES_PER_USER } from './analyses.ts'
import { DEFAULT_POLICIES, type Course, type GpaPolicies, type Institution } from './types.ts'

let seq = 0
const testId = () => `new-${++seq}`

const C = (o: Partial<Course> & { id: string; institutionId: string | null }): Course => ({
  id: o.id, institutionId: o.institutionId, courseCode: o.courseCode ?? 'X 1',
  name: o.name ?? 'Course', grade: o.grade ?? 'A', credits: o.credits ?? 3,
  year: o.year ?? '2021', term: o.term ?? 'Fall',
  categories: o.categories ?? ['general'], categorySource: o.categorySource ?? 'ai',
  level: o.level ?? 'undergraduate', levelSource: 'default',
  recordType: o.recordType ?? 'coursework', transferredIn: o.transferredIn ?? false,
  needsReview: false, reviewReasons: [],
  ...(o.provenance ? { provenance: o.provenance } : {}),
})

const RUTGERS_INST: Institution = { id: 'R', name: 'Rutgers University', creditSystem: 'semester',
  gradingScale: { source: 'transcript', points: { A: 4, 'B+': 3.5, B: 3, 'C+': 2.5, C: 2, D: 1, F: 0 } } }
const MONTCLAIR_INST: Institution = { id: 'M', name: 'Montclair State University',
  creditSystem: 'semester', gradingScale: null }
const INSTITUTIONS = [RUTGERS_INST, MONTCLAIR_INST]

/** 16 graded Rutgers rows plus 11 transfer-notation rows, as the real one has. */
const rutgers = (): CombineSource => ({
  id: 'a-rutgers', name: 'Rutgers', policies: { transfer: 'exclude', retake: 'both' },
  courses: [
    ...Array.from({ length: 16 }, (_, i) =>
      C({ id: `r${i}`, institutionId: 'R', name: `Rutgers course ${i}`, grade: 'A', credits: 3 })),
    ...Array.from({ length: 11 }, (_, i) =>
      C({ id: `rn${i}`, institutionId: 'R', name: `Notation ${i}`, grade: 'TR', credits: 3,
          recordType: 'transfer_notation' })),
  ],
})

const montclair = (): CombineSource => ({
  id: 'a-montclair', name: 'Montclair', policies: { transfer: 'exclude', retake: 'latest' },
  courses: Array.from({ length: 45 }, (_, i) =>
    C({ id: `m${i}`, institutionId: 'M', name: `Montclair course ${i}`, grade: 'B', credits: 3 })),
})

/** The analysis a real combine produces, ready to be used as a source itself. */
const combinedOf = (sources: CombineSource[], id = 'a-combined'): CombineSource => {
  const plan = planCombine({ sources, existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, true, plan.message)
  return { id, name: plan.name!, courses: plan.courses!, policies: plan.policies! }
}

// ------------------------------------------------------------- the real case
test('D47: Rutgers + Montclair creates a new 72-row analysis', () => {
  const sources = [rutgers(), montclair()]
  const plan = planCombine({ sources, existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, true)
  assert.equal(plan.courses!.length, 27 + 45)
  assert.equal(plan.resultingCourses, 72)
  assert.equal(plan.name, 'Rutgers + Montclair')
})

test('D47: Rutgers stays at 27 and Montclair stays at 45', () => {
  const r = rutgers(), m = montclair()
  const beforeR = JSON.stringify(r), beforeM = JSON.stringify(m)
  const plan = planCombine({ sources: [r, m], existingAnalyses: [], makeId: testId })
  assert.equal(plan.courses!.length, 72)
  assert.equal(r.courses.length, 27, 'Rutgers is still 27 courses')
  assert.equal(m.courses.length, 45, 'Montclair is still 45 courses')
  assert.equal(JSON.stringify(r), beforeR, 'Rutgers byte-identical')
  assert.equal(JSON.stringify(m), beforeM, 'Montclair byte-identical')
})

test('D47: combining from the header does not mutate the analysis that is open', () => {
  // The open analysis is simply the first source; it is copied like any other.
  const open = rutgers(), other = montclair()
  const before = JSON.stringify(open)
  const plan = planCombine({ sources: [open, other], existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, true)
  assert.equal(JSON.stringify(open), before, 'the open analysis is untouched')
  assert.equal(open.courses.length, 27, 'it did not grow to 72 the way the old behavior did')
  assert.equal(plan.courses!.length, 72, 'the 72 rows live in the NEW analysis')
})

test('D47: "+ New → combine" mutates no source either', () => {
  const sources = [rutgers(), montclair()]
  const before = JSON.stringify(sources)
  planCombine({ sources, existingAnalyses: [], makeId: testId })
  assert.equal(JSON.stringify(sources), before)
})

test('D47: every source row reaches the new analysis', () => {
  const sources = [rutgers(), montclair()]
  const plan = planCombine({ sources, existingAnalyses: [], makeId: testId })
  const names = new Set(plan.courses!.map(c => c.name))
  for (const s of sources) for (const c of s.courses) assert.ok(names.has(c.name), c.name)
})

test('D47: copied rows get new ids that cannot collide', () => {
  const plan = planCombine({ sources: [rutgers(), montclair()], existingAnalyses: [], makeId: testId })
  const ids = plan.courses!.map(c => c.id)
  assert.equal(new Set(ids).size, ids.length, 'all ids unique')
  const sourceIds = new Set([...rutgers().courses, ...montclair().courses].map(c => c.id))
  assert.ok(!ids.some(id => sourceIds.has(id)), 'no source id is reused')
})

test('D47: semantic fields survive the copy', () => {
  const source: CombineSource = {
    id: 's', name: 'S', policies: DEFAULT_POLICIES,
    courses: [C({ id: 'x', institutionId: 'R', courseCode: '77 705 202', name: 'Culture, Life & Health',
      grade: 'B', credits: 3, term: 'Summer', year: '2020', categories: ['science', 'nursing'],
      categorySource: 'user', level: 'graduate', recordType: 'transfer_notation', transferredIn: true })],
  }
  const [copy] = copyCoursesFrom(source, testId)
  for (const f of ['institutionId', 'courseCode', 'name', 'grade', 'credits', 'term', 'year',
                   'categorySource', 'level', 'recordType', 'transferredIn'] as const) {
    assert.deepEqual(copy[f], source.courses[0][f], f)
  }
  assert.deepEqual(copy.categories, ['science', 'nursing'])
  assert.notEqual(copy.id, 'x')
})

test('D47: transfer notation stays transfer notation after combining', () => {
  const plan = planCombine({ sources: [rutgers(), montclair()], existingAnalyses: [], makeId: testId })
  const notation = plan.courses!.filter(c => c.recordType === 'transfer_notation')
  assert.equal(notation.length, 11, 'all 11 notation rows survive')
  assert.ok(notation.every(c => c.grade === 'TR'))
  // And they are still excluded from the GPA, even though the real Montclair
  // coursework is now present in the same analysis.
  const gpa = calculateGPA(plan.courses!, 'overall',
    { institutions: INSTITUTIONS, policies: { transfer: 'exclude', retake: 'both' } })
  assert.equal(gpa.exclusions['transfer-notation'], 11)
  assert.equal(gpa.coursesCounted, 16 + 45)
})

// -------------------------------------------------------------- institutions
test('D47: a shared institution is reused, never duplicated', () => {
  const plan = planCombine({ sources: [rutgers(), montclair()], existingAnalyses: [], makeId: testId })
  const used = institutionsForCombined(plan.courses!, INSTITUTIONS)
  assert.deepEqual(used.map(i => i.id).sort(), ['M', 'R'])
  assert.equal(used.length, 2, 'two schools, not four')
  assert.equal(new Set(plan.courses!.filter(c => c.institutionId === 'R').map(c => c.institutionId)).size, 1)
})

test('D47: the new analysis lists only the schools its own coursework uses', () => {
  const plan = planCombine({ sources: [rutgers(), montclair()], existingAnalyses: [], makeId: testId })
  assert.equal(institutionsUsedIn(plan.courses!, INSTITUTIONS).length, 2)
  assert.equal(institutionsUsedIn(rutgers().courses, INSTITUTIONS).length, 1)
})

// -------------------------------------------------------------------- naming
test('D47: the combined name is derived from the school names it is given', () => {
  assert.equal(combinedNameFor(['Rutgers', 'Montclair'], []), 'Rutgers + Montclair')
  assert.equal(combinedNameFor(['Rutgers', 'Montclair', 'Hudson'], []), 'Rutgers + 2 others')
})

test('D47: an existing name gets the usual unique suffix, never an overwrite', () => {
  const existing = [{ name: 'Rutgers + Montclair' }]
  assert.equal(combinedNameFor(['Rutgers', 'Montclair'], existing), 'Rutgers + Montclair (2)')
  assert.equal(
    combinedNameFor(['Rutgers', 'Montclair'], [...existing, { name: 'Rutgers + Montclair (2)' }]),
    'Rutgers + Montclair (3)')
  // The existing analyses keep their names: suffixing never renames anything.
  assert.deepEqual(existing, [{ name: 'Rutgers + Montclair' }])
})

// ------------------------------------------------------------------ provenance
test('D47: a copied row records the analysis it came from', () => {
  const plan = planCombine({ sources: [rutgers(), montclair()], existingAnalyses: [], makeId: testId })
  const fromM = plan.courses!.filter(c => provenanceOf(c).includes('a-montclair'))
  assert.equal(fromM.length, 45)
  assert.equal(copiedCountFrom(plan.courses!, 'a-rutgers'), 27)
})

test('D47: provenance survives nesting, so an ancestor is still recognised', () => {
  const c = combinedOf([rutgers(), montclair()], 'a-c')          // C = A + B
  const d = combinedOf([c, { id: 'a-d', name: 'Hudson', policies: DEFAULT_POLICIES,
    courses: [C({ id: 'h1', institutionId: null })] }], 'a-e')   // E = C + D

  const closure = analysisClosure(d)
  for (const ancestor of ['a-rutgers', 'a-montclair', 'a-c']) {
    assert.ok(closure.has(ancestor), `${ancestor} is still part of it`)
  }
  // And the trail is ordered oldest-first, not flattened to the last hop.
  const row = d.courses.find(x => x.name === 'Montclair course 0')!
  assert.deepEqual(provenanceOf(row), ['a-montclair', 'a-c'])
})

test('D47: provenance is by id, so renaming an analysis changes nothing', () => {
  const r = rutgers(), m = montclair()
  const c = combinedOf([r, m], 'a-c')
  const renamed = { ...c, name: 'Everything' }
  const overlap = findOverlap([renamed, { ...m, name: 'MSU Fall Transcript' }])
  assert.ok(overlap, 'a rename must not hide the shared coursework')
  assert.equal(overlap!.kind, 'contains')
  assert.equal(overlap!.contained!.id, 'a-montclair')
})

test('D47: the pre-D47 single-source marker is still honoured', () => {
  // Analyses built by the earlier "add existing analysis" behavior wrote one id.
  const legacy: CombineSource = {
    id: 'a-legacy', name: 'Rutgers (was mutated)', policies: DEFAULT_POLICIES,
    courses: [{ ...C({ id: 'l1', institutionId: 'M' }), copiedFrom: 'a-montclair' }],
  }
  assert.deepEqual(provenanceOf(legacy.courses[0]), ['a-montclair'])
  const plan = planCombine({ sources: [legacy, montclair()], existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, false)
  assert.equal(plan.block, 'overlap')
})

test('D47: deleting the copied rows releases the source again', () => {
  const c = combinedOf([rutgers(), montclair()], 'a-c')
  const withoutMontclair: CombineSource = {
    ...c, courses: c.courses.filter(x => !provenanceOf(x).includes('a-montclair')),
  }
  // Provenance is derived from the rows that are actually there, so an analysis
  // whose Montclair rows are gone no longer holds Montclair coursework.
  const plan = planCombine({ sources: [withoutMontclair, montclair()], existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, true)
  assert.equal(plan.courses!.length, 27 + 45)
})

// --------------------------------------------------------------- overlap guard
test('D47: combining an analysis with one it already contains is blocked', () => {
  const c = combinedOf([rutgers(), montclair()], 'a-c')
  const plan = planCombine({ sources: [c, montclair()], existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, false)
  assert.equal(plan.block, 'overlap')
  assert.equal(plan.title, 'These analyses overlap')
  assert.match(plan.message!, /already contains coursework from “Montclair\.”/)
  assert.match(plan.message!, /duplicate coursework/)
  assert.equal(plan.courses, undefined, 'nothing is copied')
  assert.equal(plan.name, undefined, 'no analysis is even named')
})

test('D47: the 117-course UAT failure can no longer be produced', () => {
  // The exact shape that failed: an analysis that had been mutated to hold
  // Rutgers + Montclair, combined again with its own ingredients.
  const mutated = combinedOf([rutgers(), montclair()], 'a-mutated')
  assert.equal(mutated.courses.length, 72)
  for (const second of [rutgers(), montclair()]) {
    const plan = planCombine({ sources: [mutated, second], existingAnalyses: [], makeId: testId })
    assert.equal(plan.ok, false, second.name)
    assert.equal(plan.block, 'overlap')
    assert.notEqual(plan.resultingCourses, 117)
  }
})

test('D47: two analyses sharing an ancestor are blocked, and it is named', () => {
  const m = montclair()
  const left = combinedOf([rutgers(), m], 'a-left')
  const right = combinedOf([m, { id: 'a-hud', name: 'Hudson', policies: DEFAULT_POLICIES,
    courses: [C({ id: 'h1', institutionId: null })] }], 'a-right')
  const plan = planCombine({
    sources: [left, right], existingAnalyses: [], makeId: testId,
    nameFor: id => (id === 'a-montclair' ? 'Montclair' : null),
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.block, 'overlap')
  assert.match(plan.message!, /both contain coursework from “Montclair\.”/)
})

test('D47: an overlap block writes nothing at all', () => {
  const c = combinedOf([rutgers(), montclair()], 'a-c')
  const m = montclair()
  const snapshot = JSON.stringify([c, m])
  const plan = planCombine({ sources: [c, m], existingAnalyses: [{ name: 'Rutgers + Montclair' }], makeId: testId })
  assert.equal(plan.ok, false)
  assert.equal(JSON.stringify([c, m]), snapshot, 'both sources are byte-identical afterwards')
  assert.deepEqual(Object.keys(plan).sort(), ['block', 'message', 'ok', 'title'])
})

test('D47: analyses that share nothing still combine', () => {
  const c = combinedOf([rutgers(), montclair()], 'a-c')
  const hudson: CombineSource = { id: 'a-hud', name: 'Hudson', policies: DEFAULT_POLICIES,
    courses: [C({ id: 'h1', institutionId: null }), C({ id: 'h2', institutionId: null })] }
  const plan = planCombine({ sources: [c, hudson], existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, true)
  assert.equal(plan.courses!.length, 74)
  assert.equal(findOverlap([c, hudson]), null)
})

// -------------------------------------------- a newly uploaded transcript
const uploaded = (n: number): Course[] =>
  Array.from({ length: n }, (_, i) =>
    C({ id: `u${i}`, institutionId: 'M', name: `Montclair course ${i}`, grade: 'B' }))

test('D47: uploading a transcript and combining creates a new analysis, not a bigger one', () => {
  const open = rutgers()
  const before = JSON.stringify(open)
  const plan = planCombineWithNewCourses({
    current: open, incoming: uploaded(45), incomingNames: ['Montclair State University'],
    existingAnalyses: [{ name: 'Rutgers' }],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.courses!.length, 72)
  assert.equal(plan.name, 'Rutgers + Montclair')
  assert.equal(JSON.stringify(open), before, 'the open analysis is untouched')
  assert.equal(open.courses.length, 27)
})

test('D47: only the new transcript is analyzed; the open analysis is copied as-is', () => {
  const open = rutgers()
  const incoming = uploaded(45)
  const plan = planCombineWithNewCourses({
    current: open, incoming, incomingNames: ['Montclair State University'], existingAnalyses: [],
  })
  // The freshly analyzed rows are passed straight through -- the same objects,
  // so nothing about them is re-derived, re-parsed or re-analyzed.
  assert.deepEqual(plan.courses!.slice(27), incoming)
  // The existing coursework arrives by copy, field for field, with no analyzer
  // involvement: it was already structured.
  plan.courses!.slice(0, 27).forEach((copy, i) => {
    const original = open.courses[i]
    for (const f of ['institutionId', 'courseCode', 'name', 'grade', 'credits',
                     'term', 'year', 'level', 'recordType'] as const) {
      assert.deepEqual(copy[f], original[f], f)
    }
    assert.notEqual(copy.id, original.id)
  })
  // Only the copied half carries provenance; the uploaded rows are new work.
  assert.equal(copiedCountFrom(plan.courses!, open.id), 27)
  assert.ok(plan.courses!.slice(27).every(c => provenanceOf(c).length === 0))
})

test('D47: an uploaded transcript combine still respects both caps', () => {
  const big: CombineSource = { id: 'a-big', name: 'Big', policies: DEFAULT_POLICIES,
    courses: Array.from({ length: 480 }, (_, i) => C({ id: `b${i}`, institutionId: 'R' })) }
  const over = planCombineWithNewCourses({
    current: big, incoming: uploaded(45), incomingNames: [], existingAnalyses: [],
  })
  assert.equal(over.ok, false)
  assert.equal(over.block, 'course-limit')
  assert.equal(over.courses, undefined)

  const capped = planCombineWithNewCourses({
    current: rutgers(), incoming: uploaded(45), incomingNames: [], existingAnalyses: [],
    canCreate: false,
  })
  assert.equal(capped.ok, false)
  assert.equal(capped.block, 'analysis-limit')
  assert.equal(capped.courses, undefined)
})

// -------------------------------------------------------------------- guards
test('D47: fewer than two analyses cannot be combined', () => {
  const plan = planCombine({ sources: [rutgers()], existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, false)
  assert.equal(plan.block, 'too-few-sources')
  assert.equal(plan.courses, undefined, 'nothing is produced')
  assert.equal(MIN_COMBINE_SOURCES, 2)
})

test('D47: an analysis cannot be combined with itself', () => {
  const r = rutgers()
  const plan = planCombine({ sources: [r, r], existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, false)
  assert.equal(plan.block, 'self')
  assert.equal(plan.courses, undefined)
})

test('D47: the 500-course maximum blocks before anything is copied', () => {
  const big = (id: string, n: number): CombineSource => ({
    id, name: id, policies: DEFAULT_POLICIES,
    courses: Array.from({ length: n }, (_, i) => C({ id: `${id}-${i}`, institutionId: 'R' })),
  })
  const plan = planCombine({ sources: [big('a', 300), big('b', 250)], existingAnalyses: [], makeId: testId })
  assert.equal(plan.ok, false)
  assert.equal(plan.block, 'course-limit')
  assert.equal(plan.resultingCourses, 550)
  assert.equal(plan.courses, undefined, 'nothing is copied')
  assert.match(plan.message!, new RegExp(String(MAX_COURSES_PER_ANALYSIS)))
})

test('D47: the 50-analysis maximum blocks before creation', () => {
  const at = Array.from({ length: MAX_ANALYSES_PER_USER }, (_, i) => ({ name: `A${i}` }))
  assert.equal(canCreateAnalysis(at), false, 'a combined analysis is still an analysis')
  const plan = planCombine({
    sources: [rutgers(), montclair()], existingAnalyses: at,
    canCreate: canCreateAnalysis(at), makeId: testId,
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.block, 'analysis-limit')
  assert.equal(plan.courses, undefined, 'no partial creation')
  assert.match(plan.message!, new RegExp(String(MAX_ANALYSES_PER_USER)))
  assert.equal(
    planCombine({ sources: [rutgers(), montclair()], existingAnalyses: at.slice(0, -1),
      canCreate: canCreateAnalysis(at.slice(0, -1)), makeId: testId }).ok, true)
})

// ------------------------------------------------------------------ policies
test('D47: policies carry over only when every source agrees', () => {
  const same = combinedPolicies([
    { ...rutgers(), policies: { transfer: 'exclude', retake: 'both' } },
    { ...montclair(), policies: { transfer: 'exclude', retake: 'both' } },
  ])
  assert.deepEqual(same, { transfer: 'exclude', retake: 'both' })
})

test('D47: sources that disagree leave the policy unset for the user to choose', () => {
  const plan = planCombine({ sources: [rutgers(), montclair()], existingAnalyses: [], makeId: testId })
  assert.equal(plan.policies!.transfer, 'exclude', 'both said exclude')
  assert.equal(plan.policies!.retake, null, 'both vs latest is not a decision we make for them')
})

test('D47: an unset policy in any source keeps the combined policy unset', () => {
  const withUnset = combinedPolicies([
    { ...rutgers(), policies: { transfer: 'include', retake: 'both' } },
    { ...montclair(), policies: DEFAULT_POLICIES },
  ])
  assert.deepEqual(withUnset, DEFAULT_POLICIES)
})

test('D47: a transcript brings no policy, so an upload-combine starts unset', () => {
  const plan = planCombineWithNewCourses({
    current: { ...rutgers(), policies: { transfer: 'include', retake: 'latest' } },
    incoming: uploaded(3), incomingNames: [], existingAnalyses: [],
  })
  assert.deepEqual(plan.policies, DEFAULT_POLICIES,
    'the transcript states no policy, so nothing is inherited from one side')
})

// -------------------------------------------------------------- independence
test('D47: editing a source afterwards does not reach the new analysis', () => {
  const src = montclair()
  const plan = planCombine({ sources: [rutgers(), src], existingAnalyses: [], makeId: testId })
  const destCourses = plan.courses!
  const before = destCourses.find(c => c.name === 'Montclair course 0')!.grade
  src.courses[0].grade = 'F'                       // the user edits standalone Montclair
  assert.equal(destCourses.find(c => c.name === 'Montclair course 0')!.grade, before)
  assert.notEqual(before, 'F')
})

test('D47: editing the new analysis does not reach back into a source', () => {
  const src = montclair()
  const plan = planCombine({ sources: [rutgers(), src], existingAnalyses: [], makeId: testId })
  plan.courses!.find(c => c.name === 'Montclair course 0')!.grade = 'F'
  assert.equal(src.courses[0].grade, 'B', 'the source is untouched')
})

test('D47: cancelling changes nothing, because planning writes nothing', () => {
  const r = rutgers(), m = montclair()
  const snapshot = JSON.stringify([r, m])
  planCombine({ sources: [r, m], existingAnalyses: [], makeId: testId })
  planCombineWithNewCourses({ current: r, incoming: uploaded(2), incomingNames: [], existingAnalyses: [] })
  assert.equal(JSON.stringify([r, m]), snapshot, 'planning is pure; only the caller writes')
})

// -------------------------------------------------------------------- cost
test('D47: the combine path cannot reach the transcript analyzer', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib/gpa/combine.ts'), 'utf8')
  for (const forbidden of ['analyze-transcript', 'openai', 'fetch(', 'parse-pdf']) {
    assert.ok(!src.toLowerCase().includes(forbidden.toLowerCase()),
      `combine.ts must not reference ${forbidden}`)
  }
  // And every plan is synchronous, so there is nothing to await.
  const plan = planCombine({ sources: [rutgers(), montclair()], existingAnalyses: [], makeId: testId })
  assert.ok(!(plan instanceof Promise))
  assert.equal(plan.ok, true)
  assert.ok(!(planCombineWithNewCourses({
    current: rutgers(), incoming: uploaded(1), incomingNames: [], existingAnalyses: [],
  }) instanceof Promise))
})
