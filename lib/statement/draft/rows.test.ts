import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftFromRow, draftSummaryFromRow, parseStoredRevision } from './rows.ts'
import type { StatementDraftRow, StatementDraftSummaryRow } from './rows.ts'

/**
 * Pure. No client, no network, no clock.
 *
 * THE POINT OF parseStoredRevision IS THAT IT HAS NO FALLBACK. Every test below
 * that expects null is really asserting the absence of `|| 1`: a compare-and-swap
 * against a fabricated revision 1 would either overwrite newer work or invent a
 * conflict, and the corruption behind it would never surface.
 */

const row = (over: Partial<StatementDraftRow> = {}): StatementDraftRow => ({
  id: 'd1e2f3a4-0000-4000-8000-000000000001',
  user_id: 'u1e2f3a4-0000-4000-8000-000000000002',
  title: 'Draft one',
  essay: 'Opening line.',
  revision: 1,
  created_at: '2026-09-28T12:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
  ...over,
})

// --------------------------------------------------- the accepted stored forms

test('revision: a numeric 1 is accepted', () => {
  assert.equal(parseStoredRevision(1), 1)
})

test('revision: any positive safe integer number is accepted', () => {
  for (const value of [1, 2, 7, 42, 1_000_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseStoredRevision(value), value, String(value))
  }
})

test('revision: the STRING "1" is accepted -- PostgREST may send bigint as text', () => {
  assert.equal(parseStoredRevision('1'), 1)
})

test('revision: a positive integer string is accepted and returns a number', () => {
  for (const [given, want] of [['7', 7], ['42', 42], ['9007199254740991', 9_007_199_254_740_991]] as const) {
    const parsed = parseStoredRevision(given)
    assert.equal(parsed, want, given)
    assert.equal(typeof parsed, 'number')
  }
})

// --------------------------------------------------- the refused stored forms

test('revision: 0 is refused -- the column starts at 1', () => {
  assert.equal(parseStoredRevision(0), null)
  assert.equal(parseStoredRevision('0'), null)
  assert.equal(parseStoredRevision(-0), null)
})

test('revision: negatives are refused', () => {
  for (const value of [-1, -42, '-1', '-42']) {
    assert.equal(parseStoredRevision(value), null, String(value))
  }
})

test('revision: fractions are refused', () => {
  for (const value of [1.5, 0.5, 2.000001, -1.5]) {
    assert.equal(parseStoredRevision(value), null, String(value))
  }
})

test('revision: the string "1.5" is refused', () => {
  assert.equal(parseStoredRevision('1.5'), null)
  assert.equal(parseStoredRevision('2.0'), null)
})

test('revision: "abc" is refused', () => {
  for (const value of ['abc', 'one', '1abc', 'abc1', 'NaN', 'Infinity']) {
    assert.equal(parseStoredRevision(value), null, value)
  }
})

test('revision: the empty string is refused', () => {
  assert.equal(parseStoredRevision(''), null)
  assert.equal(parseStoredRevision(' '), null)
})

test('revision: null and undefined are refused', () => {
  assert.equal(parseStoredRevision(null), null)
  assert.equal(parseStoredRevision(undefined), null)
})

test('revision: an unsafe integer is refused, as a number and as a string', () => {
  // A revision that cannot round-trip through a JS number cannot be compared or
  // incremented safely, and losing precision inside a CAS is worse than failing.
  for (const value of [
    Number.MAX_SAFE_INTEGER + 1, 2 ** 60,
    '9007199254740992', '99999999999999999999',
  ]) {
    assert.equal(parseStoredRevision(value), null, String(value))
  }
})

test('revision: NaN and the infinities are refused', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(parseStoredRevision(value), null, String(value))
  }
})

test('revision: ambiguous formatting is refused rather than guessed', () => {
  // None of these is a form a bigint column reaches PostgREST as. Accepting one
  // would mean accepting a value that did not come from this column.
  for (const value of [' 1', '1 ', '+1', '1e3', '0x1', '05', '001', '1_000', ',1']) {
    assert.equal(parseStoredRevision(value), null, JSON.stringify(value))
  }
})

test('revision: non-scalars are refused', () => {
  for (const value of [true, false, {}, [], [1], () => 1, Symbol('1')]) {
    assert.equal(parseStoredRevision(value), null, String(value))
  }
})

test('revision: THERE IS NO SILENT FALLBACK TO 1 for any refused value', () => {
  // The whole reason this function exists instead of `Number(value) || 1`.
  for (const value of [null, undefined, 0, -1, 1.5, '1.5', 'abc', '', NaN, {}, []]) {
    const parsed = parseStoredRevision(value)
    assert.equal(parsed, null, String(value))
    assert.notEqual(parsed, 1, `${String(value)} must not become revision 1`)
  }
})

// ----------------------------------------------------------- row normalisation

test('row: a well-formed row becomes a draft with camel-cased fields', () => {
  const draft = draftFromRow(row())
  assert.deepEqual(draft, {
    id: 'd1e2f3a4-0000-4000-8000-000000000001',
    userId: 'u1e2f3a4-0000-4000-8000-000000000002',
    title: 'Draft one',
    essay: 'Opening line.',
    revision: 1,
    createdAt: '2026-09-28T12:00:00.000Z',
    updatedAt: '2026-09-28T12:00:00.000Z',
  })
})

test('row: a string bigint revision is normalised to a number', () => {
  const draft = draftFromRow(row({ revision: '5' }))
  assert.equal(draft?.revision, 5)
  assert.equal(typeof draft?.revision, 'number')
})

test('row: an empty essay is legitimate and survives', () => {
  const draft = draftFromRow(row({ essay: '' }))
  assert.equal(draft?.essay, '')
})

test('row: a malformed revision makes the whole row unusable', () => {
  for (const revision of [null, 0, -1, 1.5, '1.5', 'abc', '', undefined]) {
    assert.equal(draftFromRow(row({ revision })), null, String(revision))
  }
})

test('row: a missing or non-string required field makes the row unusable', () => {
  const holes: Partial<StatementDraftRow>[] = [
    { id: null }, { id: '' }, { id: 42 as unknown as string },
    { user_id: null }, { user_id: '' },
    { title: null }, { essay: null },
    { created_at: null }, { updated_at: null },
  ]
  for (const hole of holes) {
    assert.equal(draftFromRow(row(hole)), null, JSON.stringify(hole))
  }
})

test('row: null, undefined and a non-object are unusable rather than thrown on', () => {
  assert.equal(draftFromRow(null), null)
  assert.equal(draftFromRow(undefined), null)
  assert.equal(draftFromRow('row' as unknown as StatementDraftRow), null)
})

// ------------------------------------------------------ summary normalisation

const summary = (over: Partial<StatementDraftSummaryRow> = {}): StatementDraftSummaryRow => ({
  id: 'd1e2f3a4-0000-4000-8000-000000000001',
  title: 'Draft one',
  revision: 1,
  created_at: '2026-09-28T12:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
  ...over,
})

test('summary: a well-formed list row becomes exactly five camel-cased fields', () => {
  assert.deepEqual(draftSummaryFromRow(summary()), {
    id: 'd1e2f3a4-0000-4000-8000-000000000001',
    title: 'Draft one',
    revision: 1,
    createdAt: '2026-09-28T12:00:00.000Z',
    updatedAt: '2026-09-28T12:00:00.000Z',
  })
})

test('summary: NO essay field is produced, even if the row carries one', () => {
  // The object is BUILT, not spread, so a wider row cannot leak an essay into a
  // type that promises not to have one.
  const wider = { ...summary(), essay: 'the applicant essay', user_id: 'u1' } as never
  const result = draftSummaryFromRow(wider)
  assert.equal(result === null, false)
  assert.equal('essay' in (result as object), false)
  assert.equal('userId' in (result as object), false)
  assert.deepEqual(Object.keys(result as object).sort(),
    ['createdAt', 'id', 'revision', 'title', 'updatedAt'])
})

test('summary: a string bigint revision is normalised to a number', () => {
  const result = draftSummaryFromRow(summary({ revision: '42' }))
  assert.equal(result?.revision, 42)
  assert.equal(typeof result?.revision, 'number')
})

test('summary: a malformed revision makes the row unusable, with no fallback', () => {
  for (const revision of [null, 0, -1, 1.5, '1.5', 'abc', '', undefined]) {
    assert.equal(draftSummaryFromRow(summary({ revision })), null, String(revision))
  }
})

test('summary: a missing or non-string required field makes the row unusable', () => {
  for (const hole of [
    { id: null }, { id: '' }, { title: null }, { created_at: null }, { updated_at: null },
  ] as Partial<StatementDraftSummaryRow>[]) {
    assert.equal(draftSummaryFromRow(summary(hole)), null, JSON.stringify(hole))
  }
})

test('summary: null, undefined and a non-object are unusable rather than thrown on', () => {
  assert.equal(draftSummaryFromRow(null), null)
  assert.equal(draftSummaryFromRow(undefined), null)
  assert.equal(draftSummaryFromRow('row' as unknown as StatementDraftSummaryRow), null)
})
