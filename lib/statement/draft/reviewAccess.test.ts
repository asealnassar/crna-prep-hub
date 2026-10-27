import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ANALYSIS_ACTION_LABELS,
  ANALYSIS_TIER_CODE,
  ANALYSIS_TIER_MESSAGE,
  analysisActionFor,
  canAnalyzeStatement,
  ANALYSIS_NO_CACHE_NOTICE,
  ANALYSIS_UNAVAILABLE_CODE,
  ANALYSIS_UNAVAILABLE_MESSAGE,
  V2_ANALYSIS_RATE_LIMITS,
  analysisAvailability,
} from './reviewAccess.ts'
import { analysisFingerprint } from './analysisFingerprint.ts'

const base = {
  essay: 'I spent three years in a cardiothoracic ICU.',
  promptText: 'Why nurse anesthesia?',
  schoolId: 'aaaaaaaa-0000-4000-8000-000000000003',
  promptId: 'c0ffee00-0000-4000-8000-000000000004',
  statedMaxWords: 1000,
}

// ===========================================================================
// THE PLAN
// ===========================================================================

test('ULTIMATE ONLY', () => {
  assert.equal(canAnalyzeStatement('ultimate'), true)
  assert.equal(canAnalyzeStatement('premium'), false)
  assert.equal(canAnalyzeStatement('free'), false)
})

test('an unrecognised tier is never a way up', () => {
  // normaliseTier treats anything it does not know as the lowest plan, so a
  // null, a typo or a tier added later cannot become access.
  for (const unknown of [null, undefined, '', '  ', 'ULTIMATE_PLUS', 'ultimate-plus',
                         'lifetime', 'admin', 'trial', 'enterprise', 'ultimat']) {
    assert.equal(canAnalyzeStatement(unknown), false, String(unknown))
  }
  // Case and surrounding space are normalised, which is a rendering difference.
  assert.equal(canAnalyzeStatement('  Ultimate  '), true)
  assert.equal(canAnalyzeStatement('ULTIMATE'), true)
})

test('the refusal names the plan and nothing else', () => {
  assert.equal(ANALYSIS_TIER_CODE, 'analysis-requires-ultimate')
  assert.ok(ANALYSIS_TIER_MESSAGE.includes('Ultimate'))
  // No price, no link: the pricing page owns those and must not be duplicated.
  assert.equal(/\$|\d+\s*(?:\/|per)\s*month|http/i.test(ANALYSIS_TIER_MESSAGE), false)
  // And it is not a rate limit, which is a different refusal entirely.
  assert.notEqual(ANALYSIS_TIER_CODE, 'too-many-requests')
})

// ===========================================================================
// WHAT AN ANALYSIS WAS ABOUT
// ===========================================================================

test('the same inputs give the same fingerprint, every time', () => {
  assert.equal(analysisFingerprint(base), analysisFingerprint({ ...base }))
  assert.match(analysisFingerprint(base), /^[0-9a-f]{64}$/)
})

test('A TITLE EDIT IS NOT A NEW ANALYSIS', () => {
  // The title is not an input: renaming a draft changes nothing a reviewer
  // would say about it, and including it would make every rename a paid call.
  // There is no title parameter at all, which is the strongest form of this.
  assert.equal(analysisFingerprint.length, 1)
  const keys = Object.keys(base)
  assert.equal(keys.includes('title'), false)
  assert.equal(keys.includes('revision'), false)
})

test('changing the essay changes the fingerprint', () => {
  assert.notEqual(
    analysisFingerprint(base),
    analysisFingerprint({ ...base, essay: `${base.essay} One more sentence.` }),
  )
  // Even by one character.
  assert.notEqual(analysisFingerprint(base), analysisFingerprint({ ...base, essay: `${base.essay} ` }))
})

test('changing the school or the prompt changes the fingerprint', () => {
  for (const field of ['promptText', 'schoolId', 'promptId'] as const) {
    assert.notEqual(
      analysisFingerprint(base),
      analysisFingerprint({ ...base, [field]: 'something else entirely' }),
      field,
    )
  }
  assert.notEqual(analysisFingerprint(base), analysisFingerprint({ ...base, statedMaxWords: 500 }))
})

test('a general draft and a school draft never collide', () => {
  const general = analysisFingerprint({
    ...base, promptText: null, schoolId: null, promptId: null, statedMaxWords: null,
  })
  assert.notEqual(general, analysisFingerprint(base))
  // And an ABSENT prompt is distinguishable from an EMPTY one.
  const empty = analysisFingerprint({
    ...base, promptText: '', schoolId: null, promptId: null, statedMaxWords: null,
  })
  assert.notEqual(general, empty)
})

test('field boundaries cannot be forged by moving text between them', () => {
  // Joining with a plain separator would let an essay ending in the prompt's
  // first words collide with the next draft along.
  const a = analysisFingerprint({ ...base, essay: 'AB', promptText: 'C' })
  const b = analysisFingerprint({ ...base, essay: 'A', promptText: 'BC' })
  assert.notEqual(a, b)
})

test('a rubric or schema change invalidates every cached analysis', async () => {
  // A result produced under different weights is not this result.
  const { RUBRIC_VERSION } = await import('./rubric.ts')
  const { REVIEW_SCHEMA_VERSION } = await import('./reviewSchema.ts')
  // The fingerprint moved to its own module when node:crypto had to leave the
  // browser bundle; the versions moved with it.
  const source = (await import('node:fs')).readFileSync(
    (await import('node:url')).fileURLToPath(
      new URL('./analysisFingerprint.ts', import.meta.url)), 'utf8')
  assert.match(source, /RUBRIC_VERSION,/)
  assert.match(source, /REVIEW_SCHEMA_VERSION,/)
  assert.ok(RUBRIC_VERSION.length > 0 && REVIEW_SCHEMA_VERSION.length > 0)
})

// ===========================================================================
// WHAT THE EDITOR OFFERS
// ===========================================================================

test('nothing analysed yet offers Analyze', () => {
  const action = analysisActionFor({ storedFingerprint: null, currentFingerprint: 'abc' })
  assert.equal(action, 'analyze')
  assert.equal(ANALYSIS_ACTION_LABELS[action], 'Analyze this draft')
})

test('AN UNCHANGED DRAFT OFFERS "View previous analysis", NOT "Analyze again"', () => {
  const action = analysisActionFor({ storedFingerprint: 'abc', currentFingerprint: 'abc' })
  assert.equal(action, 'view')
  assert.equal(ANALYSIS_ACTION_LABELS[action], 'View previous analysis')
})

test('a changed essay or prompt offers "Analyze updated draft"', () => {
  const action = analysisActionFor({ storedFingerprint: 'abc', currentFingerprint: 'xyz' })
  assert.equal(action, 'reanalyze')
  assert.equal(ANALYSIS_ACTION_LABELS[action], 'Analyze updated draft')
})

test('the three labels are distinct', () => {
  const labels = Object.values(ANALYSIS_ACTION_LABELS)
  assert.equal(new Set(labels).size, labels.length)
})

/* ===========================================================================
 * THE ROUTE AND THE MIGRATION, AS SOURCE.
 *
 * Static assertions. They prove the code and the SQL say what this feature
 * assumes; they prove nothing about a running database, and 20261002_004 has
 * not been applied by anything.
 * ======================================================================== */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const ROUTE = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
const SQL = read('../../../supabase/migrations/20261002_004_statement_analyses.sql')
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const stripSql = (s: string) => s.replace(/^\s*--.*$/gm, '')

test('FREE AND PREMIUM ARE REFUSED ON THE SERVER, before anything costs', () => {
  const code = stripTs(ROUTE)
  assert.match(code, /canAnalyzeStatement\(caller\.tier\)/)
  // Before eligibility, before the ledger, before the model.
  const gate = code.indexOf('canAnalyzeStatement(caller.tier)')
  for (const later of ['eligibilityFor({', 'statementRateDecision(', 'recordStatementAttempt(',
                       'openai.chat.completions.create']) {
    assert.ok(gate < code.indexOf(later), `the tier gate must precede ${later}`)
  }
  // The tier comes from the verified session; no request field names a plan.
  assert.match(code, /tier: auth\.tier/)
  assert.doesNotMatch(code, /body\.tier|body\.plan|isUltimate:/)
})

test('A CACHE HIT CALLS NOTHING AND CHARGES NOTHING', () => {
  const code = stripTs(ROUTE)
  const hit = code.indexOf("claimed.value.state === 'complete'")
  const ledger = code.indexOf('statementRateDecision(')
  assert.ok(hit !== -1 && ledger !== -1 && hit < ledger,
    'the hit returns before the allowance is even read')
  // And the response says it was served from storage.
  assert.match(code, /cached: true/)
})

test('two simultaneous requests cannot both call the model', () => {
  const code = stripTs(ROUTE)
  assert.match(code, /claimed\.value\.state === 'running'/)
  assert.match(code, /'already-running'/)
  // The database decides, not a browser button: one unique constraint.
  assert.match(stripSql(SQL), /unique \(draft_id, fingerprint\)/)
})

test('NO TRANSACTION IS HELD OPEN ACROSS THE MODEL CALL', () => {
  const code = stripTs(ROUTE)
  const claim = code.indexOf('claimAnalysis(caller.db')
  const model = code.indexOf('openai.chat.completions.create')
  const settle = code.indexOf('settleAnalysis(caller.db')
  assert.ok(claim < model && model < settle, 'claim, call, then write -- three statements')
})

test('a claim never outlives the request that took it', () => {
  const code = stripTs(ROUTE)
  // Every failure after the claim releases it, or the draft would read as
  // "already running" to the next attempt for the whole staleness window.
  assert.equal((code.match(/releaseClaim\(caller\.db, claim\)/g) ?? []).length, 3,
    'the model failure, the unparseable body, and the rejected shape')
  // AND THE RELEASE CARRIES THE TOKEN, so a request whose claim was reclaimed
  // while the model ran cannot delete the replacement.
  assert.match(code, /claimToken: claim\.claimToken,\s*review: null,/)
})

test('A FAILURE IS NEVER STORED AS A SUCCESS', () => {
  const code = stripTs(ROUTE)
  const store = code.indexOf('settleAnalysis(caller.db, {')
  const validated = code.indexOf('if (!parsed.ok)')
  assert.ok(validated < store, 'the result is stored only after it validated')
  assert.match(code, /review: parsed\.review/)
  // And the database refuses a complete row without one.
  assert.match(stripSql(SQL), /status = 'complete' and review is not null and overall is not null/)
})

test('NO SILENT FALL-BACK TO A REPEATED PAID CALL', () => {
  // With the cache on, a claim that failed means this request cannot tell
  // whether the work was already paid for. Running the model anyway is the
  // charge this feature exists to prevent.
  const code = stripTs(ROUTE)
  const failure = code.indexOf('if (!claimed.ok)')
  const model = code.indexOf('openai.chat.completions.create')
  assert.ok(failure !== -1 && failure < model)
  const branch = code.slice(failure, failure + 420)
  assert.match(branch, /return NextResponse\.json/)
  assert.doesNotMatch(branch, /openai/)
})

test('the cache is gated, and the gate now fails closed rather than skipping', () => {
  // This test once asserted `if (analysisCacheEnabled())` guarded the claim --
  // which skipped storage and called the model anyway. That is the silent
  // repeat charge the correction removes: the gate is now an availability
  // decision that refuses outside development.
  const code = stripTs(ROUTE)
  assert.match(code, /cacheEnabled: analysisCacheEnabled\(\)/)
  const decided = code.indexOf('const availability = analysisAvailability({')
  const claim = code.indexOf('claimAnalysis(caller.db')
  const model = code.indexOf('openai.chat.completions.create')
  assert.ok(decided !== -1 && decided < claim && decided < model)
  // Storage is used when, and only when, it is there.
  assert.match(code, /if \(availability === 'ready'\) \{/)
})

test('the stored row carries no essay, and no browser-supplied provenance', () => {
  const sql = stripSql(SQL)
  assert.doesNotMatch(sql, /\bessay\b/, 'the draft already holds it')
  // Provenance is written from what the SERVER resolved against the catalog.
  //
  // THE CALL IS NOW draftProvenance, which routes a prompt-backed draft to
  // verifiedProvenance unchanged and a requirement-backed one to a lookup in
  // statement_requirements. The prompt verifier is INJECTED rather than
  // imported by the requirements module, so the route still names it.
  const code = stripTs(ROUTE)
  assert.match(code, /const verdict = await draftProvenance\(/)
  assert.match(code, /const provenance = verdict\.provenance/)
  assert.match(code, /^\s*verifiedProvenance,$/m, 'the prompt verifier is passed in')
  assert.ok(code.indexOf('draftProvenance(') < code.indexOf('claimAnalysis(caller.db'))
  // NOTHING FROM THE SNAPSHOT DECIDES IT. The route hands over the parsed
  // requirement and the draft's two prompt fields; it reads no verification
  // field of its own, because an applicant can PATCH that column directly.
  const call = code.slice(code.indexOf('const verdict = await draftProvenance('),
    code.indexOf('const authoritative'))
  assert.doesNotMatch(call, /verification|verifiedOn|sourceUrl|status/)
})

test('applicants may read their own analyses and write none', () => {
  const sql = stripSql(SQL)
  assert.match(sql, /for select to authenticated using \(user_id = \(select auth\.uid\(\)\)\)/)
  assert.doesNotMatch(sql, /for (insert|update|delete) to authenticated/i)
  const grants = (sql.match(/^\s*(grant|revoke)[\s\S]*?;/gm) ?? []).join('\n')
  assert.match(grants, /grant select on public\.statement_analyses to authenticated;/)
  assert.doesNotMatch(grants, /grant\s+(insert|update|delete)\s+on public\.statement_analyses/i)
  assert.match(grants, /revoke all on public\.statement_analyses from public;/)
})

test('both writes are definer functions that take no identity argument', () => {
  const sql = stripSql(SQL)
  const bodies = sql.split('create or replace function').slice(1)
  assert.equal(bodies.length, 2)
  for (const body of bodies) {
    assert.match(body, /security definer/)
    assert.match(body, /set search_path = ''/)
    assert.match(body, /auth\.uid\(\)/)
    assert.doesNotMatch(body, /p_user|p_owner|p_user_id/)
  }
  // Neither is reachable anonymously.
  assert.match(sql, /revoke all on function public\.claim_statement_analysis[\s\S]*?from anon;/)
  assert.match(sql, /revoke all on function public\.settle_statement_analysis[\s\S]*?from anon;/)
})

test('another applicant’s analysis reads as absent, not as forbidden', () => {
  assert.match(stripSql(SQL), /if v_row\.user_id <> v_user then/)
  assert.match(stripSql(SQL), /'reason', 'not-found'/)
})

/* ===========================================================================
 * UNLIMITED FOR ULTIMATE, AND HONEST WHEN STORAGE IS ABSENT.
 * ======================================================================== */

test('V2 HAS NO DAILY OR MONTHLY CEILING', () => {
  // A 60-a-day cap is a fixed allowance by another name: an applicant
  // rewriting a statement over a long evening would meet it.
  const windows = V2_ANALYSIS_RATE_LIMITS.map((w) => w.windowMs)
  const DAY = 24 * 60 * 60_000
  assert.equal(windows.some((ms) => ms >= DAY), false, 'no window spans a day or longer')
  assert.equal(V2_ANALYSIS_RATE_LIMITS.length, 2)
})

test('burst protection remains', () => {
  assert.deepEqual([...V2_ANALYSIS_RATE_LIMITS], [
    { windowMs: 60_000, max: 5 },
    { windowMs: 60 * 60_000, max: 20 },
  ])
})

test('the legacy analyser keeps its own limits, daily cap included', async () => {
  const { STATEMENT_RATE_LIMITS } = await import('../entitlement.ts')
  const DAY = 24 * 60 * 60_000
  assert.ok(STATEMENT_RATE_LIMITS.some((w) => w.windowMs === DAY), 'unchanged')
  assert.notDeepEqual([...STATEMENT_RATE_LIMITS], [...V2_ANALYSIS_RATE_LIMITS])
  // And the shared decision function still defaults to the legacy set.
  const usage = read('../usage.ts')
  assert.match(usage, /options\.limits \?\? STATEMENT_RATE_LIMITS/)
})

test('the legacy route passes no limits, so its behaviour is untouched', () => {
  const legacy = read('../../../app/api/analyze-statement/route.ts')
  assert.equal(legacy.includes('V2_ANALYSIS_RATE_LIMITS'), false)
  assert.equal(legacy.includes('limits:'), false)
})

test('WITHOUT STORAGE, PRODUCTION REFUSES RATHER THAN CHARGING AGAIN', () => {
  assert.equal(analysisAvailability({ cacheEnabled: false, nodeEnv: 'production' }), 'unavailable')
  for (const env of [undefined, '', 'test', 'staging', 'Development', 'prod']) {
    assert.equal(
      analysisAvailability({ cacheEnabled: false, nodeEnv: env }), 'unavailable', String(env),
    )
  }
})

test('the development path is development only, and never a fallback', () => {
  assert.equal(
    analysisAvailability({ cacheEnabled: false, nodeEnv: 'development' }),
    'development-no-cache',
  )
  // With storage it is simply ready, wherever it runs.
  assert.equal(analysisAvailability({ cacheEnabled: true, nodeEnv: 'production' }), 'ready')
  assert.equal(analysisAvailability({ cacheEnabled: true, nodeEnv: 'development' }), 'ready')
  // An exact boolean: a truthy flag is not storage.
  for (const notTrue of [1, 'on', {}, 'true']) {
    assert.equal(
      analysisAvailability({ cacheEnabled: notTrue as never, nodeEnv: 'production' }),
      'unavailable',
    )
  }
})

test('the development notice promises no deduplication', () => {
  assert.ok(ANALYSIS_NO_CACHE_NOTICE.includes('Development mode'))
  assert.ok(ANALYSIS_NO_CACHE_NOTICE.includes('every analysis is a new request'))
  assert.equal(/previous analysis|reuse|cached|no (extra|additional) charge/i
    .test(ANALYSIS_NO_CACHE_NOTICE), false)
})

test('the refusal says nothing was charged, and is its own code', () => {
  assert.ok(ANALYSIS_UNAVAILABLE_MESSAGE.includes('Nothing has been charged'))
  assert.equal(ANALYSIS_UNAVAILABLE_CODE, 'analysis-storage-unavailable')
  assert.notEqual(ANALYSIS_UNAVAILABLE_CODE, ANALYSIS_TIER_CODE)
})

test('the route fails closed BEFORE the model, the ledger and the draft checks', () => {
  const code = stripTs(ROUTE)
  const gate = code.indexOf("availability === 'unavailable'")
  assert.notEqual(gate, -1)
  for (const later of ['eligibilityFor({', 'statementRateDecision(', 'recordStatementAttempt(',
                       'openai.chat.completions.create']) {
    assert.ok(gate < code.indexOf(later), `the availability gate must precede ${later}`)
  }
  assert.match(code, /V2_ANALYSIS_RATE_LIMITS/)
})

test('the response says whether this result was stored', () => {
  // False means asking again will pay again. The interface must not imply
  // otherwise, so the fact travels with the result.
  assert.match(stripTs(ROUTE), /stored: availability === 'ready'/)
})

test('RESTORING PREVIOUSLY ANALYSED CONTENT FINDS ITS OWN RESULT', () => {
  // Analyse A, edit to B, analyse B, undo back to A. A recency lookup would
  // offer "Analyze updated draft" and charge again for work already stored.
  const page = read('../../../app/statement-studio/[id]/page.tsx')
  assert.match(page, /analysisFor\(db, draft\.id, currentFingerprint\)/)
  assert.equal(page.includes('latestAnalysis('), false, 'recency is the wrong key')
})

/* ===========================================================================
 * THE AUDIT HARDENING OF 20261002_004.
 *
 * STILL STATIC. These read the SQL text and prove the file says what the audit
 * asked for. They prove NOTHING about a running database: whether the draft
 * read really refuses another user's draft, and whether the loser of a real
 * race really receives 'running', can only be established by
 * supabase/tests/statement_analyses_behaviour_test.sql against an applied
 * schema, in two sessions, which nothing here has done.
 * ======================================================================== */

test('CLAIMING REQUIRES OWNING THE DRAFT', () => {
  const sql = stripSql(SQL)
  // The ownership read, with the user filter on the same predicate as the id.
  assert.match(sql,
    /select exists \(\s*select 1 from public\.statement_drafts d\s*where d\.id = p_draft_id and d\.user_id = v_user\s*\)/)
  // And it refuses before anything is read from or written to the table.
  const owns = sql.indexOf('d.user_id = v_user')
  for (const later of ['from public.statement_analyses', 'insert into public.statement_analyses']) {
    assert.ok(owns < sql.indexOf(later), `the ownership check must precede ${later}`)
  }
  // ABSENT AND SOMEBODY ELSE'S GIVE THE SAME ANSWER, so the function cannot be
  // used to discover which draft ids exist.
  assert.match(sql, /if not v_owns then\s*return jsonb_build_object\('ok', false, 'reason', 'not-found'\)/)
})

test('OWNERSHIP COMES FROM auth.uid() AND FROM NO PARAMETER', () => {
  const sql = stripSql(SQL)
  assert.match(sql, /v_user\s+uuid := auth\.uid\(\)/)
  // No parameter could name a user: the signature has none, and the insert
  // writes v_user rather than anything supplied.
  const signature = sql.slice(sql.indexOf('create or replace function public.claim_statement_analysis'),
    sql.indexOf('returns jsonb'))
  assert.doesNotMatch(signature, /p_user|user_id|p_owner/)
  assert.match(sql, /values \(\s*v_user, p_draft_id/)
})

test('THE LOSER OF A RACE GETS A STATE, NOT AN EXCEPTION', () => {
  const sql = stripSql(SQL)
  // on conflict do nothing, by constraint NAME so a rename fails loudly.
  assert.match(sql,
    /on conflict on constraint statement_analyses_draft_fingerprint_key do nothing/)
  // And the loop re-reads, so the loser reports the winner's state.
  assert.match(sql, /while v_attempts < 2 loop/)
  assert.match(sql, /v_attempts := v_attempts \+ 1/)
  // BOUNDED. A definer function that can spin is worse than one that gives up.
  assert.doesNotMatch(sql, /^\s*loop\s*$/m)
  // The give-up answer is a refusal, not a fabricated success.
  assert.match(sql, /end loop;\s*return jsonb_build_object\('ok', false, 'reason', 'invalid'\)/)
})

test('A MALFORMED DIRECT RPC CALL IS REFUSED, NOT RAISED', () => {
  const sql = stripSql(SQL)
  // Every parameter behind a not-null or CHECKed column is validated, because
  // the function is granted to `authenticated` and reachable over PostgREST.
  for (const guard of ['p_revision is null', 'p_prompt_attached is null', 'p_words is null',
    'p_rubric_version is null', 'p_schema_version is null',
    "p_provenance is not null and p_provenance not in ('catalog', 'user')"]) {
    assert.ok(sql.includes(guard), `claim() does not validate: ${guard}`)
  }
  // settle() guards the one CHECKed column it writes.
  assert.match(sql, /p_overall is not null and \(p_overall < 0 or p_overall > 100\)/)
})

test('A FAILED PROVIDER CALL LEAVES NO PERMANENT CLAIM', () => {
  const sql = stripSql(SQL)
  // The release path deletes rather than marking failed, and only a pending row
  // the caller owns.
  assert.match(sql,
    /delete from public\.statement_analyses\s*where id = p_id and claim_token = p_token\s*and user_id = v_user and status = 'pending'/)
  // And a result is only ever written onto a pending row the caller owns, so a
  // late arrival cannot overwrite feedback already on screen.
  assert.match(sql,
    /where id = p_id and claim_token = p_token\s*and user_id = v_user and status = 'pending'\s*returning id into v_updated/)
})

test('AN EXPIRED CLAIM IS RECOVERED WITHOUT CHANGING ITS IDENTITY', () => {
  const sql = stripSql(SQL)
  // The stale row is touched, not deleted and re-inserted: the id survives, so
  // a settle() still in flight from the dead request completes THIS row.
  assert.match(sql, /if v_row\.updated_at > now\(\) - interval '10 minutes' then/)
  // THE ID SURVIVES RECOVERY -- the row is touched, not deleted and re-inserted.
  assert.match(sql,
    /update public\.statement_analyses\s*set updated_at = now\(\),\s*claim_token = gen_random_uuid\(\)\s*where id = v_row\.id/)
  assert.doesNotMatch(sql, /delete from public\.statement_analyses\s*where id = v_row\.id/)
  // AND THE TOKEN DOES NOT. That is the point: the abandoned request still
  // holds the old one, so it can neither complete nor release the replacement.
  assert.match(sql, /claim_token = gen_random_uuid\(\)/)
})

test('THE HARDENING DID NOT LOOSEN DEFINER, SEARCH PATH OR GRANTS', () => {
  const sql = stripSql(SQL)
  // Two functions, both definer, both with an empty search path.
  assert.equal((sql.match(/security definer/g) ?? []).length, 2)
  assert.equal((sql.match(/set search_path = ''/g) ?? []).length, 2)
  // Signatures unchanged, so the revoke/grant statements still name them.
  for (const fn of ['claim_statement_analysis', 'settle_statement_analysis']) {
    assert.ok(sql.includes(`revoke all on function public.${fn}(`), `${fn}: no revoke`)
    assert.ok(sql.includes(`grant execute on function public.${fn}(`), `${fn}: no grant`)
    assert.match(sql,
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s*from anon`),
      `${fn}: anon must hold no EXECUTE`)
  }
  // The table itself is still select-only for authenticated and nothing for the
  // other roles.
  assert.match(sql, /revoke all on public\.statement_analyses from anon, authenticated, service_role/)
  assert.match(sql, /grant select on public\.statement_analyses to authenticated;/)
  assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*statement_analyses/)
  // Still exactly one policy, and it is a SELECT policy.
  assert.equal((sql.match(/create policy/g) ?? []).length, 1)
  assert.match(sql, /create policy "own statement analysis select"[\s\S]*?for select to authenticated/)
})

test('THE HARDENING ADDED NO DML OUTSIDE THE DEFINER BODIES', () => {
  // The audit's additive finding has to survive the edit.
  const outside = stripSql(SQL).replace(/\$fn\$[\s\S]*?\$fn\$/g, ' BODY ')
  for (const dml of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i,
    /\btruncate\b/i, /\bdrop\s+table\b/i]) {
    assert.doesNotMatch(outside, dml, String(dml))
  }
  // And it still alters only its own table.
  const altered = new Set((outside.match(/alter table (?:if exists )?\S+/gi) ?? [])
    .map((m) => m.split(/\s+/).pop()))
  assert.deepEqual([...altered], ['public.statement_analyses'])
})

/* ===========================================================================
 * A SUPERSEDED REQUEST HAS NO AUTHORITY.
 *
 * The hole: recovering an abandoned claim keeps the row's id, and the id was
 * the only thing settle() checked -- so the request whose claim had been
 * reclaimed could still complete it, or release it out from under the
 * replacement. Authority is now the per-attempt token.
 *
 * STILL STATIC. These read the SQL and the route. Whether a real superseded
 * request is actually refused needs the two-session procedure in
 * supabase/tests/statement_analyses_behaviour_test.sql, against an applied
 * schema, which nothing here has done.
 * ======================================================================== */

test('EVERY SUCCESSFUL CLAIM CARRIES A FRESH TOKEN', () => {
  const sql = stripSql(SQL)
  // The column, not null, defaulted per row.
  assert.match(sql, /claim_token\s+uuid\s+not null default gen_random_uuid\(\)/)
  // A fresh insert returns the token the default generated -- it does not
  // generate a second one, so the row and the caller cannot disagree.
  assert.match(sql,
    /'state', 'claimed',\s*'id', v_row\.id, 'claimToken', v_row\.claim_token/)
  // A RECLAIM ROTATES IT. This is the fix.
  assert.match(sql,
    /set updated_at = now\(\),\s*claim_token = gen_random_uuid\(\)\s*where id = v_row\.id\s*returning \* into v_row/)
  // Both claimed paths hand one back.
  assert.equal((sql.match(/'claimToken'/g) ?? []).length, 2,
    'the fresh claim and the reclaim')
})

test('A LIVE CLAIM IS REPORTED WITHOUT A TOKEN', () => {
  const sql = stripSql(SQL)
  // 'running' is not authority: that caller did not win the attempt, so it is
  // given nothing it could settle with.
  const running = sql.slice(sql.indexOf("'state', 'running'"))
  assert.match(running.slice(0, 120), /'id', v_row\.id\);/)
  assert.doesNotMatch(running.slice(0, 120), /claimToken/)
})

test('SETTLING REQUIRES THE TOKEN ON BOTH PATHS', () => {
  const sql = stripSql(SQL)
  // The signature changed, so a stale deployment fails loudly rather than
  // settling without one.
  assert.match(sql,
    /create or replace function public\.settle_statement_analysis\(\s*p_id\s+uuid,\s*p_token\s+uuid,/)
  // And the old three-argument overload is dropped, not left beside it.
  assert.match(sql,
    /drop function if exists public\.settle_statement_analysis\(uuid, jsonb, integer\);/)
  // A null token is not a wildcard.
  assert.match(sql, /if p_token is null then\s*return jsonb_build_object\('ok', false, 'reason', 'invalid'\)/)
  // Complete path.
  assert.match(sql, /set status = 'complete',[\s\S]{0,160}where id = p_id and claim_token = p_token/)
  // Release path -- the one that could delete the replacement's claim.
  assert.match(sql,
    /delete from public\.statement_analyses\s*where id = p_id and claim_token = p_token/)
})

test('A COMPLETED ANALYSIS IS STILL UNOVERWRITABLE, AND THE REFUSAL SAYS NOTHING', () => {
  const sql = stripSql(SQL)
  // status = 'pending' survives in both predicates, so a late request cannot
  // replace feedback already on screen.
  assert.equal((sql.match(/and user_id = v_user and status = 'pending'/g) ?? []).length, 2,
    'the release path and the complete path')
  // Wrong id, wrong token, wrong user and already-complete are one answer.
  assert.match(sql,
    /if v_updated is null then\s*return jsonb_build_object\('ok', false, 'reason', 'not-found'\)/)
})

test('A SUPERSEDED RELEASE REPORTS SUCCESS AND REMOVES NOTHING', () => {
  const sql = stripSql(SQL)
  // Being superseded is the normal outcome of losing a reclaim race, not an
  // error -- so the release path reports released and says whether a row went.
  assert.match(sql,
    /return jsonb_build_object\('ok', true, 'state', 'released',\s*'released', v_updated is not null\)/)
})

test('THE ROUTE HOLDS THE TOKEN AND PASSES IT EVERYWHERE', () => {
  const code = stripTs(ROUTE)
  assert.match(code, /let claim: HeldClaim \| null = null/)
  assert.match(code, /claim = \{ id: claimed\.value\.id, claimToken: claimed\.value\.claimToken \}/)
  // Both settle sites name it.
  assert.equal((code.match(/claimToken: claim\.claimToken,/g) ?? []).length, 2,
    'the release helper and the store')
  // And nothing settles by id alone any more.
  assert.doesNotMatch(code, /settleAnalysis\([^)]*\{\s*id: claim\.id,\s*review:/)
})

test('NO TRANSACTION STILL SPANS THE MODEL CALL', () => {
  // The token changed who may settle, not when. Re-asserted because a token
  // is exactly the kind of thing somebody would be tempted to hold a
  // transaction open for.
  const code = stripTs(ROUTE)
  const claim = code.indexOf('claimAnalysis(caller.db')
  const model = code.indexOf('openai.chat.completions.create')
  const settle = code.indexOf('settleAnalysis(caller.db, {')
  assert.ok(claim < model && model < settle, 'claim, call, then write -- three statements')
  // No explicit transaction control anywhere in the route.
  assert.doesNotMatch(code, /\bbegin\b.*transaction|rpc\('begin'|set transaction/i)
})

test('A CACHE HIT IS STILL FREE AND NEEDS NO TOKEN', () => {
  const code = stripTs(ROUTE)
  const hit = code.indexOf("claimed.value.state === 'complete'")
  const ledger = code.indexOf('statementRateDecision(')
  assert.ok(hit !== -1 && hit < ledger, 'the hit returns before the allowance is read')
  // The complete branch of the Claim union carries no token, so a hit has
  // nothing to settle and cannot accidentally try.
  const repo = stripTs(read('./analysisRepo.ts'))
  assert.match(repo, /\| \{ readonly state: 'complete'; readonly analysis: StoredAnalysis \}/)
})

/* ===========================================================================
 * DELETION AND RETENTION.
 * ======================================================================== */

test('AN ANALYSIS CANNOT OUTLIVE THE DRAFT IT QUOTES', () => {
  const sql = stripSql(SQL)
  // The review's `evidence` is a verified span of the applicant's essay, so an
  // orphaned row holds excerpts of a personal statement.
  assert.match(sql,
    /foreign key \(draft_id\) references public\.statement_drafts\(id\) on delete cascade/)
})

test('AN ANALYSIS CANNOT OUTLIVE THE ACCOUNT EITHER', () => {
  const sql = stripSql(SQL)
  assert.match(sql,
    /foreign key \(user_id\) references auth\.users\(id\) on delete cascade/)
})

test('THE CASCADE HAS AN INDEX TO USE', () => {
  // A cascading delete without an index on the referencing column degrades to a
  // sequential scan per deleted parent.
  const sql = stripSql(SQL)
  assert.match(sql,
    /create index if not exists statement_analyses_draft_idx\s*on public\.statement_analyses \(draft_id/)
})

test('THE CLEANUP CHANGES NO DELETION CODE', () => {
  // The whole point of doing it with a foreign key: deleteDraft() stays one
  // statement and the administrator's script stays untouched.
  const repo = stripTs(read('./draftRepo.ts'))
  const del = repo.slice(repo.indexOf('export async function deleteDraft'))
  assert.doesNotMatch(del.slice(0, 700), /statement_analyses/)
  const admin = read('../../../supabase/manual/delete_fake_accounts.sql')
  assert.doesNotMatch(admin, /statement_analyses/)
})

test('NO SWEEP, TRIGGER OR SCHEDULED JOB WAS INTRODUCED', () => {
  const sql = stripSql(SQL)
  assert.doesNotMatch(sql, /create trigger|create or replace trigger/i)
  assert.doesNotMatch(sql, /pg_cron|cron\.schedule/i)
  // And no retention DELETE runs at apply time.
  const outside = sql.replace(/\$fn\$[\s\S]*?\$fn\$/g, ' BODY ')
  assert.doesNotMatch(outside, /\bdelete\s+from\b/i)
})
