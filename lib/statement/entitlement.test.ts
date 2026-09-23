import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RATE_LIMIT_CODE, REWRITE_TIER_CODE, STATEMENT_RATE_LIMITS,
  canRewrite, canSeeSentenceAnalysis, canSeeSuggestions, checkStatementRate,
  normaliseTier, statementLedgerWindowMs,
} from './entitlement.ts'
import { AI_RATE_LIMITS } from '../resume/entitlement.ts'

// ------------------------------------------------------------- the tiers

test('what each tier gets is exactly what the pricing page already advertises', () => {
  // Phase 0 must not change what is sold. The comparison table says
  // free: 'Basic', premium: 'Basic', ultimate: 'Advanced + AI rewrites'.
  for (const tier of ['free', 'premium']) {
    assert.equal(canSeeSuggestions(tier), false, tier)
    assert.equal(canSeeSentenceAnalysis(tier), false, tier)
    assert.equal(canRewrite(tier), false, tier)
  }
  assert.equal(canSeeSuggestions('ultimate'), true)
  assert.equal(canSeeSentenceAnalysis('ultimate'), true)
  assert.equal(canRewrite('ultimate'), true)
})

test('Premium is the same as Free here, as it already was', () => {
  // Stated as a test so the day it changes, it changes deliberately.
  assert.equal(canSeeSuggestions('premium'), canSeeSuggestions('free'))
  assert.equal(canRewrite('premium'), canRewrite('free'))
})

test('an unrecognised, missing or forged tier is the lowest one', () => {
  for (const value of [
    null, undefined, '', '   ', 'admin', 'gold', 'true', 'ultimate!', 'ULTIMATE X',
    'free ultimate', '1', 'gpt',
  ]) {
    assert.equal(canSeeSuggestions(value), false, JSON.stringify(value))
    assert.equal(canRewrite(value), false, JSON.stringify(value))
    assert.equal(normaliseTier(value), 'free', JSON.stringify(value))
  }
})

test('odd casing and padding on a real tier still resolves', () => {
  for (const value of ['ULTIMATE', ' Ultimate ', 'uLtImAtE']) {
    assert.equal(canRewrite(value), true, value)
  }
})

test('the refusal codes are distinct, so the browser can tell them apart', () => {
  assert.notEqual(REWRITE_TIER_CODE, RATE_LIMIT_CODE)
})

// -------------------------------------------------------------- the rate

test('there is a ceiling at all, which is the whole point of Phase 0', () => {
  assert.ok(STATEMENT_RATE_LIMITS.length > 0)
  for (const window of STATEMENT_RATE_LIMITS) {
    assert.ok(window.max > 0)
    assert.ok(window.windowMs > 0)
  }
})

test('the statement ceiling is tighter than the resume builder’s', () => {
  // An analysis reads a whole essay and writes ~1,800 tokens of JSON back. A
  // resume proposal rewrites one bullet. They must not share a budget size.
  const perMinute = (limits: readonly { windowMs: number; max: number }[]) =>
    limits.find((l) => l.windowMs === 60_000)?.max ?? Infinity
  assert.ok(perMinute(STATEMENT_RATE_LIMITS) < perMinute(AI_RATE_LIMITS))
})

test('a person revising an essay never meets the ceiling', () => {
  // Four analyses spread over ten minutes: normal behaviour, never refused.
  const now = 10 * 60_000
  const recent = [0, 3 * 60_000, 6 * 60_000, 9 * 60_000]
  assert.equal(checkStatementRate(recent, now).allowed, true)
})

test('a script meets it immediately', () => {
  const now = 1_000_000
  const burst = Array.from({ length: 20 }, (_, i) => now - i * 500)
  const decision = checkStatementRate(burst, now)
  assert.equal(decision.allowed, false)
  if (decision.allowed) return
  assert.ok(decision.retryAfterSeconds >= 1)
})

test('the windows are sliding, so straddling a boundary does not double the limit', () => {
  const limits = [{ windowMs: 60_000, max: 3 }] as const
  const now = 100_000
  // Three calls inside the last minute is the limit, whenever they landed.
  assert.equal(checkStatementRate([now - 59_000, now - 30_000, now - 1_000], now, limits).allowed, false)
  // One of them ageing out makes room, and not before.
  assert.equal(checkStatementRate([now - 61_000, now - 30_000, now - 1_000], now, limits).allowed, true)
})

test('the refusal never mentions a plan, an allowance or a remaining count', () => {
  const now = 1_000_000
  const decision = checkStatementRate(Array.from({ length: 50 }, () => now - 100), now)
  assert.equal(decision.allowed, false)
  if (decision.allowed) return
  // An abuse ceiling dressed as an upgrade prompt is a lie that also trains
  // people to expect a quota that does not exist.
  assert.doesNotMatch(decision.message, /upgrade|ultimate|premium|plan|allowance|remaining|left/i)
})

test('the ledger window covers the longest limit', () => {
  const widest = Math.max(...STATEMENT_RATE_LIMITS.map((l) => l.windowMs))
  assert.equal(statementLedgerWindowMs(), widest)
})

test('an empty history always allows', () => {
  assert.equal(checkStatementRate([], Date.now()).allowed, true)
})
