import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The export's security properties, asserted against the source.
 *
 * Four things have to stay true, and none of them is visible from the outside
 * once a PDF comes back: the V2 gate still applies, RLS still decides what may
 * be read, the client cannot hand Chromium content or a destination, and the
 * document is built from a row the server read. These read the files rather
 * than trusting the intent, in the same way the Phase 4 renderer's boundaries
 * are checked.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const ROUTE = read('../../../app/api/resume-v2/export/pdf/route.ts')
const PDF = read('./pdf.ts')
const BUTTON = read('../../../app/resume-studio/components/export/ExportMenu.tsx')

/** Source with comments removed: these check what the code does, not what it says. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE_CODE = code(ROUTE)
/**
 * The route's body, with the import block removed.
 *
 * Ordering assertions below use indexOf, and an imported name appears at the
 * top of the file long before it is called -- which made "createClient runs
 * before the gate" fail against a route whose order was correct.
 */
const ROUTE_BODY = ROUTE_CODE.replace(/^import[\s\S]*?from\s+'[^']+'\s*$/gm, '')
const PDF_CODE = code(PDF)
const BUTTON_CODE = code(BUTTON)

// ------------------------------------------------------------ the gate

test('the export route applies the V2 admin gate', () => {
  assert.ok(ROUTE_CODE.includes('resumeV2Access'), 'the gate is not called')
  assert.ok(ROUTE_CODE.includes('isAdminEmail'), 'the allowlist is not consulted')
  assert.ok(ROUTE_CODE.includes('authenticateRequest'), 'the session is not verified')
})

test('the gate is applied before anything is read or rendered', () => {
  const gate = ROUTE_BODY.indexOf('resumeV2Access')
  assert.ok(gate >= 0, 'the gate is not called in the handler')
  for (const later of ['readResume', 'exportResumePdf', 'createClient']) {
    const at = ROUTE_BODY.indexOf(later)
    assert.ok(at > gate, `${later} runs before the gate`)
  }
})

test('a blocked caller gets the gate’s own refusal, not a bespoke one', () => {
  assert.ok(ROUTE_CODE.includes('BLOCKED_BODY'), 'the route invents its own refusal body')
  assert.ok(ROUTE_CODE.includes('access.status'), 'the route hard-codes a status')
})

// -------------------------------------------------- ownership and RLS

test('the export never uses a service-role client', () => {
  // A service-role key would read any user's resume. The one resume route that
  // held one was retired in 123981b.
  for (const [name, text] of [['route', ROUTE_CODE], ['pdf', PDF_CODE]] as const) {
    assert.equal(text.includes('SERVICE_ROLE'), false, `${name} reaches for the service role`)
    assert.equal(text.includes('service_role'), false, `${name} reaches for the service role`)
  }
})

test('the database client carries the caller’s own JWT', () => {
  assert.ok(ROUTE_CODE.includes('readAccessToken'), 'no caller token is read')
  assert.ok(ROUTE_CODE.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY'), 'not the anon key')
  assert.ok(/Authorization:\s*`Bearer \$\{token\}`/.test(ROUTE_CODE), 'the token is not attached')
})

test('a resume the caller may not read is not found, not forbidden', () => {
  // Ownership and entitlement are different answers on purpose. A resume that
  // is not yours does not exist (404); a resume you may read but not export
  // does exist, and saying so is the point (403). Conflating them would either
  // leak which ids are real or hide the upgrade path behind a dead end.
  assert.ok(ROUTE_BODY.includes("'not-found'"), 'no not-found path')
  const notFound = ROUTE_BODY.indexOf("'not-found'")
  const around = ROUTE_BODY.slice(notFound, notFound + 120)
  assert.match(around, /status:\s*404/, 'an unreadable resume is not a 404')

  // Exactly one 403, and it is the tier gate.
  const forbidden = [...ROUTE_BODY.matchAll(/status:\s*403/g)]
  assert.equal(forbidden.length, 1, 'more than one thing answers 403')
  const gateAt = ROUTE_BODY.indexOf('decideExport')
  assert.ok(gateAt >= 0 && gateAt < forbidden[0].index!, 'the 403 is not the entitlement refusal')
})

// ------------------------------- no arbitrary HTML or URLs to Chromium

test('the client sends an id and nothing else', () => {
  // If the body were spread, or any other field read, this is where it would
  // show. The only property taken off the request is `id`.
  const bodyReads = [...ROUTE_CODE.matchAll(/body\s*(?:as[^)]*\)?)?\s*\)?\s*\.\s*(\w+)/g)].map((m) => m[1])
  const destructured = [...ROUTE_CODE.matchAll(/const\s*\{([^}]*)\}\s*=\s*body/g)].map((m) => m[1])
  assert.deepEqual(destructured, [], 'the body is destructured somewhere')
  for (const field of bodyReads) {
    assert.equal(field, 'id', `the route reads body.${field}`)
  }
  assert.ok(/\{\s*id\?:\s*unknown\s*\}/.test(ROUTE_CODE), 'the body type allows more than an id')
})

test('the id is validated as a UUID before it reaches the database', () => {
  assert.ok(/\[0-9a-f\]\{8\}-/.test(ROUTE_CODE), 'no UUID check on the id')
  const check = ROUTE_BODY.indexOf('[0-9a-f]{8}-')
  assert.ok(check >= 0 && check < ROUTE_BODY.indexOf('readResume'), 'the id reaches the database unvalidated')
})

test('Chromium is never navigated to a URL', () => {
  // setContent takes a string this server built. goto would take a destination,
  // and a destination is something a request could eventually influence.
  assert.ok(PDF_CODE.includes('setContent'), 'content is not set directly')
  assert.equal(/\.goto\s*\(/.test(PDF_CODE), false, 'the page is navigated somewhere')
  assert.equal(/page\.url|request\.url|\bfetch\s*\(/.test(PDF_CODE), false, 'the export path fetches')
})

test('the export loads nothing over the network', () => {
  assert.equal(/https?:\/\/[a-z]/i.test(PDF_CODE), false, 'a remote origin appears in the export path')
})

test('no caller-supplied HTML can reach the renderer', () => {
  // renderPdf takes HTML, and exportResumePdf is the only caller in the app.
  // The route must use the latter, so the HTML is always built here.
  assert.ok(ROUTE_CODE.includes('exportResumePdf'), 'the route does not use the canonical entry point')
  assert.equal(ROUTE_CODE.includes('renderPdf'), false, 'the route can pass its own HTML')
  assert.equal(ROUTE_CODE.includes('documentHtml'), false, 'the route builds its own HTML')
})

// ------------------------------- the document comes from canonical data

test('the rendered resume is the one the server read', () => {
  const readAt = ROUTE_BODY.indexOf('readResume')
  const exportAt = ROUTE_BODY.indexOf('exportResumePdf')
  assert.ok(readAt >= 0 && exportAt > readAt, 'the export does not follow a read')
  assert.ok(/exportResumePdf\(\s*resume\b/.test(ROUTE_CODE), 'something other than the stored resume is exported')
})

test('the HTML is built from the shared renderer, server-side', () => {
  assert.ok(PDF_CODE.includes('renderToStaticMarkup'), 'no server render')
  assert.ok(PDF_CODE.includes('ResumeDocument'), 'not the shared document')
  assert.equal(/dangerouslySetInnerHTML/.test(PDF_CODE), false, 'raw HTML is injected in the export path')
})

// ------------------------------------------------------------- the client

test('the download button sends only an id', () => {
  assert.ok(/JSON\.stringify\(\{\s*id:\s*resumeId\s*\}\)/.test(BUTTON_CODE), 'the client sends more than an id')
  for (const word of ['html', 'url', 'template', 'css']) {
    assert.equal(new RegExp(`\\b${word}\\s*:`).test(BUTTON_CODE), false, `the client sends ${word}`)
  }
})

test('the client uses the server’s filename rather than building one', () => {
  assert.ok(BUTTON_CODE.includes('filenameFromDisposition'), 'the client does not read the header')
  assert.ok(BUTTON_CODE.includes('Content-Disposition'), 'the header is not consulted')
  assert.equal(/link\.download\s*=\s*[`'"]/.test(BUTTON_CODE), false, 'a filename is hard-coded')
})
