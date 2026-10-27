/**
 * AI-QA-017: four simultaneous requests for one essay made four model calls.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE AUDIT MEASURED
 * ---------------------------------------------------------------------------
 * Same user, same draft, same essay -- therefore the SAME fingerprint -- four
 * requests in parallel, four upstream calls, all four answering
 * `200 cached:false`. Not different scenarios and not different keys: the
 * audit set one essay and fired four.
 *
 * The cause is that the durable claim is taken only when the analysis cache is
 * on. With it off, production answers 503 and nothing runs, but a developer's
 * machine runs the model anyway -- and that is where the real API key lives.
 *
 * This is the slot that collapses that burst. It does not replace the claim,
 * and the route still prefers the claim wherever it exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  IN_FLIGHT_TTL_MS, analysesInFlight, beginAnalysis, endAnalysis,
  resetAnalysisInFlight,
} from './analysisInFlight.ts'

const KEY = 'user-1:draft-1:fingerprint-a'

test('the first caller takes the slot and the next three do not', () => {
  resetAnalysisInFlight()
  // FOUR IN ONE TICK, which is what Promise.all of four fetches looks like to
  // a single-threaded server: no await between the read and the write.
  const outcomes = [beginAnalysis(KEY), beginAnalysis(KEY), beginAnalysis(KEY),
    beginAnalysis(KEY)]
  assert.deepEqual(outcomes, [true, false, false, false])
  assert.equal(analysesInFlight(), 1)
})

test('releasing lets the next attempt through', () => {
  resetAnalysisInFlight()
  assert.equal(beginAnalysis(KEY), true)
  assert.equal(beginAnalysis(KEY), false)
  endAnalysis(KEY)
  assert.equal(analysesInFlight(), 0)
  assert.equal(beginAnalysis(KEY), true)
})

test('A DIFFERENT ESSAY IS A DIFFERENT ANALYSIS, and must not be blocked', () => {
  resetAnalysisInFlight()
  assert.equal(beginAnalysis('u:d:fingerprint-a'), true)
  // Same user, same draft, different text.
  assert.equal(beginAnalysis('u:d:fingerprint-b'), true)
  // Different applicant, same text.
  assert.equal(beginAnalysis('other:d:fingerprint-a'), true)
  assert.equal(analysesInFlight(), 3)
})

test('an abandoned slot expires rather than wedging the draft', () => {
  resetAnalysisInFlight()
  let now = 1_000_000
  const clock = () => now
  assert.equal(beginAnalysis(KEY, clock), true)
  now += IN_FLIGHT_TTL_MS - 1
  assert.equal(beginAnalysis(KEY, clock), false, 'still running, so still held')
  now += 2
  assert.equal(beginAnalysis(KEY, clock), true, 'past the TTL it is reclaimable')
})

test('the TTL is longer than the route can possibly take', () => {
  const route = readFileSync(fileURLToPath(new URL(
    '../../../app/api/statement/drafts/[id]/analyze/route.ts', import.meta.url)), 'utf8')
  const timeout = /MODEL_TIMEOUT_MS = ([\d_]+)/.exec(route)
  const duration = /maxDuration = (\d+)/.exec(route)
  assert.ok(timeout !== null && duration !== null)
  const modelMs = Number(timeout[1]!.replace(/_/g, ''))
  const routeMs = Number(duration[1]!) * 1000
  assert.ok(IN_FLIGHT_TTL_MS > modelMs, 'a slow model would look abandoned')
  assert.ok(IN_FLIGHT_TTL_MS > routeMs, 'a request at its limit would look abandoned')
})

// ---------------------------------------------------------------------------
// The route's use of it, source-derived
// ---------------------------------------------------------------------------

const ROUTE = readFileSync(fileURLToPath(new URL(
  '../../../app/api/statement/drafts/[id]/analyze/route.ts', import.meta.url)), 'utf8')

test('the slot is keyed on the user, the draft AND the fingerprint', () => {
  assert.match(ROUTE, /const inFlightKey = `\$\{caller\.userId\}:\$\{id\}:\$\{fingerprint\}`/)
})

test('THE DURABLE CLAIM STILL WINS WHERE IT EXISTS', () => {
  // With the cache on, the claim is the authority and no slot is taken: two
  // mechanisms answering the same question is how they drift apart.
  assert.match(ROUTE, /availability === 'ready' \? false : beginAnalysis\(inFlightKey\)/)
})

test('the refusal is the SAME 409 the claim produces', () => {
  // So the applicant is told one true thing, and the client needs no tenth code.
  const block = ROUTE.slice(ROUTE.indexOf('const slotTaken'))
  assert.match(block.slice(0, 400), /code: 'already-running'/)
  assert.match(block.slice(0, 400), /status: 409/)
})

test('EVERY EXIT RELEASES IT, which is why there is a finally', () => {
  assert.match(ROUTE, /\} finally \{\n    release\(\)\n  \}/)
  // And the release is conditional on having taken one, so a cache-on request
  // cannot delete a slot it never held.
  assert.match(ROUTE, /const release = \(\): void => \{ if \(slotTaken\) endAnalysis\(inFlightKey\) \}/)
})
