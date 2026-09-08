import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeName, resolveInstitutionName, planInstitutionImport, normalizeCreditSystem,
} from './institutions.ts'
import type { Institution } from './types.ts'

const I = (id: string, name: string, creditSystem: any = 'semester'): Institution =>
  ({ id, name, creditSystem })

test('D27: exact name matches an existing institution', () => {
  const r = resolveInstitutionName('Rutgers University', [I('r','Rutgers University')])
  assert.equal(r.kind, 'matched'); assert.equal(r.institutionId, 'r')
})

test('D27: case and whitespace differences still match — no duplicate school', () => {
  const existing = [I('r','Rutgers University')]
  for (const v of ['  rutgers university  ', 'RUTGERS UNIVERSITY', 'Rutgers  University']) {
    const r = resolveInstitutionName(v, existing)
    assert.equal(r.kind, 'matched', `"${v}" must match`)
    assert.equal(r.institutionId, 'r')
  }
})

test('D27: punctuation differences still match', () => {
  const r = resolveInstitutionName("St. Joseph's College", [I('s',"St Josephs College")])
  assert.equal(r.kind, 'matched')
})

test('D27: a campus qualifier is AMBIGUOUS, never silently merged', () => {
  const r = resolveInstitutionName('Rutgers University - New Brunswick', [I('r','Rutgers University')])
  assert.equal(r.kind, 'ambiguous')
  assert.equal(r.candidates?.[0].id, 'r')
  assert.match(r.reason!, /different campus/i)
})

test('D27: the reverse direction is also ambiguous', () => {
  const r = resolveInstitutionName('Rutgers University', [I('r','Rutgers University - Newark')])
  assert.equal(r.kind, 'ambiguous')
})

test('D27: genuinely different schools are NOT merged', () => {
  const existing = [I('r','Rutgers University')]
  for (const v of ['Bergen Community College','Montclair State University','Seton Hall University']) {
    assert.equal(resolveInstitutionName(v, existing).kind, 'create', `${v} is a new school`)
  }
})

test('D27: two schools sharing only a generic word are not related', () => {
  const r = resolveInstitutionName('Harborview State University', [I('c','Cedar Ridge University')])
  assert.equal(r.kind, 'create', '"University" alone is not identity')
})

test('D27: an empty detected name is ambiguous, never created', () => {
  assert.equal(resolveInstitutionName('', []).kind, 'ambiguous')
  assert.equal(resolveInstitutionName('   ', []).kind, 'ambiguous')
})

test('D27: duplicate existing names are reported as ambiguous', () => {
  const r = resolveInstitutionName('Rutgers University', [I('a','Rutgers University'), I('b','rutgers  university')])
  assert.equal(r.kind, 'ambiguous')
  assert.equal(r.candidates?.length, 2)
})

// ---------------------------------------------------------------- planning
test('D27: a multi-institution import plans each school separately', () => {
  const plan = planInstitutionImport(
    [{name:'Brookstone Community College'},{name:'Lakeshore Metropolitan University'}],
    [])
  assert.equal(plan.toCreate.length, 2)
  assert.deepEqual(plan.toCreate.map(c=>c.name).sort(),
    ['Brookstone Community College','Lakeshore Metropolitan University'])
  assert.equal(plan.ambiguous.length, 0)
})

test('D27: an import reuses an existing school instead of duplicating it', () => {
  const plan = planInstitutionImport(
    [{name:'  BROOKSTONE community college '},{name:'Lakeshore Metropolitan University'}],
    [I('b','Brookstone Community College')])
  assert.equal(plan.matched.length, 1)
  assert.equal(plan.matched[0].institutionId, 'b')
  assert.equal(plan.toCreate.length, 1)
})

test('D27: repeated detections of one school collapse to a single entry', () => {
  const plan = planInstitutionImport(
    [{name:'Cedar Ridge University'},{name:'cedar ridge university'},{name:'Cedar Ridge  University'}], [])
  assert.equal(plan.toCreate.length, 1)
})

// ---------------------------------------------------------------- D15
test('D15: detection never implies semester', () => {
  const plan = planInstitutionImport([{name:'New School'}], [])
  assert.equal(plan.toCreate[0].creditSystem, 'unknown')
})

test('D15: an unconfident credit system is discarded', () => {
  const plan = planInstitutionImport(
    [{name:'New School', creditSystem:'semester', confidence:'low'}], [])
  assert.equal(plan.toCreate[0].creditSystem, 'unknown', 'low confidence must not set it')
})

test('D15: a confident, explicit credit system is accepted', () => {
  assert.equal(planInstitutionImport([{name:'A', creditSystem:'semester', confidence:'high'}], [])
    .toCreate[0].creditSystem, 'semester')
  assert.equal(planInstitutionImport([{name:'B', creditSystem:'quarter', confidence:'high'}], [])
    .toCreate[0].creditSystem, 'quarter')
})

test('D15: junk credit-system values fall back to unknown', () => {
  for (const v of ['trimester','SEMESTER-ish','', null, undefined, 'banana'])
    assert.equal(normalizeCreditSystem(v), 'unknown', String(v))
  assert.equal(normalizeCreditSystem('Semester'), 'semester')
  assert.equal(normalizeCreditSystem(' QUARTER '), 'quarter')
})

test('normalizeName', () => {
  assert.equal(normalizeName('  Rutgers   University '), 'rutgers university')
  assert.equal(normalizeName('St. Mary’s'), 'st marys')
  assert.equal(normalizeName('A - B'), 'a b')
})
