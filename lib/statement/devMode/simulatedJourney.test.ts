/**
 * The applicant journey, as simulated-live serves it.
 *
 * These assert the DATA the screens receive. The screens themselves are the
 * production components, exercised by the owner in a browser; what is worth
 * proving here is that what reaches them is the imported catalog, with the
 * activation rule applied honestly and nothing invented.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { requirementsEnabled } from '../draft/rollout.ts'
import {
  simulatedCatalog, simulatedCatalogCounts, simulatedRequirement, simulatedSetsForSchool,
} from './simulatedCatalog.ts'
import { SIMULATED_LIVE_BANNER } from './gate.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const CATALOG = simulatedCatalog()
const have = CATALOG.available.length > 0

test('the requirement rollout reads as ON in development and OFF elsewhere', () => {
  assert.equal(requirementsEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), false)
  assert.equal(requirementsEnabled({
    NODE_ENV: 'production', STATEMENT_REQUIREMENTS: 'on' } as NodeJS.ProcessEnv), true,
    'the real flag still works in production')
})

test('62 verified sets are available and 1 is withheld', { skip: !have }, () => {
  const counts = simulatedCatalogCounts()
  assert.equal(counts.availableSets, 62)
  assert.equal(counts.availableDocuments, 79)
  assert.equal(counts.withheldSets, 1)
})

test('SOUTH DAKOTA IS WITHHELD, and for the reason the database would give',
  { skip: !have }, () => {
    const withheld = CATALOG.withheld
    assert.equal(withheld.length, 1)
    assert.match(withheld[0]!.set.schoolName.toLowerCase(), /south dakota/)
    assert.equal(withheld[0]!.set.verification.status, 'needs-review')
    assert.match(withheld[0]!.reason, /005 refuses to activate a set that is not verified/)
    // and it is NOT quietly available
    assert.equal(CATALOG.available.some(
      (s) => s.schoolName.toLowerCase().includes('south dakota')), false)
  })

test('every available set is one 005 would actually let you activate',
  { skip: !have }, () => {
    for (const set of CATALOG.available) {
      assert.equal(set.verification.status, 'verified', set.schoolName)
      assert.ok(set.verification.sourceUrl, set.schoolName)
      assert.ok(set.verification.verifiedOn, set.schoolName)
      assert.ok(set.requirements.length >= 1, set.schoolName)
    }
  })

test('a school lookup returns that school only', { skip: !have }, () => {
  const sample = CATALOG.available[0]!
  const found = simulatedSetsForSchool(sample.schoolId, 'Picked name')
  assert.equal(found.length, 1)
  assert.equal(found[0]!.id, sample.id)
  // the caller's school name wins, exactly as the real read does it
  assert.equal(found[0]!.schoolName, 'Picked name')
  assert.equal(simulatedSetsForSchool('00000000-0000-4000-8000-000000000000', '').length, 0)
})

test('Boston College keeps 1.5 pages through the simulated catalog',
  { skip: !have }, () => {
    const bc = CATALOG.available.find((s) => s.schoolName.includes('Boston College'))
    assert.ok(bc, 'Boston College is not available')
    const halves = bc!.requirements.filter((r) => r.constraints.pages?.max === 1.5)
    assert.equal(halves.length, 2)
    for (const r of halves) {
      assert.equal(r.constraints.words, null, 'no word bound derived from a page limit')
      assert.equal(r.constraints.characters, null)
    }
  })

test('Gonzaga and UW-La Crosse stay prose-only', { skip: !have }, () => {
  for (const name of ['Gonzaga', 'Franciscan']) {
    const set = CATALOG.available.find((s) => s.schoolName.includes(name))
    assert.ok(set, `${name} is not available`)
    const prose = set!.requirements.filter((r) => r.constraints.unenforcedLength !== null)
    assert.equal(prose.length, 1, name)
    const c = prose[0]!.constraints
    assert.equal(c.unenforcedLength!.verbatim, false)
    assert.equal(c.words, null)
    assert.equal(c.pages?.max ?? null, null)
  }
})

test('a multi-document school is available, so that case is reviewable',
  { skip: !have }, () => {
    assert.ok(CATALOG.available.filter((s) => s.requirements.length > 1).length >= 3)
  })

test('one requirement resolves by id, and only from an available set',
  { skip: !have }, () => {
    const set = CATALOG.available.find((s) => s.requirements.length > 0)!
    const found = simulatedRequirement(set.requirements[0]!.id)
    assert.ok(found)
    assert.equal(found!.set.id, set.id)
    // a withheld school's requirement is not resolvable, so no draft can be
    // started against a set the database would refuse to activate
    const withheldRequirement = CATALOG.withheld[0]?.set.requirements[0]
    if (withheldRequirement) {
      assert.equal(simulatedRequirement(withheldRequirement.id), null)
    }
    assert.equal(simulatedRequirement('no-such-id'), null)
  })

// ----------------------------------------------------------------- analysis

test('THE REAL ANALYSER RUNS LOCALLY: no stub stands between it and the screen', () => {
  // The stub is gone. What used to be asserted about its shape is now a
  // question about the route: does a local request reach the production model
  // call and the production validator, with nothing substituted on the way?
  const src = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
  assert.equal(src.includes('mockReview'), false, 'a stand-in analysis is still reachable')
  assert.equal(src.includes('mockAnalysis'), false, 'the stub module is still imported')
  assert.match(src, /openai\.chat\.completions\.create/, 'the real model call is gone')
  assert.match(src, /parseReview\(\{ raw, promptAttached, essay: draft\.essay \}\)/,
    'the production validator is not the one judging the response')
  // ONE PROMPT, ONE MODEL. A second, simpler local prompt would make the
  // review worthless as an evaluation of what would ship.
  assert.equal((src.match(/openai\.chat\.completions\.create/g) ?? []).length, 1)
  assert.equal((src.match(/reviewSystemPrompt\(/g) ?? []).length, 1)
  assert.equal((src.match(/buildReviewUserMessage\(/g) ?? []).length, 1)
})

test('THE LOCAL BRANCHES SIT WHERE PRODUCTION PUTS THE SAME DECISIONS', () => {
  const src = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
  const at = (needle: string) => {
    const i = src.indexOf(needle)
    assert.notEqual(i, -1, `${needle} is absent`)
    return i
  }
  // Eligibility is decided before anything local happens, so its refusals are
  // still the production refusals and still cost nothing.
  assert.ok(at('eligibilityForRequirement({') < at('localAnalysisFor(id, fingerprint)'))
  // The local store is consulted BEFORE the allowance and the model, which is
  // where production's cache hit returns -- so an identical essay is answered
  // without a paid call.
  for (const later of ['statementRateDecision(', 'openai.chat.completions.create']) {
    assert.ok(at('localAnalysisFor(id, fingerprint)') < at(later),
      `the local store must be consulted before ${later}`)
  }
  // And the local write happens only after the validator accepted the response.
  assert.ok(at('parseReview({ raw, promptAttached') < at('saveLocalAnalysis({'),
    'a result could be stored locally before it validated')
})

test('NO PRODUCTION LEDGER ENTRY IS WRITTEN LOCALLY, and settle no-ops follow', () => {
  const src = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
  // The attempt is not recorded in simulated-live...
  assert.match(src, /const usageId = simulated\s*\n\s*\? null\s*\n\s*: await recordStatementAttempt\(/)
  // ...and settleStatementUsage returns immediately on a null id, which is what
  // makes every later settle call inert without a branch at each one.
  const usage = read('../usage.ts')
  assert.match(usage, /if \(!usageId\) return/)
})

test('the claim and the settle are unreachable with the cache flag off', () => {
  const src = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
  // claimAnalysis is taken only when availability is 'ready', which requires
  // STATEMENT_ANALYSIS_CACHE -- so on localhost no cache RPC runs at all, and
  // `claim` stays null, which makes settleAnalysis and releaseClaim no-ops too.
  const claimAt = src.indexOf('const claimed = await claimAnalysis(caller.db')
  assert.notEqual(claimAt, -1)
  const guard = src.lastIndexOf("if (availability === 'ready') {", claimAt)
  assert.notEqual(guard, -1, 'the claim is no longer behind the cache-flag guard')
  assert.match(src, /if \(claim !== null\) \{\s*\n\s*const stored = await settleAnalysis\(/)
  const release = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
  assert.match(release, /if \(claim === null\) return/)
})

test('the result says it was stored locally, and never that production has it', () => {
  const src = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
  assert.match(src, /stored: availability === 'ready' \|\| simulated,/)
})

test('the development notices are shown by the server\'s decision, not the browser\'s', () => {
  const client = read('../../../app/statement-studio/components/StatementStudioClient.tsx')
  const page = read('../../../app/statement-studio/[id]/page.tsx')
  // The flag is computed on the server and passed down...
  assert.match(page, /localRealAi=\{simulatedLiveEnabled\(\)\}/)
  // ...and the editor never reads an environment variable to decide it.
  assert.match(client, /localRealAi = false,/, 'the prop must default to off')
  assert.equal(/NEXT_PUBLIC_[A-Z_]*SIMULATED/.test(client), false)
  assert.equal(client.includes('simulatedLiveEnabled'), false,
    'the boundary must not be re-decided in the browser bundle')
  // The cost is stated before the click, and withdrawn when the click is a read.
  assert.match(client, /localRealAi && analysisAction !== 'view'/)
  assert.match(client, /LOCAL_REAL_AI_WARNING/)
  assert.match(client, /LOCAL_REAL_AI_NOTICE/)
})

test('NO DEVELOPMENT PREFIX CAN APPEAR INSIDE AI FEEDBACK', () => {
  // The feedback is the model's own output after validation. The old stub
  // stamped every line of it; nothing may do that again.
  const access = read('../draft/reviewAccess.ts')
  assert.match(access, /LOCAL REAL AI TEST/)
  for (const file of ['../../../app/api/statement/drafts/[id]/analyze/route.ts',
    './localAnalyses.ts', '../draft/reviewSchema.ts']) {
    assert.equal(read(file).includes('LOCAL TEST DATA'), false, file)
  }
})

test('the banner wording is one constant, used by the layout', () => {
  const layout = read('../../../app/statement-studio/layout.tsx')
  assert.match(layout, /SIMULATED_LIVE_BANNER/)
  assert.match(layout, /simulatedLiveEnabled\(\)/)
  assert.match(SIMULATED_LIVE_BANNER, /LOCAL SIMULATED LIVE/)
  // IT STILL SAYS PRODUCTION IS INACTIVE, and now also that the calls are
  // billed -- which is the thing a reviewer has to know before clicking.
  assert.match(SIMULATED_LIVE_BANNER, /production stays inactive/)
  assert.match(SIMULATED_LIVE_BANNER, /billed/)
})
