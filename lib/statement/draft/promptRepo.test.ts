import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listActivePrompts, promptOptionFromRow, promptSnapshotFromRow, readActivePrompt,
} from './promptRepo.ts'
import type { StatementPromptOptionRow, StatementPromptRow } from './promptRepo.ts'
// Imported to prove the validator is the gate this module does not duplicate.
import { checkPromptSelection } from './validate.ts'

/**
 * NO REAL SUPABASE. The same recording double draftRepo.test.ts uses, repeated
 * here rather than extracted: it is nine lines, it belongs to the file that
 * asserts against it, and a shared helper would make one test file's needs a
 * constraint on another's. `from()` is counted, so "issued no statement" and
 * "issued one and found nothing" stay distinguishable.
 */

const PROMPT = 'c0ffee00-0000-4000-8000-000000000001'
const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000002'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000003'
const WORDING = 'Why have you chosen nurse anaesthesia?'
/** The ceiling the catalog's CHECK enforces, in code points. */
const MAX_POINTS = 5000

type Reply = { data: unknown; error: unknown }
type Call = unknown[]

function fakeDb(replies: Reply[]): { db: SupabaseClient; log: Call[] } {
  const log: Call[] = []
  let next = 0
  const client = {
    from(table: string) {
      log.push(['from', table])
      const reply = replies[next++] ?? {
        data: null,
        error: { code: 'TEST_NO_REPLY', message: 'the code issued more statements than the test queued' },
      }
      const chain: unknown = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: Reply) => void) => resolve(reply)
          }
          return (...args: unknown[]) => { log.push([String(prop), ...args]); return chain }
        },
      })
      return chain
    },
  }
  return { db: client as unknown as SupabaseClient, log }
}

const row = (over: Partial<StatementPromptRow> = {}): StatementPromptRow => ({
  id: PROMPT,
  school_id: SCHOOL,
  prompt_text: WORDING,
  stated_max_words: 500,
  ...over,
})

const ok = (data: unknown): Reply => ({ data, error: null })
const boom: Reply = { data: null, error: { code: '08006', message: 'connection failure' } }

const calls = (log: Call[], name: string) => log.filter((c) => c[0] === name)
const froms = (log: Call[]) => calls(log, 'from').length
const wroteNothing = (log: Call[]) =>
  calls(log, 'update').length === 0 &&
  calls(log, 'insert').length === 0 &&
  calls(log, 'upsert').length === 0 &&
  calls(log, 'delete').length === 0

// ================================================================ the query

test('the projection is EXACTLY the four canonical columns, and never *', async () => {
  const { db, log } = fakeDb([ok(row())])
  await readActivePrompt(db, PROMPT)

  const selected = calls(log, 'select')[0][1] as string
  assert.equal(selected, 'id, school_id, prompt_text, stated_max_words')
  assert.equal(selected.includes('*'), false, `a wildcard projection: ${selected}`)
  // A picker's columns are not a snapshot's.
  for (const absent of ['label', 'application_cycle', 'display_order', 'created_at', 'updated_at']) {
    assert.equal(selected.includes(absent), false, `${absent} is not needed here`)
  }
})

test('the read is filtered by id AND by is_active', async () => {
  const { db, log } = fakeDb([ok(row())])
  await readActivePrompt(db, PROMPT)

  assert.deepEqual(calls(log, 'from'), [['from', 'statement_prompts']])
  assert.deepEqual(calls(log, 'eq'), [['eq', 'id', PROMPT], ['eq', 'is_active', true]])
  assert.equal(calls(log, 'maybeSingle').length, 1)
  // `is_active` is a predicate, not a column anything downstream reads.
  assert.equal((calls(log, 'select')[0][1] as string).includes('is_active'), false)
})

test('ONE statement, and it writes NOTHING', async () => {
  const { db, log } = fakeDb([ok(row())])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, true)
  assert.equal(froms(log), 1)
  assert.ok(wroteNothing(log), 'the resolver must issue no write')
  // Belt and braces: no mutating verb appears in the log at all.
  for (const verb of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
    assert.equal(calls(log, verb).length, 0, `${verb} must never be called`)
  }
})

test('a refusal issues no second statement', async () => {
  const { db, log } = fakeDb([ok(null)])
  await readActivePrompt(db, PROMPT)
  // draftRepo's update does a follow-up read; resolving a prompt never does.
  assert.equal(froms(log), 1)
})

// ============================================================== the snapshot

test('resolves the canonical school, wording and word limit', async () => {
  const { db } = fakeDb([ok(row())])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(result.value, {
    promptId: PROMPT,
    schoolId: SCHOOL,
    promptText: WORDING,
    statedMaxWords: 500,
  })
  assert.deepEqual(Object.keys(result.value).sort(),
    ['promptId', 'promptText', 'schoolId', 'statedMaxWords'])
})

test('a NULL stated_max_words becomes null, not 0 and not a default', async () => {
  const { db } = fakeDb([ok(row({ stated_max_words: null }))])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  // "No stated limit" is a different fact from zero and must stay so.
  assert.equal(result.value.statedMaxWords, null)
  assert.equal('statedMaxWords' in result.value, true)
})

test('the wording is returned verbatim -- not trimmed, not normalised', async () => {
  const shaped = '  First paragraph.\n\n    Indented second.  '
  const { db } = fakeDb([ok(row({ prompt_text: shaped }))])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.promptText, shaped)
})

test('the snapshot is BUILT, not spread -- a wider row cannot widen it', async () => {
  const wider = { ...row(), is_active: true, label: 'Essay 1', secret: 'internal' } as never
  const { db } = fakeDb([ok(wider)])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.value).sort(),
    ['promptId', 'promptText', 'schoolId', 'statedMaxWords'])
  assert.equal(JSON.stringify(result.value).includes('internal'), false)
})

test('both boundary word limits the CHECK permits are accepted', async () => {
  for (const words of [1, 5000]) {
    const { db } = fakeDb([ok(row({ stated_max_words: words }))])
    const result = await readActivePrompt(db, PROMPT)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.statedMaxWords, words)
  }
})

// ============================================================== the refusals

test('an absent or inactive prompt is not-found, and carries no detail', async () => {
  // maybeSingle() returns null for both, which is what the active-only policy
  // was written to produce: a withdrawn question is invisible, not refused.
  const { db } = fakeDb([ok(null)])
  const result = await readActivePrompt(db, PROMPT)
  assert.deepEqual(result, { ok: false, reason: 'not-found', detail: '' })
})

test('A READ FAILURE IS NOT NOT-FOUND', async () => {
  // The distinction the whole refusal union exists for: a dropped connection
  // reported as absence would say the catalog lost a row.
  const { db } = fakeDb([boom])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'read-failed')
  assert.notEqual(result.reason, 'not-found')
  // Code and message only -- never `details` or `hint`, which can echo a row.
  assert.equal(result.detail, '08006 connection failure')
})

test('a read failure never carries the PostgREST details or hint', async () => {
  const { db } = fakeDb([{
    data: null,
    error: {
      code: '23514', message: 'violates check constraint',
      details: 'Failing row contains (…, Why have you chosen nurse anaesthesia?, …)',
      hint: 'the school wording',
    },
  }])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.detail, '23514 violates check constraint')
  assert.equal(result.detail.includes('Failing row'), false)
  assert.equal(result.detail.includes('anaesthesia'), false)
})

test('a malformed row is data-integrity, never a silent repair', async () => {
  const malformed: readonly Partial<StatementPromptRow>[] = [
    { id: null },
    { id: 'not-a-uuid' },
    { school_id: null },
    { school_id: 'not-a-uuid' },
    { prompt_text: null },
    { prompt_text: '' },
    { prompt_text: '   \n\t  ' },
    { prompt_text: 42 as never },
    // Outside the range the CHECK enforces: seeing one means it is gone.
    { stated_max_words: 0 },
    { stated_max_words: -1 },
    { stated_max_words: 5001 },
    { stated_max_words: 1.5 },
    // An `integer` column arrives as a JSON number or it did not come from
    // this column -- unlike `bigint`, which may legitimately be a string.
    { stated_max_words: '500' as never },
    { stated_max_words: true as never },
    { stated_max_words: NaN },
    { stated_max_words: Infinity },
  ]
  for (const over of malformed) {
    const { db } = fakeDb([ok(row(over))])
    const result = await readActivePrompt(db, PROMPT)
    assert.equal(result.ok, false, `${JSON.stringify(over)} must be refused`)
    if (result.ok) return
    assert.equal(result.reason, 'data-integrity', JSON.stringify(over))
    assert.equal(result.detail, 'unusable stored row (prompt)')
  }
})

test('prompt_text of EXACTLY 5,000 characters is accepted', async () => {
  const exactly = 'a'.repeat(5000)
  const { db } = fakeDb([ok(row({ prompt_text: exactly }))])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.promptText.length, 5000)
  assert.equal(result.value.promptText, exactly)
})

test('prompt_text of 5,001 characters is data-integrity, NOT truncated', async () => {
  // The column's CHECK says the same thing, and statement_drafts.prompt_text
  // says it again at the write. Refusing here makes the failure belong to the
  // prompt that is wrong rather than to the draft that was being saved.
  const tooLong = 'a'.repeat(5001)
  const { db } = fakeDb([ok(row({ prompt_text: tooLong }))])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'data-integrity')
  assert.equal(result.detail, 'unusable stored row (prompt)')
  // And nothing came back that a caller could mistake for a shortened prompt.
  assert.equal('value' in result, false)
})

test('the ceiling counts CODE POINTS, as char_length does -- not code units', async () => {
  // 3,000 astral characters are 3,000 code points but 6,000 UTF-16 code units.
  // Postgres stored them happily, so this parser must too: counting units here
  // would refuse wording no CHECK objects to.
  const emoji = '\u{1f642}'
  const wording = emoji.repeat(3000)
  assert.equal(wording.length, 6000, 'code units')
  assert.equal([...wording].length, 3000, 'code points')

  const { db } = fakeDb([ok(row({ prompt_text: wording }))])
  const accepted = await readActivePrompt(db, PROMPT)
  assert.equal(accepted.ok, true, 'a 3,000-code-point prompt must be readable')
  if (!accepted.ok) return
  assert.equal(accepted.value.promptText, wording)

  // And one code point past the ceiling is still refused, however many units.
  const over = emoji.repeat(MAX_POINTS + 1)
  assert.equal([...over].length, MAX_POINTS + 1)
  const { db: db2 } = fakeDb([ok(row({ prompt_text: over }))])
  const refused = await readActivePrompt(db2, PROMPT)
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.equal(refused.reason, 'data-integrity')
})

test('data-integrity detail never quotes the row', async () => {
  const { db } = fakeDb([ok(row({ prompt_text: '' }))])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.detail.includes(SCHOOL), false)
  assert.equal(result.detail.includes(PROMPT), false)
})

test('a row for a DIFFERENT id is data-integrity, never returned', async () => {
  // Unreachable while the `.eq('id', ...)` holds. If a filter ever stops
  // applying, another school's question must not reach an applicant's draft.
  const { db } = fakeDb([ok(row({ id: OTHER }))])
  const result = await readActivePrompt(db, PROMPT)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'data-integrity')
  assert.equal(result.detail, 'unusable stored row (prompt-id-mismatch)')
})

test('the three refusals are three distinct reasons', async () => {
  const reasons: string[] = []
  for (const reply of [ok(null), boom, ok(row({ prompt_text: '' }))]) {
    const { db } = fakeDb([reply])
    const result = await readActivePrompt(db, PROMPT)
    assert.equal(result.ok, false)
    if (result.ok) return
    reasons.push(result.reason)
  }
  assert.deepEqual(reasons, ['not-found', 'read-failed', 'data-integrity'])
  assert.equal(new Set(reasons).size, 3)
})

// ======================================================= the pure normaliser

test('promptSnapshotFromRow refuses a non-object without throwing', () => {
  for (const value of [null, undefined, 'row', 0, true]) {
    assert.equal(promptSnapshotFromRow(value as never), null)
  }
})

test('promptSnapshotFromRow accepts the shape the projection promises', () => {
  assert.deepEqual(promptSnapshotFromRow(row()), {
    promptId: PROMPT, schoolId: SCHOOL, promptText: WORDING, statedMaxWords: 500,
  })
})

// ============================================================ the boundaries

test('the id is validated by the VALIDATOR, not re-checked here', () => {
  // The gate is checkPromptSelection, which a caller runs first -- exactly as
  // the draft routes run isDraftId before reaching draftRepo. Recorded so the
  // division of labour is a decision rather than an omission.
  assert.equal(checkPromptSelection('not-a-uuid').ok, false)
  assert.equal(checkPromptSelection(PROMPT).ok, true)
})

test('the module never builds a client and never names the service role', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('./promptRepo.ts', import.meta.url), 'utf8'))
  for (const forbidden of [
    'createClient', 'SERVICE_ROLE', 'service_role', 'SUPABASE_SERVICE',
    "select('*')", 'from(\'statement_drafts\')',
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear`)
  }
  // The client is the caller's, and the table is named exactly once.
  assert.equal(source.includes("const PROMPTS = 'statement_prompts'"), true)
})

// ========================================================== the picker's list

const PROMPT_B = 'c0ffee00-0000-4000-8000-00000000000b'
const PROMPT_C = 'c0ffee00-0000-4000-8000-00000000000c'

const optionRow = (over: Partial<StatementPromptOptionRow> = {}): StatementPromptOptionRow => ({
  id: PROMPT,
  label: 'Essay 1',
  prompt_text: WORDING,
  stated_max_words: 500,
  application_cycle: '2026',
  ...over,
})

// ------------------------------------------------------------- the query

test('list: the projection is EXACTLY the five picker columns, and never *', async () => {
  const { db, log } = fakeDb([ok([optionRow()])])
  await listActivePrompts(db, SCHOOL)

  const selected = calls(log, 'select')[0][1] as string
  assert.equal(selected, 'id, label, prompt_text, stated_max_words, application_cycle')
  assert.deepEqual(selected.split(', '), [
    'id', 'label', 'prompt_text', 'stated_max_words', 'application_cycle',
  ])
  assert.equal(selected.includes('*'), false, `a wildcard projection: ${selected}`)
  // The two predicates and the sort key are not values anything displays.
  for (const absent of ['school_id', 'is_active', 'display_order', 'created_at', 'updated_at']) {
    assert.equal(selected.includes(absent), false, `${absent} must not be selected`)
  }
})

test('list: filtered by THIS school and by is_active', async () => {
  const { db, log } = fakeDb([ok([optionRow()])])
  await listActivePrompts(db, SCHOOL)

  assert.deepEqual(calls(log, 'from'), [['from', 'statement_prompts']])
  assert.deepEqual(calls(log, 'eq'), [
    ['eq', 'school_id', SCHOOL],
    ['eq', 'is_active', true],
  ])
})

test('list: ordered DETERMINISTICALLY -- display_order, then label, then id', async () => {
  // display_order has no uniqueness, so an unbroken tie would let the list
  // shuffle between two renders of the same data.
  const { db, log } = fakeDb([ok([optionRow()])])
  await listActivePrompts(db, SCHOOL)

  assert.deepEqual(calls(log, 'order'), [
    ['order', 'display_order', { ascending: true }],
    ['order', 'label', { ascending: true }],
    ['order', 'id', { ascending: true }],
  ])
})

test('list: ONE statement, and it writes NOTHING', async () => {
  const { db, log } = fakeDb([ok([optionRow()])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, true)
  assert.equal(froms(log), 1)
  assert.ok(wroteNothing(log))
  for (const verb of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
    assert.equal(calls(log, verb).length, 0, `${verb} must never be called`)
  }
})

// ------------------------------------------------------------- the results

test('list: MULTIPLE prompts for one school all come back, in the order given', async () => {
  const { db } = fakeDb([ok([
    optionRow({ id: PROMPT, label: 'Essay 1' }),
    optionRow({ id: PROMPT_B, label: 'Essay 2', stated_max_words: 750 }),
    optionRow({ id: PROMPT_C, label: 'Why our program', stated_max_words: null }),
  ])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.value.length, 3)
  assert.deepEqual(result.value.map((o) => o.id), [PROMPT, PROMPT_B, PROMPT_C])
  assert.deepEqual(result.value.map((o) => o.label), ['Essay 1', 'Essay 2', 'Why our program'])
  assert.deepEqual(result.value.map((o) => o.statedMaxWords), [500, 750, null])
  // The repository does not re-sort: one ordering, decided by the query.
  assert.deepEqual([...result.value].map((o) => o.id), [PROMPT, PROMPT_B, PROMPT_C])
})

test('list: an option carries exactly the five camel-cased fields', async () => {
  const { db } = fakeDb([ok([optionRow()])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(result.value[0], {
    id: PROMPT,
    label: 'Essay 1',
    promptText: WORDING,
    statedMaxWords: 500,
    applicationCycle: '2026',
  })
  assert.deepEqual(Object.keys(result.value[0]).sort(),
    ['applicationCycle', 'id', 'label', 'promptText', 'statedMaxWords'])
  // NOT a snapshot: an option has no schoolId to be mistaken for one.
  assert.equal('schoolId' in result.value[0], false)
})

test('list: AN EMPTY ARRAY IS A SUCCESS, never not-found', async () => {
  // The common case today: nothing has been seeded. A school with no published
  // prompt and an empty catalog are both legitimate answers.
  const { db } = fakeDb([ok([])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, [])
  assert.equal(Array.isArray(result.value), true)
})

test('list: NULL DATA IS A READ FAILURE, not an empty catalog', async () => {
  // The distinction this correction exists for. Reporting an unexpected
  // response as "no prompts" would tell an applicant a school asks no
  // questions when the truth is that something went wrong.
  const { db } = fakeDb([ok(null)])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'read-failed')
  assert.notEqual(result.reason, 'not-found')
  assert.equal('value' in result, false, 'no empty list may come back')
  assert.equal(result.detail, 'NO_ROWS select returned no array')
})

test('list: a NON-ARRAY result is a read failure', async () => {
  // Nothing else is "zero rows": not an object, not a string, not a number.
  for (const data of [undefined, {}, '', 'rows', 0, 42, true, false, { rows: [] }]) {
    const { db } = fakeDb([ok(data)])
    const result = await listActivePrompts(db, SCHOOL)
    assert.equal(result.ok, false, JSON.stringify(data) ?? String(data))
    if (result.ok) return
    assert.equal(result.reason, 'read-failed', String(data))
    assert.equal(result.detail, 'NO_ROWS select returned no array')
  }
})

test('list: the three NON-SUCCESS answers stay three distinct things', async () => {
  const seen: string[] = []
  for (const reply of [ok(null), boom, ok([optionRow({ label: '   ' })])]) {
    const { db } = fakeDb([reply])
    const result = await listActivePrompts(db, SCHOOL)
    assert.equal(result.ok, false)
    if (result.ok) return
    seen.push(`${result.reason}:${result.detail}`)
  }
  assert.deepEqual(seen, [
    'read-failed:NO_ROWS select returned no array',
    'read-failed:08006 connection failure',
    'data-integrity:unusable stored row (prompt-option)',
  ])
  // Two read failures, told apart by their internal detail; one integrity
  // failure. And an empty array is none of them.
  const { db } = fakeDb([ok([])])
  assert.equal((await listActivePrompts(db, SCHOOL)).ok, true)
})

test('list: a MALFORMED ROW INSIDE AN ARRAY is still data-integrity, not read-failed', async () => {
  // The array arrived intact; it is one row that cannot be read. Those are
  // different faults and must keep different reasons.
  const { db } = fakeDb([ok([optionRow({ id: 'not-a-uuid' })])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'data-integrity')
  assert.notEqual(result.reason, 'read-failed')
  assert.equal(result.detail, 'unusable stored row (prompt-option)')
})

test('list: NO REFUSAL CARRIES ANYTHING A BROWSER MAY SEE', async () => {
  // `detail` is a repository diagnostic: three fixed shapes, logged at most.
  // Routes build every 5xx from SERVER_ERROR_BODY, so none of this is ever a
  // response body -- the endpoint checkpoint is what has to honour that, and
  // http.test.ts already pins that constant.
  const hostile = {
    data: null,
    error: {
      code: '42501', message: 'permission denied for table statement_prompts',
      details: `Failing row contains (…, ${WORDING}, …)`,
      hint: 'check the policy',
    },
  }
  for (const reply of [
    hostile,
    ok(null),
    ok([optionRow({ prompt_text: `${WORDING} and a secret` })] ),
    ok([optionRow({ label: '' })]),
  ]) {
    const { db } = fakeDb([reply])
    const result = await listActivePrompts(db, SCHOOL)
    if (result.ok) continue

    // Exactly the three keys the result union declares. No row, no query, no
    // stack, no school id.
    assert.deepEqual(Object.keys(result).sort(), ['detail', 'ok', 'reason'])
    const text = JSON.stringify(result)
    for (const leak of [
      'Failing row', 'check the policy', 'anaesthesia', 'secret', SCHOOL, PROMPT,
    ]) {
      assert.equal(text.includes(leak), false, `${leak} must never be carried`)
    }
  }
})

test('list: a NULL word limit survives, and is not a default', async () => {
  const { db } = fakeDb([ok([optionRow({ stated_max_words: null })])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value[0].statedMaxWords, null)
  assert.equal('statedMaxWords' in result.value[0], true)
})

test('list: a NULL application cycle survives', async () => {
  const { db } = fakeDb([ok([optionRow({ application_cycle: null })])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value[0].applicationCycle, null)
  assert.equal('applicationCycle' in result.value[0], true)
})

test('list: both accepted cycle formats pass, and both word-limit bounds', async () => {
  for (const cycle of ['2026', '2026-2027', '2026-2031']) {
    const { db } = fakeDb([ok([optionRow({ application_cycle: cycle })])])
    const result = await listActivePrompts(db, SCHOOL)
    assert.equal(result.ok, true, cycle)
    if (!result.ok) return
    assert.equal(result.value[0].applicationCycle, cycle)
  }
  for (const words of [1, 5000]) {
    const { db } = fakeDb([ok([optionRow({ stated_max_words: words })])])
    const result = await listActivePrompts(db, SCHOOL)
    assert.equal(result.ok && result.value[0].statedMaxWords, words)
  }
})

test('list: WORDING AND LABEL ARE VERBATIM -- not trimmed, not normalised', async () => {
  const shaped = '  First paragraph.\n\n    Indented second.  '
  const padded = '  Essay 1  '
  const { db } = fakeDb([ok([optionRow({ prompt_text: shaped, label: padded })])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, true)
  if (!result.ok) return
  // Measured trimmed -- matching the CHECKs -- but RETURNED as stored.
  assert.equal(result.value[0].promptText, shaped)
  assert.equal(result.value[0].label, padded)
})

test('list: an option is BUILT, not spread -- a wider row cannot widen it', async () => {
  const wider = {
    ...optionRow(), school_id: SCHOOL, is_active: true, display_order: 3, secret: 'internal',
  } as never
  const { db } = fakeDb([ok([wider])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.value[0]).sort(),
    ['applicationCycle', 'id', 'label', 'promptText', 'statedMaxWords'])
  assert.equal(JSON.stringify(result.value).includes('internal'), false)
})

// ------------------------------------------------------------ the refusals

const MALFORMED: readonly Partial<StatementPromptOptionRow>[] = [
  { id: null }, { id: 'not-a-uuid' }, { id: '' },
  { label: null }, { label: '' }, { label: '   ' }, { label: '\n\t ' },
  { label: 'a'.repeat(201) }, { label: 42 as never },
  { prompt_text: null }, { prompt_text: '' }, { prompt_text: '  ' },
  { prompt_text: 'a'.repeat(5001) }, { prompt_text: 42 as never },
  { stated_max_words: 0 }, { stated_max_words: -1 }, { stated_max_words: 5001 },
  { stated_max_words: 1.5 }, { stated_max_words: '500' as never },
  { stated_max_words: NaN }, { stated_max_words: true as never },
  { application_cycle: '' }, { application_cycle: '26' }, { application_cycle: '2026x' },
  { application_cycle: 'x2026' }, { application_cycle: '2026-' },
  { application_cycle: '2026-20267' }, { application_cycle: 2026 as never },
  { application_cycle: '2026 2027' },
]

test('list: a MALFORMED row is data-integrity, never a silent repair', async () => {
  for (const over of MALFORMED) {
    const { db } = fakeDb([ok([optionRow(over)])])
    const result = await listActivePrompts(db, SCHOOL)
    assert.equal(result.ok, false, `${JSON.stringify(over)} must be refused`)
    if (result.ok) return
    assert.equal(result.reason, 'data-integrity', JSON.stringify(over))
    assert.equal(result.detail, 'unusable stored row (prompt-option)')
    // Never an echo of the row.
    assert.equal(result.detail.includes(SCHOOL), false)
    assert.equal(result.detail.includes('anaesthesia'), false)
  }
})

test('list: ONE malformed row fails the WHOLE list -- no silent skipping', async () => {
  // Returning the other two would hide a prompt a school published, and an
  // applicant would conclude the question was not offered.
  const { db } = fakeDb([ok([
    optionRow({ id: PROMPT, label: 'Essay 1' }),
    optionRow({ id: PROMPT_B, label: '   ' }),          // the bad one
    optionRow({ id: PROMPT_C, label: 'Essay 3' }),
  ])])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'data-integrity')
  assert.equal('value' in result, false, 'no partial list may come back')
})

test('list: A READ FAILURE IS NOT AN EMPTY LIST', async () => {
  // The distinction that matters most here: a dropped connection reported as
  // "no prompts" would tell an applicant this school asks no questions.
  const { db } = fakeDb([boom])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'read-failed')
  assert.notEqual(result.reason, 'not-found')
  assert.equal(result.detail, '08006 connection failure')

  // And an EMPTY ARRAY is unambiguously the other thing.
  const { db: db2 } = fakeDb([ok([])])
  const empty = await listActivePrompts(db2, SCHOOL)
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.ok && empty.value, [])
  // Null data is NOT that other thing: it joins the failures.
  const { db: db3 } = fakeDb([ok(null)])
  assert.equal((await listActivePrompts(db3, SCHOOL)).ok, false)
})

test('list: a read failure never carries the PostgREST details or hint', async () => {
  const { db } = fakeDb([{
    data: null,
    error: {
      code: '42501', message: 'permission denied for table statement_prompts',
      details: `Failing row contains (…, ${WORDING}, …)`,
      hint: 'check the policy',
    },
  }])
  const result = await listActivePrompts(db, SCHOOL)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.detail, '42501 permission denied for table statement_prompts')
  for (const leak of ['Failing row', 'anaesthesia', 'check the policy']) {
    assert.equal(result.detail.includes(leak), false, `${leak} must never be carried`)
  }
})

test('list: never returns not-found for any input', async () => {
  for (const reply of [ok([]), ok(null), ok([optionRow()]), boom,
    ok([optionRow({ label: '' })])]) {
    const { db } = fakeDb([reply])
    const result = await listActivePrompts(db, SCHOOL)
    if (result.ok) continue
    assert.notEqual(result.reason, 'not-found', 'a list has no not-found answer')
  }
})

// ------------------------------------------------------- the pure normaliser

test('promptOptionFromRow refuses a non-object without throwing', () => {
  for (const value of [null, undefined, 'row', 0, true, []]) {
    assert.equal(promptOptionFromRow(value as never), null, String(value))
  }
})

test('promptOptionFromRow accepts the shape the projection promises', () => {
  assert.deepEqual(promptOptionFromRow(optionRow()), {
    id: PROMPT, label: 'Essay 1', promptText: WORDING,
    statedMaxWords: 500, applicationCycle: '2026',
  })
})

test('promptOptionFromRow: the LABEL ceiling is 200 code points, measured trimmed', () => {
  // Exactly 200 passes; 201 does not. And the limit is points, not units, so an
  // astral label the database stored happily must be readable.
  assert.notEqual(promptOptionFromRow(optionRow({ label: 'a'.repeat(200) })), null)
  assert.equal(promptOptionFromRow(optionRow({ label: 'a'.repeat(201) })), null)
  // Trailing space does not push a 200-point label over, because it is trimmed
  // before measuring -- exactly as char_length(btrim(label)) does.
  assert.notEqual(promptOptionFromRow(optionRow({ label: `${'a'.repeat(200)} ` })), null)

  const emoji = '\u{1f642}'.repeat(150)          // 150 points, 300 units
  assert.equal(emoji.length, 300)
  assert.equal([...emoji].length, 150)
  assert.notEqual(promptOptionFromRow(optionRow({ label: emoji })), null)
})

// ------------------------------------------- the single resolver is unchanged

test('THE SINGLE-PROMPT RESOLVER IS UNCHANGED by the list being added', async () => {
  // Same projection, same filters, same snapshot, same refusals.
  const { db, log } = fakeDb([ok(row())])
  const result = await readActivePrompt(db, PROMPT)

  assert.equal(calls(log, 'select')[0][1], 'id, school_id, prompt_text, stated_max_words')
  assert.deepEqual(calls(log, 'eq'), [['eq', 'id', PROMPT], ['eq', 'is_active', true]])
  assert.equal(calls(log, 'maybeSingle').length, 1)
  assert.equal(calls(log, 'order').length, 0, 'a single row needs no ordering')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, {
    promptId: PROMPT, schoolId: SCHOOL, promptText: WORDING, statedMaxWords: 500,
  })
  // It still has a not-found answer, which the list deliberately does not.
  const { db: db2 } = fakeDb([ok(null)])
  const missing = await readActivePrompt(db2, PROMPT)
  assert.equal(missing.ok === false && missing.reason, 'not-found')
})

test('promptSnapshotFromRow is UNCHANGED, and is not the option parser', async () => {
  assert.deepEqual(promptSnapshotFromRow(row()), {
    promptId: PROMPT, schoolId: SCHOOL, promptText: WORDING, statedMaxWords: 500,
  })
  // A snapshot has no label; an option has no schoolId. Neither can stand in
  // for the other.
  assert.equal('label' in (promptSnapshotFromRow(row()) as object), false)
  assert.equal('schoolId' in (promptOptionFromRow(optionRow()) as object), false)
})
