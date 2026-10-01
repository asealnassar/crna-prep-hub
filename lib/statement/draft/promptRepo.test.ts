import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { promptSnapshotFromRow, readActivePrompt } from './promptRepo.ts'
import type { StatementPromptRow } from './promptRepo.ts'
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
