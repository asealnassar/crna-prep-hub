import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The analyze-statement route's guarantees, asserted against the source.
 *
 * Every assertion here corresponds to a hole the Phase 0 audit found in
 * production. The point of testing the source rather than the behaviour is that
 * these are ORDERING and ABSENCE properties -- "authentication happens before
 * the body is read", "no service role anywhere" -- which an integration test
 * can only sample and a reading can prove.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE = strip(read('../../app/api/analyze-statement/route.ts'))
const BODY = ROUTE.replace(/^import[\s\S]*?from\s+'[^']+'\s*$/gm, '')
const PAGE = strip(read('../../app/personal-statement/page.tsx'))

const POST = BODY.slice(BODY.indexOf('export async function POST'), BODY.indexOf('export async function PUT'))
const PUT = BODY.slice(BODY.indexOf('export async function PUT'))

const before = (haystack: string, first: string, second: string) => {
  const a = haystack.indexOf(first)
  const b = haystack.indexOf(second)
  assert.ok(a >= 0, `${first} is absent`)
  assert.ok(b >= 0, `${second} is absent`)
  assert.ok(a < b, `${first} does not run before ${second}`)
}

// ===================================================================
// Finding 1.1 — the rewrite endpoint wrote its own system prompt
// ===================================================================

test('the system prompt is a constant, never built from the request', () => {
  // The old route did:
  //   improvementInstructions += `\n\n${cat.name} (Current: ${cat.score}/10)...`
  // and sent the result as role: 'system'.
  assert.equal(PUT.includes('improvementInstructions'), false)
  assert.ok(PUT.includes("content: REWRITE_SYSTEM_PROMPT"))
  // No template literal is assembled anywhere in the handler.
  assert.doesNotMatch(PUT, /\+=\s*`/)
})

test('nothing from the body reaches a prompt except through the validator', () => {
  // `analysis` off the wire is used for exactly two things: revalidation and
  // signature checking. What reaches the model is reviewNotesFrom(validated).
  assert.ok(PUT.includes('reviewNotesFrom(revalidated.value)'))
  assert.doesNotMatch(PUT, /buildRewriteUserMessage\([^)]*read\.body/)
})

test('a rewrite requires a signature this server issued', () => {
  assert.ok(PUT.includes('verifyAnalysisToken'))
  before(PUT, 'verifyAnalysisToken', 'openai.chat.completions.create')
})

test('the signature is checked against the body’s analysis, not the normalised copy', () => {
  // Verifying the revalidated object would let normalisation launder a
  // tampered field into a passing signature.
  const call = PUT.slice(PUT.indexOf('verifyAnalysisToken'))
  const args = call.slice(0, call.indexOf('})'))
  assert.match(args, /analysis:\s*read\.body\.analysis/)
})

test('the analysis is signed on the way out', () => {
  assert.ok(POST.includes('signAnalysis'))
  assert.match(POST, /NextResponse\.json\(\{\s*analysis,\s*token\s*\}\)/)
})

// ===================================================================
// Finding 1.2 — no rate limiting of any kind
// ===================================================================

test('both handlers consult the rate ledger before the model', () => {
  for (const [name, handler] of [['POST', POST], ['PUT', PUT]] as const) {
    assert.ok(handler.includes('statementRateDecision'), `${name} has no rate check`)
    before(handler, 'statementRateDecision', 'openai.chat.completions.create')
  }
})

test('every attempt is recorded, including ones that fail', () => {
  for (const [name, handler] of [['POST', POST], ['PUT', PUT]] as const) {
    assert.ok(handler.includes('recordStatementAttempt'), `${name} records nothing`)
    assert.ok(handler.includes("settleStatementUsage"), `${name} settles nothing`)
    assert.ok(handler.includes("'failed'"), `${name} does not settle failures`)
  }
})

test('a 429 carries Retry-After', () => {
  assert.match(BODY, /'Retry-After':\s*String\(rate\.retryAfterSeconds\)/)
})

// ===================================================================
// Finding 1.3 — no size limits
// ===================================================================

test('the body is measured before it is parsed', () => {
  before(BODY, 'withinBodyLimit', 'JSON.parse')
  assert.ok(BODY.includes('413'))
})

test('the statement is length-checked before the model', () => {
  for (const [name, handler] of [['POST', POST], ['PUT', PUT]] as const) {
    assert.ok(handler.includes('checkStatement'), `${name} does not check length`)
    before(handler, 'checkStatement', 'openai.chat.completions.create')
  }
})

test('the two handlers use their own body ceilings', () => {
  assert.ok(POST.includes('MAX_ANALYZE_BODY_BYTES'))
  assert.ok(PUT.includes('MAX_REWRITE_BODY_BYTES'))
})

// ===================================================================
// Finding 1.4 — the entitlement leak
// ===================================================================

test('the tier decides what is asked for and what is returned', () => {
  assert.ok(POST.includes('canSeeSuggestions(caller.tier)'))
  assert.ok(POST.includes('canSeeSentenceAnalysis(caller.tier)'))
  assert.ok(POST.includes('redactForTier(parsed.value, caller.tier)'))
  before(POST, 'redactForTier', 'signAnalysis')
})

test('the tier never comes from the request body', () => {
  assert.doesNotMatch(BODY, /body\.(userTier|tier|isUltimate)/)
  assert.doesNotMatch(BODY, /userTier/)
})

test('the rewrite tier gate runs before the body is even read', () => {
  before(PUT, 'canRewrite', 'readBody')
})

// ===================================================================
// Finding 2.1 — no execution timeout
// ===================================================================

test('the route declares a duration and a runtime', () => {
  assert.match(ROUTE, /export const maxDuration = 60/)
  assert.match(ROUTE, /export const dynamic = 'force-dynamic'/)
})

test('the model call aborts inside the function’s own budget', () => {
  const matches = BODY.match(/AbortSignal\.timeout\(MODEL_TIMEOUT_MS\)/g) ?? []
  assert.equal(matches.length, 2, 'both handlers must time out')
  const budget = Number(/MODEL_TIMEOUT_MS = ([\d_]+)/.exec(ROUTE)?.[1].replace(/_/g, ''))
  assert.ok(budget > 0 && budget < 60_000, 'the abort must fire before the platform kills the function')
})

test('a timeout is a 504 with a message, not a generic failure', () => {
  assert.ok(BODY.includes('504'))
  assert.match(BODY, /TimeoutError/)
})

// ===================================================================
// Finding 2.2 — unvalidated model output
// ===================================================================

test('the model response is never returned unparsed', () => {
  // The old route did: JSON.parse(completion...) then returned it whole.
  assert.doesNotMatch(BODY, /JSON\.parse\(\s*completion/)
  assert.ok(POST.includes('parseAnalysis(completion'))
  assert.ok(POST.includes("status: 502"))
})

test('an empty rewrite is refused rather than rendered', () => {
  assert.match(PUT, /rewritten === ''/)
})

// ===================================================================
// Standing guarantees that must not regress
// ===================================================================

test('authentication happens before anything else', () => {
  for (const [name, handler] of [['POST', POST], ['PUT', PUT]] as const) {
    before(handler, 'admit()', 'readBody')
  }
  before(BODY, 'authenticateRequest', 'createClient')
})

test('the route never uses the service role', () => {
  assert.equal(/SERVICE_ROLE|service_role/.test(ROUTE), false)
})

test('the caller’s own JWT scopes the database client', () => {
  assert.ok(BODY.includes('readAccessToken'))
  assert.match(BODY, /Authorization:\s*`Bearer \$\{token\}`/)
  assert.ok(BODY.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
})

test('no error object is ever logged, only its name', () => {
  // An OpenAI error echoes the request, and the request is the applicant's
  // personal statement.
  assert.doesNotMatch(BODY, /console\.error\([^)]*,\s*error\s*\)/)
  assert.doesNotMatch(BODY, /console\.error\(\s*error\s*\)/)
})

test('the statement is never written to a database', () => {
  // Phase 0 stores nothing. The only write is the usage ledger.
  assert.doesNotMatch(BODY, /\.insert\(|\.upsert\(|\.update\(/)
  const rpcs = BODY.match(/rpc\('([a-z_]+)'/g) ?? []
  assert.deepEqual([...new Set(rpcs)], [])
})

// ===================================================================
// The page keeps its side of the contract
// ===================================================================

test('the page sends the token back on a rewrite', () => {
  assert.match(PAGE, /body:\s*JSON\.stringify\(\{ statement, analysis, token: analysisToken \}\)/)
})

test('the page never sends a tier', () => {
  assert.doesNotMatch(PAGE, /JSON\.stringify\(\{[^}]*userTier/)
})

test('a new analysis clears the previous token and rewrite', () => {
  // A rewrite belongs to the analysis it came from.
  const handler = PAGE.slice(PAGE.indexOf('const analyzeStatement'), PAGE.indexOf('const rewriteStatement'))
  assert.ok(handler.includes('setAnalysisToken("")'))
  assert.ok(handler.includes('setRewritten("")'))
})

test('the tier conditionals in the page are still there, as presentation', () => {
  // They were the only gate. They are now the second one, and still correct.
  assert.ok(PAGE.includes('{isUltimate &&'))
})

// ===================================================================
// Concurrency — the attempt is recorded before the limit is consulted
// ===================================================================

test('the attempt is written before the ledger is read', () => {
  // Check-then-record is a read-modify-write race: a burst arriving inside one
  // ledger round trip all passes, because none of them can see the others yet.
  for (const [name, handler] of [['POST', POST], ['PUT', PUT]] as const) {
    before(handler, 'recordStatementAttempt', 'statementRateDecision')
  }
})

test('the rate check knows whether the caller recorded itself', () => {
  for (const [name, handler] of [['POST', POST], ['PUT', PUT]] as const) {
    assert.match(
      handler,
      /statementRateDecision\(caller\.db, caller\.userId, \{ selfRecorded: usageId !== null \}\)/,
      `${name} does not discount its own row`
    )
  }
})

test('a rate-refused attempt is settled rather than left dangling', () => {
  for (const [name, handler] of [['POST', POST], ['PUT', PUT]] as const) {
    const refusal = handler.slice(handler.indexOf('if (!rate.allowed)'))
    assert.match(refusal.slice(0, 200), /settleStatementUsage\(caller\.db, usageId, 'rejected'\)/, name)
  }
})

test('a misconfigured server writes no ledger rows', () => {
  for (const [name, handler] of [['POST', POST], ['PUT', PUT]] as const) {
    before(handler, 'OPENAI_API_KEY', 'recordStatementAttempt')
  }
})

// ===================================================================
// Request size — refused before it is buffered where possible
// ===================================================================

test('Content-Length is consulted before the body is read', () => {
  before(BODY, 'declaredTooLarge', 'await request.text()')
})

test('the real measurement still runs after the body arrives', () => {
  before(BODY, 'await request.text()', 'withinBodyLimit')
})
