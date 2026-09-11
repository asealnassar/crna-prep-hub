import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The score route's guarantees, asserted against the source.
 *
 * The retired `app/api/resume/score` is the cautionary example: it used the
 * service role, checked no session, and took an id from the request body, so
 * anyone could score anyone's resume. It was deleted in 123981b. None of its
 * mistakes may reappear here.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE = code(read('../../../app/api/resume-v2/score/route.ts'))
const BODY = ROUTE.replace(/^import[\s\S]*?from\s+'[^']+'\s*$/gm, '')
const PANEL = code(read('../../../app/resume-studio/components/strength/StrengthPanel.tsx'))

// ------------------------------------------------------- the failures

test('the route never uses the service role', () => {
  assert.equal(/SERVICE_ROLE|service_role/.test(ROUTE), false)
})

test('the session is verified before anything else happens', () => {
  const auth = BODY.indexOf('authenticateRequest')
  assert.ok(auth >= 0)
  for (const later of ['readResume', 'createClient', 'openai.chat.completions.create']) {
    assert.ok(BODY.indexOf(later) > auth, `${later} runs before authentication`)
  }
})

test('the V2 gate applies, and the caller’s own JWT decides what may be read', () => {
  assert.ok(BODY.includes('resumeV2Access'))
  assert.ok(BODY.includes('readAccessToken'))
  assert.ok(/Authorization:\s*`Bearer \$\{token\}`/.test(BODY))
  assert.ok(BODY.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
})

test('an id is validated, and comes from the body only as an id', () => {
  assert.ok(/\[0-9a-f\]\{8\}-/.test(ROUTE), 'the id is not checked')
  const reads = [...BODY.matchAll(/body\s*(?:as[^)]*\)?)?\s*\)?\s*\.\s*(\w+)/g)].map((m) => m[1])
  for (const field of reads) assert.equal(field, 'id', `the route reads body.${field}`)
})

test('a resume the caller may not read is not found, never forbidden', () => {
  assert.ok(BODY.includes("'not-found'"))
  assert.equal(/status:\s*403/.test(BODY), false, 'a 403 would confirm the resume exists')
})

// ----------------------------------------------------- no tier gate

test('there is no tier gate anywhere on the score route', () => {
  // Every tier gets Resume Strength. Gating it would remove the reason anyone
  // reaches the paywall, which is finalising and exporting.
  for (const gate of ['decideExport', 'decideFinalize', 'canExportPdf', 'canFinalize', 'isUltimate', 'ultimate']) {
    assert.equal(ROUTE.includes(gate), false, `the score route consults "${gate}"`)
  }
})

test('neither the route nor the panel mentions upgrading', () => {
  for (const [name, text] of [['route', ROUTE], ['panel', PANEL]] as const) {
    for (const word of ['upgrade', 'Ultimate', 'Premium', 'quota', 'allowance', 'remaining']) {
      assert.equal(text.includes(word), false, `the ${name} says "${word}"`)
    }
  }
})

// ------------------------------------------------------ cost control

test('the rate ceiling is checked before a token is spent', () => {
  const rate = BODY.indexOf('rateDecision')
  const call = BODY.indexOf('openai.chat.completions.create')
  assert.ok(rate >= 0 && rate < call, 'the model is called before the rate check')
  assert.ok(BODY.includes('429'))
})

test('an unreadable usage ledger refuses rather than waves through', () => {
  // Asserted on the code, not on the comment explaining it: an abuse control
  // that opens when its own storage misbehaves is not a control.
  const rateFn = BODY.slice(BODY.indexOf('async function rateDecision'))
  const errorBranch = rateFn.slice(rateFn.indexOf('if (error)'), rateFn.indexOf('const recent'))
  assert.match(errorBranch, /allowed:\s*false/, 'a ledger failure lets the call through')
  assert.ok(BODY.includes('record_ai_usage'), 'the attempt is not recorded')
})

// --------------------------------------------- storing must not stale

test('storing a score uses the scoped write, not a document save', () => {
  // save_resume_v2 bumps the revision, and the revision is exactly what decides
  // staleness -- so saving a score through it would mark the score stale the
  // instant it was written.
  assert.ok(BODY.includes('saveStrength'), 'the score is not stored')
  for (const forbidden of ['saveResume', 'save_resume_v2', 'applyPatches']) {
    assert.equal(BODY.includes(forbidden), false, `storing the score goes through ${forbidden}`)
  }
})

test('the repository write touches only the three strength columns', () => {
  const repo = code(read('../repo/resumeRepo.ts'))
  const fn = repo.slice(repo.indexOf('export async function saveStrength'))
  const update = fn.slice(fn.indexOf('.update('), fn.indexOf('.eq('))
  for (const column of ['strength_score', 'strength_computed_at', 'strength_revision']) {
    assert.ok(update.includes(column), `saveStrength does not write ${column}`)
  }
  // `revision:` on its own would move the document's revision and so make the
  // score stale the instant it was stored. `strength_revision:` contains that
  // substring, so the check has to exclude it rather than search for it.
  assert.equal(
    /(^|[^_])\brevision:/.test(update.replace(/strength_revision:/g, '')), false,
    'saveStrength moves the document revision'
  )
  for (const column of ['updated_at', 'title:', 'status:']) {
    assert.equal(update.includes(column), false, `saveStrength also writes ${column}`)
  }
})

// ------------------------------------------------------ the reporting

test('the response carries the disclaimer and the staleness flag', () => {
  assert.ok(BODY.includes('STRENGTH_DISCLAIMER'), 'the number ships without its disclaimer')
  assert.ok(BODY.includes('isStale'))
})

test('the panel scores on demand and never on a keystroke', () => {
  assert.equal(/useEffect/.test(PANEL), false, 'the panel scores itself on render')
  assert.match(PANEL, /onClick=\{\(\) => void run\(\)\}/)
})

test('a stale result stays on screen and is labelled', () => {
  assert.ok(PANEL.includes('stale'), 'the panel has no staleness state')
  assert.match(PANEL, /describe an earlier\s*\n?\s*version|earlier version/i)
  // Hiding it would lose the guidance someone is working through.
  assert.equal(/stale \? null :/.test(PANEL), false, 'a stale result is hidden rather than labelled')
})

test('the panel waits for edits to save before scoring the stored resume', () => {
  assert.match(PANEL, /disabled=\{working \|\| hasUnsavedWork\}/)
})
