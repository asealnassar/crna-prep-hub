import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_FIELD_TEXT, MAX_PATCHES, parsePatch, parsePatches } from './parse.ts'
import type { ResumeSectionType } from '../model/types.ts'

const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const SEC = U(1)
const ENTRY = U(2)

/** The route resolves a section id to its type; tests fix that mapping. */
const asType = (type: ResumeSectionType | null) => () => type
const education = asType('education')
const none = asType(null)

// -------------------------------------------------------------- shape

test('a body that is not a list is refused', () => {
  for (const body of [null, undefined, 42, 'edits', {}, true]) {
    assert.equal(parsePatches(body, education).ok, false, JSON.stringify(body) ?? 'undefined')
  }
})

test('an empty run is refused rather than saved as a no-op', () => {
  assert.equal(parsePatches([], education).ok, false)
})

test('a run longer than the cap is refused', () => {
  const one = { op: 'contact', field: 'city', value: 'Newark' }
  assert.equal(parsePatches(Array(MAX_PATCHES).fill(one), education).ok, true)
  assert.equal(parsePatches(Array(MAX_PATCHES + 1).fill(one), education).ok, false)
})

test('one bad patch refuses the whole run', () => {
  const result = parsePatches(
    [{ op: 'contact', field: 'city', value: 'Newark' }, { op: 'nonsense' }],
    education
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /Edit 2/)
})

test('a refusal does not echo the value back', () => {
  const secret = 'x'.repeat(MAX_FIELD_TEXT + 1)
  const result = parsePatches([{ op: 'contact', field: 'city', value: secret }], education)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.includes('x'.repeat(20)), false)
})

// ---------------------------------------------------------------- ids

test('every id must be a UUID', () => {
  for (const bad of ['', 'abc', SEC.slice(0, -1), 42, null, `${SEC}' or 1=1`]) {
    assert.equal(parsePatch({ op: 'section-remove', sectionId: bad }, education), null, String(bad))
  }
  assert.notEqual(parsePatch({ op: 'section-remove', sectionId: SEC }, education), null)
})

// -------------------------------------------------------------- enums

test('an unknown op is refused', () => {
  for (const op of ['drop', 'section-nuke', '', null, 42]) {
    assert.equal(parsePatch({ op }, education), null, String(op))
  }
})

test('only real section types may be added', () => {
  assert.notEqual(parsePatch({ op: 'section-add', sectionType: 'awards', sectionId: SEC }, education), null)
  for (const bad of ['resume_scores', 'Awards', '', null]) {
    assert.equal(parsePatch({ op: 'section-add', sectionType: bad, sectionId: SEC }, education), null, String(bad))
  }
})

test('only the three templates are accepted', () => {
  for (const good of ['classic', 'modern', 'compact']) {
    assert.notEqual(parsePatch({ op: 'template', template: good }, education), null, good)
  }
  for (const bad of ['creative', 'ats-optimized', 'Classic', '', null]) {
    assert.equal(parsePatch({ op: 'template', template: bad }, education), null, String(bad))
  }
})

test('only real contact fields are accepted', () => {
  assert.notEqual(parsePatch({ op: 'contact', field: 'email', value: 'a@b.test' }, education), null)
  for (const bad of ['user_id', 'id', 'revision', '__proto__', '']) {
    assert.equal(parsePatch({ op: 'contact', field: bad, value: 'x' }, education), null, bad)
  }
})

// ------------------------------------------------- descriptor-checked

test('a field is checked against the section’s own descriptor', () => {
  assert.notEqual(
    parsePatch({ op: 'field', sectionId: SEC, entryId: ENTRY, field: 'institution', value: 'Rutgers' }, education),
    null
  )
  // 'providerName' belongs to shadowing, not education.
  assert.equal(
    parsePatch({ op: 'field', sectionId: SEC, entryId: ENTRY, field: 'providerName', value: 'x' }, education),
    null
  )
})

test('a field patch for an unknown section is refused', () => {
  assert.equal(
    parsePatch({ op: 'field', sectionId: SEC, entryId: ENTRY, field: 'institution', value: 'x' }, none),
    null
  )
})

test('a value of the wrong kind for its field is refused', () => {
  const patch = (value: unknown) =>
    parsePatch({ op: 'field', sectionId: SEC, entryId: ENTRY, field: 'institution', value }, education)
  assert.notEqual(patch('Rutgers'), null)
  for (const bad of [42, true, null, {}, []]) assert.equal(patch(bad), null, JSON.stringify(bad))
})

test('a GPA value accepts only its two fields, and caps the text', () => {
  const patch = (value: unknown) =>
    parsePatch({ op: 'field', sectionId: SEC, entryId: ENTRY, field: 'overallGpa', value }, education)
  assert.notEqual(patch({ raw: '3.85', showOnResume: true }), null)
  assert.notEqual(patch({ raw: '3.4/4.0' }), null)
  assert.equal(patch({ raw: 'x'.repeat(100) }), null)
  assert.equal(patch({ raw: 3.85 }), null)
  assert.equal(patch('3.85'), null)
})

test('a date range accepts only strings and the current flag', () => {
  const patch = (value: unknown) =>
    parsePatch({ op: 'field', sectionId: SEC, entryId: ENTRY, field: 'graduationDate', value }, education)
  assert.notEqual(patch('2021-03'), null, 'a date is a string')
  assert.equal(patch({ start: '2021-03' }), null, 'a date is not a range')
})

test('text is capped at a length that still clears real resumes', () => {
  // One live professional summary is 4,214 characters.
  const patch = (n: number) =>
    parsePatch({ op: 'summary', sectionId: SEC, value: 'x'.repeat(n) }, education)
  assert.notEqual(patch(5_000), null, 'a real summary must fit')
  assert.notEqual(patch(MAX_FIELD_TEXT), null)
  assert.equal(patch(MAX_FIELD_TEXT + 1), null)
})

// ----------------------------------------------------------- positions

test('only real clinical facts are accepted, with the right kind', () => {
  const fact = (field: string, value: unknown) =>
    parsePatch({ op: 'position-fact', sectionId: SEC, positionId: U(3), field, value }, education)

  assert.notEqual(fact('employer', 'University Hospital'), null)
  assert.notEqual(fact('chargeExperience', true), null)
  assert.notEqual(fact('devices', ['Ventilator', 'CRRT']), null)
  assert.notEqual(fact('dates', { start: '2021-03', isCurrent: true }), null)

  assert.equal(fact('employer', 42), null, 'a text fact is not a number')
  assert.equal(fact('chargeExperience', 'yes'), null, 'a flag is not a string')
  assert.equal(fact('devices', 'Ventilator'), null, 'a list is not a string')
  assert.equal(fact('salary', '120000'), null, 'an unknown fact is refused')
})

test('a fact list is bounded in length and in item size', () => {
  const fact = (value: unknown) =>
    parsePatch({ op: 'position-fact', sectionId: SEC, positionId: U(3), field: 'devices', value }, education)
  assert.notEqual(fact(Array(60).fill('Ventilator')), null)
  assert.equal(fact(Array(61).fill('Ventilator')), null)
  assert.equal(fact(['x'.repeat(201)]), null)
  assert.equal(fact([42]), null)
})

test('bullet indexes must be real indexes', () => {
  const bullet = (index: unknown) =>
    parsePatch({ op: 'bullet-remove', sectionId: SEC, positionId: U(3), index }, education)
  assert.notEqual(bullet(0), null)
  for (const bad of [-1, 1.5, '0', null, 10_000, NaN]) assert.equal(bullet(bad), null, String(bad))
})

// -------------------------------------------------------------- misc

test('a reorder accepts only a bounded list of UUIDs', () => {
  assert.notEqual(parsePatch({ op: 'section-reorder', orderedIds: [SEC, U(2)] }, education), null)
  assert.equal(parsePatch({ op: 'section-reorder', orderedIds: [SEC, 'nope'] }, education), null)
  assert.equal(parsePatch({ op: 'section-reorder', orderedIds: Array(101).fill(SEC) }, education), null)
  assert.equal(parsePatch({ op: 'section-reorder', orderedIds: SEC }, education), null)
})

test('a label may be cleared to null but not set to a non-string', () => {
  assert.notEqual(parsePatch({ op: 'section-label', sectionId: SEC, label: null }, education), null)
  assert.notEqual(parsePatch({ op: 'section-label', sectionId: SEC, label: 'ICU' }, education), null)
  assert.equal(parsePatch({ op: 'section-label', sectionId: SEC, label: 42 }, education), null)
})

test('extra keys on a patch are dropped, not carried through', () => {
  const patch = parsePatch(
    { op: 'contact', field: 'city', value: 'Newark', user_id: 'someone', revision: 999 },
    education
  )
  assert.deepEqual(patch, { op: 'contact', field: 'city', value: 'Newark' })
})

test('a visibility patch needs a real boolean', () => {
  assert.notEqual(parsePatch({ op: 'section-visible', sectionId: SEC, visible: false }, education), null)
  for (const bad of ['false', 0, null, undefined]) {
    assert.equal(parsePatch({ op: 'section-visible', sectionId: SEC, visible: bad }, education), null, String(bad))
  }
})
