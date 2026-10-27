import test, { after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { STATEMENT_STUDIO_HIDDEN_BODY } from '../../../../lib/statement/studioGate.ts'

/**
 * The document-upload endpoint.
 *
 * TWO KINDS OF TEST, AND THE DIFFERENCE MATTERS.
 *
 * PART 1 asserts ORDERING and ABSENCE properties against the route's SOURCE.
 * This follows lib/statement/route.test.ts, which does the same for the analyzer
 * and explains why: "authentication happens before the body is read" and "no
 * ledger row is ever written" are properties an integration test can only sample,
 * and a reading can prove. Part 1 needs no flags and no mocks.
 *
 * PART 2 INVOKES the handler with an isolated authentication mock, for the things
 * only execution can establish: status codes, headers, and the multipart envelope
 * boundary. It needs `--experimental-test-module-mocks`.
 *
 * WHAT NEITHER PART IS. This is not proof of a real deployed HTTP request. No
 * server is started, no socket is opened, and nothing here exercises Next's own
 * request pipeline, its body-size handling or Vercel's. A mocked invocation of
 * POST() is a function call. Real HTTP verification is a separate step.
 *
 * NO PRODUCTION CREDENTIALS. The authentication mock returns a fixed fictional
 * user. `authenticateRequest` -- the only thing that reads a cookie or contacts
 * Supabase -- is replaced, so no session, key or network call is involved. The
 * route does read one environment variable of its own now, STATEMENT_STUDIO_MODE,
 * which these tests set and restore themselves; it is a rollout flag, not a
 * credential.
 */

const ROUTE_PATH = '../../../../app/api/statement/extract/route.ts'
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SOURCE = read('./route.ts')
const CODE = strip(SOURCE)
const POST = CODE.slice(CODE.indexOf('export async function POST'))

const before = (haystack: string, first: string, second: string) => {
  const a = haystack.indexOf(first)
  const b = haystack.indexOf(second)
  assert.ok(a >= 0, `${first} is absent`)
  assert.ok(b >= 0, `${second} is absent`)
  assert.ok(a < b, `${first} does not run before ${second}`)
}

/**
 * THE STUDIO MODE BASELINE FOR THIS FILE IS 'general'.
 *
 * Every extraction test here describes a NORMAL authenticated applicant --
 * sizes, formats, scans, budgets, refusal codes. 'general' is the mode that
 * admits one. Left unset the gate defaults to 'internal' and answers all of them
 * 404, which would test the gate instead of the extractor.
 *
 * The gate tests set the mode they need through withMode(), which restores it
 * when that test ends, and beforeEach() restores this baseline regardless. The
 * process value is put back in after().
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
 * It is STATEMENT_STUDIO_HIDDEN_BODY from lib/statement/studioGate.ts, which all
 * five Studio endpoints now import, so one identical response is sent by
 * construction rather than by three copies agreeing. Spelling it out here means
 * a change to that constant has to be acknowledged in this file; checking it
 * against the import means this file and
 * app/api/statement/drafts/route.test.ts are asserting the same bytes, which is
 * how the two families are proven byte-equivalent across two test processes.
 *
 * Note what it is NOT: the draft not-found body. This route reads uploaded
 * files and has no drafts to report missing.
 */
const GATE_HIDDEN = { error: 'Not found.', code: 'not-found' }

// ===================================================================
// PART 1 — ordering and absence, proven by reading
// ===================================================================

test('route: authentication happens before the body is read or parsed', () => {
  before(POST, 'authenticateRequest()', 'request.formData()')
  before(POST, 'authenticateRequest()', "request.headers.get('content-length')")
  // And it is the very first thing in the handler.
  const firstStatement = POST.slice(POST.indexOf('{'), POST.indexOf('{') + 200)
  assert.match(firstStatement, /authenticateRequest\(\)/)
})

test('route: the Studio gate is the first thing the handler does', () => {
  before(POST, 'statementStudioMode()', 'authenticateRequest()')
  before(POST, 'authenticateRequest()', 'statementStudioAccess(')
  // Nothing touches the request until the gate has allowed it.
  before(POST, 'statementStudioAccess(', "request.headers.get('content-type')")
  before(POST, 'statementStudioAccess(', "request.headers.get('content-length')")
  before(POST, 'statementStudioAccess(', 'request.formData()')
  before(POST, 'statementStudioAccess(', 'extractDocument(')
  // And the mode is determined before anything else at all.
  const firstStatement = POST.slice(POST.indexOf('{'), POST.indexOf('{') + 200)
  assert.match(firstStatement, /statementStudioMode\(\)/)
})

test('route: the gate is the STATEMENT one, and there is no 403 anywhere', () => {
  assert.ok(SOURCE.includes("from '@/lib/statement/studioGate'"))
  assert.ok(SOURCE.includes('const mode = statementStudioMode()'))
  assert.ok(SOURCE.includes('isAdmin: isAdminEmail(auth?.email)'))
  // Never the resume cutover flag: that would release the Studio the day
  // resumes are cut over.
  for (const forbidden of ['RESUME_BUILDER_MODE', 'resumeBuilderMode', 'resumeV2Access']) {
    assert.equal(SOURCE.includes(forbidden), false, `${forbidden} must not appear`)
  }
  assert.equal(/\b403\b/.test(CODE), false, 'a hidden endpoint must never answer 403')
})

test('route: Content-Length is consulted before the body is buffered', () => {
  before(POST, "request.headers.get('content-length')", 'request.formData()')
})

test('route: the content type is checked before multipart parsing is attempted', () => {
  before(POST, "request.headers.get('content-type')", 'request.formData()')
})

test('route: the multipart allowance is above the file limit, not equal to it', () => {
  // A valid 4,000,000-byte file arrives inside a larger envelope. Guarding on the
  // file limit alone would refuse it.
  assert.match(CODE, /MAX_DECLARED_BODY_BYTES\s*=\s*MAX_UPLOAD_BYTES\s*\+\s*MULTIPART_OVERHEAD_ALLOWANCE/)
  assert.match(CODE, /MULTIPART_OVERHEAD_ALLOWANCE\s*=\s*64\s*\*\s*1024/)
})

test('route: the measured file size is checked as well as the declared one', () => {
  // The declared header narrows the window; the measurement is the control.
  assert.match(POST, /file\.size\s*>\s*MAX_UPLOAD_BYTES/)
  before(POST, 'content-length', 'file.size')
})

test('route: exactly one file is required — more than one is refused, not chosen from', () => {
  assert.match(POST, /files\.length\s*===\s*0/)
  assert.match(POST, /files\.length\s*>\s*1/)
  assert.match(POST, /'too-many-files'/)
})

test('route: NO ANALYSIS ALLOWANCE IS CONSUMED — the ledger is never imported', () => {
  // An absence property, and the reason Part 1 exists. A route that imports none
  // of these cannot write a usage row on any path, reached or unreached.
  for (const forbidden of [
    'recordStatementAttempt',
    'settleStatementUsage',
    'statementRateDecision',
    'STATEMENT_OPERATIONS',
    'statement_ai_usage',
  ]) {
    assert.equal(CODE.includes(forbidden), false, `${forbidden} appears in the route`)
  }
  // Nor any import from the usage or entitlement modules.
  assert.doesNotMatch(CODE, /from '@\/lib\/statement\/(usage|entitlement)'/)
})

test('route: no model client and no signing key is reachable from here', () => {
  for (const forbidden of ['OpenAI', 'openai', 'anthropic', 'signAnalysis', 'createClient']) {
    assert.equal(CODE.includes(forbidden), false, `${forbidden} appears in the route`)
  }
})

test('route: nothing is written to a database and no service role exists', () => {
  assert.equal(CODE.includes('SERVICE_ROLE'), false)
  assert.equal(CODE.includes('.insert('), false)
  assert.equal(CODE.includes('.upsert('), false)
  assert.equal(CODE.includes('.from('), false)
})

test('route: the diagnostic detail never reaches the response body', () => {
  // `detail` is a server-side word. The client gets `error`, `code`, and a count.
  const body = POST.slice(POST.indexOf('const body: Record<string, unknown>'))
  assert.equal(/body\.detail/.test(CODE), false, 'detail is assigned into a response body')
  assert.doesNotMatch(body, /detail/)
})

test('route: only fixed words are ever logged, never text or an error object', () => {
  const logs = CODE.match(/console\.\w+\([^)]*\)/g) ?? []
  assert.ok(logs.length > 0, 'no logging at all would hide a fenced process')
  for (const call of logs) {
    // THE ARGUMENTS, NOT THE WHOLE CALL.
    //
    // Scanning the call text made the `err` entry below match every single
    // `console.error(...)`, because the method name itself contains those three
    // letters. The method name is not evidence of anything; what is logged is.
    // The matching regex above stops at the first `)`, so the call it captured can
    // contain no inner parenthesis and this slice is unambiguous.
    //
    // LOWER-CASED, because the scan is by substring: without it `extractedText` or
    // `errorMessage` would slip past the lower-case entries below, and "document
    // text reached a log line" is precisely what this test exists to prevent.
    const args = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')')).toLowerCase()

    // Nothing that could carry a raw error, document content or an internal object.
    // Bare identifiers rather than `error)`/`outcome)`: now that only the arguments
    // are scanned, the trailing parenthesis is no longer needed to avoid the method
    // name, and dropping it catches `log(error, x)` as well as `log(error)`.
    for (const forbidden of ['text', 'bytes', 'file', 'error', 'err', 'stack', 'message', 'outcome']) {
      assert.equal(args.includes(forbidden), false, `${call} may log ${forbidden}`)
    }
  }
  // And the values that ARE logged are the fixed code plus the fixed detail.
  assert.match(CODE, /console\.error\('statement extract: refused —', code, detail \?\? ''\)/)
})

test('route: no extracted text can reach a log line', () => {
  assert.doesNotMatch(CODE, /console\.\w+\([^)]*outcome\.text/)
  assert.doesNotMatch(CODE, /console\.\w+\([^)]*\.text\b/)
})

test('route: a capacity refusal carries Retry-After and a stable code', () => {
  assert.match(CODE, /'pdf-capacity':\s*\{\s*status:\s*503/)
  assert.match(CODE, /headers\['Retry-After'\]\s*=\s*'2'/)
  assert.match(CODE, /code === 'pdf-capacity'/)
})

test('route: the cancellation signal is wired to the extractor', () => {
  assert.match(POST, /extractDocument\(bytes,\s*\{\s*signal:\s*request\.signal\s*\}\)/)
})

test('route: the route declares a duration and stays on the Node runtime', () => {
  assert.match(CODE, /export const maxDuration = 60/)
  assert.match(CODE, /export const dynamic = 'force-dynamic'/)
  // No edge declaration: worker_threads does not exist there.
  assert.equal(CODE.includes("runtime = 'edge'"), false)
})

test('route: every refusal code has a status and a message', () => {
  // A missing entry would be a runtime TypeError on an already-failing request.
  const dispatcher = strip(read('../../../../lib/statement/extract/extractDocument.ts'))
  const union = dispatcher.slice(
    dispatcher.indexOf('export type DocumentRefusal'),
    dispatcher.indexOf('export interface DocumentText'),
  )
  const codes = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  assert.ok(codes.length >= 15, `expected the full refusal union, found ${codes.length}`)
  const table = CODE.slice(CODE.indexOf('const REFUSALS'), CODE.indexOf('function refuse('))
  for (const code of codes) {
    assert.ok(
      table.includes(`'${code}'`) || table.includes(`${code}:`),
      `no response defined for refusal '${code}'`,
    )
  }
})

test('route: the existing analyzer and page are untouched by this feature', () => {
  // The guarantee that matters most to production: this endpoint is additive.
  const analyzer = read('../../../../app/api/analyze-statement/route.ts')
  assert.equal(analyzer.includes('statement/extract'), false, 'the analyzer now references the new library')
  assert.equal(analyzer.includes('extractDocument'), false)
  const page = read('../../../../app/personal-statement/PersonalStatementAnalyzer.tsx')
  assert.equal(page.includes('/api/statement/extract'), false, 'the page now calls the new endpoint')
})

// ===================================================================
// PART 2 — invoking the handler, with authentication mocked
// ===================================================================

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures/statement-worker')
const loadPdf = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(FIX, name)))
const SMALL_PDF = '01_statement_100kb_under_ceiling.pdf'

/** A fictional signed-in user. Nothing real, nothing from any environment. */
const FAKE_USER = { userId: '00000000-0000-4000-8000-000000000000', email: null, tier: 'free', isUltimate: false }

/**
 * THE CURRENT FICTIONAL SESSION, and the only thing that switches between the
 * authenticated and unauthenticated cases.
 *
 * The auth mock below is installed ONCE and reads this variable on every call.
 * The previous harness re-registered the mock per test, and Node rejects a second
 * `mock.module()` for the same resolved module with ERR_INVALID_STATE -- which is
 * what failed nine of the ten Group 4 tests before any assertion ran.
 */
let session: typeof FAKE_USER | null = null
let admin = false
let extractCalls = 0

const AUTH_MODULE = fileURLToPath(new URL('../../../../lib/apiAuth.ts', import.meta.url))
const EXTRACT_MODULE = fileURLToPath(
  new URL('../../../../lib/statement/extract/extractDocument.ts', import.meta.url),
)

/** Unauthenticated, non-admin, general mode: no test inherits another's setup. */
beforeEach(() => {
  session = null
  admin = false
  extractCalls = 0
  process.env.STATEMENT_STUDIO_MODE = 'general'
})

let mocksInstalled = false
let routePost: ((request: Request) => Promise<Response>) | null = null

/**
 * Installs both module mocks, exactly once.
 *
 * LAZY ON PURPOSE. Part 1 needs no mocks and runs without
 * `--experimental-test-module-mocks`; installing at module scope or in a `before`
 * hook would make the flag mandatory for the Part 1 selection too.
 */
async function installMocksOnce(): Promise<void> {
  if (mocksInstalled) return
  mocksInstalled = true

  assert.equal(
    typeof mock.module,
    'function',
    'Part 2 needs --experimental-test-module-mocks; without it the route cannot be loaded with isolated mocks',
  )

  // ---------------------------------------------------------------------
  // `next/server`, because bare Node cannot resolve it.
  //
  // `node_modules/next/server.js` exists but `next`'s package.json publishes no
  // `"./server"` entry in its `exports` map, so the specifier only resolves
  // through Next's own bundler. The production import must NOT change -- the
  // analyzer and transcript routes use exactly the same line and work in
  // production -- so the harness adapts instead.
  //
  // THE MOCK IS THE MINIMUM THE ROUTE ACTUALLY USES:
  //
  //   NextResponse.json(body, init)  the ONLY runtime Next API in route.ts,
  //                                  at seven call sites, with `{ status }` and
  //                                  in one case `{ status, headers }`.
  //   NextRequest                    type-only: a parameter annotation and a
  //                                  return type. Never constructed at runtime.
  //                                  The binding must still exist, because Node's
  //                                  type stripping does not elide unused imports
  //                                  and ESM linking would fail without it.
  //
  // The substitute returns a REAL standards `Response`. It is not a stand-in that
  // merely satisfies assertions: status, headers and the JSON body behave exactly
  // as a Response does, which is what the tests read.
  // ---------------------------------------------------------------------
  mock.module('next/server', {
    namedExports: {
      NextResponse: {
        json(
          body: unknown,
          init?: { status?: number; headers?: Record<string, string> },
        ): Response {
          return new Response(JSON.stringify(body), {
            status: init?.status ?? 200,
            headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
          })
        },
      },
      NextRequest: class NextRequestTypeOnlyPlaceholder {},
    },
  })

  // The session, from one fictional identity. No real user, no credential, no
  // network, no production auth path.
  mock.module(AUTH_MODULE, {
    namedExports: {
      authenticateRequest: async () => session,
      readAccessToken: async () => (session ? 'fictional-token' : null),
      isAdminEmail: () => admin,
      ADMIN_EMAILS: [] as readonly string[],
    },
  })

  // ---------------------------------------------------------------------
  // THE EXTRACTOR, WRAPPED RATHER THAN REPLACED.
  //
  // The real module is imported FIRST and then delegated to, so every test
  // below still exercises the genuine signature detection, capacity gate, time
  // budget and refusal codes -- no extraction behaviour is simulated, and the
  // module-level capacity state the simultaneous-PDF test contends for is the
  // same instance it always was.
  //
  // The wrapper exists for exactly one reason: to COUNT invocations, so that
  // "a blocked caller never causes extraction" is measured rather than inferred
  // from a status code.
  //
  // extractDocument.ts imports nothing from next and nothing from apiAuth, so
  // importing it here, after those two mocks, cannot contaminate it.
  // ---------------------------------------------------------------------
  const realExtract = (await import(pathToFileURL(EXTRACT_MODULE).href)) as {
    extractDocument: (...args: never[]) => Promise<unknown>
  }
  mock.module(EXTRACT_MODULE, {
    namedExports: {
      extractDocument: async (...args: never[]) => {
        extractCalls += 1
        return realExtract.extractDocument(...args)
      },
    },
  })
}

/**
 * The route's POST handler, with the session set for this test.
 *
 * THE ROUTE IS IMPORTED ONCE AND REUSED, with no cache-busting query string.
 * That matters for the simultaneous-PDF test: the capacity gate is module-level
 * state inside lib/statement/extract/extractDocument.ts, and both concurrent
 * requests must contend for the SAME gate instance. A fresh route per test would
 * also make "one 200, one 503" depend on module-cache behaviour rather than on
 * the gate, which is the thing under test.
 */
async function handler(authed: boolean): Promise<(request: Request) => Promise<Response>> {
  await installMocksOnce()
  session = authed ? FAKE_USER : null
  if (!routePost) {
    // Imported AFTER the mocks are installed. Both are in place by this line.
    const mod = await import('./route.ts')
    routePost = mod.POST as unknown as (request: Request) => Promise<Response>
  }
  return routePost
}

function upload(bytes: Uint8Array, filename = 'statement.txt', field = 'file'): Request {
  const form = new FormData()
  form.append(field, new File([bytes as unknown as BlobPart], filename))
  return new Request('http://localhost/api/statement/extract', { method: 'POST', body: form })
}

test('route: general mode — an unauthenticated request is 401 BEFORE the body is parsed', async (t) => {
  withMode(t, 'general')
  const POSTFn = await handler(false)
  // A body that would fail multipart parsing. A 401 rather than a 400 proves the
  // parse never ran.
  const broken = new Request('http://localhost/api/statement/extract', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=----nope' },
    body: 'this is not a valid multipart body',
  })
  const response = await POSTFn(broken)
  assert.equal(response.status, 401)
  const body = await response.json()
  assert.equal(body.code, 'unauthenticated')
})

// ------------------------------------------------------------- the Studio gate

/** One request, at the given identity. */
const post = async (authed: boolean, request: Request): Promise<Response> =>
  (await handler(authed))(request)

/** A TXT upload that WOULD succeed for an admitted caller. */
const goodUpload = () => upload(new Uint8Array(Buffer.from('My statement.', 'utf8')))

/** A body that would make multipart parsing throw. */
const brokenMultipart = () =>
  new Request('http://localhost/api/statement/extract', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=----nope' },
    body: 'this is not a valid multipart body',
  })

test('gate: internal — an anonymous upload gets the hidden 404 and no extraction', async (t) => {
  withMode(t, 'internal')
  const response = await post(false, goodUpload())
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), GATE_HIDDEN)
  assert.equal(extractCalls, 0, 'extraction must never be invoked for a blocked caller')
})

test('gate: internal — an authenticated NON-admin upload gets the hidden 404 and no extraction', async (t) => {
  withMode(t, 'internal')
  admin = false
  const response = await post(true, goodUpload())
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), GATE_HIDDEN)
  assert.equal(extractCalls, 0, 'a normal user must not be able to cause any extraction')
})

test('gate: internal — the two blocked responses are byte-identical', async (t) => {
  withMode(t, 'internal')
  const anonymous = await (await post(false, goodUpload())).text()
  admin = false
  const signedIn = await (await post(true, goodUpload())).text()
  assert.equal(anonymous, signedIn, 'a prober must not be able to tell the two cases apart')
  assert.equal(anonymous, JSON.stringify(GATE_HIDDEN))
  assert.equal(extractCalls, 0)
})

test('gate: internal — a blocked caller is refused before multipart parsing', async (t) => {
  withMode(t, 'internal')
  // A 404 rather than a 400 proves the parse never ran, exactly as the 401 test
  // above proves it for general mode.
  const response = await post(true, brokenMultipart())
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), GATE_HIDDEN)
  assert.equal(extractCalls, 0)
})

test('gate: internal — an oversized upload is hidden, not refused as too large', async (t) => {
  withMode(t, 'internal')
  // 413 would confirm the endpoint exists and reads sizes. 404 says nothing.
  const response = await post(
    true,
    new Request('http://localhost/api/statement/extract', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '99999999' },
      body: 'x',
    }),
  )
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), GATE_HIDDEN)
  assert.equal(extractCalls, 0)
})

test('gate: internal — the hidden answer names nothing, and is never 403', async (t) => {
  withMode(t, 'internal')
  const response = await post(true, goodUpload())
  assert.notEqual(response.status, 403, 'a hidden endpoint must never answer 403')
  const text = (await response.text()).toLowerCase()
  for (const word of [
    // The approved list.
    'draft', 'statement', 'studio', 'admin', 'internal', 'upload', 'extract',
    'forbidden', 'permission',
    // Plus these, which this body also does not contain: nothing reveals what
    // kind of endpoint refused the caller, or that signing in would help.
    'flag', 'beta', 'denied', 'role', 'sign', 'file',
  ]) {
    assert.equal(text.includes(word), false, `the hidden answer leaked "${word}"`)
  }
})

test('gate: the hidden body IS the gate constant, and names no draft', () => {
  assert.deepEqual(GATE_HIDDEN, STATEMENT_STUDIO_HIDDEN_BODY)
  assert.equal(JSON.stringify(GATE_HIDDEN), '{"error":"Not found.","code":"not-found"}')
  // The draft body this route used to send is gone from the route entirely.
  assert.equal(SOURCE.includes('NOT_FOUND_BODY'), false)
  assert.equal(SOURCE.includes('draft/http'), false, 'no dependency on the draft http module')
})

test('gate: internal — an authenticated ADMIN upload is extracted normally', async (t) => {
  withMode(t, 'internal')
  admin = true
  const response = await post(true, goodUpload())
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.format, 'txt')
  assert.equal(body.text, 'My statement.')
  assert.equal(extractCalls, 1, 'an admitted admin does reach extraction')
})

test('gate: general — an anonymous upload is 401, and still no extraction', async (t) => {
  withMode(t, 'general')
  const response = await post(false, goodUpload())
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'unauthenticated')
  assert.equal(extractCalls, 0)
})

test('gate: general — an authenticated NON-admin upload is extracted', async (t) => {
  withMode(t, 'general')
  admin = false
  const response = await post(true, goodUpload())
  assert.equal(response.status, 200, 'general mode is what one env change will turn on')
  assert.equal((await response.json()).text, 'My statement.')
  assert.equal(extractCalls, 1)
})

test('gate: general — an authenticated ADMIN upload is extracted too', async (t) => {
  withMode(t, 'general')
  admin = true
  const response = await post(true, goodUpload())
  assert.equal(response.status, 200)
  assert.equal(extractCalls, 1)
})

test('gate: an unknown or absent mode FAILS CLOSED to internal', async (t) => {
  // One registration, so the restore runs once however many values are tried.
  withMode(t, 'internal')
  admin = false

  for (const value of ['beta', 'v2', 'on', 'true', '1', '', ' ', 'GENERALLY', 'general,beta']) {
    process.env.STATEMENT_STUDIO_MODE = value
    const response = await post(true, goodUpload())
    assert.equal(response.status, 404, `STATEMENT_STUDIO_MODE="${value}" must hide the endpoint`)
    assert.deepEqual(await response.json(), GATE_HIDDEN)
  }

  delete process.env.STATEMENT_STUDIO_MODE
  const absent = await post(true, goodUpload())
  assert.equal(absent.status, 404, 'an unset flag must hide the endpoint')
  assert.deepEqual(await absent.json(), GATE_HIDDEN)

  assert.equal(extractCalls, 0, 'no unknown mode may reach extraction')
})

test('route: a signed-in TXT upload returns the text and its eligibility', async () => {
  const POSTFn = await handler(true)
  const response = await POSTFn(upload(new Uint8Array(Buffer.from('My statement.\n\nSecond paragraph.', 'utf8'))))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.format, 'txt')
  assert.equal(body.text, 'My statement.\n\nSecond paragraph.')
  assert.equal(body.characters, body.text.length)
  assert.equal(body.saveable, true)
  assert.equal(body.maxSavedCharacters, 20_000)
  assert.equal(body.maxCharacters, 50_000)
})

test('route: a non-multipart request is refused', async () => {
  const POSTFn = await handler(true)
  const response = await POSTFn(
    new Request('http://localhost/api/statement/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'not a file' }),
    }),
  )
  assert.equal(response.status, 415)
  assert.equal((await response.json()).code, 'not-multipart')
})

test('route: a multipart request with no file field is refused', async () => {
  const POSTFn = await handler(true)
  const form = new FormData()
  form.append('notafile', 'text')
  const response = await POSTFn(
    new Request('http://localhost/api/statement/extract', { method: 'POST', body: form }),
  )
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'no-file')
})

test('route: two files are refused rather than one being chosen', async () => {
  const POSTFn = await handler(true)
  const form = new FormData()
  form.append('file', new File([Buffer.from('one', 'utf8') as unknown as BlobPart], 'a.txt'))
  form.append('file', new File([Buffer.from('two', 'utf8') as unknown as BlobPart], 'b.txt'))
  const response = await POSTFn(
    new Request('http://localhost/api/statement/extract', { method: 'POST', body: form }),
  )
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'too-many-files')
})

test('route: an empty file is refused', async () => {
  const POSTFn = await handler(true)
  const response = await POSTFn(upload(new Uint8Array(0)))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'empty-file')
})

test('route: 4,000,001 bytes is refused 413 on the MEASURED size', async () => {
  const POSTFn = await handler(true)
  const response = await POSTFn(upload(new Uint8Array(Buffer.alloc(4_000_001, 0x61))))
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'too-large')
})

test('route: A VALID 4,000,000-BYTE FILE IS NOT REFUSED FOR ITS ENVELOPE', async () => {
  // The multipart body is necessarily larger than the file: boundary, headers,
  // filename, CRLFs. If the early guard used the file limit, this would 413.
  const POSTFn = await handler(true)
  const request = upload(new Uint8Array(Buffer.alloc(4_000_000, 0x61)), 'exactly-at-the-limit.txt')

  const response = await POSTFn(request)
  assert.notEqual(response.status, 413, 'a file exactly at the limit was refused for size')
  // It is then refused for LENGTH -- 4,000,000 characters is far past 50,000 --
  // which is the correct reason and proves the size gate let it through.
  assert.equal(response.status, 422)
  const body = await response.json()
  assert.equal(body.code, 'text-too-long')
  assert.equal(body.characters, 4_000_000)
  assert.equal(body.maxCharacters, 50_000)
})

test('route: a refusal body carries no text and no internal diagnostics', async () => {
  const POSTFn = await handler(true)
  const response = await POSTFn(upload(new Uint8Array(Buffer.alloc(60_000, 0x61))))
  assert.equal(response.status, 422)
  const body = await response.json()
  assert.equal(body.code, 'text-too-long')
  for (const forbidden of ['text', 'detail', 'timeline', 'memorySamples', 'plan', 'termination', 'errorMessage']) {
    assert.equal(forbidden in body, false, `${forbidden} leaked into the response`)
  }
  // Codes are plain words, safe to show and to log.
  assert.match(body.code, /^[a-z-]+$/)
})

test('route: two simultaneous PDF uploads — one 200, one 503 with Retry-After: 2', async () => {
  // NOTE: the route uses the PROCESS-WIDE capacity gate, which is not injectable
  // from here. This test therefore depends on that gate being clean, and on
  // running with --test-concurrency=1 so no other test holds the slot.
  const POSTFn = await handler(true)
  const pdf = loadPdf(SMALL_PDF)
  const [a, b] = await Promise.all([
    POSTFn(upload(pdf, 'a.pdf')),
    POSTFn(upload(pdf, 'b.pdf')),
  ])

  const statuses = [a.status, b.status].sort((x, y) => x - y)
  assert.deepEqual(statuses, [200, 503], `expected one 200 and one 503, got ${statuses.join(', ')}`)

  const refused = a.status === 503 ? a : b
  assert.equal(refused.headers.get('Retry-After'), '2')
  const body = await refused.json()
  assert.equal(body.code, 'pdf-capacity')
  // The message tells the user to come back, without blaming them.
  assert.match(body.error, /try again/i)

  const accepted = a.status === 200 ? a : b
  const ok = await accepted.json()
  assert.equal(ok.format, 'pdf')
  assert.equal(ok.pages, 4)
})
