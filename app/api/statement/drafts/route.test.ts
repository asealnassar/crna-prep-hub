import test, { after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { STATEMENT_STUDIO_HIDDEN_BODY } from '../../../../lib/statement/studioGate.ts'

/**
 * The statement draft API, both route modules.
 *
 * ONE FILE FOR TWO ROUTES because `mock.module` installs are process-wide: a
 * second file would repeat the whole harness to obtain the same mocks.
 *
 * TWO KINDS OF TEST, following app/api/statement/extract/route.test.ts and
 * lib/statement/route.test.ts before it.
 *
 * PART 1 reads the SOURCE, for properties execution can only sample: that
 * neither route names the table, that no service-role client exists, that
 * authentication precedes every query. A single passing request does not prove
 * a path that does not exist.
 *
 * PART 2 INVOKES the handlers with the repository, the auth module and
 * `next/server` mocked, for what only execution establishes: status codes,
 * response bodies, and exactly what the repository is handed.
 *
 * NO REAL SUPABASE, NO NETWORK, NO CREDENTIALS. The repository is replaced
 * wholesale, so no statement is ever issued. `createClient` is left real but
 * inert -- it is constructed from fixture values with autoRefreshToken and
 * persistSession off, and nothing ever calls it, because the module that would
 * is mocked.
 *
 * NOTE ON DISCOVERY: this file sits under app/, which `npm test`'s
 * `lib/**\/*.test.ts` glob does not reach -- the same known gap as the extract
 * route's tests. The decision table these routes rely on lives in
 * lib/statement/draft/http.ts precisely so that it IS covered by the suite.
 */

// Fixture values, set before anything constructs a client. Not credentials:
// nothing here reaches the network, and the repository is mocked out entirely.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'

/**
 * THE STUDIO MODE BASELINE FOR THIS FILE IS 'general'.
 *
 * Every behaviour test here describes a NORMAL authenticated applicant -- draft
 * validation, conflicts, 404s, leakage -- and 'general' is the mode that admits
 * one. Left unset, the gate would default to 'internal' and answer all of them
 * 404, which would be a test of the gate rather than of the route.
 *
 * The gate tests set the mode they need through withMode(), which restores it
 * when that test ends, and beforeEach() puts this baseline back regardless. No
 * test can inherit another's mode. The process value is restored in after().
 */
const ORIGINAL_MODE = process.env.STATEMENT_STUDIO_MODE
process.env.STATEMENT_STUDIO_MODE = 'general'
after(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.STATEMENT_STUDIO_MODE
  else process.env.STATEMENT_STUDIO_MODE = ORIGINAL_MODE
})

/** Sets the mode for one test and puts it back when that test ends. */
function withMode(t: { after: (fn: () => void) => void }, mode: string | undefined): void {
  const previous = process.env.STATEMENT_STUDIO_MODE
  if (mode === undefined) delete process.env.STATEMENT_STUDIO_MODE
  else process.env.STATEMENT_STUDIO_MODE = mode
  t.after(() => {
    if (previous === undefined) delete process.env.STATEMENT_STUDIO_MODE
    else process.env.STATEMENT_STUDIO_MODE = previous
  })
}

/**
 * THE GATE-HIDDEN BODY: spelled out, AND checked against the real constant.
 *
 * Spelled out so a change to STATEMENT_STUDIO_HIDDEN_BODY has to be
 * acknowledged here. Checked against the import so that this file and
 * app/api/statement/extract/route.test.ts are asserting the same bytes -- which
 * is how the two families' hidden responses are proven byte-equivalent, given
 * that neither test process can call the other's handler.
 */
const GATE_HIDDEN = { error: 'Not found.', code: 'not-found' }

/**
 * What an ADMITTED caller gets for a draft that is absent or invisible to them.
 * A different answer on purpose: they may use this endpoint, and the row is not
 * there. See lib/statement/studioGate.ts for why the two must not be merged.
 */
const DRAFT_NOT_FOUND = { error: 'That draft could not be found.', code: 'not-found' }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../../..')
const AUTH_MODULE = path.join(ROOT, 'lib', 'apiAuth.ts')
const REPO_MODULE = path.join(ROOT, 'lib', 'statement', 'draft', 'draftRepo.ts')
const ITEM_ROUTE = pathToFileURL(path.join(HERE, '[id]', 'route.ts')).href

const COLLECTION_SRC = readFileSync(path.join(HERE, 'route.ts'), 'utf8')
const ITEM_SRC = readFileSync(path.join(HERE, '[id]', 'route.ts'), 'utf8')

const ID = 'd1e2f3a4-0000-4000-8000-000000000001'
const OTHER_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const USER = 'u1e2f3a4-0000-4000-8000-000000000002'
const FAKE_USER = { userId: USER, email: 'applicant@example.test', tier: 'free', isUltimate: false }

const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000003'
const PROMPT = 'c0ffee00-0000-4000-8000-000000000004'

/**
 * A GENERIC draft by default: the four prompt columns are explicit nulls, which
 * is what draftFromRow produces for every draft created today. They must be
 * stated rather than left off -- omitting them would let JSON.stringify drop
 * them and make the response assertions below pass without testing anything.
 */
const draft = (over: Record<string, unknown> = {}) => ({
  id: ID,
  userId: USER,
  title: 'Draft one',
  essay: 'Opening line.',
  revision: 1,
  createdAt: '2026-09-29T12:00:00.000Z',
  updatedAt: '2026-09-29T12:00:00.000Z',
  schoolId: null,
  promptId: null,
  promptText: null,
  statedMaxWords: null,
  ...over,
})

const summary = (over: Record<string, unknown> = {}) => ({
  id: ID,
  title: 'Draft one',
  revision: 1,
  createdAt: '2026-09-29T12:00:00.000Z',
  updatedAt: '2026-09-29T12:00:00.000Z',
  ...over,
})

// ==========================================================================
// PART 1 -- source properties
// ==========================================================================

test('source: neither route names the table or builds a query', () => {
  // The whole boundary: all persistence is draftRepo's. A route that grew its
  // own `.from('statement_drafts')` would bypass the stored-revision parser and
  // the CAS, so the absence is asserted rather than trusted.
  for (const [name, src] of [['collection', COLLECTION_SRC], ['item', ITEM_SRC]] as const) {
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    assert.equal(/\.from\(/.test(code), false, `${name} route must not build a query`)
    assert.equal(/statement_drafts/.test(code), false, `${name} route must not name the table`)
    assert.equal(/\.rpc\(/.test(code), false, `${name} route must not call an RPC`)
  }
})

test('source: no service-role client anywhere', () => {
  for (const src of [COLLECTION_SRC, ITEM_SRC]) {
    assert.equal(src.includes('SERVICE_ROLE'), false)
    assert.equal(src.includes('service_role'), false)
    // The anon key plus the caller's JWT is the only client either file builds.
    assert.ok(src.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
    assert.ok(src.includes('Authorization: `Bearer ${token}`'))
  }
})

test('source: authentication precedes every repository call', () => {
  // Ordering an integration test can only sample. `admit()` is the first
  // statement of every handler, and every repository call appears after it.
  for (const [name, src] of [['collection', COLLECTION_SRC], ['item', ITEM_SRC]] as const) {
    for (const fn of ['listDrafts(', 'createDraft(', 'readDraft(', 'updateDraft(', 'deleteDraft(']) {
      const call = src.indexOf(`await ${fn}`)
      if (call === -1) continue
      const admit = src.indexOf('const caller = await admit()')
      assert.ok(admit !== -1 && admit < call, `${name}: ${fn} must come after admit()`)
    }
  }
})

test('source: the id passed to the repository is the PATH id, never the body', () => {
  // `updateDraft(caller.db, id, checked.input)` -- `id` is the awaited param and
  // `checked.input` is the validator's normalised object, which has no id.
  assert.ok(ITEM_SRC.includes('updateDraft(caller.db, id, checked.input)'))
  assert.ok(ITEM_SRC.includes('readDraft(caller.db, id)'))
  assert.ok(ITEM_SRC.includes('deleteDraft(caller.db, id)'))
  assert.equal(/body\.id/.test(ITEM_SRC), false, 'the body id must never be read')
})

test('source: no timestamp is ever read from a request', () => {
  for (const src of [COLLECTION_SRC, ITEM_SRC]) {
    for (const forbidden of ['body.updated_at', 'body.updatedAt', 'body.savedAt', 'body.created_at']) {
      assert.equal(src.includes(forbidden), false, `${forbidden} must never be read`)
    }
  }
})

test('source: no repository detail is ever put in a response', () => {
  for (const src of [COLLECTION_SRC, ITEM_SRC]) {
    assert.equal(/\.detail/.test(src), false, 'a repository detail must not be read at all')
  }
})

test('source: both draft routes are gated by the SAME statement gate', () => {
  for (const [name, src] of [['collection', COLLECTION_SRC], ['item', ITEM_SRC]] as const) {
    assert.ok(src.includes("from '@/lib/statement/studioGate'"), `${name} must import the gate`)
    assert.ok(src.includes('statementStudioAccess({'), `${name} must apply the gate`)
    // Read into a local FIRST, so the mode is determined before the request is
    // authenticated -- step 1 of the documented order.
    assert.ok(src.includes('const mode = statementStudioMode()'), `${name} must read the statement flag`)
    // Not the resume cutover flag, and not the resume gate. Coupling the Studio
    // to RESUME_BUILDER_MODE would release it the day resumes are cut over.
    assert.equal(src.includes('RESUME_BUILDER_MODE'), false, `${name} must not read the resume flag`)
    assert.equal(src.includes('resumeBuilderMode'), false)
    assert.equal(src.includes('resumeV2Access'), false)
  }

  // The two admit() functions are byte-for-byte the same, so one family cannot
  // end up gated differently from the other by an edit to only one file.
  const admitBody = (src: string) => {
    const at = src.indexOf('async function admit')
    assert.notEqual(at, -1)
    return src.slice(at, src.indexOf('\n}\n', at))
  }
  assert.equal(admitBody(COLLECTION_SRC), admitBody(ITEM_SRC))

  // And inside admit(), the gate precedes the token and the client.
  for (const [name, src] of [['collection', COLLECTION_SRC], ['item', ITEM_SRC]] as const) {
    const body = admitBody(src)
    const at = (needle: string) => {
      const i = body.indexOf(needle)
      assert.notEqual(i, -1, `${name}: ${needle} is absent from admit()`)
      return i
    }
    assert.ok(at('statementStudioMode()') < at('authenticateRequest()'), `${name}: mode first`)
    assert.ok(at('authenticateRequest()') < at('statementStudioAccess({'), `${name}: then identity`)
    assert.ok(at('statementStudioAccess({') < at('readAccessToken()'), `${name}: gate before token`)
    assert.ok(at('statementStudioAccess({') < at('createClient('), `${name}: gate before client`)
  }
})

// ==========================================================================
// PART 2 -- invocation
// ==========================================================================

assert.ok(
  typeof mock.module === 'function',
  'Part 2 needs --experimental-test-module-mocks; without it the routes cannot be loaded with isolated mocks',
)

let session: typeof FAKE_USER | null = null
let admin = false
let tokenReads = 0
let repoCalls: { fn: string; args: unknown[] }[] = []
let repoReplies: Record<string, unknown> = {}
let installed = false

beforeEach(() => {
  session = null
  admin = false
  tokenReads = 0
  repoCalls = []
  repoReplies = {}
  process.env.STATEMENT_STUDIO_MODE = 'general'
})

/** Records the call and returns whatever the test queued for that function. */
const recorded = (fn: string) => async (...args: unknown[]) => {
  repoCalls.push({ fn, args })
  const reply = repoReplies[fn]
  if (reply === undefined) {
    throw new Error(`the route called ${fn}() but the test queued no reply for it`)
  }
  return reply
}

function installMocksOnce(): void {
  if (installed) return
  installed = true

  // `next/server`, because bare Node cannot resolve it -- see the extract
  // route's tests for the full reasoning. The substitute returns a REAL
  // standards Response, so status, headers and body behave exactly as one.
  mock.module('next/server', {
    namedExports: {
      NextResponse: class NextResponse extends Response {
        static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
          return new NextResponse(JSON.stringify(body), {
            status: init?.status ?? 200,
            headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
          })
        }
      },
      NextRequest: class NextRequestTypeOnlyPlaceholder {},
    },
  })

  // One fictional identity. No real user, no credential, no network.
  // `readAccessToken` COUNTS ITS CALLS. That is how the tests observe that a
  // blocked caller never gets as far as token or client work: the gate returns
  // above this line, so the counter stays at zero.
  mock.module(AUTH_MODULE, {
    namedExports: {
      authenticateRequest: async () => session,
      readAccessToken: async () => {
        tokenReads += 1
        return session ? 'fictional-token' : null
      },
      isAdminEmail: () => admin,
      ADMIN_EMAILS: [] as string[],
    },
  })

  // The repository, replaced wholesale: no statement is ever issued, and every
  // call is recorded so the tests can assert exactly what it was handed.
  mock.module(REPO_MODULE, {
    namedExports: {
      createDraft: recorded('createDraft'),
      readDraft: recorded('readDraft'),
      listDrafts: recorded('listDrafts'),
      updateDraft: recorded('updateDraft'),
      deleteDraft: recorded('deleteDraft'),
    },
  })
}

type Collection = {
  GET: () => Promise<Response>
  POST: (request: Request) => Promise<Response>
}
type Item = {
  GET: (request: Request, ctx: unknown) => Promise<Response>
  PATCH: (request: Request, ctx: unknown) => Promise<Response>
  DELETE: (request: Request, ctx: unknown) => Promise<Response>
}
let collectionMod: Collection | null = null
let itemMod: Item | null = null

async function collection(authed: boolean): Promise<Collection> {
  installMocksOnce()
  session = authed ? FAKE_USER : null
  if (!collectionMod) collectionMod = (await import('./route.ts')) as unknown as Collection
  return collectionMod
}

async function item(authed: boolean): Promise<Item> {
  installMocksOnce()
  session = authed ? FAKE_USER : null
  if (!itemMod) itemMod = (await import(ITEM_ROUTE)) as unknown as Item
  return itemMod
}

/**
 * A request the handlers can actually receive.
 *
 * NO BODY ON GET. The Fetch standard forbids it -- `new Request(url, {method:
 * 'GET', body})` throws TypeError -- and the GET and DELETE handlers do not read
 * one anyway, which is why their first parameter is named `_request`. Passing
 * `undefined` is therefore both legal and more faithful than a body nobody reads.
 */
const jsonRequest = (method: string, body?: unknown) =>
  new Request('https://fixture.test/api/statement/drafts', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'HEAD' || body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

const ctx = (id: unknown) => ({ params: Promise.resolve({ id }) })
const called = (fn: string) => repoCalls.filter((c) => c.fn === fn)

// ------------------------------------------------------------ authentication

test('auth: general mode — every collection method is 401, and reaches no repository call', async (t) => {
  withMode(t, 'general')
  const mod = await collection(false)
  for (const [name, res] of [
    ['GET', await mod.GET()],
    ['POST', await mod.POST(jsonRequest('POST', { title: 't', essay: 'e' }))],
  ] as const) {
    assert.equal(res.status, 401, name)
    assert.equal((await res.json()).code, 'unauthenticated')
  }
  assert.equal(repoCalls.length, 0, 'no repository function may be reached unauthenticated')
})

test('auth: general mode — every item method is 401, and reaches no repository call', async (t) => {
  withMode(t, 'general')
  const mod = await item(false)
  for (const [name, res] of [
    ['GET', await mod.GET(jsonRequest('GET'), ctx(ID))],
    ['PATCH', await mod.PATCH(jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 1 }), ctx(ID))],
    ['DELETE', await mod.DELETE(jsonRequest('DELETE'), ctx(ID))],
  ] as const) {
    assert.equal(res.status, 401, name)
    assert.equal((await res.json()).code, 'unauthenticated')
  }
  assert.equal(repoCalls.length, 0)
})

// ------------------------------------------------------------- the Studio gate

/** Every Studio draft method, exercised once, for the gate tests. */
async function allMethods(authed: boolean): Promise<{ name: string; res: Response }[]> {
  const c = await collection(authed)
  const i = await item(authed)
  return [
    { name: 'GET /drafts', res: await c.GET() },
    { name: 'POST /drafts', res: await c.POST(jsonRequest('POST', { title: 't', essay: 'e' })) },
    { name: 'GET /drafts/[id]', res: await i.GET(jsonRequest('GET'), ctx(ID)) },
    {
      name: 'PATCH /drafts/[id]',
      res: await i.PATCH(jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 1 }), ctx(ID)),
    },
    { name: 'DELETE /drafts/[id]', res: await i.DELETE(jsonRequest('DELETE'), ctx(ID)) },
  ]
}

test('gate: internal — an anonymous caller gets the hidden 404 from every method', async (t) => {
  withMode(t, 'internal')
  for (const { name, res } of await allMethods(false)) {
    assert.equal(res.status, 404, name)
    assert.deepEqual(await res.json(), GATE_HIDDEN, name)
  }
  assert.equal(repoCalls.length, 0, 'no repository function may be reached')
  assert.equal(tokenReads, 0, 'no access token may be read past the gate')
})

test('gate: internal — an authenticated NON-admin gets the hidden 404 from every method', async (t) => {
  withMode(t, 'internal')
  admin = false
  for (const { name, res } of await allMethods(true)) {
    assert.equal(res.status, 404, name)
    assert.deepEqual(await res.json(), GATE_HIDDEN, name)
  }
  // List, create, read, update and delete: all five unreachable for a normal user.
  assert.equal(repoCalls.length, 0, 'a blocked user must cause no draft query or write')
  assert.equal(tokenReads, 0, 'no access token may be read past the gate')
})

test('gate: internal — the blocked responses are byte-identical for both callers', async (t) => {
  withMode(t, 'internal')
  const anonymous = await Promise.all((await allMethods(false)).map((m) => m.res.text()))
  admin = false
  const signedIn = await Promise.all((await allMethods(true)).map((m) => m.res.text()))
  const unique = new Set([...anonymous, ...signedIn])
  assert.equal(unique.size, 1, 'a prober must not be able to tell the two cases apart')
  assert.deepEqual([...unique], [JSON.stringify(GATE_HIDDEN)])
})

test('gate: internal — the hidden answer names nothing, and is never 403', async (t) => {
  withMode(t, 'internal')
  for (const { name, res } of await allMethods(true)) {
    assert.notEqual(res.status, 403, `${name} must never answer 403`)
    const text = (await res.text()).toLowerCase()
    for (const word of [
      // The approved list, plus four this body also happens not to contain.
      'draft', 'statement', 'studio', 'admin', 'internal', 'upload', 'extract',
      'forbidden', 'permission',
      'flag', 'beta', 'denied', 'role',
    ]) {
      assert.equal(text.includes(word), false, `${name} leaked "${word}"`)
    }
  }
})

test('gate: internal — an authenticated ADMIN is admitted to the collection', async (t) => {
  withMode(t, 'internal')
  admin = true
  repoReplies.listDrafts = { ok: true, value: [summary()] }
  const res = await (await collection(true)).GET()
  assert.equal(res.status, 200)
  assert.equal(called('listDrafts').length, 1)
  assert.ok(tokenReads > 0, 'an admitted caller does go on to read a token')
})

test('gate: internal — an authenticated ADMIN is admitted to every item method', async (t) => {
  withMode(t, 'internal')
  admin = true
  repoReplies.readDraft = { ok: true, value: draft() }
  repoReplies.updateDraft = { ok: true, value: draft({ revision: 2 }) }
  repoReplies.deleteDraft = { ok: true, value: { id: ID } }
  const i = await item(true)
  assert.equal((await i.GET(jsonRequest('GET'), ctx(ID))).status, 200)
  assert.equal(
    (await i.PATCH(jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 1 }), ctx(ID))).status,
    200,
  )
  assert.equal((await i.DELETE(jsonRequest('DELETE'), ctx(ID))).status, 200)
  assert.deepEqual(repoCalls.map((c) => c.fn), ['readDraft', 'updateDraft', 'deleteDraft'])
})

test('gate: the hidden body IS the gate constant, and is NOT the draft 404', () => {
  assert.deepEqual(GATE_HIDDEN, STATEMENT_STUDIO_HIDDEN_BODY)
  assert.notDeepEqual(GATE_HIDDEN, DRAFT_NOT_FOUND, 'the two answers must stay distinct')
  // Neutral: nothing in it says what kind of endpoint refused the caller.
  assert.equal(JSON.stringify(GATE_HIDDEN), '{"error":"Not found.","code":"not-found"}')
})

test('gate: internal — an admitted ADMIN still gets the DRAFT 404 for a missing draft', async (t) => {
  withMode(t, 'internal')
  admin = true
  repoReplies.readDraft = { ok: false, reason: 'not-found' }
  repoReplies.updateDraft = { ok: false, reason: 'not-found' }
  repoReplies.deleteDraft = { ok: false, reason: 'not-found' }

  const i = await item(true)
  const responses = [
    ['GET', await i.GET(jsonRequest('GET'), ctx(ID))],
    ['PATCH', await i.PATCH(jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 1 }), ctx(ID))],
    ['DELETE', await i.DELETE(jsonRequest('DELETE'), ctx(ID))],
  ] as const

  for (const [name, res] of responses) {
    assert.equal(res.status, 404, name)
    // Admitted, so the honest answer: this draft is not there. NOT the gate's
    // neutral body -- that would take away the one thing they need to be told.
    assert.deepEqual(await res.json(), DRAFT_NOT_FOUND, name)
  }
  // And the gate really did admit them: the repository was reached three times.
  assert.deepEqual(repoCalls.map((c) => c.fn), ['readDraft', 'updateDraft', 'deleteDraft'])
})

test('gate: general — an anonymous caller gets 401, not the hidden 404', async (t) => {
  withMode(t, 'general')
  for (const { name, res } of await allMethods(false)) {
    assert.equal(res.status, 401, name)
    assert.equal((await res.json()).code, 'unauthenticated', name)
  }
  assert.equal(repoCalls.length, 0)
})

test('gate: general — an authenticated NON-admin is admitted', async (t) => {
  withMode(t, 'general')
  admin = false
  repoReplies.listDrafts = { ok: true, value: [] }
  const res = await (await collection(true)).GET()
  assert.equal(res.status, 200, 'general mode is what one env change will turn on')
  assert.equal(called('listDrafts').length, 1)
})

test('gate: general — an authenticated ADMIN is admitted too', async (t) => {
  withMode(t, 'general')
  admin = true
  repoReplies.listDrafts = { ok: true, value: [] }
  assert.equal((await (await collection(true)).GET()).status, 200)
  assert.equal(called('listDrafts').length, 1)
})

test('gate: an unknown or absent mode FAILS CLOSED to internal', async (t) => {
  // One registration, so the restore runs once however many values are tried.
  withMode(t, 'internal')
  admin = false
  repoReplies.listDrafts = { ok: true, value: [] }

  for (const value of ['beta', 'v2', 'on', 'true', '1', '', ' ', 'GENERALLY', 'general,beta']) {
    process.env.STATEMENT_STUDIO_MODE = value
    const res = await (await collection(true)).GET()
    assert.equal(res.status, 404, `STATEMENT_STUDIO_MODE="${value}" must hide the endpoint`)
    assert.deepEqual(await res.json(), GATE_HIDDEN)
  }

  delete process.env.STATEMENT_STUDIO_MODE
  const absent = await (await collection(true)).GET()
  assert.equal(absent.status, 404, 'an unset flag must hide the endpoint')
  assert.deepEqual(await absent.json(), GATE_HIDDEN)

  assert.equal(repoCalls.length, 0, 'no unknown mode may reach the repository')
  assert.equal(tokenReads, 0, 'no unknown mode may reach token or client work')
})

// -------------------------------------------------------------- GET collection

test('GET collection: returns metadata summaries scoped to the session user', async () => {
  repoReplies.listDrafts = { ok: true, value: [summary(), summary({ id: OTHER_ID, title: 'Draft two' })] }
  const res = await (await collection(true)).GET()

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.drafts.length, 2)

  // The user id came from the SESSION.
  assert.deepEqual(called('listDrafts')[0].args[1], USER)
})

test('GET collection: no essay and no userId in any entry', async () => {
  repoReplies.listDrafts = { ok: true, value: [summary()] }
  const res = await (await collection(true)).GET()
  const body = await res.json()

  for (const entry of body.drafts) {
    assert.equal('essay' in entry, false)
    assert.equal('userId' in entry, false)
    assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'id', 'revision', 'title', 'updatedAt'])
  }
})

test('GET collection: a list failure is a generic 500', async () => {
  repoReplies.listDrafts = { ok: false, reason: 'list-failed', detail: '08006 connection failure' }
  const res = await (await collection(true)).GET()
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.code, 'server-error')
  assert.equal(JSON.stringify(body).includes('08006'), false)
})

// -------------------------------------------------------------------- POST

test('POST: the repository receives the normalised title and the exact essay', async () => {
  repoReplies.createDraft = { ok: true, value: draft() }
  const res = await (await collection(true)).POST(
    jsonRequest('POST', { title: '  Draft one  ', essay: '\n\n  Body with edges.  \n' }),
  )
  assert.equal(res.status, 201)

  const [db, userId, input] = called('createDraft')[0].args as [unknown, string, Record<string, unknown>]
  assert.ok(db, 'a caller-scoped client is passed')
  assert.equal(userId, USER)
  // Title TRIMMED, essay byte-for-byte.
  assert.deepEqual(input, { title: 'Draft one', essay: '\n\n  Body with edges.  \n' })
})

test('POST: an empty essay is allowed', async () => {
  repoReplies.createDraft = { ok: true, value: draft({ essay: '' }) }
  const res = await (await collection(true)).POST(jsonRequest('POST', { title: 'Draft one', essay: '' }))
  assert.equal(res.status, 201)
  assert.equal((called('createDraft')[0].args[2] as Record<string, unknown>).essay, '')
})

test('POST: 201 carries the full draft and never the userId', async () => {
  repoReplies.createDraft = { ok: true, value: draft() }
  const res = await (await collection(true)).POST(jsonRequest('POST', { title: 'Draft one', essay: 'Body.' }))
  assert.equal(res.status, 201)

  const { draft: returned } = await res.json()
  // TEN fields now: the read model exposes the four prompt snapshot columns.
  assert.deepEqual(Object.keys(returned).sort(), [
    'createdAt', 'essay', 'id', 'promptId', 'promptText', 'revision',
    'schoolId', 'statedMaxWords', 'title', 'updatedAt',
  ])
  assert.equal('userId' in returned, false)
  assert.equal(returned.revision, 1)
})

test('POST: a new draft is GENERIC -- four explicit nulls over the wire', async () => {
  repoReplies.createDraft = { ok: true, value: draft() }
  const res = await (await collection(true)).POST(jsonRequest('POST', { title: 'Draft one', essay: '' }))
  const { draft: returned } = await res.json()
  for (const key of ['schoolId', 'promptId', 'promptText', 'statedMaxWords']) {
    assert.equal(key in returned, true, `${key} must survive JSON`)
    assert.equal(returned[key], null, `${key} must be null, not absent`)
  }
})

test('GET one: a GENERIC draft serialises all four fields as explicit null', async () => {
  // Present and null over the wire, never omitted. Four absent keys would be
  // indistinguishable from a server too old to send them, so a client could not
  // tell "this draft has no prompt" from "this response does not say".
  repoReplies.readDraft = { ok: true, value: draft() }
  const res = await (await item(true)).GET(jsonRequest('GET'), ctx(ID))
  assert.equal(res.status, 200)

  // Read from the SERIALISED body: JSON.stringify drops undefined values, so a
  // field that was merely absent on the object would vanish silently here.
  const { draft: returned } = await res.json()
  for (const key of ['schoolId', 'promptId', 'promptText', 'statedMaxWords']) {
    assert.equal(key in returned, true, `${key} must survive serialisation`)
    assert.equal(returned[key], null, `${key} must be null, not absent`)
  }
  assert.deepEqual(Object.keys(returned).sort(), [
    'createdAt', 'essay', 'id', 'promptId', 'promptText', 'revision',
    'schoolId', 'statedMaxWords', 'title', 'updatedAt',
  ])
  assert.equal('userId' in returned, false)
  assert.equal(JSON.stringify(returned).includes(USER), false)
})

test('PATCH: a draft that HAS prompt metadata returns the snapshot unchanged', async () => {
  // This checkpoint writes none of the four columns, so a save hands back the
  // snapshot it did not touch. That is what makes a reload after an autosave
  // preserve the prompt selection rather than appear to clear it.
  const saved = draft({
    revision: 2,
    schoolId: SCHOOL, promptId: PROMPT,
    promptText: 'Why have you chosen nurse anaesthesia?', statedMaxWords: 500,
  })
  repoReplies.updateDraft = { ok: true, value: saved }

  const res = await (await item(true)).PATCH(
    jsonRequest('PATCH', { title: 'Draft one', essay: 'Body.', expectedRevision: 1 }),
    ctx(ID),
  )
  assert.equal(res.status, 200)

  const { draft: returned } = await res.json()
  assert.equal(returned.schoolId, SCHOOL)
  assert.equal(returned.promptId, PROMPT)
  assert.equal(returned.promptText, 'Why have you chosen nurse anaesthesia?')
  assert.equal(returned.statedMaxWords, 500)
  assert.equal(returned.revision, 2)
  assert.equal('userId' in returned, false)

  // AND THE REQUEST STILL DECIDED NOTHING ABOUT THE PROMPT. The repository was
  // handed exactly the three validated fields, so nothing in this response came
  // from the body.
  const [, , input] = called('updateDraft')[0].args as [unknown, string, Record<string, unknown>]
  assert.deepEqual(Object.keys(input).sort(), ['essay', 'expectedRevision', 'title'])
})

test('PATCH: a generic draft still answers with four explicit nulls', async () => {
  repoReplies.updateDraft = { ok: true, value: draft({ revision: 2 }) }
  const res = await (await item(true)).PATCH(
    jsonRequest('PATCH', { title: 'Draft one', essay: 'Body.', expectedRevision: 1 }),
    ctx(ID),
  )
  const { draft: returned } = await res.json()
  for (const key of ['schoolId', 'promptId', 'promptText', 'statedMaxWords']) {
    assert.equal(key in returned, true, `${key} must survive serialisation`)
    assert.equal(returned[key], null, `${key} must be null, not absent`)
  }
  assert.equal('userId' in returned, false)
})

test('GET one: a stored prompt snapshot reaches the client', async () => {
  repoReplies.readDraft = {
    ok: true,
    value: draft({
      schoolId: SCHOOL, promptId: PROMPT,
      promptText: 'Why have you chosen nurse anaesthesia?', statedMaxWords: 500,
    }),
  }
  const res = await (await item(true)).GET(jsonRequest('GET'), ctx(ID))
  assert.equal(res.status, 200)
  const { draft: returned } = await res.json()
  assert.equal(returned.schoolId, SCHOOL)
  assert.equal(returned.promptId, PROMPT)
  assert.equal(returned.promptText, 'Why have you chosen nurse anaesthesia?')
  assert.equal(returned.statedMaxWords, 500)
  assert.equal('userId' in returned, false)
})

test('the routes still send NO ability to select a prompt', async () => {
  // Checkpoint A stays unwired: neither route reads a prompt from a body, and
  // neither resolves one. This is the READ side only.
  const sources = await Promise.all([
    import('node:fs/promises').then((fs) => fs.readFile(
      new URL('./route.ts', import.meta.url), 'utf8')),
    import('node:fs/promises').then((fs) => fs.readFile(
      new URL('./[id]/route.ts', import.meta.url), 'utf8')),
  ])
  for (const source of sources) {
    for (const forbidden of [
      'checkPromptSelection', 'promptSelectionOf', 'readActivePrompt',
      'promptRepo', 'promptId', 'schoolId', 'statedMaxWords',
    ]) {
      assert.equal(source.includes(forbidden), false, `${forbidden} belongs to a later step`)
    }
  }
})

test('POST: a request-supplied userId, id, revision or timestamp is ignored entirely', async () => {
  repoReplies.createDraft = { ok: true, value: draft() }
  await (await collection(true)).POST(jsonRequest('POST', {
    title: 'Draft one',
    essay: 'Body.',
    userId: 'attacker-user-id',
    user_id: 'attacker-user-id',
    id: OTHER_ID,
    revision: 99,
    expectedRevision: 99,
    created_at: '2099-01-01T00:00:00.000Z',
    updated_at: '2099-01-01T00:00:00.000Z',
  }))

  const [, userId, input] = called('createDraft')[0].args as [unknown, string, Record<string, unknown>]
  // Ownership is the session's.
  assert.equal(userId, USER)
  // And the repository input is exactly two fields.
  assert.deepEqual(Object.keys(input).sort(), ['essay', 'title'])
  assert.equal(JSON.stringify(input).includes('2099'), false)
  assert.equal(JSON.stringify(input).includes('attacker'), false)
})

test('POST: a validation refusal keeps its machine code, with the right status', async () => {
  const mod = await collection(true)
  for (const [body, code, status] of [
    [{ title: '', essay: 'e' }, 'invalid-title', 400],
    [{ title: 42, essay: 'e' }, 'invalid-title', 400],
    [{ title: 'a'.repeat(201), essay: 'e' }, 'title-too-long', 422],
    [{ title: 't', essay: 42 }, 'invalid-essay', 400],
    [{ title: 't', essay: 'x'.repeat(20_001) }, 'essay-too-long', 422],
  ] as const) {
    const res = await mod.POST(jsonRequest('POST', body))
    assert.equal(res.status, status, code)
    const payload = await res.json()
    assert.equal(payload.code, code)
    // Never the rejected text.
    assert.equal(JSON.stringify(payload).includes('x'.repeat(50)), false)
  }
  assert.equal(called('createDraft').length, 0, 'a refused body must not reach the repository')
})

test('POST: an over-long essay reports its count without the essay', async () => {
  const res = await (await collection(true)).POST(
    jsonRequest('POST', { title: 't', essay: 'x'.repeat(20_050) }),
  )
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.code, 'essay-too-long')
  assert.equal(body.characters, 20_050)
})

test('POST: malformed JSON is a 400, not a 500', async () => {
  const res = await (await collection(true)).POST(jsonRequest('POST', '{ not json'))
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'malformed-json')
  assert.equal(called('createDraft').length, 0)
})

test('POST: JSON that is not an object is refused cleanly', async () => {
  const mod = await collection(true)
  for (const raw of ['null', '[]', '["a"]', '"a string"', '42', 'true']) {
    const res = await mod.POST(jsonRequest('POST', raw))
    assert.equal(res.status, 400, raw)
    assert.equal((await res.json()).code, 'not-an-object', raw)
  }
  assert.equal(called('createDraft').length, 0)
})

test('POST: a repository failure is a generic 500 and leaks no detail', async () => {
  repoReplies.createDraft = { ok: false, reason: 'create-failed', detail: '23514 violates check' }
  const res = await (await collection(true)).POST(jsonRequest('POST', { title: 't', essay: 'e' }))
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.code, 'server-error')
  assert.equal(JSON.stringify(body).includes('23514'), false)
})

// ---------------------------------------------------------------- GET item

test('GET item: a visible draft comes back in full, without the userId', async () => {
  repoReplies.readDraft = { ok: true, value: draft({ essay: 'The whole essay.' }) }
  const res = await (await item(true)).GET(jsonRequest('GET'), ctx(ID))

  assert.equal(res.status, 200)
  const { draft: returned } = await res.json()
  assert.equal(returned.essay, 'The whole essay.')
  assert.equal('userId' in returned, false)
  // The PATH id reached the repository.
  assert.equal(called('readDraft')[0].args[1], ID)
})

test('GET item: a malformed id is refused BEFORE any repository call', async () => {
  const mod = await item(true)
  for (const bad of ['not-a-uuid', '', '123', `${ID}x`, 'd1e2f3a4-0000-4000-8000', undefined, null, [ID], 42]) {
    const res = await mod.GET(jsonRequest('GET'), ctx(bad))
    assert.equal(res.status, 400, JSON.stringify(bad))
    assert.equal((await res.json()).code, 'invalid-id')
  }
  assert.equal(called('readDraft').length, 0, 'an invalid id must never reach a query')
})

test('GET item: a missing or RLS-hidden draft is the same 404', async () => {
  repoReplies.readDraft = { ok: false, reason: 'not-found', detail: '' }
  const res = await (await item(true)).GET(jsonRequest('GET'), ctx(OTHER_ID))

  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.code, 'not-found')
  // Never 403, and never a hint that the row belongs to somebody.
  assert.equal(JSON.stringify(body).includes('403'), false)
  assert.equal(/forbidden|another user|owner/i.test(JSON.stringify(body)), false)
})

test('GET item: a repository failure is a generic 500', async () => {
  repoReplies.readDraft = { ok: false, reason: 'read-failed', detail: '08006 connection failure' }
  const res = await (await item(true)).GET(jsonRequest('GET'), ctx(ID))
  assert.equal(res.status, 500)
  assert.equal((await res.json()).code, 'server-error')
})

// ------------------------------------------------------------------ PATCH

test('PATCH: a valid save normalises the title and preserves the expected revision', async () => {
  repoReplies.updateDraft = { ok: true, value: draft({ title: 'Draft two', revision: 5 }) }
  const res = await (await item(true)).PATCH(
    jsonRequest('PATCH', { title: '  Draft two  ', essay: 'Revised.', expectedRevision: 4 }),
    ctx(ID),
  )

  assert.equal(res.status, 200)
  const [, id, input] = called('updateDraft')[0].args as [unknown, string, Record<string, unknown>]
  assert.equal(id, ID)
  assert.deepEqual(input, { title: 'Draft two', essay: 'Revised.', expectedRevision: 4 })

  const { draft: returned } = await res.json()
  assert.equal(returned.revision, 5)
  assert.equal('userId' in returned, false)
})

test('PATCH: a stale save is 409 carrying only the stored revision', async () => {
  repoReplies.updateDraft = {
    ok: false, reason: 'conflict', detail: 'stored revision 7', storedRevision: 7,
  }
  const res = await (await item(true)).PATCH(
    jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 4 }), ctx(ID),
  )

  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.code, 'conflict')
  assert.equal(body.storedRevision, 7)
  // The stored TITLE and ESSAY are not disclosed to a caller who lost the race.
  assert.equal('draft' in body, false)
  assert.equal('essay' in body, false)
  assert.equal('title' in body, false)
})

test('PATCH: an invalid expectedRevision is refused before the repository', async () => {
  const mod = await item(true)
  for (const expectedRevision of [0, -1, 1.5, '4', null, undefined, NaN, Number.MAX_SAFE_INTEGER]) {
    const res = await mod.PATCH(
      jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision }), ctx(ID),
    )
    assert.equal(res.status, 400, String(expectedRevision))
    assert.equal((await res.json()).code, 'invalid-revision')
  }
  assert.equal(called('updateDraft').length, 0)
})

test('PATCH: a body `revision` is not a substitute for `expectedRevision`', async () => {
  // Only expectedRevision is read. Sending `revision` alone leaves it absent.
  const res = await (await item(true)).PATCH(
    jsonRequest('PATCH', { title: 't', essay: 'e', revision: 4 }), ctx(ID),
  )
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'invalid-revision')
  assert.equal(called('updateDraft').length, 0)
})

test('PATCH: hostile timestamps and ids never reach the repository input', async () => {
  repoReplies.updateDraft = { ok: true, value: draft({ revision: 5 }) }
  await (await item(true)).PATCH(jsonRequest('PATCH', {
    title: 't', essay: 'e', expectedRevision: 4,
    id: OTHER_ID, userId: 'attacker', user_id: 'attacker',
    updated_at: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
    savedAt: '2099-01-01T00:00:00.000Z',
    revision: 999,
  }), ctx(ID))

  const [, id, input] = called('updateDraft')[0].args as [unknown, string, Record<string, unknown>]
  // The PATH id won.
  assert.equal(id, ID)
  assert.notEqual(id, OTHER_ID)
  // And the input is exactly the three validated fields.
  assert.deepEqual(Object.keys(input).sort(), ['essay', 'expectedRevision', 'title'])
  assert.equal(input.expectedRevision, 4)
  assert.equal(JSON.stringify(input).includes('2099'), false)
  assert.equal(JSON.stringify(input).includes('attacker'), false)
  // updateDraft is called with THREE arguments: no timestamp can be smuggled in.
  assert.equal(called('updateDraft')[0].args.length, 3)
})

test('PATCH: a malformed id is refused before the repository, and before the body', async () => {
  const res = await (await item(true)).PATCH(
    jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 1 }), ctx('not-a-uuid'),
  )
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'invalid-id')
  assert.equal(called('updateDraft').length, 0)
})

test('PATCH: malformed JSON and non-object bodies are 400', async () => {
  const mod = await item(true)
  const bad = await mod.PATCH(jsonRequest('PATCH', '{ not json'), ctx(ID))
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'malformed-json')

  const arr = await mod.PATCH(jsonRequest('PATCH', '[]'), ctx(ID))
  assert.equal(arr.status, 400)
  assert.equal((await arr.json()).code, 'not-an-object')
  assert.equal(called('updateDraft').length, 0)
})

test('PATCH: a missing or hidden draft is 404, a failure is 500', async () => {
  const mod = await item(true)

  repoReplies.updateDraft = { ok: false, reason: 'not-found', detail: '' }
  const missing = await mod.PATCH(
    jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 1 }), ctx(OTHER_ID),
  )
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'not-found')

  repoReplies.updateDraft = { ok: false, reason: 'update-failed', detail: '08006 connection failure' }
  const broken = await mod.PATCH(
    jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 1 }), ctx(ID),
  )
  assert.equal(broken.status, 500)
  assert.equal((await broken.json()).code, 'server-error')
})

// ----------------------------------------------------------------- DELETE

test('DELETE: removes the path id and answers with it', async () => {
  repoReplies.deleteDraft = { ok: true, value: { id: ID } }
  const res = await (await item(true)).DELETE(jsonRequest('DELETE'), ctx(ID))

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { id: ID })
  assert.equal(called('deleteDraft')[0].args[1], ID)
})

test('DELETE: a malformed id is refused before the repository', async () => {
  const res = await (await item(true)).DELETE(jsonRequest('DELETE'), ctx('nope'))
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'invalid-id')
  assert.equal(called('deleteDraft').length, 0)
})

test('DELETE: a missing or hidden draft is 404, a failure is 500', async () => {
  const mod = await item(true)

  repoReplies.deleteDraft = { ok: false, reason: 'not-found', detail: '' }
  const missing = await mod.DELETE(jsonRequest('DELETE'), ctx(OTHER_ID))
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'not-found')

  repoReplies.deleteDraft = { ok: false, reason: 'delete-failed', detail: '08006 connection failure' }
  const broken = await mod.DELETE(jsonRequest('DELETE'), ctx(ID))
  assert.equal(broken.status, 500)
  assert.equal((await broken.json()).code, 'server-error')
})

// ------------------------------------------------------------------ leakage

test('LEAKAGE: a database detail quoting an essay never reaches the response', async () => {
  // The distinctive string would be unmistakable if it escaped.
  const SECRET = 'MY-SECRET-ESSAY-PHRASE-ariadne-in-the-trauma-bay'
  const detail = `23514 new row violates check constraint; failing row contains (${SECRET})`

  const mod = await item(true)
  const collectionMod2 = await collection(true)

  repoReplies.updateDraft = { ok: false, reason: 'update-failed', detail }
  repoReplies.readDraft = { ok: false, reason: 'data-integrity', detail }
  repoReplies.deleteDraft = { ok: false, reason: 'delete-failed', detail }
  repoReplies.createDraft = { ok: false, reason: 'create-failed', detail }
  repoReplies.listDrafts = { ok: false, reason: 'list-failed', detail }

  const responses = [
    await mod.PATCH(jsonRequest('PATCH', { title: 't', essay: 'e', expectedRevision: 1 }), ctx(ID)),
    await mod.GET(jsonRequest('GET'), ctx(ID)),
    await mod.DELETE(jsonRequest('DELETE'), ctx(ID)),
    await collectionMod2.POST(jsonRequest('POST', { title: 't', essay: 'e' })),
    await collectionMod2.GET(),
  ]

  for (const res of responses) {
    assert.equal(res.status, 500)
    const text = await res.text()
    assert.equal(text.includes(SECRET), false, 'the essay fragment must not be in the body')
    assert.equal(text.includes('23514'), false, 'the Postgres code must not be in the body')
    assert.equal(text.includes('check constraint'), false)
    assert.equal(text.includes('failing row'), false)
    assert.deepEqual(JSON.parse(text), {
      error: 'Something went wrong saving your draft. Please try again.',
      code: 'server-error',
    })
  }
})
