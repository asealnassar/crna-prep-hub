import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRevenueReport, primaryCurrency, type RevenueRange } from './revenue.ts'
import type { AccountRecord, Checkout, Payment, Refund, StripeSnapshot } from './model.ts'

/**
 * Revenue arithmetic, against a fixture whose totals are worked out by hand
 * below. Every expected figure is written as a sum of the individual payments
 * that make it up, so a wrong total fails with an arithmetic difference rather
 * than a mystery.
 */

const NOW = new Date('2026-09-22T16:00:00.000Z') // midday in New York

const RANGE: RevenueRange = {
  from: '2026-09-01T04:00:00.000Z', // 1 September, New York
  to: '2026-09-22T16:00:00.000Z',
  bucket: 'day',
  timezone: 'America/New_York',
  comparison: { from: '2026-08-11T04:00:00.000Z', to: '2026-09-01T04:00:00.000Z' },
}

const payment = (over: Partial<Payment> & Pick<Payment, 'id' | 'createdAt' | 'amount'>): Payment => ({
  amountRefunded: 0,
  currency: 'usd',
  succeeded: true,
  fee: null,
  net: null,
  email: null,
  paymentIntentId: null,
  disputed: false,
  ...over,
})

const session = (over: Partial<Checkout> & Pick<Checkout, 'id' | 'paymentIntentId'>): Checkout => ({
  createdAt: '2026-09-01T00:00:00.000Z',
  status: 'complete',
  paymentStatus: 'paid',
  plan: null,
  email: null,
  amountTotal: null,
  amountSubtotal: null,
  amountDiscount: 0,
  promotionCode: null,
  currency: 'usd',
  ...over,
})

// Prices in cents, as Stripe stores them.
const ULTIMATE = 3999
const PREMIUM = 1499
const ULTIMATE_HALF = 1999
const HALF_OFF = 2000

const PAYMENTS: Payment[] = [
  payment({ id: 'ch_1', createdAt: '2026-09-10T12:00:00.000Z', amount: ULTIMATE, email: 'alice@x.com', paymentIntentId: 'pi_1', fee: 146, amountRefunded: ULTIMATE }),
  payment({ id: 'ch_2', createdAt: '2026-09-12T12:00:00.000Z', amount: PREMIUM, email: 'bob@x.com', paymentIntentId: 'pi_2', fee: 74 }),
  payment({ id: 'ch_3', createdAt: '2026-09-15T12:00:00.000Z', amount: ULTIMATE_HALF, email: 'carol@x.com', paymentIntentId: 'pi_3', fee: 88 }),
  // Alice buys a second time: a repeat purchase, not a subscription renewal.
  payment({ id: 'ch_4', createdAt: '2026-09-18T12:00:00.000Z', amount: PREMIUM, email: 'alice@x.com', paymentIntentId: 'pi_4', fee: 74 }),
  // A charge whose checkout session cannot be found: still revenue.
  payment({ id: 'ch_5', createdAt: '2026-09-20T12:00:00.000Z', amount: ULTIMATE, email: 'dave@x.com', paymentIntentId: 'pi_5', fee: 146 }),
  // Somebody who paid but has no account here.
  payment({ id: 'ch_6', createdAt: '2026-09-17T12:00:00.000Z', amount: PREMIUM, email: 'ghost@x.com', paymentIntentId: 'pi_6', fee: 74 }),
  // Today.
  payment({ id: 'ch_7', createdAt: '2026-09-22T14:00:00.000Z', amount: PREMIUM, email: 'frank@x.com', paymentIntentId: 'pi_7', fee: 74 }),
  // A failed charge must never count.
  payment({ id: 'ch_fail', createdAt: '2026-09-14T12:00:00.000Z', amount: ULTIMATE, succeeded: false, email: 'nope@x.com' }),
  // Another currency, reported separately rather than added in.
  payment({ id: 'ch_eur', createdAt: '2026-09-19T12:00:00.000Z', amount: 3500, currency: 'eur', email: 'euro@x.com' }),
  // Before the window: counts for all time only.
  payment({ id: 'ch_old', createdAt: '2026-08-01T12:00:00.000Z', amount: ULTIMATE, email: 'erin@x.com', paymentIntentId: 'pi_old', fee: 146, amountRefunded: ULTIMATE }),
]

const REFUNDS: Refund[] = [
  // Refund of a purchase made in the window, refunded in the window.
  { id: 're_1', chargeId: 'ch_1', createdAt: '2026-09-21T12:00:00.000Z', amount: ULTIMATE, currency: 'usd', succeeded: true },
  // Refund of an August purchase, issued in August: outside this window.
  { id: 're_old', chargeId: 'ch_old', createdAt: '2026-08-05T12:00:00.000Z', amount: ULTIMATE, currency: 'usd', succeeded: true },
  // A failed refund never reduces anything.
  { id: 're_failed', chargeId: 'ch_2', createdAt: '2026-09-13T12:00:00.000Z', amount: PREMIUM, currency: 'usd', succeeded: false },
]

const CHECKOUTS: Checkout[] = [
  session({ id: 'cs_1', paymentIntentId: 'pi_1', plan: 'ultimate', amountTotal: ULTIMATE }),
  session({ id: 'cs_2', paymentIntentId: 'pi_2', plan: 'premium', amountTotal: PREMIUM }),
  session({ id: 'cs_3', paymentIntentId: 'pi_3', plan: 'ultimate', amountTotal: ULTIMATE_HALF, amountSubtotal: ULTIMATE, amountDiscount: HALF_OFF, promotionCode: 'CRNA50' }),
  session({ id: 'cs_4', paymentIntentId: 'pi_4', plan: 'premium', amountTotal: PREMIUM }),
  session({ id: 'cs_6', paymentIntentId: 'pi_6', plan: 'premium', amountTotal: PREMIUM }),
  session({ id: 'cs_7', paymentIntentId: 'pi_7', plan: 'premium', amountTotal: PREMIUM }),
  session({ id: 'cs_old', paymentIntentId: 'pi_old', plan: 'ultimate', amountTotal: ULTIMATE }),
  // An abandoned session that never became a payment.
  session({ id: 'cs_open', paymentIntentId: null, status: 'expired', paymentStatus: 'unpaid', plan: 'ultimate' }),
]

const SNAPSHOT: StripeSnapshot = {
  mode: 'live',
  fetchedAt: '2026-09-22T16:00:00.000Z',
  payments: PAYMENTS,
  refunds: REFUNDS,
  checkouts: CHECKOUTS,
  warnings: [],
  truncated: false,
}

const ACCOUNTS: AccountRecord[] = [
  { email: 'Alice@X.com', createdAt: '2026-09-01T00:00:00.000Z' }, // upper case on purpose
  { email: 'bob@x.com', createdAt: '2026-09-05T00:00:00.000Z' },
  { email: 'carol@x.com', createdAt: '2026-09-08T00:00:00.000Z' },
  { email: 'dave@x.com', createdAt: '2026-09-19T00:00:00.000Z' },
  { email: 'frank@x.com', createdAt: '2026-09-22T00:00:00.000Z' },
  { email: 'erin@x.com', createdAt: '2026-07-01T00:00:00.000Z' },
  { email: 'grace@x.com', createdAt: '2026-09-02T00:00:00.000Z' }, // never paid
]

const report = () => buildRevenueReport(SNAPSHOT, RANGE, ACCOUNTS, NOW)

// The window's seven successful US-dollar payments.
const WINDOW_GROSS = ULTIMATE + PREMIUM + ULTIMATE_HALF + PREMIUM + ULTIMATE + PREMIUM + PREMIUM
const WINDOW_ORDERS = 7

// --- the headline figures ---------------------------------------------------

test('gross revenue is the sum of the successful payments in the window', () => {
  assert.equal(report().gross, WINDOW_GROSS)
  assert.equal(WINDOW_GROSS, 15993, 'worked out by hand: 3999+1499+1999+1499+3999+1499+1499')
  assert.equal(report().orders, WINDOW_ORDERS)
})

test('a failed charge is not revenue', () => {
  const without = buildRevenueReport(
    { ...SNAPSHOT, payments: PAYMENTS.filter((p) => p.id !== 'ch_fail') },
    RANGE,
    ACCOUNTS,
    NOW
  )
  assert.equal(without.gross, report().gross, 'removing the failed charge changes nothing')
})

test('a discounted purchase counts what was actually paid, not the list price', () => {
  // ch_3 is an Ultimate bought with 50% off: 1999 paid, not 3999.
  const ultimate = report().byPlan.find((entry) => entry.plan === 'ultimate')
  assert.equal(ultimate?.gross, ULTIMATE + ULTIMATE_HALF)
  assert.equal(ultimate?.orders, 2)
})

test('a refund reduces net revenue in the window it happened, not the window of the purchase', () => {
  const result = report()
  assert.equal(result.refunded, ULTIMATE, 'only the September refund')
  assert.equal(result.net, WINDOW_GROSS - ULTIMATE)
  assert.equal(result.net, 11994)
})

test('a failed refund reduces nothing', () => {
  assert.equal(report().refunded, ULTIMATE, 're_failed is ignored')
})

test('average order value is gross over orders, and null when there are none', () => {
  assert.equal(report().averageOrder, WINDOW_GROSS / WINDOW_ORDERS)
  const empty = buildRevenueReport({ ...SNAPSHOT, payments: [] }, RANGE, ACCOUNTS, NOW)
  assert.equal(empty.averageOrder, null, 'no orders means no average, not zero')
})

test('Stripe fees are summed, and the report says when it could not see them all', () => {
  const result = report()
  // Every windowed payment except the EUR one carries a fee in the fixture.
  assert.equal(result.fees, 146 + 74 + 88 + 74 + 146 + 74 + 74)
  assert.equal(result.feesComplete, true)

  const partial = buildRevenueReport(
    { ...SNAPSHOT, payments: PAYMENTS.map((p) => (p.id === 'ch_2' ? { ...p, fee: null } : p)) },
    RANGE,
    ACCOUNTS,
    NOW
  )
  assert.equal(partial.feesComplete, false)
})

// --- plans ------------------------------------------------------------------

test('Premium and Ultimate are told apart by the checkout session, not by price', () => {
  const result = report()
  const premium = result.byPlan.find((entry) => entry.plan === 'premium')
  const ultimate = result.byPlan.find((entry) => entry.plan === 'ultimate')

  assert.equal(premium?.orders, 4, 'bob, alice again, ghost, frank')
  assert.equal(premium?.gross, PREMIUM * 4)
  assert.equal(ultimate?.orders, 2)
})

test('a payment with no session still counts, and is reported as unattributed', () => {
  const result = report()
  const unattributed = result.byPlan.find((entry) => entry.plan === 'unattributed')

  assert.equal(unattributed?.orders, 1)
  assert.equal(unattributed?.gross, ULTIMATE)
  assert.equal(result.reconciliation.unattributedOrders, 1)
  assert.equal(
    result.reconciliation.attributedGross + result.reconciliation.unattributedGross,
    result.gross,
    'the parts add up to the whole'
  )
})

// --- discounts and promotion codes -----------------------------------------

test('discounts are reported from the session, separately from revenue', () => {
  const result = report()

  assert.equal(result.discountTotal, HALF_OFF)
  assert.equal(result.discountedOrders, 1)
  assert.equal(result.gross, WINDOW_GROSS, 'the discount is not added back into revenue')
})

test('promotion codes are grouped by code with their uses and value', () => {
  const [code] = report().promoCodes

  assert.equal(code.code, 'CRNA50')
  assert.equal(code.uses, 1)
  assert.equal(code.discount, HALF_OFF)
  assert.equal(code.gross, ULTIMATE_HALF, 'what the customer still paid')
})

// --- customers --------------------------------------------------------------

test('paying customers are counted once however many times they bought', () => {
  // alice paid twice inside the window.
  assert.equal(report().payingCustomers, 6, 'alice, bob, carol, dave, ghost, frank')
})

test('a repeat purchase is somebody who bought twice, not a renewal', () => {
  const result = report()
  assert.equal(result.allTime.repeatCustomers, 1, 'alice')
  assert.equal(result.allTime.customers, 7, 'and seven people have ever paid')
})

// --- to-date figures --------------------------------------------------------

test('today, week to date and month to date follow the calendar, not the window', () => {
  const result = report()

  assert.equal(result.today, PREMIUM, 'the 22nd has one payment')
  assert.equal(result.weekToDate, PREMIUM, 'the week began on Monday the 21st')
  assert.equal(
    result.monthToDate,
    WINDOW_GROSS,
    'every September payment, since the window happens to be September'
  )
})

test('an evening payment in New York is not tomorrow', () => {
  // 02:00 UTC on the 23rd is 22:00 on the 22nd in New York.
  const late = buildRevenueReport(
    {
      ...SNAPSHOT,
      payments: [...PAYMENTS, payment({ id: 'ch_late', createdAt: '2026-09-23T02:00:00.000Z', amount: 100, email: 'late@x.com' })],
    },
    { ...RANGE, to: '2026-09-23T03:00:00.000Z' },
    ACCOUNTS,
    new Date('2026-09-23T02:30:00.000Z')
  )

  assert.equal(late.today, PREMIUM + 100, 'both the afternoon and the late-evening payment are the 22nd')
})

// --- lifetime ---------------------------------------------------------------

test('all-time totals include everything before the window', () => {
  const result = report()

  assert.equal(result.allTime.gross, WINDOW_GROSS + ULTIMATE, 'plus the August purchase')
  assert.equal(result.allTime.refunded, ULTIMATE * 2, 'both refunds')
  assert.equal(result.allTime.net, result.allTime.gross - result.allTime.refunded)
  assert.equal(result.allTime.orders, 8)
  assert.equal(result.allTime.firstPaymentAt, '2026-08-01T12:00:00.000Z')
})

// --- comparison -------------------------------------------------------------

test('the previous window holds nothing here, and says so rather than borrowing', () => {
  const result = report()
  // The comparison window is 11 August to 1 September. The only earlier
  // payment in the fixture is 1 August, which falls outside it.
  assert.deepEqual(result.previous, { gross: 0, net: 0, orders: 0 })
})

test('the previous window is measured exactly like the current one', () => {
  const august = payment({
    id: 'ch_aug',
    createdAt: '2026-08-15T12:00:00.000Z',
    amount: ULTIMATE,
    email: 'prior@x.com',
    paymentIntentId: 'pi_aug',
  })
  const result = buildRevenueReport(
    {
      ...SNAPSHOT,
      payments: [...PAYMENTS, august],
      refunds: [
        ...REFUNDS,
        { id: 're_aug', chargeId: 'ch_aug', createdAt: '2026-08-20T12:00:00.000Z', amount: 1000, currency: 'usd', succeeded: true },
      ],
    },
    RANGE,
    ACCOUNTS,
    NOW
  )

  assert.equal(result.previous?.gross, ULTIMATE)
  assert.equal(result.previous?.net, ULTIMATE - 1000, 'its refund lands in the same window')
  assert.equal(result.previous?.orders, 1)
  assert.equal(result.gross, WINDOW_GROSS, 'and the current window is untouched by it')
})

// --- currency ---------------------------------------------------------------

test('a second currency is reported separately and never added in', () => {
  const result = report()

  assert.equal(result.currency, 'usd')
  assert.deepEqual(result.reconciliation.otherCurrencies, [{ currency: 'eur', orders: 1, gross: 3500 }])
  assert.equal(result.gross, WINDOW_GROSS, 'the euro payment is not in the dollar total')
})

test('the primary currency is the one most orders are in', () => {
  assert.equal(primaryCurrency(PAYMENTS), 'usd')
  assert.equal(primaryCurrency([]), 'usd', 'an empty account still has a currency to format with')
})

// --- conversion -------------------------------------------------------------

test('conversion matches payments to accounts case-insensitively', () => {
  const result = report()

  // Alice's account is 'Alice@X.com' and her Stripe email is 'alice@x.com'.
  assert.equal(result.conversion.accounts, 7)
  assert.equal(result.conversion.payingAccounts, 6, 'everyone but grace')
  assert.equal(Math.round(result.conversion.rate ?? 0), 86)
})

test('a payer with no account is counted, not silently dropped', () => {
  assert.equal(report().conversion.unmatchedPayers, 1, 'ghost@x.com')
})

test('time to purchase is measured from signup to first payment', () => {
  // alice 9.5 days, bob 7.5, carol 7.5, dave 1.5, frank 0.58, erin 31.5.
  // The median of six values is the mean of the middle two: both 7.5.
  assert.equal(report().conversion.medianDaysToPurchase, 7.5)
})

test('the cohort rate only counts accounts created inside the window', () => {
  const result = report()

  // bob, carol, dave, frank and grace. Erin signed up in July, and Alice's
  // midnight-UTC signup on 1 September is 31 August in New York, which is the
  // evening before this window opens.
  assert.equal(result.conversion.cohortAccounts, 5)
  assert.equal(result.conversion.cohortPaid, 4, 'grace never paid')
  assert.equal(Math.round(result.conversion.cohortRate ?? 0), 80)
})

// --- series -----------------------------------------------------------------

test('the daily series puts each payment in its own day and sums to the window', () => {
  const result = report()

  assert.equal(result.series.gross.reduce((a, b) => a + b, 0), WINDOW_GROSS)
  assert.equal(result.series.refunded.reduce((a, b) => a + b, 0), ULTIMATE)
  assert.equal(result.series.keys.length, result.series.labels.length)
  assert.equal(result.series.keys[0], '2026-09-01')
})

test('the monthly series starts at the first payment ever, not at the window', () => {
  const result = report()

  assert.deepEqual(result.monthly.keys, ['2026-08', '2026-09'])
  assert.equal(result.monthly.gross[0], ULTIMATE, 'August')
  assert.equal(result.monthly.gross[1], WINDOW_GROSS, 'September')
})

// --- what this report deliberately does not contain -------------------------

test('there is no recurring revenue anywhere in the report', () => {
  const result = report() as unknown as Record<string, unknown>
  const keys = JSON.stringify(result).toLowerCase()

  assert.equal('mrr' in result, false)
  assert.equal(keys.includes('"mrr"'), false)
  assert.equal(keys.includes('churn'), false)
  assert.equal(keys.includes('recurring'), false)
})

test('an account with no Stripe data at all produces zeroes, not crashes', () => {
  const empty = buildRevenueReport(
    { mode: 'test', fetchedAt: NOW.toISOString(), payments: [], refunds: [], checkouts: [], warnings: [], truncated: false },
    RANGE,
    ACCOUNTS,
    NOW
  )

  assert.equal(empty.gross, 0)
  assert.equal(empty.orders, 0)
  assert.equal(empty.averageOrder, null)
  assert.equal(empty.allTime.firstPaymentAt, null)
  assert.equal(empty.conversion.payingAccounts, 0)
})
