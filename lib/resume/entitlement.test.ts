import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AI_RATE_LIMITS, EXPORT_CODE, FINALIZE_CODE, RATE_LIMIT_CODE,
  RESUME_LIMIT_CODE, canExportDocx, canExportPdf, canFinalize, canUseAi, checkAiRate,
  decideCreateResume, decideExport, decideFinalize, normaliseTier, outputGated,
  rateLedgerWindowMs, resumeLimitFor,
} from './entitlement.ts'

const TIERS = ['free', 'premium', 'ultimate'] as const

// --------------------------------------------------------------- tiers

test('an unrecognised tier is the lowest one', () => {
  // An error must never be a path to a paid feature.
  for (const value of [null, undefined, '', '  ', 'ULTIMATE ', 'gold', 'admin', 'true']) {
    const tier = normaliseTier(value)
    if (value === 'ULTIMATE ') {
      assert.equal(tier, 'ultimate', 'a real tier with odd casing should still resolve')
      continue
    }
    assert.equal(tier, 'free', JSON.stringify(value))
  }
})

test('the resume limits are the ones that were locked', () => {
  // One resume on either paid-for-nothing tier; Ultimate is the unlimited one.
  assert.equal(resumeLimitFor('free'), 1)
  assert.equal(resumeLimitFor('premium'), 1)
  assert.equal(resumeLimitFor('ultimate'), null, 'Ultimate is unlimited')
})

test('what Premium adds to the Resume Builder is not a second resume', () => {
  // The old model gave Premium three. The locked one gives it one, and sells
  // the download instead -- so this is the rule, stated where it can drift.
  assert.equal(resumeLimitFor('premium'), resumeLimitFor('free'))
})

// ------------------------------------------------------------- creating

test('a resume may be created below the limit and refused at it', () => {
  assert.equal(decideCreateResume({ tier: 'free', currentCount: 0 }).allowed, true)
  assert.equal(decideCreateResume({ tier: 'free', currentCount: 1 }).allowed, false)
  assert.equal(decideCreateResume({ tier: 'premium', currentCount: 0 }).allowed, true)
  assert.equal(decideCreateResume({ tier: 'premium', currentCount: 1 }).allowed, false)
})

test('Ultimate is never refused, however many exist', () => {
  for (const count of [0, 3, 50, 10_000]) {
    assert.equal(decideCreateResume({ tier: 'ultimate', currentCount: count }).allowed, true, String(count))
  }
})

test('a count somehow past the limit still refuses', () => {
  assert.equal(decideCreateResume({ tier: 'free', currentCount: 7 }).allowed, false)
})

test('a refusal carries a code and a message that names the way forward', () => {
  const decision = decideCreateResume({ tier: 'free', currentCount: 1 })
  assert.equal(decision.allowed, false)
  if (decision.allowed) return
  assert.equal(decision.code, RESUME_LIMIT_CODE)
  assert.match(decision.message, /upgrade/i)
})

test('the refusal reads as a sentence, not as "1 resumes"', () => {
  const decision = decideCreateResume({ tier: 'premium', currentCount: 1 })
  assert.equal(decision.allowed, false)
  if (decision.allowed) return
  assert.match(decision.message, /one resume/i)
  assert.match(decision.message, /ultimate/i)
})

// ------------------------------------------------- finalise and export

test('only Ultimate may finalise or export', () => {
  for (const tier of TIERS) {
    const ultimate = tier === 'ultimate'
    assert.equal(canFinalize(tier), ultimate, `finalize/${tier}`)
    assert.equal(canExportPdf(tier), ultimate, `pdf/${tier}`)
    assert.equal(canExportDocx(tier), ultimate, `docx/${tier}`)
  }
})

test('an unknown tier may not finalise or export', () => {
  for (const value of [null, undefined, '', 'gold']) {
    assert.equal(canFinalize(value), false, String(value))
    assert.equal(canExportPdf(value), false, String(value))
  }
})

test('the gate refusals are upgrade prompts, because that is what they are', () => {
  const finalize = decideFinalize('free')
  const exportPdf = decideExport('premium')
  assert.equal(finalize.allowed, false)
  assert.equal(exportPdf.allowed, false)
  if (!finalize.allowed) {
    assert.equal(finalize.code, FINALIZE_CODE)
    assert.match(finalize.message, /ultimate/i)
  }
  if (!exportPdf.allowed) {
    assert.equal(exportPdf.code, EXPORT_CODE)
    assert.match(exportPdf.message, /ultimate/i)
  }
})

test('Ultimate passes both gates cleanly', () => {
  assert.deepEqual(decideFinalize('ultimate'), { allowed: true })
  assert.deepEqual(decideExport('ultimate'), { allowed: true })
})

// -------------------------------------------------------- the output gate

test('the output gate is the export gate, asked about what is on screen', () => {
  for (const tier of TIERS) {
    assert.equal(
      outputGated(tier), !canExportPdf(tier),
      `${tier}: the output gate and the export gate disagree`
    )
  }
})

test('the preview watermark is gone, and so is the language on it', () => {
  const entitlement = readFileSync(
    fileURLToPath(new URL('./entitlement.ts', import.meta.url)), 'utf8'
  )
  for (const gone of ['PREVIEW_WATERMARK', 'needsPreviewWatermark', 'UPGRADE TO ULTIMATE TO FINALIZE']) {
    assert.equal(entitlement.includes(gone), false, `${gone} survives`)
  }
})

// ------------------------------------------------------------- AI rate

test('every tier may use AI — there is no AI entitlement', () => {
  for (const tier of [...TIERS, null, undefined, 'gold']) {
    assert.equal(canUseAi(tier as string), true, String(tier))
  }
})

test('the approved ceilings are the ones in force', () => {
  assert.deepEqual(
    AI_RATE_LIMITS.map((l) => [l.windowMs, l.max]),
    [[60_000, 10], [3_600_000, 60], [86_400_000, 150]]
  )
})

test('a first call is always allowed', () => {
  assert.deepEqual(checkAiRate([], 1_000_000), { allowed: true })
})

test('normal use never meets a ceiling', () => {
  // One proposal every thirty seconds for an hour: faster than anyone reads.
  const now = 10_000_000
  const recent = Array.from({ length: 60 }, (_, i) => now - i * 30_000)
  // 60 in an hour is exactly the hourly ceiling, so step back one.
  assert.deepEqual(checkAiRate(recent.slice(1), now), { allowed: true })
})

test('a burst is refused', () => {
  const now = 10_000_000
  const burst = Array.from({ length: 10 }, (_, i) => now - i * 1_000)
  const decision = checkAiRate(burst, now)
  assert.equal(decision.allowed, false)
  if (!decision.allowed) assert.ok(decision.retryAfterSeconds > 0)
})

test('the window slides — it cannot be doubled across a boundary', () => {
  const now = 10_000_000
  // Ten calls, all just inside the minute.
  const recent = Array.from({ length: 10 }, (_, i) => now - 59_000 + i * 100)
  assert.equal(checkAiRate(recent, now).allowed, false)
  // Once the oldest falls out, one more is allowed.
  assert.equal(checkAiRate(recent, now + 2_000).allowed, true)
})

test('retry-after says when room actually appears', () => {
  const now = 10_000_000
  const recent = Array.from({ length: 10 }, () => now - 30_000)
  const decision = checkAiRate(recent, now)
  assert.equal(decision.allowed, false)
  if (!decision.allowed) {
    // The oldest leaves the minute window 30s from now.
    assert.ok(decision.retryAfterSeconds >= 29 && decision.retryAfterSeconds <= 31,
      `got ${decision.retryAfterSeconds}`)
  }
})

test('the daily ceiling holds even when the minute is quiet', () => {
  const now = 10_000_000
  const spread = Array.from({ length: 150 }, (_, i) => now - (i + 1) * 300_000)
  const decision = checkAiRate(spread, now)
  assert.equal(decision.allowed, false, 'the day limit did not apply')
  if (!decision.allowed) assert.ok(decision.retryAfterSeconds > 60)
})

test('old calls stop counting', () => {
  const now = 10_000_000
  const yesterday = Array.from({ length: 500 }, (_, i) => now - 25 * 60 * 60_000 - i * 1_000)
  assert.deepEqual(checkAiRate(yesterday, now), { allowed: true })
})

test('the refusal is a rate-limit response, never an upgrade prompt', () => {
  // The whole point of having no quota is that nothing pretends to be one.
  const now = 10_000_000
  const decision = checkAiRate(Array.from({ length: 10 }, () => now - 1_000), now)
  assert.equal(decision.allowed, false)
  if (decision.allowed) return
  const text = decision.message.toLowerCase()
  for (const forbidden of ['upgrade', 'ultimate', 'premium', 'plan', 'quota', 'allowance', 'remaining', 'credits']) {
    assert.equal(text.includes(forbidden), false, `the rate-limit message said "${forbidden}"`)
  }
  assert.match(decision.message, /try again/i)
  assert.equal(RATE_LIMIT_CODE, 'too-many-requests')
})

test('the ledger window covers the widest limit', () => {
  assert.equal(rateLedgerWindowMs(), 24 * 60 * 60_000)
})

test('the rate check is pure and order-independent', () => {
  const now = 10_000_000
  const recent = [now - 5_000, now - 1_000, now - 3_000]
  const copy = [...recent]
  assert.deepEqual(checkAiRate(recent, now), checkAiRate([...recent].reverse(), now))
  assert.deepEqual(recent, copy, 'the input was mutated')
})
