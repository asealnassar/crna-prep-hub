import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createDraft, deleteDraft, listDrafts, readDraft, updateDraft,
} from './draftRepo.ts'
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

const row = (over: Partial<StatementDraftRow> = {}): StatementDraftRow => ({
  id: ID,
  user_id: USER,
  title: 'Draft one',
  essay: 'Opening line.',
  revision: 1,
  created_at: '2026-09-28T12:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
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
  // The signature takes three arguments. A fourth is not read, and a timestamp
  // smuggled through DraftUpdateInput is not read either -- the payload carries
  // the generated value, not the attacker's.
  const hostile = {
    title: 't', essay: 'e', expectedRevision: 1,
    updated_at: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
    savedAt: '2099-01-01T00:00:00.000Z',
  }
  const { db, log } = fakeDb([ok(row({ revision: 2 }))])
  await (updateDraft as unknown as (
    db: SupabaseClient, id: string, input: unknown, extra?: unknown,
  ) => Promise<unknown>)(db, ID, hostile, '2099-01-01T00:00:00.000Z')

  const payload = calls(log, 'update')[0][1] as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), ['essay', 'revision', 'title', 'updated_at'])
  assert.equal((payload.updated_at as string).startsWith('2099'), false,
    'a supplied timestamp must never reach the row')
  assert.match(payload.updated_at as string, ISO)
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
