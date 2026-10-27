/**
 * Analysing a draft on localhost with the REAL analyser, through the route the
 * UI actually calls.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 * Simulated-live used to return a deterministic stub, which made the results
 * screen reviewable but said nothing about the quality of what would ship. The
 * stub is gone: a local click now builds the production request, calls the
 * production model, and is judged by the production validator. The only things
 * that change are where the result is kept and that no allowance is spent.
 *
 * So the subject here is the boundary, in both directions:
 *
 *   the ANALYSIS is real -- one model call, the production prompt, the
 *   production parser, a production-shaped review reaching the browser;
 *
 *   the PERSISTENCE is not -- no cache RPC, no usage RPC, no row in
 *   statement_analyses, no production draft touched, nothing charged.
 *
 * ---------------------------------------------------------------------------
 * THIS SUITE NEVER SPENDS MONEY, AND THAT IS ENFORCED, NOT INTENDED
 * ---------------------------------------------------------------------------
 * `openai` is replaced by a stand-in that counts its calls and returns a
 * review built HERE. Every test asserts the count it expects -- one for a paid
 * path, zero for every refusal -- so a change that moved a refusal after the
 * model call would fail rather than quietly start billing. Nothing in
 * `npm test` can reach OpenAI: the module that would is never loaded.
 */
import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'
// The real route refuses without a key, which is correct and is not the
// subject here. The stand-in never reads it.
process.env.OPENAI_API_KEY ||= 'fixture-key-never-sent-anywhere'
// The cache flag stays off: that is the configuration being reviewed, and it is
// what makes every production cache RPC unreachable.
delete process.env.STATEMENT_ANALYSIS_CACHE

// ITS OWN STORES, so the suite never deletes a review session done by hand in
// the browser, and so concurrent test files do not race each other.
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.analyze-test.json'
process.env.STATEMENT_LOCAL_ANALYSES_FILE = 'dev-analyses.analyze-test.json'
const STORE = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const ANALYSES = `local-review/${process.env.STATEMENT_LOCAL_ANALYSES_FILE}`

const USER = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'a@example.invalid',
}
/** Mutable so the non-Ultimate refusal can be driven through the real check. */
let tier = 'ultimate'
/** Mutable so the unauthenticated refusal can be driven through the real gate. */
let authed = true

const PAYLOAD = 'local-review/statement_requirements_catalog.json'
const skip = !existsSync(PAYLOAD) || typeof mock.module !== 'function'

type Handler = (request: unknown, context?: unknown) => Promise<Response>
type Row = Record<string, unknown>

let CREATE: Handler | null = null
let PATCH_ITEM: Handler | null = null
let ANALYZE: Handler | null = null
let build: ((title: string, id: string) => Record<string, unknown>) | null = null
let requirementId = ''

/** Every request the route made to the stand-in, in order. */
const calls: Row[] = []
/** Flipped by the rate-limit test; the real decision is a live ledger read. */
let rateAllowed = true
/** Set if the route ever tried to write the production usage ledger. */
let ledgerWrites = 0
/** What the stand-in answers with next. Replaced to test the failure paths. */
let reply: () => string = () => JSON.stringify(aiReview())

/**
 * An essay with recognisable sentences in it.
 *
 * REAL PROSE, BECAUSE THE VALIDATOR CHECKS QUOTATIONS. parseReview compares any
 * evidence a category claims to have quoted against the essay, so a review that
 * says `evidenceFound: true` has to quote something that is genuinely here.
 */
const ESSAY = [
  'I first understood anesthesia as a form of attention rather than a procedure.',
  'In the cardiothoracic unit I cared for a woman whose blood pressure fell',
  'during induction, and the anesthetist beside me narrated every adjustment',
  'until she was stable again. I had been a nurse for four years by then, and',
  'I had never seen physiology managed that precisely in real time. I began',
  'asking to be assigned to the sickest patients on the unit, and I took the',
  'CCRN because I wanted the vocabulary for what I was already doing by',
  'instinct. Over three years I precepted six new graduates, and teaching them',
  'showed me how much of my own practice had become automatic. I want the',
  'training that turns that instinct into accountable decision-making, and I',
  'want it in a programme that expects me to explain my reasoning out loud.',
].join(' ')
/**
 * A genuine fragment of it, for the one category that claims evidence.
 *
 * IT IS THE `excerpt` FIELD THAT IS VERIFIED, not punctuation in prose. A
 * category claiming evidenceFound: true must carry a contiguous verbatim span
 * of the essay, at least MIN_VERIFIABLE_QUOTE_CHARS long -- which is what
 * stopped "your essay contains strong material" from validating. AI-QA-002.
 */
const QUOTE = 'the anesthetist beside me narrated every adjustment'
const QUOTED = `“${QUOTE}”`
const SHORT = 'care '.repeat(40).trim()

/** A production-valid review, as the model would return it. */
function aiReview(options: { readonly promptAttached?: boolean } = {}): Row {
  const promptAttached = options.promptAttached !== false
  const ids = ['motivation', 'clinical-experience', 'reflection-growth',
    'understanding-goals', 'organization-flow', 'writing-quality']
  const categories: Row[] = ids.map((id, index) => ({
    id,
    // Mixed bands, and the one that claims a quotation quotes the real essay.
    score: index === 0 ? 8 : [7, 6, 5, 7, 6][index - 1],
    evidence: index === 0
      ? `The draft says ${QUOTED}, which is the moment it argues from.`
      : 'No passage in the draft addresses this directly.',
    evidenceFound: index === 0,
    // THE PROVABLE HALF: a real span when evidence is claimed, null when not.
    excerpt: index === 0 ? QUOTE : null,
    explanation: `An assessment of ${id} written by the model.`,
    recommendation: `A specific revision the applicant could make for ${id}.`,
    components: [],
  }))
  if (promptAttached) {
    categories.push({
      id: 'prompt-alignment',
      score: 6,
      evidence: 'The draft answers the first requirement but not the second.',
      evidenceFound: false,
      excerpt: null,
      explanation: 'An assessment of how the draft answers the school’s question.',
      recommendation: 'Answer the second requirement explicitly.',
      components: [
        { component: 'Reasons for entering the profession', status: 'addressed',
          evidence: 'The opening paragraph gives them.' },
        { component: 'Evidence of clinical judgement', status: 'weak',
          evidence: 'Described once, without an outcome.' },
      ],
    })
  }
  return {
    overall: 0,
    categories,
    overallAssessment: 'A capable draft that argues from experience and needs a '
      + 'sharper close.',
    strengths: ['The induction scene is concrete and specific.'],
    priorities: ['Answer the second requirement of the prompt.'],
    nextSteps: ['Rewrite the final paragraph as a claim rather than a wish.'],
  }
}

before(async () => {
  if (skip) return
  mock.module('@/lib/apiAuth', {
    namedExports: {
      authenticateRequest: async () =>
        (authed ? { ...USER, tier, isUltimate: tier === 'ultimate' } : null),
      readAccessToken: async () => (authed ? 'fixture-token' : null),
      isAdminEmail: () => true,
      ADMIN_EMAILS: [USER.email],
    },
  })
  /*
   * THE USAGE LEDGER, MOCKED IN TWO DIFFERENT WAYS ON PURPOSE.
   *
   * statementRateDecision is a live SELECT on resume_ai_usage. It is real on
   * localhost -- that is the point, a local run is rate-limited exactly as
   * production would be -- but there is no Supabase in a test process, so the
   * read fails and the function fails CLOSED with a 429. Returning a decision
   * here is what lets the rest of the route be tested; the flag makes the
   * refusal itself testable too.
   *
   * THE TWO WRITES ARE TRIPWIRES. record_ai_usage and settle_ai_usage are the
   * RPCs that would consume somebody's allowance. Rather than assert that the
   * route passes a null id, these throw -- so a 200 from any test below is
   * proof at runtime that neither was called.
   */
  mock.module('@/lib/statement/usage', {
    namedExports: {
      STATEMENT_OPERATIONS: { analyze: 'statement-analyze' },
      statementRateDecision: async () => (rateAllowed
        ? { allowed: true }
        : { allowed: false, retryAfterSeconds: 30, message: 'Too many requests just now.' }),
      recordStatementAttempt: async () => {
        ledgerWrites += 1
        throw new Error('THE PRODUCTION USAGE LEDGER WAS WRITTEN')
      },
      settleStatementUsage: async () => {
        ledgerWrites += 1
        throw new Error('THE PRODUCTION USAGE LEDGER WAS SETTLED')
      },
    },
  })
  // THE EXTERNAL BOUNDARY, AND THE ONLY ONE. Nothing here reaches a network.
  mock.module('openai', {
    defaultExport: class {
      chat = {
        completions: {
          create: async (body: Row) => {
            calls.push(body)
            return { choices: [{ message: { content: reply() } }] }
          },
        },
      }
    },
  })

  const payload = JSON.parse(readFileSync(PAYLOAD, 'utf8')) as {
    sets: Row[]; documents: Row[]
  }
  const set = payload.sets.find((s) => String(s.school_name).includes('Boston College'))!
  requirementId = String(payload.documents.find((d) => d.set_id === set.id)!.id)

  CREATE = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  PATCH_ITEM = (await import('../../../app/api/statement/drafts/[id]/route.ts')).PATCH as Handler
  ANALYZE = (await import(
    '../../../app/api/statement/drafts/[id]/analyze/route.ts')).POST as Handler
  build = (await import('../requirements/newDraftFlow.ts')).requirementDraftRequest as typeof build
})

after(() => {
  if (skip) return
  rmSync(STORE, { force: true })
  rmSync(ANALYSES, { force: true })
})

const request = (body?: unknown) => ({
  json: async () => body,
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
})
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const rows = () => JSON.parse(readFileSync(STORE, 'utf8')) as Row[]
const writeRows = (next: Row[]) => writeFileSync(STORE, JSON.stringify(next, null, 2))

/** A requirement-backed draft carrying `essay`, through the real routes. */
async function seed(essay: string, revision = 1): Promise<string> {
  rmSync(STORE, { force: true })
  rmSync(ANALYSES, { force: true })
  calls.length = 0
  ledgerWrites = 0
  rateAllowed = true
  reply = () => JSON.stringify(aiReview())
  const created = await CREATE!(request(build!('Analyze test', requirementId)))
  const body = await created.json() as { draft?: Row }
  assert.equal(created.status, 201, `create failed: ${JSON.stringify(body)}`)
  const id = String(body.draft!.id)
  const saved = await PATCH_ITEM!(
    request({ title: 'Analyze test', essay, expectedRevision: revision }), ctx(id))
  assert.equal(saved.status, 200, 'save failed')
  return id
}

// ------------------------------------------------- the real analysis, locally

test('an eligible draft reaches the REAL model call and comes back validated',
  { skip }, async () => {
    const id = await seed(ESSAY)
    const response = await ANALYZE!(request(), ctx(id))
    const body = await response.json() as Row
    assert.equal(response.status, 200, `analyze failed: ${JSON.stringify(body)}`)
    assert.equal(calls.length, 1, 'the model was not called exactly once')
    assert.equal(body.cached, undefined, 'a first analysis is not a cache hit')
    // THE LEDGER TRIPWIRES NEVER FIRED, so no allowance was consumed.
    assert.equal(ledgerWrites, 0, 'the production usage ledger was touched')
    assert.equal(body.stored, true, 'a locally kept result must say so')
  })

test('the request is the PRODUCTION one: same model, prompt builders and format',
  { skip }, async () => {
    const id = await seed(ESSAY)
    await ANALYZE!(request(), ctx(id))
    const sent = calls[0]!
    const messages = sent.messages as { role: string; content: string }[]
    assert.equal(sent.model, process.env.STATEMENT_AI_MODEL || 'gpt-4o')
    assert.deepEqual((sent.response_format as Row), { type: 'json_object' })
    assert.equal(sent.temperature, 0.3)
    assert.equal(sent.max_tokens, 4000)
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user'])

    // THE SAME TEXT THE PRODUCTION BUILDERS PRODUCE, compared against them
    // rather than against a copy written here -- a second local prompt is
    // exactly what this test exists to rule out.
    const { reviewSystemPrompt, buildReviewUserMessage } = await import('../draft/reviewPrompt.ts')
    const { wordCount } = await import('../draft/editor.ts')
    const { parseRequirementSnapshot } = await import('../requirements/snapshot.ts')
    const { analyzerUnmeasuredKinds } = await import('../requirements/constraints.ts')
    const snapshot = parseRequirementSnapshot(rows()[0]!.requirement_snapshot)!
    assert.equal(messages[0]!.content, reviewSystemPrompt(true, {
      componentCount: snapshot.components.length,
      hasOptionalComponent: snapshot.components.some((part) => part.optional),
      hasUnmeasurable: analyzerUnmeasuredKinds(snapshot.constraints).length > 0,
    }))
    assert.equal(messages[1]!.content, buildReviewUserMessage({
      essay: ESSAY,
      promptText: String(rows()[0]!.prompt_text),
      statedMaxWords: null,
      words: wordCount(ESSAY),
      requirement: snapshot,
    }))
    // The applicant's essay really is what was sent for judgement.
    assert.ok(messages[1]!.content.includes(QUOTE))
  })

test('the model response is judged by the PRODUCTION validator', { skip }, async () => {
  const id = await seed(ESSAY)
  const body = await (await ANALYZE!(request(), ctx(id))).json() as Row
  const { parseReview } = await import('../draft/reviewSchema.ts')
  const parsed = parseReview({ raw: body.review, promptAttached: true, essay: ESSAY })
  assert.equal(parsed.ok, true,
    `the payload is malformed: ${(parsed as { reason?: string }).reason}`)
})

test('a response the validator refuses is a 502, and nothing is stored locally',
  { skip }, async () => {
    const id = await seed(ESSAY)
    // A quotation the applicant never wrote: the production check for a
    // fabricated quote, reached through the real route.
    reply = () => JSON.stringify({
      ...aiReview(),
      categories: (aiReview().categories as Row[]).map((c, i) => i === 0
        ? { ...c,
            evidence: 'The draft says \u201cI have always known that anesthesia '
              + 'would be my calling in life\u201d, which it does not.' }
        : c),
    })
    const response = await ANALYZE!(request(), ctx(id))
    const body = await response.json() as Row
    assert.equal(response.status, 502)
    assert.equal(body.code, 'malformed')
    assert.equal(existsSync(ANALYSES), false, 'a refused analysis was stored anyway')
  })

test('the result parses through the REAL client parser and every panel renders',
  { skip }, async () => {
    const id = await seed(ESSAY)
    const response = await ANALYZE!(request(), ctx(id))
    const payload = await response.json()
    const { reviewOutcomeFrom } = await import('../draft/reviewClient.ts')
    const outcome = reviewOutcomeFrom({ status: response.status, body: payload }) as Row
    assert.equal(outcome.type, 'ready', `the client refused it: ${JSON.stringify(outcome)}`)
    const review = (outcome.result as { review: Row }).review

    const { RUBRIC, BAND_LABELS, overallScore } = await import('../draft/rubric.ts')
    const categories = review.categories as
      { id: string; score: number; band: string; evidenceFound: boolean
        evidence: string; recommendation: string; components: Row[] }[]

    // 5. every category the rubric names is scored and bandable
    const scores = new Map(categories.map((c) => [c.id, c.score]))
    for (const category of RUBRIC) {
      const scored = categories.find((c) => c.id === category.id)
      assert.ok(scored, `${category.id} would render as "not assessed"`)
      assert.ok(BAND_LABELS[scored.band as keyof typeof BAND_LABELS], scored.band)
    }
    // 6. the overall is the rubric's weighted score
    assert.equal(review.overall,
      overallScore({ scores: scores as never, promptAttached: true }))
    // 7. both evidence states survive: one quotation, and absences
    const quoted = categories.filter((c) => c.evidenceFound)
    assert.equal(quoted.length, 1, 'the quoting category did not survive')
    assert.ok(quoted[0]!.evidence.includes(QUOTE), 'the verified quotation was lost')
    assert.ok(categories.some((c) => !c.evidenceFound), 'no absence to render')
    // 8. the school prompt's components
    const alignment = categories.find((c) => c.id === 'prompt-alignment')!
    assert.equal(alignment.components.length, 2)
    assert.deepEqual(alignment.components.map((part) => part.status), ['addressed', 'weak'])
    // 9. recommendations
    for (const category of categories) assert.ok(category.recommendation.length > 0)
    for (const field of ['overallAssessment', 'strengths', 'priorities', 'nextSteps']) {
      assert.ok(review[field], field)
    }
  })

test('10. THE AI TEXT CARRIES NO DEVELOPMENT PREFIX', { skip }, async () => {
  const id = await seed(ESSAY)
  const body = await (await ANALYZE!(request(), ctx(id))).json() as Row
  const review = body.review as Row
  const prose = [
    review.overallAssessment,
    ...(review.strengths as string[]), ...(review.priorities as string[]),
    ...(review.nextSteps as string[]),
    ...(review.categories as Row[]).flatMap(
      (c) => [c.evidence, c.explanation, c.recommendation]),
  ].join('\n')
  for (const stamp of ['LOCAL TEST DATA', 'LOCAL REAL AI', 'placeholder', 'mock']) {
    assert.equal(prose.includes(stamp), false, `the feedback is stamped with "${stamp}"`)
  }
})

// --------------------------------------- identical essay, and a changed one

test('an IDENTICAL essay is answered from the local store, with no second call',
  { skip }, async () => {
    const id = await seed(ESSAY)
    const first = await (await ANALYZE!(request(), ctx(id))).json() as Row
    assert.equal(calls.length, 1)

    const again = await ANALYZE!(request(), ctx(id))
    const body = await again.json() as Row
    assert.equal(again.status, 200)
    assert.equal(calls.length, 1, 'an identical essay was sent to the model twice')
    assert.equal(body.cached, true, 'the reuse is not declared')
    assert.ok(typeof body.analyzedAt === 'string')
    assert.deepEqual(body.review, first.review, 'the stored review differs from the first')
  })

test('a CHANGED essay is a different fingerprint, so the model runs again',
  { skip }, async () => {
    const id = await seed(ESSAY)
    await ANALYZE!(request(), ctx(id))
    assert.equal(calls.length, 1)

    const edited = `${ESSAY} I have also completed a graduate statistics course.`
    const saved = await PATCH_ITEM!(
      request({ title: 'Analyze test', essay: edited, expectedRevision: 2 }), ctx(id))
    assert.equal(saved.status, 200)

    const response = await ANALYZE!(request(), ctx(id))
    const body = await response.json() as Row
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(calls.length, 2, 'a changed essay reused a stale result')
    assert.equal(body.cached, undefined)
    // AND BOTH ARE KEPT, keyed by fingerprint -- so undoing the edit finds the
    // first result rather than re-paying for it, exactly as production does.
    const { localAnalysisCount } = await import('./localAnalyses.ts')
    assert.equal(localAnalysisCount(), 2)
  })

test('the local store is what answered, and production was never asked',
  { skip }, async () => {
    const id = await seed(ESSAY)
    await ANALYZE!(request(), ctx(id))
    const stored = JSON.parse(readFileSync(ANALYSES, 'utf8')) as Row[]
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.draftId, id)
    assert.equal(typeof stored[0]!.fingerprint, 'string')
    assert.ok(stored[0]!.review, 'the review was not kept')
  })

test('REOPENING the draft offers its own result, and an edited one does not',
  { skip }, async () => {
    const id = await seed(ESSAY)
    await ANALYZE!(request(), ctx(id))

    // The editor page asks the same question, keyed the same way: the stored
    // result for THIS essay, not the most recent one for this draft.
    const { localAnalysisFor } = await import('./localAnalyses.ts')
    const { analysisFingerprint } = await import('../draft/analysisFingerprint.ts')
    const { parseRequirementSnapshot } = await import('../requirements/snapshot.ts')
    const { analysisActionFor } = await import('../draft/reviewAccess.ts')
    const row = rows()[0]!
    const keyFor = (essay: string) => analysisFingerprint({
      essay,
      promptText: String(row.prompt_text),
      schoolId: String(row.school_id),
      promptId: null,
      statedMaxWords: null,
      requirement: parseRequirementSnapshot(row.requirement_snapshot),
      requirementAuthentic: true,
    })

    const mine = localAnalysisFor(id, keyFor(ESSAY))
    assert.ok(mine, 'reopening an unchanged draft found no result')
    assert.equal(
      analysisActionFor({
        storedFingerprint: mine.fingerprint, currentFingerprint: keyFor(ESSAY) }),
      'view', 'an unchanged draft should offer to view its result')

    // An essay that was never analysed has no stored result to offer.
    assert.equal(localAnalysisFor(id, keyFor(`${ESSAY} One more sentence.`)), null)
  })

// --------------------------- refusals, all of them before a paid call

test('under the general minimum: refused, zero model calls', { skip }, async () => {
  const id = await seed(SHORT)
  const response = await ANALYZE!(request(), ctx(id))
  const body = await response.json() as Row
  assert.equal(response.status, 422)
  assert.equal(body.code, 'too-short')
  assert.equal(body.minimumWords, 100)
  assert.equal(calls.length, 0, 'a too-short draft was sent to the model')
})

test('under a SCHOOL-SPECIFIC adjusted minimum: refused, zero model calls',
  { skip }, async () => {
    const id = await seed(SHORT)
    // A legacy school prompt with a stated maximum of 75 moves the floor to 60.
    const stored = rows()
    stored[0]!.requirement_id = null
    stored[0]!.requirement_snapshot = null
    stored[0]!.prompt_id = '22222222-2222-4222-8222-222222222222'
    stored[0]!.stated_max_words = 75
    stored[0]!.prompt_text = 'A short school question that is still above the ceiling.'
    stored[0]!.essay = 'care '.repeat(50).trim()
    writeRows(stored)
    const response = await ANALYZE!(request(), ctx(id))
    const body = await response.json() as Row
    assert.equal(response.status, 422)
    assert.equal(body.code, 'too-short')
    assert.equal(body.minimumWords, 60)
    assert.equal(calls.length, 0)
  })

test('a prompt under the short-response ceiling: refused, zero model calls',
  { skip }, async () => {
    const id = await seed(ESSAY)
    const stored = rows()
    stored[0]!.requirement_id = null
    stored[0]!.requirement_snapshot = null
    stored[0]!.prompt_id = '22222222-2222-4222-8222-222222222222'
    stored[0]!.stated_max_words = 40
    stored[0]!.prompt_text = 'Answer in forty words.'
    writeRows(stored)
    const response = await ANALYZE!(request(), ctx(id))
    const body = await response.json() as Row
    assert.equal(response.status, 422)
    assert.equal(body.code, 'prompt-too-short')
    assert.equal(calls.length, 0)
  })

test('the real rate decision still refuses, before any paid call', { skip }, async () => {
  const id = await seed(ESSAY)
  rateAllowed = false
  const response = await ANALYZE!(request(), ctx(id))
  const body = await response.json() as Row
  assert.equal(response.status, 429)
  assert.equal(body.code, 'too-many-requests')
  assert.equal(calls.length, 0, 'a rate-limited request reached the model')
})

test('a non-Ultimate account: refused, zero model calls', { skip }, async () => {
  const id = await seed(ESSAY)
  const { ANALYSIS_TIER_CODE } = await import('../draft/reviewAccess.ts')
  tier = 'premium'
  try {
    const response = await ANALYZE!(request(), ctx(id))
    const body = await response.json() as Row
    assert.equal(response.status, 403)
    assert.equal(body.code, ANALYSIS_TIER_CODE)
  } finally {
    tier = 'ultimate'
  }
  assert.equal(calls.length, 0)
})

test('an unauthenticated request: refused, zero model calls', { skip }, async () => {
  const id = await seed(ESSAY)
  authed = false
  try {
    const response = await ANALYZE!(request(), ctx(id))
    assert.ok([401, 404].includes(response.status), `status was ${response.status}`)
  } finally {
    authed = true
  }
  assert.equal(calls.length, 0)
})

test('an UNKNOWN requirement loses its authority, and the model is told nothing of it',
  { skip }, async () => {
    // Production does not refuse this -- it falls back to the legacy
    // single-prompt path -- so the assertion is that the forged requirement
    // reaches neither the instruction nor the provenance label.
    const id = await seed(ESSAY)
    const stored = rows()
    const snapshot = stored[0]!.requirement_snapshot as Row
    snapshot.requirementId = '00000000-0000-5000-8000-000000000000'
    stored[0]!.requirement_snapshot = snapshot
    writeRows(stored)
    const response = await ANALYZE!(request(), ctx(id))
    const body = await response.json() as Row
    assert.equal(response.status, 200)
    assert.notEqual(body.provenance, 'catalog')
    const sent = calls[0]!
    const user = (sent.messages as { content: string }[])[1]!.content
    assert.equal(user.includes('Reasons for becoming'), false,
      'a forged requirement’s components reached the model')
  })

test('a TAMPERED word maximum cannot lower the floor, and costs nothing',
  { skip }, async () => {
    const id = await seed(SHORT)
    const stored = rows()
    const snapshot = stored[0]!.requirement_snapshot as Row
    ;(snapshot.constraints as Row).words = { max: 60, min: null }
    writeRows(stored)
    const response = await ANALYZE!(request(), ctx(id))
    const body = await response.json() as Row
    assert.equal(response.status, 422)
    assert.equal(body.minimumWords, 100, 'the forged maximum moved the floor')
    assert.equal(calls.length, 0)
  })

// --------------------- nothing production holds was read back or written

test('NO PRODUCTION WRITE, CACHE RPC OR LEDGER RPC IS REACHABLE', { skip }, async () => {
  const { simulatedLiveEnabled, SimulatedLiveWriteBlocked } = await import('./gate.ts')
  assert.equal(simulatedLiveEnabled(), true, 'the whole proof rests on this being on')

  // THE BACKSTOP, NOT THE BRANCH. Every paid or persistent step the route could
  // take goes through this client, so each one is asserted impossible -- which
  // holds even if a future edit moved one of the local branches.
  const { statementDbClient } = await import('./guardedClient.ts')
  const db = statementDbClient('fixture-token')
  for (const table of ['statement_analyses', 'resume_ai_usage', 'statement_drafts',
    'statement_requirement_sets', 'statement_requirements']) {
    for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
      const builder = db.from(table) as unknown as Record<string, () => unknown>
      // statement_drafts is served from the local file, so it is not even a
      // Supabase builder; the rest must refuse.
      if (table === 'statement_drafts') {
        assert.equal(typeof (builder as Row).url, 'undefined',
          'statement_drafts reached a real client')
        continue
      }
      assert.throws(() => builder[operation]!(), SimulatedLiveWriteBlocked,
        `${table}.${operation}`)
    }
  }
  for (const fn of ['claim_statement_analysis', 'settle_statement_analysis',
    'record_ai_usage', 'settle_ai_usage']) {
    assert.throws(() => db.rpc(fn), SimulatedLiveWriteBlocked, fn)
  }
})

test('the cache flag is still off, so no claim or settle ever ran', { skip }, async () => {
  const { analysisCacheEnabled } = await import('../draft/rollout.ts')
  assert.equal(analysisCacheEnabled(), false)
  const { analysisAvailability } = await import('../draft/reviewAccess.ts')
  assert.equal(
    analysisAvailability({ cacheEnabled: false, nodeEnv: 'development' }),
    'development-no-cache')
})

test('the requirement catalog is read-only here', { skip }, async () => {
  const { statementDbClient } = await import('./guardedClient.ts')
  const { SimulatedLiveWriteBlocked } = await import('./gate.ts')
  const db = statementDbClient('fixture-token')
  // Reading works -- the catalog is what the draft was created from...
  assert.equal(typeof (db.from('statement_requirements') as unknown as Row).select, 'function')
  // ...and is_active cannot be moved from here.
  assert.throws(
    () => (db.from('statement_requirement_sets') as unknown as Record<string, () => unknown>)
      .update!(),
    SimulatedLiveWriteBlocked)
})
