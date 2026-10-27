/**
 * Creating, reading, saving and deleting a draft in simulated-live mode,
 * through the routes the UI actually calls.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY THE EXISTING TESTS COULD NOT HAVE CAUGHT THE BUG
 * ---------------------------------------------------------------------------
 * app/api/statement/drafts/route.test.ts mocks the REPOSITORY wholesale --
 * correctly, because its subject is the route's decision table. Nothing beneath
 * draftRepo runs there, so neither the guarded client nor the local store is
 * exercised. And no test anywhere composed a body with the real
 * requirementDraftRequest(), so the missing `essay` key was invisible: every
 * test that created a requirement-backed draft wrote its own body, and wrote it
 * correctly.
 *
 * This file mocks ONLY authentication. The real route, the real validator, the
 * real repository, the real guarded client and the real local store all run,
 * and the request body comes from the builder the dialog calls.
 */
import test, { before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'

const USER = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'a@example.invalid', tier: 'ultimate', isUltimate: true,
}
// ITS OWN STORE, for the reason localDrafts.ts gives: this suite deletes the
// file it points at, and the owner's review drafts are not fixtures.
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.create-test.json'
const STORE = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const PAYLOAD = 'local-review/statement_requirements_catalog.json'
const skip = !existsSync(PAYLOAD) || typeof mock.module !== 'function'

type Handler = (request: unknown, context?: unknown) => Promise<Response>
let POST: Handler | null = null
let GET_ITEM: Handler | null = null
let PATCH_ITEM: Handler | null = null
let DELETE_ITEM: Handler | null = null
let requirementId = ''
let build: ((title: string, id: string) => Record<string, unknown>) | null = null

before(async () => {
  if (skip) return
  mock.module('@/lib/apiAuth', {
    namedExports: {
      authenticateRequest: async () => USER,
      readAccessToken: async () => 'fixture-token',
      isAdminEmail: () => true,
      ADMIN_EMAILS: [USER.email],
    },
  })
  const payload = JSON.parse(readFileSync(PAYLOAD, 'utf8'))
  const set = payload.sets.find((s: Record<string, unknown>) =>
    String(s.school_name).includes('Boston College'))
  requirementId = String(payload.documents.find(
    (d: Record<string, unknown>) => d.set_id === set.id).id)
  POST = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  const item = await import('../../../app/api/statement/drafts/[id]/route.ts')
  GET_ITEM = item.GET as Handler
  PATCH_ITEM = item.PATCH as Handler
  DELETE_ITEM = item.DELETE as Handler
  build = (await import('../requirements/newDraftFlow.ts')).requirementDraftRequest as typeof build
})

const request = (body?: unknown) => ({
  json: async () => body,
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
})
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const rows = () => JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, unknown>[]

// --------------------------------------------------- the bug, reproduced

test('THE ORIGINAL FAILURE: a body with no essay is refused', { skip }, async () => {
  // This is what the dialog sent before the fix. It is asserted rather than
  // described so the regression cannot return quietly: if requirementDraftRequest
  // ever drops the key again, the test above fails and this one still passes,
  // which names the cause precisely.
  rmSync(STORE, { force: true })
  const response = await POST!(request({ title: 'No essay key', requirementId }))
  assert.equal(response.status, 400)
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.code, 'invalid-essay')
  assert.equal(existsSync(STORE), false, 'a refused create must write nothing')
})

test('the builder the dialog calls now sends the key', { skip }, () => {
  const body = build!('A title', requirementId)
  assert.deepEqual(Object.keys(body).sort(), ['essay', 'requirementId', 'title'])
  assert.equal(body.essay, '')
  assert.equal(body.requirementId, requirementId)
})

// ------------------------------------------------------- the journey

let draftId = ''

test('CREATE succeeds and returns a usable id', { skip }, async () => {
  rmSync(STORE, { force: true })
  const response = await POST!(request(build!('Local test draft', requirementId)))
  const body = await response.json() as Record<string, unknown>
  assert.equal(response.status, 201, `create failed: ${JSON.stringify(body)}`)
  const draft = body.draft as Record<string, unknown>
  assert.match(String(draft.id), /^[0-9a-f-]{36}$/, 'the id is not a usable uuid')
  draftId = String(draft.id)
  // the projection the UI navigates with
  assert.equal(draft.revision, 1)
  assert.equal(draft.essay, '')
})

test('the row is in the LOCAL file, with its requirement and snapshot', { skip }, () => {
  const stored = rows()
  assert.equal(stored.length, 1)
  assert.equal(stored[0]!.id, draftId)
  assert.equal(stored[0]!.user_id, USER.userId)
  assert.equal(stored[0]!.requirement_id, requirementId)
  assert.ok(stored[0]!.requirement_snapshot, 'the snapshot did not survive')
})

test('the stored row parses through the REAL draft parser', { skip }, async () => {
  const { draftFromRow } = await import('../draft/rows.ts')
  const parsed = draftFromRow(rows()[0] as never)
  assert.ok(parsed, 'the real parser refused the row the local store wrote')
  assert.equal(parsed!.id, draftId)
  assert.equal(parsed!.requirementId, requirementId)
  assert.equal(parsed!.revision, 1)
})

test('the snapshot survives as a requirement the real parser accepts', { skip }, async () => {
  const { parseRequirementSnapshot } = await import('../requirements/snapshot.ts')
  const snapshot = parseRequirementSnapshot(rows()[0]!.requirement_snapshot)
  assert.ok(snapshot, 'the stored snapshot does not parse')
  // Boston College: the 1.5-page limit must have survived the round trip
  assert.equal(snapshot!.constraints.pages?.max, 1.5)
})

test('FETCH immediately afterwards works', { skip }, async () => {
  const response = await GET_ITEM!(request(), ctx(draftId))
  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, unknown>
  assert.equal((body.draft as Record<string, unknown>).id, draftId)
})

test('RE-READ after a fresh read of the file works (refresh)', { skip }, async () => {
  // The store is read from disk on every query, so this is a genuine reload.
  const response = await GET_ITEM!(request(), ctx(draftId))
  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, unknown>
  assert.equal((body.draft as Record<string, unknown>).title, 'Local test draft')
})

test('AUTOSAVE updates locally and bumps the revision', { skip }, async () => {
  const response = await PATCH_ITEM!(
    request({ title: 'Local test draft', essay: 'first words', expectedRevision: 1 }),
    ctx(draftId))
  const body = await response.json() as Record<string, unknown>
  assert.equal(response.status, 200, `autosave failed: ${JSON.stringify(body)}`)
  const draft = body.draft as Record<string, unknown>
  assert.equal(draft.essay, 'first words')
  assert.equal(draft.revision, 2)
  assert.equal(rows()[0]!.essay, 'first words')
})

test('a STALE autosave is refused, so the real concurrency check still runs',
  { skip }, async () => {
    const response = await PATCH_ITEM!(
      request({ title: 'x', essay: 'stale', expectedRevision: 1 }), ctx(draftId))
    assert.equal(response.status, 409)
    assert.equal(rows()[0]!.essay, 'first words', 'a refused save must change nothing')
  })

test('DELETE removes it locally', { skip }, async () => {
  const response = await DELETE_ITEM!(request(), ctx(draftId))
  assert.equal(response.status, 200)
  assert.equal(rows().length, 0)
})

// ------------------------------------------------- nothing reached production

test('NO PRODUCTION MUTATION IS REACHABLE from any of it', { skip }, async () => {
  const { statementDbClient } = await import('./guardedClient.ts')
  const { SimulatedLiveWriteBlocked } = await import('./gate.ts')
  const db = statementDbClient('token')
  // the drafts table is served locally, so it is NOT a Supabase builder
  const drafts = db.from('statement_drafts') as unknown as Record<string, unknown>
  assert.equal(typeof drafts.url, 'undefined', 'statement_drafts reached a real client')
  // every other table still refuses every write
  for (const table of ['statement_requirement_sets', 'statement_requirements',
    'statement_analyses', 'resume_ai_usage', 'statement_prompts', 'schools']) {
    for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
      assert.throws(
        () => (db.from(table) as unknown as Record<string, () => unknown>)[operation]!(),
        SimulatedLiveWriteBlocked, `${operation} on ${table}`)
    }
  }
  for (const fn of ['record_ai_usage', 'settle_ai_usage',
    'claim_statement_analysis', 'settle_statement_analysis']) {
    assert.throws(() => db.rpc(fn), SimulatedLiveWriteBlocked, fn)
  }
})
