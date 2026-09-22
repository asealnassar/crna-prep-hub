import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The checkout conversion rule.
 *
 * A funnel step only means something when its numerator is a subset of its
 * denominator. Counting sessions created in a window and then counting CHARGES
 * in the same window compares two different populations: a charge here can
 * belong to a session opened before the window, and a session opened near the
 * end of it may be paid after. The rate that falls out of that is not a
 * conversion rate at all — it can exceed 100%.
 *
 * Both funnels must therefore start from one set of sessions and narrow it.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const OVERVIEW = read('./overview.ts')
const REVENUE = read('./revenue.ts')

test('the Overview funnel narrows one set of sessions rather than mixing sources', () => {
  assert.match(OVERVIEW, /const sessionsInWindow = /, 'the sessions in the window are the denominator')
  assert.match(
    OVERVIEW,
    /const paidSessionsInWindow = sessionsInWindow\.filter/,
    'and the paid step is a subset of exactly those sessions'
  )
  assert.match(OVERVIEW, /value: snapshot \? paidPeople : null/, 'the paid step uses the matched sessions')
  assert.doesNotMatch(
    OVERVIEW,
    /id: 'paid'[\s\S]{0,200}revenue\.orders/,
    'the paid step must never be a charge count taken from a different population'
  )
})

test('the Revenue checkout funnel does the same', () => {
  assert.match(REVENUE, /const sessionsInWindow = snapshot\.checkouts\.filter/)
  assert.match(REVENUE, /const completedSessions = sessionsInWindow\.filter/)
  assert.doesNotMatch(
    REVENUE,
    /id: 'completed'[\s\S]{0,200}report\.orders/,
    'abandonment is measured over the same sessions, not against charges'
  )
})

test('a completed session with nothing to pay still counts as paid', () => {
  // A 100%-off promotion leaves payment_status 'no_payment_required'. Both
  // funnels exclude only 'unpaid', so that purchase is not lost.
  for (const source of [OVERVIEW, REVENUE]) {
    assert.match(source, /paymentStatus !== 'unpaid'/)
  }
})

test('both funnels state that the checkout steps are matched', () => {
  assert.match(OVERVIEW, /MATCHED/)
  assert.match(REVENUE, /session by session|same sessions|Matched/i)
})
