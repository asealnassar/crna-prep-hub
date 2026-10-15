/**
 * AI-QA-003: every refusal the analyse route can answer with has its own
 * message, and adding a tenth breaks this file rather than reaching an
 * applicant as a shrug.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * The route answers with nine codes. The client mapped six, and the three it
 * missed fell through to "The analysis could not be completed. Please try
 * again.", marked retryable. Two of those mattered:
 *
 *   `already-running` (409) is reachable in ordinary use -- a second tab -- and
 *   the advice given was the one action certain to produce the same 409.
 *   `analysis-requires-ultimate` (403) turned a clear upsell into what reads
 *   like a bug, on the very path that exists because hiding the button is only
 *   a courtesy.
 *
 * THE CODES ARE READ OUT OF THE ROUTE, not listed here. A list would be a
 * fourth place to forget.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ANALYSIS_REFUSAL_CODES, REVIEW_MESSAGES, reviewOutcomeFrom,
} from './reviewClient.ts'
import { RATE_LIMIT_CODE } from '../entitlement.ts'
import { ANALYSIS_TIER_CODE, ANALYSIS_UNAVAILABLE_CODE } from './reviewAccess.ts'

const ROUTE = readFileSync(fileURLToPath(new URL(
  '../../../app/api/statement/drafts/[id]/analyze/route.ts', import.meta.url)), 'utf8')

/** Every `code:` the route can answer with, resolved through its constants. */
function routeCodes(): readonly string[] {
  const CONSTANTS: Record<string, string> = {
    RATE_LIMIT_CODE,
    ANALYSIS_TIER_CODE,
    ANALYSIS_UNAVAILABLE_CODE,
  }
  const found = new Set<string>()
  for (const match of ROUTE.matchAll(/code: '([a-z-]+)'/g)) found.add(match[1]!)
  for (const match of ROUTE.matchAll(/code: ([A-Z_]+)/g)) {
    const resolved = CONSTANTS[match[1]!]
    assert.ok(resolved !== undefined,
      `the route answers with ${match[1]} and this test cannot resolve it`)
    found.add(resolved)
  }
  return [...found].sort()
}

test('the route answers with the codes we think it does', () => {
  // Nine, as the audit counted. A tenth fails the next test until it is mapped.
  const codes = routeCodes()
  assert.equal(codes.length, 9, `the route now answers with ${codes.length} codes: ${codes}`)
})

test('AI-QA-003 EVERY ROUTE CODE HAS ITS OWN MESSAGE', () => {
  const unmapped = routeCodes().filter((code) => !ANALYSIS_REFUSAL_CODES.includes(code))
  assert.deepEqual(unmapped, [],
    `the applicant would be shown the generic failure for: ${unmapped.join(', ')}`)
})

test('and the mapping carries nothing the route cannot send', () => {
  const codes = routeCodes()
  const stale = ANALYSIS_REFUSAL_CODES.filter((code) => !codes.includes(code))
  assert.deepEqual(stale, [], `mapped codes the route never sends: ${stale.join(', ')}`)
})

test('the nine messages are distinct, so none is a copy of another', () => {
  const messages = ANALYSIS_REFUSAL_CODES.map((code) =>
    (reviewOutcomeFrom({ status: 400, body: { code } }) as { message: string }).message)
  assert.equal(new Set(messages).size, messages.length, 'two codes share a message')
})

// ---------------------------------------------------------------------------
// The distinctions that matter, one at a time
// ---------------------------------------------------------------------------

const outcome = (status: number, code?: string) =>
  reviewOutcomeFrom({ status, body: code === undefined ? {} : { code } })

test('ALREADY RUNNING does not tell the applicant to try again', () => {
  const result = outcome(409, 'already-running')
  assert.equal(result.type, 'refused')
  assert.ok(result.type === 'refused')
  assert.match(result.message, /already running/i)
  assert.match(result.message, /Wait for it to finish/i)
  // THE POINT OF THE FINDING. Retrying returns the same 409.
  assert.equal(result.retryable, false)
  assert.doesNotMatch(result.message, /try again/i)
})

test('ULTIMATE REQUIRED names the plan, and is not a failure', () => {
  const result = outcome(403, ANALYSIS_TIER_CODE)
  assert.ok(result.type === 'refused')
  assert.match(result.message, /Ultimate/)
  assert.equal(result.retryable, false)
  assert.doesNotMatch(result.message, /could not be completed/i)
})

test('TEMPORARILY UNAVAILABLE says nothing was charged, and is not retryable', () => {
  const result = outcome(503, ANALYSIS_UNAVAILABLE_CODE)
  assert.ok(result.type === 'refused')
  assert.match(result.message, /not available/i)
  assert.match(result.message, /Nothing has been charged/i)
  assert.equal(result.retryable, false)
})

test('AN EXPIRED SESSION says to sign in, not to reload', () => {
  const result = outcome(401)
  assert.ok(result.type === 'refused')
  assert.match(result.message, /session has expired/i)
  assert.match(result.message, /Sign in again/i)
  assert.equal(result.retryable, false)
})

test('AN INELIGIBLE ESSAY is not retryable, and says what to do instead', () => {
  for (const code of ['too-short', 'prompt-too-short']) {
    const result = outcome(422, code)
    assert.ok(result.type === 'refused')
    assert.equal(result.retryable, false, code)
  }
  assert.match(outcome(422, 'too-short').type === 'refused'
    ? (outcome(422, 'too-short') as { message: string }).message : '', /Write a little more/i)
})

test('THROTTLED is retryable, and says to wait', () => {
  const result = outcome(429, RATE_LIMIT_CODE)
  assert.ok(result.type === 'refused')
  assert.equal(result.retryable, true)
  assert.match(result.message, /wait a moment/i)
})

test('A MALFORMED AI RESULT is retryable and shows nothing', () => {
  const result = outcome(502, 'malformed')
  assert.ok(result.type === 'refused')
  assert.equal(result.retryable, true)
  assert.match(result.message, /nothing is shown/i)
})

test('AN UPSTREAM FAILURE is retryable', () => {
  const result = outcome(502, 'unavailable')
  assert.ok(result.type === 'refused')
  assert.equal(result.retryable, true)
})

test('A DRAFT THAT IS NOT THERE -- or not theirs -- reads the same either way', () => {
  for (const probe of [outcome(404, 'not-found'), outcome(404)]) {
    assert.ok(probe.type === 'refused')
    assert.equal(probe.message, REVIEW_MESSAGES.unavailableDraft)
  }
})

test('NO INTERNAL DETAIL REACHES THE APPLICANT', () => {
  /*
   * Fixed strings only. A server `error` field, a reason from the validator, a
   * PostgREST code or a model name must never be shown -- the body is data from
   * a path that has already failed.
   */
  const leaky = reviewOutcomeFrom({
    status: 502,
    body: {
      code: 'malformed',
      error: 'parse failed: unverifiable-evidence at categories[2]',
      detail: 'gpt-4o returned 1 of 7',
      hint: 'relation "statement_analyses" does not exist',
    },
  })
  assert.ok(leaky.type === 'refused')
  assert.equal(leaky.message, REVIEW_MESSAGES.malformed)
  for (const secret of ['unverifiable-evidence', 'gpt-4o', 'statement_analyses',
    'categories[2]', 'parse failed']) {
    assert.ok(!leaky.message.includes(secret), `leaked: ${secret}`)
  }
  // And an unrecognised code falls back to a fixed string, never to the body.
  const unknown = reviewOutcomeFrom({
    status: 418, body: { code: 'teapot', error: 'internal: shard 3 unreachable' },
  })
  assert.ok(unknown.type === 'refused')
  assert.equal(unknown.message, REVIEW_MESSAGES.unavailable)
})

test('every message is written to the applicant, not about the system', () => {
  for (const code of ANALYSIS_REFUSAL_CODES) {
    const result = outcome(400, code)
    assert.ok(result.type === 'refused')
    const message = result.message
    assert.ok(message.length > 20, `${code} is too terse to be useful`)
    assert.ok(/[.!]$/.test(message.trim()), `${code} is not a sentence`)
    for (const jargon of ['null', 'undefined', '500', '502', 'RPC', 'fingerprint',
      'claim', 'PostgREST', 'OpenAI', 'token']) {
      assert.ok(!message.includes(jargon), `${code} leaks "${jargon}"`)
    }
  }
})
