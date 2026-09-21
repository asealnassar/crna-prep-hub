import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyTurn, createInitialState } from './state.ts'
import {
  buildSessionRow,
  createSessionSaver,
  isMissingColumnError,
  supabaseSessionWriter,
  type RowId,
  type SaveStatus,
  type SchemaSupport,
  type SessionMeta,
  type SessionRow,
  type SessionSnapshot,
  type SessionWriter,
  type WriteError,
} from './sessionSaver.ts'
import type { ChatMessage, InterviewState, ModelTurn, TurnAction } from './types.ts'

/**
 * Interview progress must keep saving.
 *
 * Root cause, from the page's previous save routine: a module-level flag,
 * `extendedColumnsAvailable`, was set false the first time ANY write that
 * included the engine columns returned an error. The code assumed the only
 * possible error was "the migration has not run". But the Supabase client does
 * not throw on a network failure -- it returns `{ error }` -- and an expired
 * session, a 5xx or a timeout do the same. One such blip permanently switched
 * every later save in that browser tab, for this interview AND every later
 * interview until a full reload, to the base columns. The transcript kept
 * saving; engine_state, mode, overall_score and readiness froze where they
 * were, or were never written at all.
 *
 * That is exactly the production pattern: about 6% of sessions (19 of 316)
 * whose saved engine_state stopped at an earlier question while the stored
 * transcript went on, plus sessions with no engine_state whatsoever.
 *
 * The legacy routine is reproduced below, line for line in logic, against a
 * fake table with PostgREST PATCH semantics (columns not sent are left as
 * they were), so the failure is demonstrated rather than asserted.
 */

const PAGE = readFileSync(new URL('../../app/interview/page.tsx', import.meta.url), 'utf8')
const NETWORK: WriteError = { code: '', message: 'TypeError: Failed to fetch', status: 0 }
const JWT_EXPIRED: WriteError = { code: 'PGRST301', message: 'JWT expired', status: 401 }
const MISSING_COLUMN: WriteError = {
  code: 'PGRST204',
  message: "Could not find the 'engine_state' column of 'interview_sessions' in the schema cache",
}

const meta: SessionMeta = { userId: 'user-1', interviewType: 'clinical', customTopic: '', mode: 'practice' }

const turn = (action: TurnAction, over: Partial<ModelTurn> = {}): ModelTurn => ({
  action,
  display_text: 'text',
  question_asked: 'q',
  scenario_label: 'label',
  category: 'clinical',
  question_format: 'scenario',
  concepts_tested: [],
  difficulty_level: 2,
  evaluation: null,
  final_report: null,
  internal_note: '',
  ...over,
})

/** The snapshots a page saves as an interview advances: one per main question. */
function snapshots(n: number, opening = 'Welcome. Q1'): SessionSnapshot[] {
  let state: InterviewState = applyTurn(
    createInitialState({ mode: 'practice', type: 'clinical', followUpsEnabled: true }),
    turn('next_primary', { question_asked: 'Q1' })
  )
  let conversation: ChatMessage[] = [{ role: 'assistant', content: opening }]
  const out: SessionSnapshot[] = [{ conversation, state }]
  for (let i = 1; i < n; i++) {
    state = applyTurn(state, turn('next_primary', { question_asked: `Q${i + 1}` }))
    conversation = [...conversation, { role: 'user', content: `a${i}` }, { role: 'assistant', content: `Q${i + 1}` }]
    out.push({ conversation, state })
  }
  return out
}

type StoredRow = SessionRow & { id: number; created_at: string }

/** interview_sessions, in memory, with scripted faults. */
class FakeTable implements SessionWriter {
  rows = new Map<number, StoredRow>()
  calls: string[] = []
  hasEngineColumns = true
  private nextId = 1
  private faults: { op: 'insert' | 'update' | 'find'; error: WriteError; commit?: boolean; throws?: boolean }[] = []

  failNext(op: 'insert' | 'update' | 'find', error: WriteError, opts: { commit?: boolean; throws?: boolean; times?: number } = {}) {
    for (let i = 0; i < (opts.times ?? 1); i++) this.faults.push({ op, error, commit: opts.commit, throws: opts.throws })
  }

  private take(op: 'insert' | 'update' | 'find') {
    const i = this.faults.findIndex((f) => f.op === op)
    return i >= 0 ? this.faults.splice(i, 1)[0] : null
  }

  private missingColumn(row: SessionRow): WriteError | null {
    return !this.hasEngineColumns && ('engine_state' in row || 'mode' in row) ? MISSING_COLUMN : null
  }

  async insert(row: SessionRow) {
    this.calls.push('insert')
    const missing = this.missingColumn(row)
    if (missing) return { id: null, error: missing }
    const fault = this.take('insert')
    if (fault?.throws) throw new Error(fault.error.message ?? 'thrown')
    if (fault && !fault.commit) return { id: null, error: fault.error }
    const id = this.nextId++
    this.rows.set(id, { ...structuredClone(row), id, created_at: new Date().toISOString() })
    // commit: the row was written but the response was lost on the way back.
    return fault ? { id: null, error: fault.error } : { id, error: null }
  }

  async update(id: RowId, row: SessionRow) {
    this.calls.push('update')
    const missing = this.missingColumn(row)
    if (missing) return { error: missing }
    const fault = this.take('update')
    if (fault?.throws) throw new Error(fault.error.message ?? 'thrown')
    if (fault) return { error: fault.error }
    const existing = this.rows.get(id as number)
    if (!existing) return { error: { code: 'NO_ROW', message: 'not found' } }
    // PostgREST PATCH: only the columns sent change.
    this.rows.set(id as number, { ...existing, ...structuredClone(row) })
    return { error: null }
  }

  async findExisting({ firstMessage, since }: { firstMessage: string; since: string }) {
    this.calls.push('find')
    const fault = this.take('find')
    if (fault) return { id: null, error: fault.error }
    for (const [id, row] of this.rows) {
      if (row.conversation[0]?.content === firstMessage && row.created_at >= since) return { id, error: null }
    }
    return { id: null, error: null }
  }

  only(): StoredRow {
    assert.equal(this.rows.size, 1, 'exactly one row for the interview')
    return [...this.rows.values()][0]
  }
}

const noWait = { retryDelaysMs: [0, 0], sleep: async () => {} }
const freshSchema = (): SchemaSupport => ({ extendedColumns: true })

function saver(table: SessionWriter, opts: { schema?: SchemaSupport; onStatus?: (s: SaveStatus) => void } = {}) {
  return createSessionSaver({ writer: table, meta, startedAt: new Date(), ...noWait, schema: opts.schema ?? freshSchema(), onStatus: opts.onStatus })
}

/** The page's save routine before this fix, reproduced in logic. */
function legacySaver(table: SessionWriter) {
  let extendedColumnsAvailable = true // module-level in the page: shared by every interview in the tab
  return async (snapshot: SessionSnapshot, sessionRowId: RowId | null): Promise<RowId | null> => {
    const base = buildSessionRow(meta, snapshot, false)
    const extended = buildSessionRow(meta, snapshot, true)
    const write = async (payload: SessionRow) =>
      sessionRowId ? { ...(await table.update(sessionRowId, payload)), id: sessionRowId } : table.insert(payload)
    let result = extendedColumnsAvailable ? await write(extended) : await write(base)
    if (result.error && extendedColumnsAvailable) {
      // "The engine columns haven't been migrated in yet — fall back permanently."
      extendedColumnsAvailable = false
      result = await write(base)
    }
    return sessionRowId ?? (result as any).id ?? null
  }
}

// ==========================================================================
// The exact failure, reproduced
// ==========================================================================

test('REGRESSION: one transient failure froze engine_state for the rest of the interview (old save path)', async () => {
  const snaps = snapshots(5)
  const table = new FakeTable()
  const legacy = legacySaver(table)
  let rowId = await legacy(snaps[0], null)
  table.failNext('update', NETWORK)
  for (const snap of snaps.slice(1)) rowId = await legacy(snap, rowId)

  const row = table.only()
  assert.equal(row.conversation.length, snaps[4].conversation.length, 'the transcript kept saving')
  assert.equal(row.question_count, 5)
  assert.equal(row.engine_state!.primaryQuestionNumber, 1, 'but engine_state froze at question 1 -- the production pattern')
})

test('FIX: the same transient failure is retried and the latest state is saved', async () => {
  const snaps = snapshots(5)
  const table = new FakeTable()
  const schema = freshSchema()
  const s = saver(table, { schema })
  await s.save(snaps[0])
  table.failNext('update', NETWORK)
  for (const snap of snaps.slice(1)) assert.equal((await s.save(snap)).ok, true)

  const row = table.only()
  assert.equal(row.engine_state!.primaryQuestionNumber, 5, 'engine_state is current')
  assert.deepEqual(row.conversation, snaps[4].conversation)
  assert.equal(row.mode, 'practice')
  assert.equal(schema.extendedColumns, true, 'a network blip is not a schema fact')
  assert.equal(s.status, 'saved')
})

test('REGRESSION: a failure on the first save left this interview AND later ones in the tab without engine_state', async () => {
  const table = new FakeTable()
  const legacy = legacySaver(table)
  table.failNext('insert', NETWORK)
  await legacy(snapshots(1)[0], null)
  await legacy(snapshots(1, 'Welcome back. A second interview. Q1')[0], null)
  const rows = [...table.rows.values()]
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => !('engine_state' in r)), 'neither interview ever saved its engine state')
})

test('FIX: a failed first save is retried with the engine columns, and later interviews are unaffected', async () => {
  const table = new FakeTable()
  const schema = freshSchema()
  table.failNext('insert', NETWORK)
  const first = saver(table, { schema })
  assert.equal((await first.save(snapshots(1)[0])).ok, true)
  const second = saver(table, { schema })
  assert.equal((await second.save(snapshots(1, 'Another interview. Q1')[0])).ok, true)
  const rows = [...table.rows.values()]
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.engine_state && r.engine_state.primaryQuestionNumber === 1))
})

test('an expired session (401) is retried, never mistaken for a missing column', async () => {
  const table = new FakeTable()
  const schema = freshSchema()
  const s = saver(table, { schema })
  const snaps = snapshots(3)
  await s.save(snaps[0])
  table.failNext('update', JWT_EXPIRED)
  await s.save(snaps[1])
  await s.save(snaps[2])
  assert.equal(table.only().engine_state!.primaryQuestionNumber, 3)
  assert.equal(schema.extendedColumns, true)
})

// ==========================================================================
// Compatibility: a database without the engine columns still works
// ==========================================================================

test('only a genuine missing-column error falls back to the base columns', async () => {
  const table = new FakeTable()
  table.hasEngineColumns = false
  const schema = freshSchema()
  const s = saver(table, { schema })
  const snaps = snapshots(2)
  assert.equal((await s.save(snaps[0])).ok, true)
  assert.equal((await s.save(snaps[1])).ok, true)
  const row = table.only()
  assert.deepEqual(row.conversation, snaps[1].conversation, 'the transcript is saved')
  assert.ok(!('engine_state' in row))
  assert.equal(schema.extendedColumns, false, 'remembered as a fact about this database')
  assert.deepEqual(table.calls, ['insert', 'insert', 'update'], 'one wasted round trip, then base writes only')

  assert.equal(isMissingColumnError(MISSING_COLUMN), true)
  assert.equal(isMissingColumnError({ code: '42703', message: 'column "engine_state" does not exist' }), true)
  for (const transient of [NETWORK, JWT_EXPIRED, { code: '57014', message: 'canceling statement due to statement timeout' }, { code: '', message: 'Bad Gateway', status: 502 }]) {
    assert.equal(isMissingColumnError(transient), false, transient.message!)
  }
})

// ==========================================================================
// No duplicate rows, no duplicate turns
// ==========================================================================

test('REGRESSION: a save that read the row id before the first insert resolved created a second row (old path)', async () => {
  const table = new FakeTable()
  const legacy = legacySaver(table)
  const snaps = snapshots(2)
  // Both saves read `currentSessionId` from React state while it was still null.
  await Promise.all([legacy(snaps[0], null), legacy(snaps[1], null)])
  assert.equal(table.rows.size, 2, 'two rows for one interview; the first frozen at question 1')
})

test('FIX: saves are serialized, so a save requested mid-insert updates the same row', async () => {
  const table = new FakeTable()
  const s = saver(table)
  const snaps = snapshots(3)
  const results = await Promise.all([s.save(snaps[0]), s.save(snaps[1]), s.save(snaps[2])])
  assert.ok(results.every((r) => r.ok))
  const row = table.only()
  assert.deepEqual(row.conversation, snaps[2].conversation, 'the newest snapshot wins')
  assert.equal(table.calls.filter((c) => c === 'insert').length, 1, 'one insert')
})

test('an insert whose response was lost does not create a second row', async () => {
  const table = new FakeTable()
  table.failNext('insert', NETWORK, { commit: true })
  const s = saver(table)
  const snaps = snapshots(2)
  assert.equal((await s.save(snaps[0])).ok, true)
  assert.equal((await s.save(snaps[1])).ok, true)
  assert.deepEqual(table.only().conversation, snaps[1].conversation)
  assert.deepEqual(table.calls.slice(0, 3), ['insert', 'find', 'update'], 'reconciled before writing again')
})

test('saving the same snapshot twice never duplicates a turn', async () => {
  const table = new FakeTable()
  const s = saver(table)
  const snap = snapshots(3)[2]
  await s.save(snap)
  await s.save(snap)
  await s.retry()
  const row = table.only()
  assert.equal(row.conversation.length, snap.conversation.length)
  assert.equal(row.conversation.filter((m) => m.content === 'a1').length, 1)
  assert.deepEqual(table.calls, ['insert'], 'an unchanged snapshot is not rewritten')
})

// ==========================================================================
// A failed save is visible, never silent
// ==========================================================================

test('a save that cannot land reports failure; the next save recovers', async () => {
  const table = new FakeTable()
  const statuses: SaveStatus[] = []
  const s = saver(table, { onStatus: (st) => statuses.push(st) })
  const snaps = snapshots(3)
  await s.save(snaps[0])
  table.failNext('update', NETWORK, { times: 3 }) // every attempt of the next save

  const failed = await s.save(snaps[1])
  assert.equal(failed.ok, false, 'the caller is told')
  assert.equal(s.status, 'error')
  assert.equal(statuses.at(-1), 'error')
  assert.equal(table.only().engine_state!.primaryQuestionNumber, 1, 'and nothing pretends otherwise')

  const recovered = await s.save(snaps[2])
  assert.equal(recovered.ok, true)
  assert.equal(s.status, 'saved')
  assert.equal(table.only().engine_state!.primaryQuestionNumber, 3, 'the newest progress lands')
})

test('retry() lands the newest unsaved snapshot', async () => {
  const table = new FakeTable()
  const s = saver(table)
  const snaps = snapshots(2)
  await s.save(snaps[0])
  table.failNext('update', NETWORK, { times: 3 })
  assert.equal((await s.save(snaps[1])).ok, false)
  assert.equal((await s.retry()).ok, true)
  assert.equal(table.only().engine_state!.primaryQuestionNumber, 2)
})

test('an update that matched no row is a failure, not a silent success', async () => {
  const table = new FakeTable()
  const s = saver(table)
  const snaps = snapshots(2)
  await s.save(snaps[0])
  table.rows.clear() // the row disappeared
  const result = await s.save(snaps[1])
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'NO_ROW')
})

test('a writer that throws is reported like one that returns an error', async () => {
  const table = new FakeTable()
  const s = saver(table)
  const snaps = snapshots(2)
  await s.save(snaps[0])
  table.failNext('update', NETWORK, { throws: true, times: 3 })
  const result = await s.save(snaps[1]) // must resolve, not reject
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'THROWN')
})

test('a thrown insert is reconciled before inserting again', async () => {
  const table = new FakeTable()
  table.failNext('insert', NETWORK, { throws: true })
  const s = saver(table)
  assert.equal((await s.save(snapshots(1)[0])).ok, true)
  assert.equal(table.rows.size, 1)
  assert.deepEqual(table.calls, ['insert', 'find', 'insert'])
})

// ==========================================================================
// Stored rows keep their shape
// ==========================================================================

test('the saved row has exactly the columns the page always wrote', () => {
  const snap = snapshots(2)[1]
  const custom: SessionMeta = { ...meta, interviewType: 'custom', customTopic: 'Leadership' }
  assert.deepEqual(buildSessionRow(custom, snap, false), {
    user_id: 'user-1',
    school_type: 'custom',
    interview_type: 'Leadership',
    conversation: snap.conversation,
    question_count: 2,
    reviewed: false,
  })
  assert.deepEqual(buildSessionRow(meta, snap, true), {
    user_id: 'user-1',
    school_type: 'clinical',
    interview_type: 'clinical',
    conversation: snap.conversation,
    question_count: 2,
    reviewed: false,
    mode: 'practice',
    engine_state: snap.state,
    overall_score: null,
    readiness: null,
    // Resume added this. Always present when the column exists, and explicitly
    // null when no checkpoint is open, so consuming one erases the stored copy.
    pending_turn: null,
  })
  // Stepping down past pending_turn must not take engine_state with it.
  const withoutColumn = buildSessionRow(meta, snap, true, false)
  assert.equal('pending_turn' in withoutColumn, false)
  assert.deepEqual(withoutColumn.engine_state, snap.state)
})

test('the Supabase writer maps responses and scopes the lookup to the user', async () => {
  const log: unknown[][] = []
  const client = (result: unknown) => {
    const chain: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        return (...args: unknown[]) => { log.push([prop, ...args]); return chain }
      },
    })
    return { from: (table: string) => { log.push(['from', table]); return chain } }
  }
  const row = buildSessionRow(meta, snapshots(1)[0], true)

  assert.deepEqual(await supabaseSessionWriter(client({ data: { id: 7 }, error: null }), 'user-1').insert(row), { id: 7, error: null })
  assert.equal((await supabaseSessionWriter(client({ data: [], error: null }), 'user-1').update(7, row)).error?.code, 'NO_ROW')
  assert.equal((await supabaseSessionWriter(client({ data: [{ id: 7 }], error: null }), 'user-1').update(7, row)).error, null)

  log.length = 0
  const found = await supabaseSessionWriter(client({ data: [{ id: 9 }], error: null }), 'user-1').findExisting({ firstMessage: 'Welcome. Q1', since: '2026-01-01T00:00:00.000Z' })
  assert.equal(found.id, 9)
  assert.deepEqual(log.filter((c) => c[0] === 'eq'), [['eq', 'user_id', 'user-1'], ['eq', 'conversation->0->>content', 'Welcome. Q1']])
  assert.ok(log.some((c) => c[0] === 'gte' && c[1] === 'created_at'))
})

// ==========================================================================
// Source pins: the page uses the saver and surfaces failures
// ==========================================================================

test('page: the permanent downgrade flag is gone and every save goes through the saver', () => {
  assert.doesNotMatch(PAGE, /extendedColumnsAvailable/)
  assert.doesNotMatch(PAGE, /currentSessionId/, 'no row id read from React state')
  assert.match(PAGE, /createSessionSaver\(\{\s*writer: supabaseSessionWriter\(supabase, userId\)/)
  assert.match(PAGE, /const saveSession = async \(\s*convo: ChatMessage\[\],\s*state: InterviewState \| null,\s*pendingTurn: PendingTurnPayload \| null = null,?\s*\) => \{/)
  assert.match(PAGE, /await saver\.save\(\{ conversation: convo, state, pendingTurn \}\)/)
  assert.doesNotMatch(PAGE, /from\('interview_sessions'\)\s*\.insert\(/, 'no direct inserts left in the page')
  // The one remaining direct write is the history "Reviewed" toggle, which is
  // not interview progress.
  const updates = [...PAGE.matchAll(/from\('interview_sessions'\)\s*\.update\(([^)]*)\)/g)].map((m) => m[1].trim())
  assert.deepEqual(updates, ['{ reviewed: true }'])
})

test('page: a failed save is shown to the applicant, with a way to retry', () => {
  assert.match(PAGE, /saveStatus === 'error' &&/)
  assert.match(PAGE, /Your progress isn&apos;t saving right now/)
  assert.match(PAGE, /onClick=\{retrySave\}/)
  // A previous interview's saver cannot change the status shown for this one.
  assert.match(PAGE, /if \(saverRef\.current === saver\) setSaveStatus\(status\)/)
})
