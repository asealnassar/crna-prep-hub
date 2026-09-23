import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  channelOf, cohortFunnel, firstTouch, lastTouch, performanceByChannel, rate,
  type SessionRow, type VisitorRow,
} from './attribution.ts'

/**
 * Attribution, tested as a story rather than as a set of field assignments:
 * someone finds the site on TikTok, comes back from Google, types the address
 * in a week later, and buys. Who gets the credit depends on the model, and
 * both answers have to be defensible.
 */

const session = (over: Partial<SessionRow> & Pick<SessionRow, 'session_id' | 'visitor_id' | 'started_at'>): SessionRow => ({
  channel: 'direct', source: 'direct', medium: null, campaign: null,
  referrer_host: null, landing_path: '/', device: 'desktop', browser: 'Chrome',
  is_first_visit: false, page_view_count: 1,
  ...over,
})

const visitor = (over: Partial<VisitorRow> & Pick<VisitorRow, 'visitor_id' | 'first_seen_at'>): VisitorRow => ({
  last_seen_at: over.first_seen_at, first_channel: 'direct', first_source: 'direct',
  first_campaign: null, first_landing_path: '/', user_id: null, linked_at: null,
  ...over,
})

// --- the two models disagree, on purpose ------------------------------------

const JOURNEY: SessionRow[] = [
  session({ session_id: 's1', visitor_id: 'v1', started_at: '2026-09-01T10:00:00Z', channel: 'tiktok', campaign: 'sept_launch' }),
  session({ session_id: 's2', visitor_id: 'v1', started_at: '2026-09-05T10:00:00Z', channel: 'google_organic' }),
  session({ session_id: 's3', visitor_id: 'v1', started_at: '2026-09-12T10:00:00Z', channel: 'direct' }),
]

test('first touch credits what introduced the visitor, whatever came later', () => {
  const person = visitor({ visitor_id: 'v1', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'tiktok' })

  assert.equal(firstTouch(person), 'tiktok')
})

test('last touch skips a Direct return visit rather than losing the credit to "we do not know"', () => {
  // The purchase happened on the 12th, during a Direct visit. Direct means no
  // information, so the credit goes to the most recent visit that had some.
  assert.equal(lastTouch(JOURNEY, '2026-09-12T11:00:00Z'), 'google_organic')
})

test('last touch only looks backwards: a later visit cannot claim an earlier purchase', () => {
  assert.equal(lastTouch(JOURNEY, '2026-09-02T00:00:00Z'), 'tiktok')
})

test('a visitor whose every visit was Direct is Direct, not silently upgraded', () => {
  const allDirect = [session({ session_id: 'd1', visitor_id: 'v9', started_at: '2026-09-01T10:00:00Z' })]

  assert.equal(lastTouch(allDirect, '2026-09-02T00:00:00Z'), 'direct')
})

test('a visitor with no surviving sessions is Direct rather than a crash', () => {
  assert.equal(lastTouch([], '2026-09-02T00:00:00Z'), 'direct')
})

test('an unrecognised stored channel becomes a referral, never an invented one', () => {
  assert.equal(channelOf('something_new'), 'referral')
  assert.equal(channelOf(null), 'direct')
  assert.equal(channelOf('tiktok'), 'tiktok')
})

// --- the population rule ----------------------------------------------------

test('the funnel narrows ONE cohort, so every step is a subset of the one above', () => {
  const visitors = [
    visitor({ visitor_id: 'v1', first_seen_at: '2026-09-01T10:00:00Z', user_id: 'u1', linked_at: '2026-09-01T11:00:00Z' }),
    visitor({ visitor_id: 'v2', first_seen_at: '2026-09-02T10:00:00Z', user_id: 'u2', linked_at: '2026-09-02T11:00:00Z' }),
    visitor({ visitor_id: 'v3', first_seen_at: '2026-09-03T10:00:00Z' }),
    visitor({ visitor_id: 'v4', first_seen_at: '2026-09-04T10:00:00Z' }),
  ]
  const counts = cohortFunnel({
    visitors,
    sessions: [],
    confirmedUserIds: new Set(['u1']),
    payingUserIds: new Set(['u1']),
  })

  assert.deepEqual(counts, { visitors: 4, signedUp: 2, confirmed: 1, paid: 1 })
  assert.ok(counts.signedUp <= counts.visitors)
  assert.ok(counts.confirmed <= counts.signedUp)
  assert.ok(counts.paid <= counts.signedUp)
})

test('a payer who never confirmed still counts as paid: the steps are not a chain', () => {
  // Confirmation and payment are both narrowed from signups, not from each
  // other. Someone can pay without ever clicking the confirmation email.
  const counts = cohortFunnel({
    visitors: [visitor({ visitor_id: 'v1', first_seen_at: '2026-09-01T10:00:00Z', user_id: 'u1', linked_at: '2026-09-01T10:30:00Z' })],
    sessions: [],
    confirmedUserIds: new Set(),
    payingUserIds: new Set(['u1']),
  })

  assert.equal(counts.confirmed, 0)
  assert.equal(counts.paid, 1)
})

test('a rate with no denominator is null, never 0%', () => {
  assert.equal(rate(0, 0), null)
  assert.equal(rate(5, 0), null)
  assert.equal(rate(1, 4), 25)
})

// --- money per channel ------------------------------------------------------

const REVENUE = {
  grossByUser: new Map([['u1', 3499], ['u2', 2999]]),
  netByUser: new Map([['u1', 3499], ['u2', 0]]),
  purchasesByUser: new Map([['u1', 1], ['u2', 1]]),
}

test('revenue follows the model: the same money lands on a different channel', () => {
  const visitors = [
    visitor({
      visitor_id: 'v1', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'tiktok',
      user_id: 'u1', linked_at: '2026-09-12T10:30:00Z', last_seen_at: '2026-09-12T10:00:00Z',
    }),
  ]

  const first = performanceByChannel({ visitors, sessions: JOURNEY, revenue: REVENUE, model: 'first' })
  const last = performanceByChannel({ visitors, sessions: JOURNEY, revenue: REVENUE, model: 'last' })

  const tiktokFirst = first.find((row) => row.channel === 'tiktok')
  assert.equal(tiktokFirst?.grossCents, 3499, 'first touch credits TikTok')

  const googleLast = last.find((row) => row.channel === 'google_organic')
  assert.equal(googleLast?.grossCents, 3499, 'last touch credits Google organic')
  assert.equal(last.find((row) => row.channel === 'tiktok')?.grossCents, 0)
})

test('sessions and page views are counted where the visit came from, under either model', () => {
  const visitors = [visitor({ visitor_id: 'v1', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'tiktok' })]

  for (const model of ['first', 'last'] as const) {
    const rows = performanceByChannel({ visitors, sessions: JOURNEY, revenue: REVENUE, model })
    assert.equal(rows.find((row) => row.channel === 'tiktok')?.sessions, 1, model)
    assert.equal(rows.find((row) => row.channel === 'google_organic')?.sessions, 1, model)
    assert.equal(rows.find((row) => row.channel === 'direct')?.sessions, 1, model)
  }
})

test('a refunded purchase is still a purchase but no longer net revenue', () => {
  const visitors = [
    visitor({ visitor_id: 'v2', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'instagram', user_id: 'u2', linked_at: '2026-09-01T11:00:00Z' }),
  ]
  const rows = performanceByChannel({ visitors, sessions: [], revenue: REVENUE, model: 'first' })
  const instagram = rows.find((row) => row.channel === 'instagram')

  assert.equal(instagram?.purchases, 1)
  assert.equal(instagram?.grossCents, 2999)
  assert.equal(instagram?.netCents, 0, 'refunded in full')
})

test('a signup that never paid counts as a signup and adds no money', () => {
  const visitors = [
    visitor({ visitor_id: 'v3', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'tiktok', user_id: 'u404', linked_at: '2026-09-01T11:00:00Z' }),
  ]
  const rows = performanceByChannel({ visitors, sessions: [], revenue: REVENUE, model: 'first' })
  const tiktok = rows.find((row) => row.channel === 'tiktok')

  assert.equal(tiktok?.signups, 1)
  assert.equal(tiktok?.customers, 0)
  assert.equal(tiktok?.grossCents, 0)
})

test('channels come back in a stable order, and only those with traffic appear', () => {
  const rows = performanceByChannel({
    visitors: [visitor({ visitor_id: 'v1', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'tiktok' })],
    sessions: JOURNEY,
    revenue: REVENUE,
    model: 'first',
  })

  assert.deepEqual(rows.map((row) => row.channel), ['tiktok', 'google_organic', 'direct'])
})

// --- attributed against unattributed money ----------------------------------

import { splitAttributedRevenue, type PaymentLite } from './attribution.ts'

const payment = (over: Partial<PaymentLite> = {}): PaymentLite => ({
  email: 'buyer@example.com',
  amount: 3499,
  createdAt: '2026-09-15T10:00:00Z',
  succeeded: true,
  ...over,
})

const WINDOW = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }

test('the two halves always add up to the window’s gross revenue', () => {
  const split = splitAttributedRevenue({
    ...WINDOW,
    payments: [
      payment({ email: 'known@example.com', amount: 3499 }),
      payment({ email: 'untracked@example.com', amount: 2999 }),
      payment({ email: 'nobody@example.com', amount: 1499 }),
    ],
    emailToUser: new Map([['known@example.com', 'u1'], ['untracked@example.com', 'u2']]),
    visitorByUser: new Map([
      ['u1', visitor({ visitor_id: 'v1', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'tiktok', user_id: 'u1', linked_at: '2026-09-01T10:00:00Z' })],
    ]),
  })

  assert.equal(split.attributedCents, 3499)
  assert.equal(split.unattributedCents, 2999 + 1499)
  assert.equal(split.attributedCents + split.unattributedCents, 3499 + 2999 + 1499)
})

test('the reasons a payment is unattributed are counted separately', () => {
  const split = splitAttributedRevenue({
    ...WINDOW,
    payments: [payment({ email: 'untracked@example.com' }), payment({ email: 'nobody@example.com' })],
    emailToUser: new Map([['untracked@example.com', 'u2']]),
    visitorByUser: new Map(),
  })

  assert.equal(split.noTrackedVisit, 1, 'an account we know, with no tracked visit')
  assert.equal(split.noAccountMatch, 1, 'a payment matching no account at all')
})

test('Direct is unattributed: it is the absence of a source, not a source', () => {
  const split = splitAttributedRevenue({
    ...WINDOW,
    payments: [payment({ email: 'direct@example.com' })],
    emailToUser: new Map([['direct@example.com', 'u3']]),
    visitorByUser: new Map([
      ['u3', visitor({ visitor_id: 'v3', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'direct', user_id: 'u3', linked_at: '2026-09-01T10:00:00Z' })],
    ]),
  })

  assert.equal(split.attributedCents, 0)
  assert.equal(split.noTrackedVisit, 1)
})

test('payments outside the window and failed payments are both ignored', () => {
  const split = splitAttributedRevenue({
    ...WINDOW,
    payments: [
      payment({ createdAt: '2026-08-15T10:00:00Z' }),
      payment({ createdAt: '2026-10-15T10:00:00Z' }),
      payment({ succeeded: false }),
    ],
    emailToUser: new Map(),
    visitorByUser: new Map(),
  })

  assert.equal(split.attributedCents + split.unattributedCents, 0)
})

test('an email is matched case-insensitively, the way Stripe stores it', () => {
  const split = splitAttributedRevenue({
    ...WINDOW,
    payments: [payment({ email: '  Buyer@Example.COM ' })],
    emailToUser: new Map([['buyer@example.com', 'u1']]),
    visitorByUser: new Map([
      ['u1', visitor({ visitor_id: 'v1', first_seen_at: '2026-09-01T10:00:00Z', first_channel: 'instagram', user_id: 'u1', linked_at: '2026-09-01T10:00:00Z' })],
    ]),
  })

  assert.equal(split.attributedCents, 3499)
})
