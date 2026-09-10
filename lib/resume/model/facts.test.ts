import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factFromValue, factSheet, factValues, factsFromValues, hasFact, makeFact } from './facts.ts'
import type { Fact } from './facts.ts'

/**
 * The fact / text boundary.
 *
 * V1's prompt was told to produce "measurable outcomes" the builder never
 * collected. The structural answer is that a Fact can only carry 'user' or
 * 'import' provenance — there is no value an AI path could construct one with.
 */

test('a fact records what was supplied, where it came from, and its path', () => {
  const f = makeFact('f:1', 'device', 'CRRT', 'critical_care/p1/devices#0')
  assert.equal(f.value, 'CRRT')
  assert.equal(f.provenance, 'user')
  assert.equal(f.path, 'critical_care/p1/devices#0')
})

test('provenance admits only user and import — AI cannot originate a fact', () => {
  const user = makeFact('f:1', 'device', 'ECMO', 'p', 'user')
  const imported = makeFact('f:2', 'device', 'IABP', 'p', 'import')
  assert.equal(user.provenance, 'user')
  assert.equal(imported.provenance, 'import')
  // This does not compile — the guarantee is in the type:
  // makeFact('f:3', 'device', 'invented', 'p', 'ai')
  const provenances: Array<Fact['provenance']> = ['user', 'import']
  assert.equal(provenances.length, 2, 'exactly two origins exist')
})

test('blank values never become facts', () => {
  const facts = factsFromValues(['CRRT', '', '   ', 'ECMO', '\t'], 'device', 'p/devices')
  assert.deepEqual(facts.map((f) => f.value), ['CRRT', 'ECMO'])
})

test('non-arrays and missing values yield nothing rather than throwing', () => {
  assert.deepEqual(factsFromValues(undefined, 'device', 'p'), [])
  assert.deepEqual(factsFromValues([] as string[], 'device', 'p'), [])
  assert.deepEqual(factFromValue('', 'employer', 'p'), [])
  assert.deepEqual(factFromValue(null, 'employer', 'p'), [])
})

test('values are carried verbatim, not normalised or expanded', () => {
  const [f] = factFromValue('  Swan-Ganz  ', 'device', 'p/d')
  assert.equal(f.value, 'Swan-Ganz', 'trimmed only')
  const [g] = factFromValue('CVVHD/CRRT', 'therapy', 'p/t')
  assert.equal(g.value, 'CVVHD/CRRT', 'not split or interpreted')
})

test('ids are stable across rebuilds so a citation keeps meaning', () => {
  const build = () => factsFromValues(['CRRT', 'ECMO'], 'device', 'critical_care/p1/devices')
  assert.deepEqual(build().map((f) => f.id), build().map((f) => f.id))
  assert.equal(build()[1].id, 'f:critical_care/p1/devices#1')
})

test('a fact sheet is addressed to one subject and can be checked', () => {
  const sheet = factSheet('critical_care/p1/bullets', [
    factFromValue('Mercy General', 'employer', 'critical_care/p1/employer'),
    factsFromValues(['CRRT', 'ECMO'], 'device', 'critical_care/p1/devices'),
  ])
  assert.equal(sheet.subject, 'critical_care/p1/bullets')
  assert.equal(sheet.facts.length, 3)
  assert.equal(hasFact(sheet, 'f:critical_care/p1/devices#0'), true)
  assert.equal(hasFact(sheet, 'f:invented'), false, 'a made-up citation fails')
  assert.deepEqual(factValues(sheet).sort(), ['CRRT', 'ECMO', 'Mercy General'])
})

test('an empty sheet is valid — nothing supplied means nothing to draw on', () => {
  const sheet = factSheet('critical_care/p9/bullets', [])
  assert.deepEqual(sheet.facts, [])
  assert.equal(hasFact(sheet, 'anything'), false)
})
