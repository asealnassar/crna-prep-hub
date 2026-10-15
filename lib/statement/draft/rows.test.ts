import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftFromRow, draftSummaryFromRow, parseStoredRevision } from './rows.ts'
import type { StatementDraftRow, StatementDraftSummaryRow } from './rows.ts'
// Imported ONLY to assert the two snapshot parsers have not drifted apart.
import { promptSnapshotFromRow } from './promptRepo.ts'

/**
 * Pure. No client, no network, no clock.
 *
 * THE POINT OF parseStoredRevision IS THAT IT HAS NO FALLBACK. Every test below
 * that expects null is really asserting the absence of `|| 1`: a compare-and-swap
 * against a fabricated revision 1 would either overwrite newer work or invent a
 * conflict, and the corruption behind it would never surface.
 */

const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000003'
const PROMPT = 'c0ffee00-0000-4000-8000-000000000004'
const WORDING = 'Why have you chosen nurse anaesthesia?'

/** The DEFAULT IS A GENERIC DRAFT: no prompt, all four snapshot columns NULL,
 *  which is what every draft created today looks like. */
const row = (over: Partial<StatementDraftRow> = {}): StatementDraftRow => ({
  id: 'd1e2f3a4-0000-4000-8000-000000000001',
  user_id: 'u1e2f3a4-0000-4000-8000-000000000002',
  title: 'Draft one',
  essay: 'Opening line.',
  revision: 1,
  created_at: '2026-09-28T12:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
  school_id: null,
  prompt_id: null,
  prompt_text: null,
  stated_max_words: null,
  ...over,
})

/** The same row with a prompt chosen. */
const chosen = (over: Partial<StatementDraftRow> = {}): StatementDraftRow => row({
  school_id: SCHOOL,
  prompt_id: PROMPT,
  prompt_text: WORDING,
  stated_max_words: 500,
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

test('row: a GENERIC row becomes a draft whose prompt fields are all null', () => {
  const draft = draftFromRow(row())
  assert.deepEqual(draft, {
    id: 'd1e2f3a4-0000-4000-8000-000000000001',
    userId: 'u1e2f3a4-0000-4000-8000-000000000002',
    title: 'Draft one',
    essay: 'Opening line.',
    // 013: null for a row written before formatting existed, which is every
    // row this fixture stands for.
    editorDocument: null,
    // 015: null for a row that has chosen no face, which means the Studio's
    // own. Null rather than undefined, for the reason the prompt fields give.
    documentFont: null,
    revision: 1,
    createdAt: '2026-09-28T12:00:00.000Z',
    updatedAt: '2026-09-28T12:00:00.000Z',
    schoolId: null,
    promptId: null,
    promptText: null,
    statedMaxWords: null,
    // THE ROW CARRIED NEITHER COLUMN, which is what every draft read looks
    // like until 20261002_005 is applied. Both arrive as null rather than
    // undefined, so a consumer cannot tell an unmigrated database from a
    // general statement -- and does not need to, because both mean "read the
    // prompt columns instead".
    requirementId: null,
    requirementSnapshot: null,
  })
  // PRESENT AND null, not absent: a consumer must be able to tell "no prompt"
  // from "this parser forgot".
  for (const key of ['schoolId', 'promptId', 'promptText', 'statedMaxWords',
    'requirementId', 'requirementSnapshot']) {
    assert.equal(key in (draft as object), true, `${key} must be present`)
    assert.equal((draft as Record<string, unknown>)[key], null)
  }
  assert.equal(JSON.stringify(draft).includes('undefined'), false)
})

test('row: AN UNMIGRATED ROW AND A REQUIREMENT-LESS ROW PARSE THE SAME WAY', () => {
  // The columns absent entirely, versus present and NULL. Both are "this draft
  // has no structured requirement", and the parsed draft must not distinguish
  // them: the difference is a property of the deployment, not of the draft.
  const absent = draftFromRow(row())
  const present = draftFromRow(row({ requirement_id: null, requirement_snapshot: null }))
  assert.deepEqual(absent, present)
})

/** A coherent requirement-backed row: school and wording set, prompt_id NULL. */
const REQUIREMENT_ROW = {
  school_id: 'cccccccc-0000-4000-8000-000000000003',
  prompt_id: null,
  prompt_text: 'Describe a significant challenge.',
  stated_max_words: null,
  requirement_id: 'aaaaaaaa-0000-4000-8000-000000000001',
}

test('row: a stored requirement is passed through UNPARSED', () => {
  // rows.ts is a row-to-object mapper and knows nothing about what a
  // requirement is. Parsing happens in requirements/snapshot.ts.
  const snapshot = { requirementId: 'r1', setId: 's1', anything: ['at', 'all'] }
  const draft = draftFromRow(row({ ...REQUIREMENT_ROW, requirement_snapshot: snapshot }))
  assert.equal(draft?.requirementId, 'aaaaaaaa-0000-4000-8000-000000000001')
  assert.deepEqual(draft?.requirementSnapshot, snapshot)
})

test('row: A REQUIREMENT-BACKED ROW NEEDS NO prompt_id', () => {
  // The third shape. prompt_id means a public.statement_prompts row and must
  // not carry a requirement's id, so a requirement-backed draft leaves it null
  // and the parser accepts that -- which is what removed the overload.
  const draft = draftFromRow(row({ ...REQUIREMENT_ROW, requirement_snapshot: {} }))
  assert.notEqual(draft, null)
  assert.equal(draft?.promptId, null)
  assert.equal(draft?.schoolId, REQUIREMENT_ROW.school_id)
  assert.equal(draft?.promptText, REQUIREMENT_ROW.prompt_text)
  assert.equal(draft?.requirementId, REQUIREMENT_ROW.requirement_id)
})

test('row: A ROW CARRYING BOTH IDS IS REFUSED', () => {
  // Two claims about one question. Whichever a reader joined on first would
  // decide what the essay is judged against, so the row is unusable.
  const both = draftFromRow(row({
    ...REQUIREMENT_ROW,
    prompt_id: 'bbbbbbbb-0000-4000-8000-000000000002',
    requirement_snapshot: {},
  }))
  assert.equal(both, null)
})

test('row: A GENERIC ROW CANNOT CARRY A REQUIREMENT', () => {
  // No school and no wording, but a requirement id. Reading this as a general
  // statement would silently drop the question the essay answers and hand it
  // to the analyser with six categories instead of seven.
  const incoherent = draftFromRow(row({
    requirement_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    requirement_snapshot: {},
  }))
  assert.equal(incoherent, null)
})

test('row: a school and wording with NEITHER id is refused', () => {
  // Nothing can say where this question came from, so it must not be displayed
  // as though something vouched for it.
  const orphan = draftFromRow(row({
    school_id: REQUIREMENT_ROW.school_id,
    prompt_id: null,
    prompt_text: REQUIREMENT_ROW.prompt_text,
    stated_max_words: null,
  }))
  assert.equal(orphan, null)
})

test('row: A MALFORMED REQUIREMENT DOES NOT DESTROY THE DRAFT', () => {
  // Unlike a malformed prompt snapshot, which makes the row unusable, a bad
  // requirement copy must not lose somebody's essay. It is passed through and
  // the snapshot parser downstream refuses it, falling back to the prompt
  // columns -- which is a true description of what is stored.
  for (const junk of ['not an object', 7, [], true]) {
    const draft = draftFromRow(row({ ...REQUIREMENT_ROW, requirement_snapshot: junk }))
    assert.notEqual(draft, null, String(junk))
    assert.equal(draft?.essay, 'Opening line.')
    assert.equal(draft?.requirementId, REQUIREMENT_ROW.requirement_id, String(junk))
  }
  // A non-string id is not an id. The row then has a school and wording with
  // neither id, which is the orphan shape and is refused -- so the draft is
  // null rather than silently read as a prompt-backed one.
  assert.equal(draftFromRow(row({
    ...REQUIREMENT_ROW, requirement_id: 7 as unknown as string,
  })), null)
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

// ------------------------------------------------------- the prompt snapshot

test('snapshot: a CHOSEN prompt parses into all four camel-cased fields', () => {
  const draft = draftFromRow(chosen())
  assert.equal(draft === null, false)
  assert.equal(draft?.schoolId, SCHOOL)
  assert.equal(draft?.promptId, PROMPT)
  assert.equal(draft?.promptText, WORDING)
  assert.equal(draft?.statedMaxWords, 500)
})

test('snapshot: a chosen prompt with NO stated word limit is valid', () => {
  // A school stating no limit is a real and common fact, distinct from zero.
  const draft = draftFromRow(chosen({ stated_max_words: null }))
  assert.equal(draft === null, false)
  assert.equal(draft?.statedMaxWords, null)
  assert.equal(draft?.promptText, WORDING)
})

test('snapshot: the wording is returned verbatim -- not trimmed or normalised', () => {
  const shaped = '  First paragraph.\n\n    Indented second.  '
  const draft = draftFromRow(chosen({ prompt_text: shaped }))
  assert.equal(draft?.promptText, shaped)
})

test('snapshot: an invalid school_id makes the row unusable', () => {
  for (const school of ['', ' ', 'not-a-uuid', SCHOOL.slice(0, -1), 42 as never, true as never]) {
    assert.equal(draftFromRow(chosen({ school_id: school })), null, String(school))
  }
})

test('snapshot: an invalid prompt_id makes the row unusable', () => {
  for (const prompt of ['', ' ', 'not-a-uuid', `${PROMPT}0`, 42 as never, true as never]) {
    assert.equal(draftFromRow(chosen({ prompt_id: prompt })), null, String(prompt))
  }
})

test('snapshot: blank or non-string prompt_text makes the row unusable', () => {
  for (const text of ['', ' ', '\n\t  ', 42 as never, true as never, {} as never]) {
    assert.equal(draftFromRow(chosen({ prompt_text: text })), null, JSON.stringify(text))
  }
})

test('snapshot: prompt_text of exactly 5,000 code points is accepted', () => {
  const draft = draftFromRow(chosen({ prompt_text: 'a'.repeat(5000) }))
  assert.equal(draft === null, false)
  assert.equal(draft?.promptText?.length, 5000)
})

test('snapshot: prompt_text of 5,001 code points makes the row unusable', () => {
  assert.equal(draftFromRow(chosen({ prompt_text: 'a'.repeat(5001) })), null)
})

test('snapshot: the ceiling counts CODE POINTS, as char_length does', () => {
  // 3,000 astral characters are 3,000 code points but 6,000 UTF-16 code units.
  // Postgres stored them, so this parser must read them.
  const emoji = '\u{1f642}'
  const within = emoji.repeat(3000)
  assert.equal(within.length, 6000, 'code units')
  assert.equal([...within].length, 3000, 'code points')
  assert.equal(draftFromRow(chosen({ prompt_text: within }))?.promptText, within)

  const over = emoji.repeat(5001)
  assert.equal([...over].length, 5001)
  assert.equal(draftFromRow(chosen({ prompt_text: over })), null)
})

test('snapshot: an invalid stated_max_words makes the row unusable', () => {
  for (const words of [0, -1, 5001, 1.5, NaN, Infinity, '500' as never, true as never]) {
    assert.equal(draftFromRow(chosen({ stated_max_words: words })), null, String(words))
  }
})

test('snapshot: both boundary word limits the CHECK permits are accepted', () => {
  for (const words of [1, 5000]) {
    assert.equal(draftFromRow(chosen({ stated_max_words: words }))?.statedMaxWords, words)
  }
})

test('snapshot: PARTIAL metadata is refused -- a prompt is all three or none', () => {
  // There is no cross-column CHECK and no foreign key at this checkpoint, so
  // the read side is where incoherence has to be caught. Each of these is a row
  // claiming a prompt while missing part of it.
  const partial: Partial<StatementDraftRow>[] = [
    { school_id: SCHOOL },                              // school alone
    { prompt_id: PROMPT },                              // id alone
    { prompt_text: WORDING },                           // wording alone
    { stated_max_words: 500 },                          // a limit and nothing else
    { school_id: SCHOOL, prompt_id: PROMPT },           // no wording
    { school_id: SCHOOL, prompt_text: WORDING },        // no id
    { prompt_id: PROMPT, prompt_text: WORDING },        // no school
    { school_id: null, prompt_id: PROMPT, prompt_text: WORDING, stated_max_words: 500 },
    { school_id: SCHOOL, prompt_id: null, prompt_text: WORDING, stated_max_words: 500 },
    { school_id: SCHOOL, prompt_id: PROMPT, prompt_text: null, stated_max_words: 500 },
  ]
  for (const hole of partial) {
    assert.equal(draftFromRow(row(hole)), null, JSON.stringify(hole))
  }
})

test('snapshot: an ABSENT column is unusable, not read as a generic draft', () => {
  // A projection that forgot the columns must be loud. Read as null, every
  // draft in the database would silently look like it had no prompt.
  for (const key of ['school_id', 'prompt_id', 'prompt_text', 'stated_max_words'] as const) {
    const missing = { ...row() }
    delete (missing as Record<string, unknown>)[key]
    assert.equal(draftFromRow(missing as StatementDraftRow), null, `missing ${key}`)

    const explicitly = row({ [key]: undefined } as Partial<StatementDraftRow>)
    assert.equal(draftFromRow(explicitly), null, `undefined ${key}`)
  }
})

test('snapshot: nothing is repaired, clamped or inferred', () => {
  // Every refusal above returns null. None of them returns a draft carrying a
  // corrected value, which is what a clamp or a fallback would look like.
  for (const over of [
    { stated_max_words: 9999 }, { stated_max_words: 0 },
    { prompt_text: 'a'.repeat(6000) }, { prompt_text: '   ' },
  ] as Partial<StatementDraftRow>[]) {
    assert.equal(draftFromRow(chosen(over)), null, JSON.stringify(over))
  }
})

test('snapshot: THE DRAFT PARSER AND THE PROMPT RESOLVER AGREE ON EVERY BOUNDARY', () => {
  // rows.ts repeats promptRepo.ts's value rules rather than importing them, so
  // that the draft read path does not reach into the prompt resolver. This is
  // what stops the two copies drifting apart.
  const cases: readonly { text?: unknown; words?: unknown }[] = [
    { text: 'a'.repeat(5000) }, { text: 'a'.repeat(5001) },
    { text: '' }, { text: '   ' }, { text: '\u{1f642}'.repeat(3000) },
    { words: 1 }, { words: 5000 }, { words: 0 }, { words: 5001 },
    { words: null }, { words: 1.5 }, { words: '500' },
  ]
  for (const c of cases) {
    const text = c.text === undefined ? WORDING : c.text
    const words = c.words === undefined ? 500 : c.words

    const draftOk = draftFromRow(chosen({
      prompt_text: text as never, stated_max_words: words as never,
    })) !== null
    const promptOk = promptSnapshotFromRow({
      id: PROMPT, school_id: SCHOOL,
      prompt_text: text as never, stated_max_words: words as never,
    }) !== null

    assert.equal(draftOk, promptOk, `disagreed about ${JSON.stringify(c)}`)
  }
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
