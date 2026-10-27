import test, { after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { STATEMENT_STUDIO_HIDDEN_BODY } from '../../../../lib/statement/studioGate.ts'
import { SERVER_ERROR_BODY } from '../../../../lib/statement/draft/http.ts'

/**
 * The active prompt catalog endpoint.
 *
 * ITS OWN HARNESS, AND ITS OWN PROCESS. `mock.module` installs are
 * process-wide, and `node --test` runs one process per file, so this file
 * cannot share the draft routes' mocks and must not try to: it installs its own
 * for `next/server`, lib/apiAuth.ts and lib/statement/draft/promptRepo.ts. The
 * draft route tests are not modified and are not loaded here.
 *
 * TWO KINDS OF TEST, following app/api/statement/drafts/route.test.ts.
 *
 * PART 1 reads the SOURCE, for properties execution can only sample: that the
 * gate is the first thing the handler does, that the table is never named here,
 * that no service-role client exists, that admit() is byte-for-byte the draft
 * routes'. A single passing request does not prove a path that does not exist.
 *
 * PART 2 INVOKES the handler with the repository, the auth module and
 * `next/server` mocked, for what only execution establishes: status codes,
 * response bodies, and exactly what the repository is handed.
 *
 * NO REAL SUPABASE, NO NETWORK, NO CREDENTIALS. The repository is replaced
 * wholesale, so no statement is ever issued. `createClient` is left real but
 * inert -- constructed from fixture values with autoRefreshToken and
 * persistSession off, and nothing ever calls it, because the module that would
 * is mocked.
 */

// Fixture values, set before anything constructs a client. Not credentials:
// nothing here reaches the network, and the repository is mocked out entirely.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'

/**
 * THE STUDIO MODE BASELINE FOR THIS FILE IS 'general'.
 *
 * Every behaviour test here describes a normal authenticated applicant. Left
 * unset, the gate would default to 'internal' and answer all of them 404, which
 * would be a test of the gate rather than of the route. The gate tests set the
 * mode they need through withMode(), which restores it when that test ends.
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
 * THE GATE-HIDDEN BODY: spelled out, AND checked against the real constant, so
 * that this file and the draft route tests assert the same bytes.
 */
const GATE_HIDDEN = { error: 'Not found.', code: 'not-found' }
const UNAUTHENTICATED = {
  error: 'You must be signed in to work on a statement.', code: 'unauthenticated',
}
const INVALID_SCHOOL = {
  error: 'That school is not one this editor can look up.', code: 'invalid-school',
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../../..')
const AUTH_MODULE = path.join(ROOT, 'lib', 'apiAuth.ts')
const PROMPT_MODULE = path.join(ROOT, 'lib', 'statement', 'draft', 'promptRepo.ts')

const SRC = readFileSync(path.join(HERE, 'route.ts'), 'utf8')
/**
 * The same source with commentary removed.
 *
 * The header and the helper comments legitimately discuss the catalog -- its
 * ordering, its policy, the table the repository reads -- and a word blacklist
 * run over the raw text would match that prose rather than any code. CODE is
 * the view those assertions want. A guard test proves the stripping removed
 * commentary and nothing else.
 */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
const DRAFTS_DIR = path.join(ROOT, 'app', 'api', 'statement', 'drafts')
const COLLECTION_SRC = readFileSync(path.join(DRAFTS_DIR, 'route.ts'), 'utf8')
const ITEM_SRC = readFileSync(path.join(DRAFTS_DIR, '[id]', 'route.ts'), 'utf8')

const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000001'
const PROMPT = 'c0ffee00-0000-4000-8000-000000000002'
const PROMPT_B = 'c0ffee00-0000-4000-8000-000000000003'
const WORDING = 'Why have you chosen nurse anaesthesia?'

// ==========================================================================
// PART 1 -- the source
// ==========================================================================

/** The handler body, for order-of-operations assertions. */
const GET_BODY = SRC.slice(SRC.indexOf('export async function GET'))

test('source: the GATE IS THE FIRST THING the handler does', () => {
  const gate = GET_BODY.indexOf('await admit()')
  const query = GET_BODY.indexOf('schoolIdOf(request)')
  const read = GET_BODY.indexOf('listActivePrompts(')
  assert.ok(gate >= 0 && query > gate, 'the query string is read after the gate')
  assert.ok(read > query, 'the database is reached after the id is validated')
})

test('source: admit() is BYTE-FOR-BYTE the draft routes’', () => {
  // All Studio endpoints must be gated the same way, and the cheapest way to be
  // sure of that is for there to be nothing to compare.
  const body = (source: string) => {
    const start = source.indexOf('async function admit()')
    const end = source.indexOf('\n}\n', start)
    assert.ok(start >= 0 && end > start, 'admit() was located')
    return source.slice(start, end)
  }
  assert.equal(body(SRC), body(COLLECTION_SRC))
  assert.equal(body(SRC), body(ITEM_SRC))
})

test('source: the comment-stripped view kept the code and dropped the prose', () => {
  // The guard for every CODE assertion below.
  assert.equal(CODE.includes('export async function GET'), true, 'code survived')
  assert.equal(CODE.includes('listActivePrompts(caller.db, schoolId)'), true, 'code survived')
  assert.equal(CODE.includes('THE GATE IS WHY THIS ENDPOINT EXISTS'), false, 'prose removed')
  assert.equal(CODE.includes('display_order, then label'), false, 'prose removed')
})

test('source: this file NEVER NAMES A TABLE and never duplicates the query', () => {
  // Judged on CODE, not on words: the comments discuss the catalog's ordering
  // and its policy on purpose, which is a notice, not a query.
  for (const forbidden of [
    "from('statement_prompts')", "from('statement_drafts')", '.from(',
    "select('*')", '.select(', '.eq(', '.order(',
    'display_order', 'is_active', 'prompt_text', 'school_id',
  ]) {
    assert.equal(CODE.includes(forbidden), false, `${forbidden} belongs to promptRepo`)
  }
  assert.equal(CODE.includes('listActivePrompts'), true, 'the committed reader is called')
})

test('source: NO SERVICE ROLE, and no write of any kind', () => {
  for (const forbidden of [
    'SERVICE_ROLE', 'service_role', 'SUPABASE_SERVICE',
    '.insert(', '.update(', '.upsert(', '.delete(', '.rpc(',
    'POST', 'PATCH', 'PUT', 'DELETE',
  ]) {
    assert.equal(CODE.includes(forbidden), false, `${forbidden} must not appear`)
  }
    // THE CLIENT MOVED, THE PROPERTY DID NOT. Every statement path now takes
    // its client from statementDbClient(), which is asserted to hold the anon
    // key and no service role in lib/statement/devMode/writeIsolation.test.ts.
    assert.match(CODE, /statementDbClient\(token,/)
})

test('source: per-request by construction, like every other Studio route', () => {
  assert.match(SRC, /export const dynamic = 'force-dynamic'/)
  // GET is the only handler exported.
  assert.deepEqual(SRC.match(/^export async function [A-Z]+/gm), ['export async function GET'])
})

test('source: the draft routes were not touched, and do not know this one', () => {
  for (const source of [COLLECTION_SRC, ITEM_SRC]) {
    assert.equal(source.includes('listActivePrompts'), false)
    assert.equal(source.includes('/api/statement/prompts'), false)
    assert.equal(source.includes('invalid-school'), false)
  }
  // Nor does either name the catalog table, which is still promptRepo's alone.
  for (const source of [COLLECTION_SRC, ITEM_SRC]) {
    assert.equal(source.includes("from('statement_prompts')"), false)
  }
})

test('source: `getAll` not `get`, so two parameters cannot read as one', () => {
  assert.match(SRC, /searchParams\.getAll\('schoolId'\)/)
  assert.equal(SRC.includes("searchParams.get('schoolId')"), false)
  assert.match(SRC, /supplied\.length !== 1/)
})

// ==========================================================================
// PART 2 -- invocation
// ==========================================================================

assert.ok(
  typeof mock.module === 'function',
  'Part 2 needs --experimental-test-module-mocks; without it the route cannot be loaded with isolated mocks',
)

const FAKE_USER = { userId: 'u1', email: 'applicant@example.test', tier: 'free', isUltimate: false }

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

  // `next/server`, because bare Node cannot resolve it. The substitute returns
  // a REAL standards Response, so status, headers and body behave exactly as
  // one.
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
  // `readAccessToken` COUNTS ITS CALLS, which is how the tests observe that a
  // blocked caller never gets as far as token or client work.
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

  // The catalog reader, replaced wholesale: no statement is ever issued, and
  // every call is recorded so the tests can assert exactly what it was handed.
  mock.module(PROMPT_MODULE, {
    namedExports: {
      listActivePrompts: recorded('listActivePrompts'),
      readActivePrompt: recorded('readActivePrompt'),
      promptSnapshotFromRow: () => null,
      promptOptionFromRow: () => null,
    },
  })
}

type Route = { GET: (request: unknown) => Promise<Response> }
let routeMod: Route | null = null

async function route(authed: boolean): Promise<Route> {
  installMocksOnce()
  session = authed ? FAKE_USER : null
  if (!routeMod) routeMod = (await import('./route.ts')) as unknown as Route
  return routeMod
}

/** A request carrying a query string. A real URL, so getAll() is the real one. */
const request = (query: string) =>
  ({ nextUrl: new URL(`https://fixture.test/api/statement/prompts${query}`) })

const called = (fn: string) => repoCalls.filter((c) => c.fn === fn)
const option = (over: Record<string, unknown> = {}) => ({
  id: PROMPT,
  label: 'Essay 1',
  promptText: WORDING,
  statedMaxWords: 500,
  applicationCycle: '2026',
  ...over,
})

// ------------------------------------------------------------------ the gate

test('GATE: the spelled-out hidden body matches the real constant', () => {
  assert.deepEqual(GATE_HIDDEN, STATEMENT_STUDIO_HIDDEN_BODY)
})

test('GATE: internal mode HIDES this endpoint from a non-admin', async (t) => {
  withMode(t, 'internal')
  const mod = await route(true)
  admin = false

  const res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), GATE_HIDDEN)
  // A public SELECT policy on the catalog must not admit anyone here.
  assert.equal(called('listActivePrompts').length, 0, 'the catalog must not be read')
  assert.equal(tokenReads, 0, 'no token is read for a blocked caller')
})

test('GATE: internal mode ADMITS an administrator', async (t) => {
  withMode(t, 'internal')
  const mod = await route(true)
  admin = true
  repoReplies.listActivePrompts = { ok: true, value: [] }

  const res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { prompts: [] })
})

test('GATE: an unauthenticated caller never reaches the catalog', async (t) => {
  // internal -> hidden 404; general -> sign in 401. Neither reads a row.
  withMode(t, 'internal')
  let mod = await route(false)
  let res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), GATE_HIDDEN)

  withMode(t, 'general')
  mod = await route(false)
  res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), UNAUTHENTICATED)

  assert.equal(called('listActivePrompts').length, 0)
  assert.equal(tokenReads, 0)
})

test('GATE: the mode is read per request, not once per process', async (t) => {
  withMode(t, 'internal')
  const mod = await route(true)
  admin = false
  assert.equal((await mod.GET(request(`?schoolId=${SCHOOL}`))).status, 404)

  process.env.STATEMENT_STUDIO_MODE = 'general'
  repoReplies.listActivePrompts = { ok: true, value: [] }
  assert.equal((await mod.GET(request(`?schoolId=${SCHOOL}`))).status, 200)
})

// ------------------------------------------------------------ the school id

test('ID: an authorized caller with a valid id gets 200', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = { ok: true, value: [option()] }
  const res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  assert.equal(res.status, 200)
})

test('ID: missing, empty, malformed and DUPLICATE ids are all 400', async () => {
  const mod = await route(true)
  for (const query of [
    '',                                        // no query string at all
    '?',                                       // empty query string
    '?schoolId=',                              // present but empty
    '?schoolId=%20',                           // a space
    '?schoolId=not-a-uuid',
    `?schoolId=${SCHOOL}0`,                    // one character too long
    `?schoolId=${SCHOOL.slice(0, -1)}`,        // one too short
    `?schoolId=${SCHOOL}&schoolId=${PROMPT}`,  // TWO parameters
    `?schoolId=${SCHOOL}&schoolId=${SCHOOL}`,  // the same one twice
    '?school_id=' + SCHOOL,                    // the column name is not the key
    `?SchoolId=${SCHOOL}`,                     // keys are case-sensitive
  ]) {
    repoCalls = []
    const res = await mod.GET(request(query))
    assert.equal(res.status, 400, query || '(no query)')
    assert.deepEqual(await res.json(), INVALID_SCHOOL, query || '(no query)')
    assert.equal(called('listActivePrompts').length, 0, `${query} must not query`)
  }
})

test('ID: a uuid in any case is accepted, and is passed through unchanged', async () => {
  const mod = await route(true)
  for (const id of [SCHOOL, SCHOOL.toUpperCase()]) {
    repoCalls = []
    repoReplies.listActivePrompts = { ok: true, value: [] }
    assert.equal((await mod.GET(request(`?schoolId=${id}`))).status, 200)
    // Postgres compares uuids by value, so case is not this route's to change.
    assert.equal(called('listActivePrompts')[0].args[1], id)
  }
})

test('ID: an extra unrelated parameter is ignored, not refused', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = { ok: true, value: [] }
  const res = await mod.GET(request(`?schoolId=${SCHOOL}&cycle=2026&promptId=${PROMPT}`))
  assert.equal(res.status, 200)
  // And nothing but the school id reached the reader.
  assert.deepEqual(called('listActivePrompts')[0].args.length, 2)
})

test('ID: a VALID id with no prompts is NOT a validation failure', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = { ok: true, value: [] }
  const res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  assert.equal(res.status, 200)
  assert.notEqual(res.status, 400)
  assert.notEqual(res.status, 404)
})

test('ID: the refusal body echoes nothing the caller sent', async () => {
  const mod = await route(true)
  const res = await mod.GET(request('?schoolId=deadbeef-not-a-uuid'))
  const body = await res.json()
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error'])
  assert.equal(JSON.stringify(body).includes('deadbeef'), false)
})

// --------------------------------------------------------- what is handed on

test('READ: the EXACT uuid and the CALLER-SCOPED client are passed on', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = { ok: true, value: [] }
  await mod.GET(request(`?schoolId=${SCHOOL}`))

  const call = called('listActivePrompts')
  assert.equal(call.length, 1, 'exactly one read')
  assert.equal(call[0].args.length, 2)
  const [db, id] = call[0].args as [Record<string, unknown>, string]
  assert.equal(id, SCHOOL)

  // A Supabase client built from the anon key and the CALLER's bearer token --
  // not a service-role client, and not a module-level singleton.
  assert.equal(typeof db, 'object')
  assert.ok(db !== null)
  assert.ok('from' in db, 'a Supabase client was handed over')
  assert.equal(tokenReads, 1, 'the caller’s own token was read, once')
})

test('READ: the route issues ONE read and never writes', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = { ok: true, value: [option()] }
  await mod.GET(request(`?schoolId=${SCHOOL}`))

  assert.equal(repoCalls.length, 1, 'one repository call in total')
  assert.equal(called('listActivePrompts').length, 1)
  assert.equal(called('readActivePrompt').length, 0, 'the single resolver is not this route’s')
  // No write function exists to call: the module exports none, and the route
  // names none. PART 1 asserts the source side.
  for (const fn of ['createPrompt', 'updatePrompt', 'deletePrompt']) {
    assert.equal(called(fn).length, 0)
  }
})

// ------------------------------------------------------------- the responses

test('OK: an empty catalog is 200 with an empty array', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = { ok: true, value: [] }
  const res = await mod.GET(request(`?schoolId=${SCHOOL}`))

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, { prompts: [] })
  assert.deepEqual(Object.keys(body), ['prompts'])
  assert.equal(Array.isArray(body.prompts), true)
})

test('OK: MULTIPLE prompts keep the repository’s order and exactly five fields', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = {
    ok: true,
    value: [
      option({ id: PROMPT, label: 'Essay 1' }),
      option({ id: PROMPT_B, label: 'Essay 2', statedMaxWords: 750 }),
    ],
  }
  const res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  const { prompts } = await res.json()

  assert.equal(prompts.length, 2)
  assert.deepEqual(prompts.map((p: { id: string }) => p.id), [PROMPT, PROMPT_B])
  assert.deepEqual(prompts.map((p: { label: string }) => p.label), ['Essay 1', 'Essay 2'])
  for (const prompt of prompts) {
    assert.deepEqual(Object.keys(prompt).sort(),
      ['applicationCycle', 'id', 'label', 'promptText', 'statedMaxWords'])
    // Not a draft snapshot: no schoolId, and nothing a draft would carry.
    for (const absent of ['schoolId', 'displayOrder', 'isActive', 'createdAt', 'updatedAt']) {
      assert.equal(absent in prompt, false, `${absent} must not be returned`)
    }
  }
})

test('OK: the route does not RESHAPE what the reader returned', async () => {
  // Whatever the reader hands over is what goes out, so a field cannot be added
  // to a response by being added here.
  const mod = await route(true)
  const value = [option()]
  repoReplies.listActivePrompts = { ok: true, value }
  const { prompts } = await (await mod.GET(request(`?schoolId=${SCHOOL}`))).json()
  assert.deepEqual(prompts, value)
})

test('OK: a NULL word limit and a NULL cycle serialise as explicit nulls', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = {
    ok: true,
    value: [option({ statedMaxWords: null, applicationCycle: null })],
  }
  const { prompts } = await (await mod.GET(request(`?schoolId=${SCHOOL}`))).json()

  // Present and null, never omitted: a school stating no limit is a real fact,
  // and an absent key is indistinguishable from a server too old to send it.
  assert.equal('statedMaxWords' in prompts[0], true)
  assert.equal('applicationCycle' in prompts[0], true)
  assert.equal(prompts[0].statedMaxWords, null)
  assert.equal(prompts[0].applicationCycle, null)
})

test('OK: the wording is returned verbatim', async () => {
  const mod = await route(true)
  const shaped = '  First paragraph.\n\n    Indented second.  '
  repoReplies.listActivePrompts = { ok: true, value: [option({ promptText: shaped })] }
  const { prompts } = await (await mod.GET(request(`?schoolId=${SCHOOL}`))).json()
  assert.equal(prompts[0].promptText, shaped)
})

// -------------------------------------------------------------- the failures

test('FAIL: read-failed is the generic 500', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = {
    ok: false, reason: 'read-failed', detail: '08006 connection failure',
  }
  const res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), SERVER_ERROR_BODY)
})

test('FAIL: data-integrity is the SAME generic 500', async () => {
  const mod = await route(true)
  repoReplies.listActivePrompts = {
    ok: false, reason: 'data-integrity', detail: 'unusable stored row (prompt-option)',
  }
  const res = await mod.GET(request(`?schoolId=${SCHOOL}`))
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), SERVER_ERROR_BODY)
})

test('FAIL: NO DETAIL, WORDING OR DIAGNOSTIC LEAKS INTO A RESPONSE', async () => {
  const mod = await route(true)
  for (const refusal of [
    {
      ok: false, reason: 'read-failed',
      detail: `42501 permission denied for table statement_prompts; row contains ${WORDING}`,
    },
    { ok: false, reason: 'data-integrity', detail: 'unusable stored row (prompt-option)' },
  ]) {
    repoReplies.listActivePrompts = refusal
    const res = await mod.GET(request(`?schoolId=${SCHOOL}`))
    const text = await res.text()

    assert.equal(res.status, 500)
    assert.deepEqual(JSON.parse(text), SERVER_ERROR_BODY)
    for (const leak of [
      '42501', 'permission denied', 'statement_prompts', 'unusable stored row',
      'anaesthesia', 'prompt-option', 'read-failed', 'data-integrity', SCHOOL,
    ]) {
      assert.equal(text.includes(leak), false, `${leak} must never be sent`)
    }
  }
})

test('FAIL: a 5xx body is the SHARED constant, not a sentence written here', async () => {
  assert.equal(CODE.includes('SERVER_ERROR_BODY'), true)
  // No prose of its own: the only string literals in this file that a caller
  // could receive are the one refusal body and the shared constants it imports.
  const sentences = CODE.match(/error: '[^']+'/g) ?? []
  assert.deepEqual(sentences, ["error: 'That school is not one this editor can look up.'"])
})
