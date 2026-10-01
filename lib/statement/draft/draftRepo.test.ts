import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createDraft, deleteDraft, listDrafts, readDraft, updateDraft,
} from './draftRepo.ts'
import type { PromptWrite } from './draftRepo.ts'
import type { StatementDraftRow, StatementDraftSummaryRow } from './rows.ts'
// Imported to prove the validator stops the impossible update BEFORE this layer.
import { MAX_EXPECTED_REVISION, checkDraftUpdate } from './validate.ts'

/**
 * NO REAL SUPABASE. The client is a recording double in the shape
 * lib/interview/sessionSaver.test.ts already uses: a Proxy whose every method
 * logs its name and arguments and returns itself, so a whole PostgREST chain is
 * captured, and whose `then` resolves to a queued `{ data, error }`.
 *
 * WHY A QUEUE AND NOT ONE RESULT. The compare-and-swap can issue a second
 * statement -- the follow-up read after zero rows match -- and the tests have to
 * distinguish "did not read" from "read and found nothing". One result per
 * `from()`, consumed in order, makes both observable: `froms(log)` counts the
 * statements actually issued.
 */

const ID = 'd1e2f3a4-0000-4000-8000-000000000001'
const USER = 'u1e2f3a4-0000-4000-8000-000000000002'
/**
 * A stored updated_at, as the database might echo one back. NEVER an input:
 * updateDraft takes no timestamp, so nothing below can hand it one.
 */
const STORED_AT = '2026-09-28T18:30:00.000Z'
/** RFC 3339 / toISOString shape, to the millisecond, in UTC. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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

const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000003'
const PROMPT = 'c0ffee00-0000-4000-8000-000000000004'

/** A GENERIC draft by default: all four prompt columns NULL. */
const row = (over: Partial<StatementDraftRow> = {}): StatementDraftRow => ({
  id: ID,
  user_id: USER,
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

/** The same row with a prompt snapshot stored on it. */
const withPrompt = (over: Partial<StatementDraftRow> = {}): StatementDraftRow => row({
  school_id: SCHOOL,
  prompt_id: PROMPT,
  prompt_text: 'Why have you chosen nurse anaesthesia?',
  stated_max_words: 500,
  ...over,
})

/** What the LIST projection returns: five columns, no essay, no user_id. */
const summaryRow = (over: Partial<StatementDraftSummaryRow> = {}): StatementDraftSummaryRow => ({
  id: ID,
  title: 'Draft one',
  revision: 1,
  created_at: '2026-09-28T12:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
  ...over,
})

const ok = (data: unknown): Reply => ({ data, error: null })
const boom: Reply = { data: null, error: { code: '08006', message: 'connection failure' } }

/** Every call of one name, in order. */
const calls = (log: Call[], name: string) => log.filter((c) => c[0] === name)
/** How many statements were issued: one `from` per statement. */
const froms = (log: Call[]) => calls(log, 'from').length
/** No statement in this log wrote anything. */
const wroteNothing = (log: Call[]) =>
  calls(log, 'update').length === 0 &&
  calls(log, 'insert').length === 0 &&
  calls(log, 'upsert').length === 0 &&
  calls(log, 'delete').length === 0

// ================================================================== create

test('create: sends only user_id, title and essay', async () => {
  const { db, log } = fakeDb([ok(row())])
  const result = await createDraft(db, USER, { title: 'Draft one', essay: 'Opening line.' })
  assert.equal(result.ok, true)

  assert.deepEqual(calls(log, 'from'), [['from', 'statement_drafts']])
  const payload = calls(log, 'insert')[0][1] as Record<string, unknown>
  assert.deepEqual(payload, { user_id: USER, title: 'Draft one', essay: 'Opening line.' })
})

test('create: does NOT send revision, id or either timestamp', async () => {
  // Those are the database's to choose. A client-supplied revision in particular
  // would break the compare-and-swap before the first edit.
  const { db, log } = fakeDb([ok(row())])
  await createDraft(db, USER, { title: 'Draft one', essay: '' })
  const payload = calls(log, 'insert')[0][1] as Record<string, unknown>
  for (const forbidden of ['revision', 'id', 'created_at', 'updated_at']) {
    assert.equal(forbidden in payload, false, `insert must not carry ${forbidden}`)
  }
  assert.deepEqual(Object.keys(payload).sort(), ['essay', 'title', 'user_id'])
})

test('create: a fresh row reads back at revision 1, and a string bigint normalises', async () => {
  const { db } = fakeDb([ok(row({ revision: '1' }))])
  const result = await createDraft(db, USER, { title: 'Draft one', essay: '' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.revision, 1)
  assert.equal(typeof result.value.revision, 'number')
})

test('create: a malformed returned revision is a data-integrity failure, not a draft', async () => {
  for (const revision of [null, 0, 'abc', '1.5']) {
    const { db } = fakeDb([ok(row({ revision }))])
    const result = await createDraft(db, USER, { title: 'Draft one', essay: '' })
    assert.equal(result.ok, false, String(revision))
    if (result.ok) continue
    assert.equal(result.reason, 'data-integrity')
  }
})

test('create: a database error stays a create failure and leaks no row content', async () => {
  const { db } = fakeDb([{ data: null, error: { code: '23514', message: 'violates check', details: 'essay = <the applicant essay>' } }])
  const result = await createDraft(db, USER, { title: 'Draft one', essay: 'x' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'create-failed')
  assert.equal(result.detail, '23514 violates check')
  assert.equal(result.detail.includes('applicant'), false, 'details must never be carried')
})

// ============================================ the projections, and the writes

const ALL_ELEVEN = [
  'id', 'user_id', 'title', 'essay', 'revision', 'created_at', 'updated_at',
  'school_id', 'prompt_id', 'prompt_text', 'stated_max_words',
]

test('projection: the full read names ALL ELEVEN columns, and never *', async () => {
  const { db, log } = fakeDb([ok(row())])
  await readDraft(db, ID)

  const selected = calls(log, 'select')[0][1] as string
  assert.equal(
    selected,
    'id, user_id, title, essay, revision, created_at, updated_at, '
    + 'school_id, prompt_id, prompt_text, stated_max_words',
  )
  assert.deepEqual(selected.split(', '), ALL_ELEVEN)
  assert.equal(selected.split(', ').length, 11)
  assert.equal(selected.includes('*'), false, `a wildcard projection: ${selected}`)
})

test('projection: create and update ask for the same eleven columns', async () => {
  // All three statements hand a full draft back, so all three need the whole row.
  const reads: string[] = []
  for (const run of [
    async () => {
      const { db, log } = fakeDb([ok(row())])
      await createDraft(db, USER, { title: 't', essay: '' })
      return log
    },
    async () => {
      const { db, log } = fakeDb([ok(row({ revision: 2 }))])
      await updateDraft(db, ID, { title: 't', essay: '', expectedRevision: 1 })
      return log
    },
  ]) {
    const log = await run()
    reads.push(calls(log, 'select')[0][1] as string)
  }
  assert.equal(new Set(reads).size, 1, 'create and update must not drift apart')
  assert.deepEqual(reads[0].split(', '), ALL_ELEVEN)
})

test('projection: SUMMARY_COLUMNS is UNCHANGED -- the library gains nothing', async () => {
  const { db, log } = fakeDb([ok([summaryRow()])])
  await listDrafts(db, USER)

  const selected = calls(log, 'select')[0][1] as string
  // Byte-for-byte what it was before the prompt columns existed.
  assert.equal(selected, 'id, title, revision, created_at, updated_at')
  assert.equal(selected.split(', ').length, 5)
  for (const absent of ['essay', 'user_id', 'school_id', 'prompt_id', 'prompt_text', 'stated_max_words']) {
    assert.equal(selected.includes(absent), false, `the library must not load ${absent}`)
  }
})

test('write: the INSERT payload gained NO prompt column', async () => {
  const { db, log } = fakeDb([ok(row())])
  await createDraft(db, USER, { title: 'Draft one', essay: 'Opening line.' })

  const payload = calls(log, 'insert')[0][1] as Record<string, unknown>
  // Exactly what it was before this checkpoint.
  assert.deepEqual(Object.keys(payload).sort(), ['essay', 'title', 'user_id'])
  for (const forbidden of ['school_id', 'prompt_id', 'prompt_text', 'stated_max_words']) {
    assert.equal(forbidden in payload, false, `insert must not carry ${forbidden}`)
  }
  assert.equal(JSON.stringify(payload).includes('prompt'), false)
})

test('write: the UPDATE payload gained NO prompt column', async () => {
  const { db, log } = fakeDb([ok(row({ revision: 2 }))])
  await updateDraft(db, ID, { title: 'Draft one', essay: 'Body.', expectedRevision: 1 })

  const payload = calls(log, 'update')[0][1] as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), ['essay', 'revision', 'title', 'updated_at'])
  for (const forbidden of ['school_id', 'prompt_id', 'prompt_text', 'stated_max_words']) {
    assert.equal(forbidden in payload, false, `update must not carry ${forbidden}`)
  }
  assert.equal(JSON.stringify(payload).includes('prompt'), false)
})

test('write: saving a draft that HAS a prompt still writes only the four fields', async () => {
  // The snapshot comes back in the response and is left exactly where it was.
  const { db, log } = fakeDb([ok(withPrompt({ revision: 2 }))])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 1 })

  const payload = calls(log, 'update')[0][1] as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), ['essay', 'revision', 'title', 'updated_at'])
  // And the untouched snapshot is what the caller gets back.
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.promptId, PROMPT)
  assert.equal(result.value.schoolId, SCHOOL)
  assert.equal(result.value.statedMaxWords, 500)
})

test('read: a stored snapshot reaches the caller; a generic draft reads as nulls', async () => {
  const { db: db1 } = fakeDb([ok(withPrompt())])
  const chosen = await readDraft(db1, ID)
  assert.equal(chosen.ok, true)
  if (!chosen.ok) return
  assert.equal(chosen.value.promptText, 'Why have you chosen nurse anaesthesia?')

  const { db: db2 } = fakeDb([ok(row())])
  const generic = await readDraft(db2, ID)
  assert.equal(generic.ok, true)
  if (!generic.ok) return
  assert.deepEqual(
    [generic.value.schoolId, generic.value.promptId, generic.value.promptText, generic.value.statedMaxWords],
    [null, null, null, null],
  )
})

test('read: an INCOHERENT stored snapshot is a data-integrity failure', async () => {
  // A prompt_id with no wording is not a draft this application can use.
  for (const broken of [
    withPrompt({ prompt_text: null }),
    withPrompt({ school_id: null }),
    withPrompt({ prompt_id: 'not-a-uuid' }),
    withPrompt({ stated_max_words: 9999 }),
    row({ stated_max_words: 500 }),
  ]) {
    const { db } = fakeDb([ok(broken)])
    const result = await readDraft(db, ID)
    assert.equal(result.ok, false, JSON.stringify(broken))
    if (result.ok) continue
    assert.equal(result.reason, 'data-integrity')
    assert.equal(result.detail, 'unusable stored row (read)')
  }
})

test('CAS: the predicate, the increment and the follow-up read are UNCHANGED', async () => {
  // Widening the projection must not have touched the concurrency control.
  const { db, log } = fakeDb([ok(null), ok(withPrompt({ revision: 9 }))])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 4 })

  // One conditional update on id AND revision...
  assert.deepEqual(calls(log, 'eq').slice(0, 2), [['eq', 'id', ID], ['eq', 'revision', 4]])
  // ...bumping by exactly one...
  assert.equal((calls(log, 'update')[0][1] as Record<string, unknown>).revision, 5)
  // ...then exactly one follow-up read, and exactly two statements in all.
  assert.equal(froms(log), 2)
  assert.equal(calls(log, 'update').length, 1)
  // ...reporting the stored revision, and no part of the stored snapshot.
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'conflict')
  assert.equal(result.storedRevision, 9)
  assert.equal(JSON.stringify(result).includes('anaesthesia'), false)
  assert.equal(JSON.stringify(result).includes(PROMPT), false)
})

// ============================================ writing the prompt snapshot

/** The four SET keys an ordinary save has always carried. */
const DOCUMENT_KEYS = ['essay', 'revision', 'title', 'updated_at']
/** The four a prompt change adds to them, and nothing else. */
const PROMPT_KEYS = ['prompt_id', 'prompt_text', 'school_id', 'stated_max_words']

/** An already-resolved canonical snapshot, as promptRepo would have returned it. */
const SNAPSHOT = {
  promptId: PROMPT,
  schoolId: SCHOOL,
  promptText: 'Why have you chosen nurse anaesthesia?',
  statedMaxWords: 500,
} as const

const doc = { title: 'Draft one', essay: 'Body.', expectedRevision: 4 }

/** The SET payload of the one UPDATE this call issued. */
async function setPayload(
  prompt: PromptWrite | undefined,
  reply = ok(row({ revision: 5 })),
): Promise<{ payload: Record<string, unknown>; log: Call[] }> {
  const { db, log } = fakeDb([reply])
  await (prompt === undefined
    ? updateDraft(db, ID, doc)
    : updateDraft(db, ID, doc, prompt))
  return { payload: calls(log, 'update')[0][1] as Record<string, unknown>, log }
}

test('write: NO prompt change leaves the SET payload exactly as it was', async () => {
  const { payload } = await setPayload(undefined)
  assert.deepEqual(Object.keys(payload).sort(), DOCUMENT_KEYS)
  for (const forbidden of PROMPT_KEYS) {
    assert.equal(forbidden in payload, false, `an ordinary save must not write ${forbidden}`)
  }
  // Not merely absent from the keys -- absent from the serialised payload.
  assert.equal(JSON.stringify(payload).includes('prompt'), false)
  assert.equal(JSON.stringify(payload).includes('school'), false)
})

test('write: a RESOLVED SNAPSHOT adds exactly the four prompt columns', async () => {
  const { payload } = await setPayload(SNAPSHOT)
  assert.deepEqual(Object.keys(payload).sort(), [...DOCUMENT_KEYS, ...PROMPT_KEYS].sort())
  assert.equal(Object.keys(payload).length, 8)
  assert.equal(payload.school_id, SCHOOL)
  assert.equal(payload.prompt_id, PROMPT)
  assert.equal(payload.prompt_text, 'Why have you chosen nurse anaesthesia?')
  assert.equal(payload.stated_max_words, 500)
  // And the document half is untouched by the prompt half.
  assert.equal(payload.title, 'Draft one')
  assert.equal(payload.essay, 'Body.')
  assert.equal(payload.revision, 5)
})

test('write: statedMaxWords null writes stated_max_words NULL, present not omitted', async () => {
  // A school stating no limit must CLEAR a limit the previous prompt left, so
  // the key has to be there carrying null rather than left out.
  const { payload } = await setPayload({ ...SNAPSHOT, statedMaxWords: null })
  assert.equal('stated_max_words' in payload, true)
  assert.equal(payload.stated_max_words, null)
  assert.equal(payload.prompt_id, PROMPT)
  assert.deepEqual(Object.keys(payload).sort(), [...DOCUMENT_KEYS, ...PROMPT_KEYS].sort())
})

test('write: an EXPLICIT CLEAR writes all four columns as NULL', async () => {
  const { payload } = await setPayload(null)
  assert.deepEqual(Object.keys(payload).sort(), [...DOCUMENT_KEYS, ...PROMPT_KEYS].sort())
  for (const column of PROMPT_KEYS) {
    assert.equal(column in payload, true, `${column} must be written`)
    assert.equal(payload[column], null, `${column} must be NULL`)
  }
})

test('write: undefined and null are DIFFERENT instructions', async () => {
  // The distinction the whole three-state input exists for. An autosave that
  // omits the prompt must not wipe it; an explicit clear must not be ignored.
  const omitted = (await setPayload(undefined)).payload
  const cleared = (await setPayload(null)).payload
  assert.equal('prompt_id' in omitted, false)
  assert.equal('prompt_id' in cleared, true)
  assert.notDeepEqual(Object.keys(omitted).sort(), Object.keys(cleared).sort())
})

test('write: NO prompt change PRESERVES a stored snapshot', async () => {
  // The row comes back carrying the prompt the save did not touch.
  const { db, log } = fakeDb([ok(withPrompt({ revision: 5 }))])
  const result = await updateDraft(db, ID, doc)

  const payload = calls(log, 'update')[0][1] as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), DOCUMENT_KEYS)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.promptId, PROMPT)
  assert.equal(result.value.schoolId, SCHOOL)
  assert.equal(result.value.promptText, 'Why have you chosen nurse anaesthesia?')
  assert.equal(result.value.statedMaxWords, 500)
})

test('write: ONE conditional UPDATE, whatever the prompt state', async () => {
  for (const prompt of [undefined, null, SNAPSHOT] as const) {
    const { log } = await setPayload(prompt)
    assert.equal(calls(log, 'update').length, 1, 'exactly one update')
    assert.equal(froms(log), 1, 'exactly one statement')
    assert.equal(calls(log, 'insert').length, 0)
    assert.equal(calls(log, 'upsert').length, 0)
    assert.equal(calls(log, 'delete').length, 0)
    assert.equal(calls(log, 'rpc').length, 0, 'no RPC')
    // The predicate is unchanged: id AND the expected revision.
    assert.deepEqual(calls(log, 'eq'), [['eq', 'id', ID], ['eq', 'revision', 4]])
  }
})

test('write: a snapshot change consumes EXACTLY ONE revision', async () => {
  const { payload } = await setPayload(SNAPSHOT)
  assert.equal(payload.revision, 5, 'expectedRevision + 1, not + 2')
})

test('write: a CLEAR consumes exactly one revision', async () => {
  const { payload } = await setPayload(null)
  assert.equal(payload.revision, 5)
})

test('write: the repository still owns updated_at, with or without a prompt', async () => {
  const before = Date.now()
  for (const prompt of [undefined, null, SNAPSHOT] as const) {
    const { payload } = await setPayload(prompt)
    const written = payload.updated_at as string
    assert.match(written, ISO)
    const at = Date.parse(written)
    assert.ok(at >= before && at <= Date.now(), 'generated during the call')
  }
  // And no caller can supply one: updateDraft takes no timestamp parameter.
  assert.equal(updateDraft.length <= 4, true)
})

test('write: a STALE revision with a prompt change writes NOTHING and conflicts', async () => {
  // Zero rows matched, then the existing single follow-up read.
  const { db, log } = fakeDb([ok(null), ok(withPrompt({ revision: 9 }))])
  const result = await updateDraft(db, ID, doc, SNAPSHOT)

  // The statement was issued and matched nothing, so no column moved -- the
  // prompt change is lost with the rest of the save, which is correct.
  assert.equal(calls(log, 'update').length, 1)
  assert.equal(froms(log), 2, 'the update plus exactly one follow-up read')
  assert.deepEqual(calls(log, 'eq').slice(0, 2), [['eq', 'id', ID], ['eq', 'revision', 4]])

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'conflict')
  assert.equal(result.storedRevision, 9)
  // The winner's prompt is not disclosed to the loser.
  assert.equal(JSON.stringify(result).includes('anaesthesia'), false)
  assert.equal(JSON.stringify(result).includes(PROMPT), false)
})

test('write: a missing row with a prompt change is not-found, not a conflict', async () => {
  const { db, log } = fakeDb([ok(null), ok(null)])
  const result = await updateDraft(db, ID, doc, SNAPSHOT)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'not-found')
  assert.equal(froms(log), 2)
})

test('write: a failed follow-up read with a prompt change is NOT a conflict', async () => {
  const { db } = fakeDb([ok(null), boom])
  const result = await updateDraft(db, ID, doc, SNAPSHOT)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'read-failed')
  assert.notEqual(result.reason, 'conflict')
})

test('write: createDraft is UNCHANGED -- three columns, no prompt metadata', async () => {
  const { db, log } = fakeDb([ok(row())])
  await createDraft(db, USER, { title: 'Draft one', essay: 'Opening line.' })

  const payload = calls(log, 'insert')[0][1] as Record<string, unknown>
  assert.deepEqual(payload, { user_id: USER, title: 'Draft one', essay: 'Opening line.' })
  for (const forbidden of [...PROMPT_KEYS, 'revision', 'id', 'created_at', 'updated_at']) {
    assert.equal(forbidden in payload, false, `insert must not carry ${forbidden}`)
  }
  // createDraft takes no prompt parameter at all: a draft is born generic.
  assert.equal(createDraft.length, 3)
})

test('write: THIS MODULE NEVER RESOLVES A PROMPT', async () => {
  // Read the SOURCE with commentary removed: the comments discuss
  // statement_prompts and readActivePrompt deliberately, and a naive substring
  // check would match the prose rather than the code.
  const raw = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('./draftRepo.ts', import.meta.url), 'utf8'))
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')

  // Guard: the stripping removed commentary and nothing else.
  assert.equal(code.includes('export async function updateDraft'), true, 'code survived')
  assert.equal(code.includes('THE PROMPT TRAVELS IN THE SAME STATEMENT'), false, 'prose removed')

  assert.equal(code.includes('statement_prompts'), false, 'no query against the catalog')
  assert.equal(code.includes('readActivePrompt'), false, 'the resolver is never called')
  assert.equal(code.includes('promptSnapshotFromRow'), false)
  assert.equal(code.includes('checkPromptSelection'), false)
  assert.equal(code.includes('promptSelectionOf'), false)
  // The only table this module names, and it names it once.
  assert.equal(code.includes("const DRAFTS = 'statement_drafts'"), true)
  assert.equal((code.match(/\.from\(/g) ?? []).length, 6, 'one from() per statement')
  // The snapshot's TYPE is imported; no value from that module is. Every
  // reference to it sits on an `import type` line, so the runtime erases it and
  // nothing in promptRepo.ts is loaded, let alone called.
  const promptRepoLines = code.split('\n').filter((line) => line.includes("'./promptRepo.ts'"))
  assert.equal(promptRepoLines.length, 1, 'exactly one reference to that module')
  assert.match(promptRepoLines[0], /^import type \{ StatementPromptSnapshot \} from/)
})

// ===================================================================== get

test('get: a row is returned normalised, scoped by id, and nothing is written', async () => {
  const { db, log } = fakeDb([ok(row({ revision: '9' }))])
  const result = await readDraft(db, ID)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.revision, 9)
  assert.equal(result.value.id, ID)

  assert.deepEqual(calls(log, 'eq'), [['eq', 'id', ID]])
  assert.equal(froms(log), 1)
  assert.ok(wroteNothing(log), 'a read must issue no insert, update or delete')
})

test('get: a missing or RLS-hidden row is not-found -- the two are indistinguishable', async () => {
  const { db, log } = fakeDb([ok(null)])
  const result = await readDraft(db, ID)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'not-found')
  assert.ok(wroteNothing(log))
})

test('get: a database error stays a read failure, never not-found', async () => {
  const { db } = fakeDb([boom])
  const result = await readDraft(db, ID)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'read-failed')
  assert.equal(result.detail, '08006 connection failure')
})

test('get: a malformed row is a data-integrity failure, not not-found', async () => {
  const { db } = fakeDb([ok(row({ revision: 'abc' }))])
  const result = await readDraft(db, ID)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'data-integrity')
})

// ==================================================================== list

test('list: filters by user_id, orders by updated_at descending, writes nothing', async () => {
  const { db, log } = fakeDb([ok([summaryRow(), summaryRow({ id: 'other' })])])
  const result = await listDrafts(db, USER)
  assert.equal(result.ok, true)

  assert.deepEqual(calls(log, 'eq'), [['eq', 'user_id', USER]])
  assert.deepEqual(calls(log, 'order'), [['order', 'updated_at', { ascending: false }]])
  assert.equal(froms(log), 1)
  assert.ok(wroteNothing(log))
})

test('list: the PROJECTION does not request essay', async () => {
  // The library screen shows titles. Pulling up to 20,000 characters per draft,
  // for an unlimited number of drafts, would be unbounded work for nothing.
  const { db, log } = fakeDb([ok([summaryRow()])])
  await listDrafts(db, USER)

  const selected = calls(log, 'select')[0][1] as string
  assert.equal(selected.includes('essay'), false, `select must not name essay: ${selected}`)
  assert.equal(selected, 'id, title, revision, created_at, updated_at')
  // user_id is a WHERE clause, not a column anything downstream reads.
  assert.equal(selected.includes('user_id'), false)
})

test('list: returned entries contain no essay, and only the five summary fields', async () => {
  const { db } = fakeDb([ok([summaryRow(), summaryRow({ id: 'b' })])])
  const result = await listDrafts(db, USER)
  assert.equal(result.ok, true)
  if (!result.ok) return

  for (const entry of result.value) {
    assert.equal('essay' in entry, false, 'a summary must not carry an essay')
    assert.equal('userId' in entry, false)
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['createdAt', 'id', 'revision', 'title', 'updatedAt'],
    )
  }
})

test('list: an essay in the row is dropped, never passed through', async () => {
  // Belt and braces: even if a wider row arrived, the summary normaliser builds
  // its own object rather than spreading what it was given.
  const withEssay = { ...summaryRow(), essay: 'the applicant essay' } as never
  const { db } = fakeDb([ok([withEssay])])
  const result = await listDrafts(db, USER)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal('essay' in result.value[0], false)
  assert.equal(JSON.stringify(result.value).includes('applicant'), false)
})

test('list: every revision is normalised, including string bigints', async () => {
  const { db } = fakeDb([ok([
    summaryRow({ revision: '3' }), summaryRow({ revision: 12 }), summaryRow({ revision: '900' }),
  ])])
  const result = await listDrafts(db, USER)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.map((d) => d.revision), [3, 12, 900])
  for (const entry of result.value) assert.equal(typeof entry.revision, 'number')
})

test('list: ONE malformed revision fails the whole list rather than being coerced', async () => {
  // Returning the others would look like the applicant lost one, and coercing to
  // 1 would hand the client a revision nobody ever wrote.
  for (const revision of [null, 0, 'abc', '1.5', '']) {
    const { db } = fakeDb([ok([summaryRow(), summaryRow({ revision }), summaryRow()])])
    const result = await listDrafts(db, USER)
    assert.equal(result.ok, false, String(revision))
    if (result.ok) continue
    assert.equal(result.reason, 'data-integrity')
  }
})

test('list: an empty result is an empty list, not not-found', async () => {
  const { db } = fakeDb([ok([])])
  const result = await listDrafts(db, USER)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value, [])
})

test('list: a null payload is an empty list', async () => {
  const { db } = fakeDb([ok(null)])
  const result = await listDrafts(db, USER)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value, [])
})

test('list: a database error stays a list failure', async () => {
  const { db } = fakeDb([boom])
  const result = await listDrafts(db, USER)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'list-failed')
})

// ======================================================= CAS update success

test('CAS: the update is conditional on id AND revision, and bumps by exactly one', async () => {
  const { db, log } = fakeDb([ok(row({ revision: '5', updated_at: STORED_AT }))])
  const result = await updateDraft(
    db, ID,
    { title: 'Draft two', essay: 'Revised body.', expectedRevision: 4 },
  )

  // The condition.
  assert.deepEqual(calls(log, 'eq'), [
    ['eq', 'id', ID],
    ['eq', 'revision', 4],
  ])

  // The payload. updated_at is GENERATED by the repository, so it is asserted by
  // shape rather than by value -- there is no way to predetermine it.
  const payload = calls(log, 'update')[0][1] as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), ['essay', 'revision', 'title', 'updated_at'])
  assert.equal(payload.title, 'Draft two')
  assert.equal(payload.essay, 'Revised body.')
  assert.equal(payload.revision, 5)
  assert.match(payload.updated_at as string, ISO)

  // The returned row, with its string bigint normalised.
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.revision, 5)
  assert.equal(typeof result.value.revision, 'number')
  assert.equal(result.value.updatedAt, STORED_AT)

  // NO FOLLOW-UP READ on success: exactly one statement was issued.
  assert.equal(froms(log), 1)
})

test('CAS: the payload never carries id, user_id or created_at', async () => {
  const { db, log } = fakeDb([ok(row({ revision: 2 }))])
  await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 1 })
  const payload = calls(log, 'update')[0][1] as Record<string, unknown>
  for (const forbidden of ['id', 'user_id', 'created_at']) {
    assert.equal(forbidden in payload, false, `update must not carry ${forbidden}`)
  }
  assert.deepEqual(Object.keys(payload).sort(), ['essay', 'revision', 'title', 'updated_at'])
})

test('CAS: updated_at is generated DURING the call and is a valid ISO instant', async () => {
  // No literal is asserted, because no caller can choose one. What is asserted
  // is that the value was produced inside this attempt.
  const before = new Date().toISOString()
  const { db, log } = fakeDb([ok(row({ revision: 2 }))])
  await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 1 })
  const after = new Date().toISOString()

  const sent = (calls(log, 'update')[0][1] as Record<string, unknown>).updated_at as string
  assert.equal(typeof sent, 'string')
  assert.match(sent, ISO)
  assert.equal(new Date(sent).toISOString(), sent, 'round-trips as a real instant')
  assert.ok(sent >= before && sent <= after, `${sent} should fall between ${before} and ${after}`)
})

test('CAS: exactly ONE timestamp value is used in the attempt', async () => {
  const { db, log } = fakeDb([ok(row({ revision: 2 }))])
  await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 1 })

  const updates = calls(log, 'update')
  assert.equal(updates.length, 1, 'one update statement, therefore one timestamp')
  // And that one value appears exactly once ANYWHERE in the call log, so no
  // second statement reused or recomputed it. Counted over the serialised log
  // because the timestamp lives inside the payload object, not as a top-level
  // argument -- log.flat() does not reach into it, which an earlier version of
  // this assertion got wrong.
  const sent = (updates[0][1] as Record<string, unknown>).updated_at as string
  const mentions = JSON.stringify(log).split(sent).length - 1
  assert.equal(mentions, 1, `the generated timestamp appears once, not ${mentions} times`)
})

test('CAS: no caller can supply the persisted timestamp', async () => {
  // A timestamp smuggled through DraftUpdateInput is not read -- the payload
  // carries the generated value, not the caller's.
  //
  // THE FOURTH ARGUMENT NOW MEANS SOMETHING: it is the resolved prompt. It is
  // still not a timestamp, and a value that is neither a snapshot nor null
  // writes no prompt column at all -- not four `undefined` ones, which
  // JSON.stringify would drop and make "write nothing" an accident instead of a
  // decision. isSnapshot() in draftRepo.ts is the guard.
  const hostile = {
    title: 't', essay: 'e', expectedRevision: 1,
    updated_at: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
    savedAt: '2099-01-01T00:00:00.000Z',
  }
  const { db, log } = fakeDb([ok(row({ revision: 2 }))])
  await updateDraft(db, ID, hostile)

  const payload = calls(log, 'update')[0][1] as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), ['essay', 'revision', 'title', 'updated_at'])
  assert.equal((payload.updated_at as string).startsWith('2099'), false,
    'a supplied timestamp must never reach the row')
  assert.match(payload.updated_at as string, ISO)
  assert.equal(JSON.stringify(payload).includes('2099'), false)

  // AND A TIMESTAMP PASSED AS THE FOURTH ARGUMENT REACHES NOTHING AT ALL. It is
  // not a prompt, so the call refuses before a statement exists -- which is a
  // stronger guarantee than the old "a fourth argument is not read": there is
  // no row to reach, because no row was touched.
  const { db: db2, log: log2 } = fakeDb([ok(row({ revision: 2 }))])
  const refused = await (updateDraft as unknown as (
    db: SupabaseClient, id: string, input: unknown, extra?: unknown,
  ) => Promise<{ ok: boolean; reason?: string }>)(
    db2, ID, hostile, '2099-01-01T00:00:00.000Z',
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'data-integrity')
  assert.equal(froms(log2), 0, 'no statement was issued')
  assert.equal(JSON.stringify(log2).includes('2099'), false)
})

/** Every runtime value that is NOT one of the three valid states. */
const BOGUS: readonly unknown[] = [
  'a string', '', 42, 0, true, false, [], [SNAPSHOT], NaN,
  {},                                                          // nothing at all
  { schoolId: SCHOOL },                                        // partial
  { schoolId: SCHOOL, promptId: PROMPT },                      // still partial
  { schoolId: SCHOOL, promptId: PROMPT, promptText: 'q' },     // no word limit key
  { schoolId: SCHOOL, promptId: PROMPT, promptText: 'q', statedMaxWords: '500' },
  { schoolId: 1, promptId: 2, promptText: 3, statedMaxWords: 4 },
  { school_id: SCHOOL, prompt_id: PROMPT, prompt_text: 'q', stated_max_words: 1 },
  { ...SNAPSHOT, promptText: null },                           // wording cannot be null
  { ...SNAPSHOT, statedMaxWords: undefined },                  // absent is not null
]

test('write: a MALFORMED fourth argument is a data-integrity refusal', async () => {
  // There is no fourth state. A value the types should have stopped is an
  // internal error, NOT something to absorb as "unchanged" -- a silent no-op
  // would look exactly like a successful save.
  for (const bogus of BOGUS) {
    const { db } = fakeDb([ok(row({ revision: 5 }))])
    const result = await updateDraft(db, ID, doc, bogus as never)

    assert.equal(result.ok, false, JSON.stringify(bogus))
    if (result.ok) return
    // The EXISTING reason, so the refusal union and the status table are
    // untouched and every caller already handles it.
    assert.equal(result.reason, 'data-integrity', JSON.stringify(bogus))
    assert.equal(result.detail, 'unusable argument (prompt)')
    // Never an echo of the value.
    assert.equal(result.detail.includes(SCHOOL), false)
    assert.equal(result.detail.includes(PROMPT), false)
    assert.equal('storedRevision' in result, false)
  }
})

test('write: a malformed fourth argument executes ZERO database statements', async () => {
  for (const bogus of BOGUS) {
    const { db, log } = fakeDb([ok(row({ revision: 5 }))])
    await updateDraft(db, ID, doc, bogus as never)

    assert.equal(froms(log), 0, `a statement was issued for ${JSON.stringify(bogus)}`)
    assert.equal(log.length, 0, 'the client was not touched at all')
    assert.ok(wroteNothing(log))
    assert.equal(calls(log, 'select').length, 0, 'not even a read')
  }
})

test('write: a malformed fourth argument consumes no revision and moves no clock', async () => {
  // No statement means no compare-and-swap, so the stored revision cannot have
  // advanced -- and updated_at, the 400-day retention clock, cannot have moved.
  const { db, log } = fakeDb([ok(row({ revision: 5 }))])
  const result = await updateDraft(db, ID, doc, 'not a snapshot' as never)

  assert.equal(result.ok, false)
  assert.equal(calls(log, 'update').length, 0, 'no UPDATE, so no revision bump')
  assert.equal(JSON.stringify(log).includes('revision'), false)
  assert.equal(JSON.stringify(log).includes('updated_at'), false)
  // And the queued reply was never consumed, which is what proves nothing ran.
  const { db: db2, log: log2 } = fakeDb([ok(row({ revision: 5 }))])
  await updateDraft(db2, ID, doc, undefined)
  assert.equal(froms(log2), 1, 'the same fixture DOES issue a statement when valid')
})

test('write: THE THREE VALID STATES still behave exactly as before', async () => {
  // The correction must not have moved the contract itself.
  const omitted = (await setPayload(undefined)).payload
  assert.deepEqual(Object.keys(omitted).sort(), DOCUMENT_KEYS)

  const cleared = (await setPayload(null)).payload
  assert.deepEqual(Object.keys(cleared).sort(), [...DOCUMENT_KEYS, ...PROMPT_KEYS].sort())
  for (const column of PROMPT_KEYS) assert.equal(cleared[column], null)

  const selected = (await setPayload(SNAPSHOT)).payload
  assert.deepEqual(Object.keys(selected).sort(), [...DOCUMENT_KEYS, ...PROMPT_KEYS].sort())
  assert.equal(selected.school_id, SCHOOL)
  assert.equal(selected.prompt_id, PROMPT)
  assert.equal(selected.prompt_text, 'Why have you chosen nurse anaesthesia?')
  assert.equal(selected.stated_max_words, 500)

  // A snapshot with no stated limit is VALID, not malformed.
  const noLimit = (await setPayload({ ...SNAPSHOT, statedMaxWords: null })).payload
  assert.equal('stated_max_words' in noLimit, true)
  assert.equal(noLimit.stated_max_words, null)
})

// ------------------------------------------- the increment safety invariant

test('CAS: the largest VALID expected revision still writes a safe revision', async () => {
  // MAX_EXPECTED_REVISION + 1 is exactly MAX_SAFE_INTEGER, so the value this
  // layer writes is the last one parseStoredRevision() will read back. That is
  // the whole point of the validator's ceiling sitting one below the parser's.
  const { db, log } = fakeDb([ok(row({ revision: String(Number.MAX_SAFE_INTEGER) }))])
  const result = await updateDraft(
    db, ID, { title: 't', essay: 'e', expectedRevision: MAX_EXPECTED_REVISION },
  )

  const written = (calls(log, 'update')[0][1] as Record<string, unknown>).revision as number
  assert.equal(written, Number.MAX_SAFE_INTEGER)
  assert.ok(Number.isSafeInteger(written), 'the repository must never write an unsafe revision')

  // And the row it produces reads back cleanly rather than as data-integrity.
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.revision, Number.MAX_SAFE_INTEGER)
})

test('CAS: an un-incrementable expected revision is rejected with NO database call', async () => {
  // The validator refuses it, so the route never reaches the repository. Nothing
  // is written that could not then be read back -- the failure mode this
  // invariant exists to prevent is a landed write plus a data-integrity error.
  //
  // No reply is queued: any statement at all would draw the fake client's
  // TEST_NO_REPLY and show up in the log.
  const { db, log } = fakeDb([])

  const checked = checkDraftUpdate({
    title: 't', essay: 'e', expectedRevision: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(checked.ok, false)
  if (checked.ok) return
  assert.equal(checked.code, 'invalid-revision')

  // The repository is simply not called, which is the assertion.
  assert.equal(log.length, 0, 'no statement of any kind was issued')
  assert.equal(froms(log), 0)
  void db
})

// ====================================================== CAS conflict

test('CAS: zero rows plus a visible row is a conflict carrying the stored revision', async () => {
  const { db, log } = fakeDb([
    ok(null),                       // the conditional update matched nothing
    ok(row({ revision: 5 })),       // the follow-up read finds the row at 5
  ])
  const result = await updateDraft(
    db, ID, { title: 'Draft two', essay: 'Revised.', expectedRevision: 4 },
  )

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'conflict')
  assert.equal(result.storedRevision, 5)

  // NO AUTOMATIC OVERWRITE, NO SECOND UPDATE, NO RETRY: exactly one update was
  // issued, and the second statement was the read.
  assert.equal(calls(log, 'update').length, 1)
  assert.equal(froms(log), 2)
  assert.deepEqual(calls(log, 'from'), [['from', 'statement_drafts'], ['from', 'statement_drafts']])
})

test('CAS: a stale attempt performs no write at all, so updated_at does not move', async () => {
  // The condition failed, so the UPDATE touched no row. That matters beyond
  // concurrency: updated_at is the retention clock, and a refused save must not
  // look like activity.
  const { db, log } = fakeDb([ok(null), ok(row({ revision: 9 }))])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 4 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'conflict')

  // One conditional UPDATE was issued and matched nothing; nothing else wrote.
  assert.equal(calls(log, 'update').length, 1)
  assert.equal(calls(log, 'insert').length, 0)
  assert.equal(calls(log, 'delete').length, 0)
  // And the follow-up statement is a read, not a second write.
  assert.ok(calls(log, 'select').length >= 1)
})

test('CAS: a string bigint in the conflict read normalises', async () => {
  const { db } = fakeDb([ok(null), ok(row({ revision: '5' }))])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 4 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'conflict')
  assert.equal(result.storedRevision, 5)
  assert.equal(typeof result.storedRevision, 'number')
})

// ===================================================== CAS not-found

test('CAS: zero rows plus no visible row is not-found', async () => {
  const { db, log } = fakeDb([ok(null), ok(null)])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 4 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'not-found')
  assert.equal('storedRevision' in result, false)
  assert.equal(froms(log), 2)
})

test('CAS: another user’s row is not-found, never conflict -- RLS hides it', async () => {
  // The follow-up read sees nothing, exactly as it would for a deleted draft.
  const { db } = fakeDb([ok(null), ok(null)])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 1 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'not-found')
})

// ================================================ CAS database errors

test('CAS: an update database error stays an update failure, never a conflict', async () => {
  const { db, log } = fakeDb([boom])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 4 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'update-failed')
  assert.equal(result.detail, '08006 connection failure')
  assert.equal('storedRevision' in result, false)
  // No follow-up read: a failed statement says nothing about the revision.
  assert.equal(froms(log), 1)
})

test('CAS: a follow-up-read error stays a read failure, never a conflict', async () => {
  // Reporting a conflict here would tell the applicant their work is stale on
  // the evidence of a dropped connection.
  const { db, log } = fakeDb([ok(null), boom])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 4 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'read-failed')
  assert.equal('storedRevision' in result, false)
  assert.equal(froms(log), 2)
  assert.equal(calls(log, 'update').length, 1, 'still no retry')
})

test('CAS: a malformed stored revision is NOT interpreted as conflict-at-1', async () => {
  // Without this the client would resync onto a revision nobody ever wrote.
  for (const revision of [null, 0, 'abc', '1.5', '']) {
    const { db } = fakeDb([ok(null), ok(row({ revision }))])
    const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 4 })
    assert.equal(result.ok, false, String(revision))
    if (result.ok) continue
    assert.equal(result.reason, 'data-integrity', String(revision))
    assert.equal('storedRevision' in result, false)
    assert.notEqual((result as { storedRevision?: number }).storedRevision, 1)
  }
})

test('CAS: a malformed row on the SUCCESS path is a data-integrity failure', async () => {
  const { db } = fakeDb([ok(row({ revision: 'abc' }))])
  const result = await updateDraft(db, ID, { title: 't', essay: 'e', expectedRevision: 4 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'data-integrity')
})

// ================================================================== delete

test('delete: targets the right id, succeeds, and writes no timestamp', async () => {
  const { db, log } = fakeDb([ok({ id: ID })])
  const result = await deleteDraft(db, ID)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value, { id: ID })

  assert.deepEqual(calls(log, 'eq'), [['eq', 'id', ID]])
  assert.equal(calls(log, 'delete').length, 1)
  assert.equal(calls(log, 'update').length, 0, 'a delete must not touch updated_at')
  assert.equal(froms(log), 1)
})

test('delete: a missing or RLS-hidden row is not-found', async () => {
  const { db } = fakeDb([ok(null)])
  const result = await deleteDraft(db, ID)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'not-found')
})

test('delete: a database error stays a delete failure', async () => {
  const { db } = fakeDb([boom])
  const result = await deleteDraft(db, ID)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'delete-failed')
})

test('delete: a returned row without a usable id is a data-integrity failure', async () => {
  const { db } = fakeDb([ok({ id: 42 })])
  const result = await deleteDraft(db, ID)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'data-integrity')
})

// ============================================ every read path writes nothing

test('no read-only operation issues a write of any kind', async () => {
  for (const [name, run] of [
    ['get', (db: SupabaseClient) => readDraft(db, ID)],
    ['list', (db: SupabaseClient) => listDrafts(db, USER)],
  ] as const) {
    const { db, log } = fakeDb([ok(name === 'list' ? [summaryRow()] : row())])
    await run(db)
    assert.ok(wroteNothing(log), `${name} must issue no insert, update, upsert or delete`)

    // AND no WRITE PAYLOAD carries updated_at. Checked on the payloads of
    // mutating calls only, not on every argument: `list` legitimately names the
    // column in `.order('updated_at', ...)`, which is an ORDER BY -- a read, and
    // the whole reason statement_drafts_user_updated_idx exists. An earlier
    // version of this assertion failed on exactly that, which is the difference
    // between mentioning a column and writing it.
    for (const write of [...calls(log, 'update'), ...calls(log, 'insert'), ...calls(log, 'upsert')]) {
      const payload = (write[1] ?? {}) as Record<string, unknown>
      assert.equal('updated_at' in payload, false, `${name} must not send updated_at`)
    }
  }
})
