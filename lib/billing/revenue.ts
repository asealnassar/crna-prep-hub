import { REPORTING_TIMEZONE, bucketKeys, bucketLabel, bucketOf, dayKey, weekStart, within, type Bucket } from '../analytics/range'
import type { AccountRecord, Checkout, Payment, PlanName, Refund, StripeSnapshot } from './model'
import { normaliseEmail } from './model'

/**
 * Every revenue figure on the dashboard, computed from Stripe's own records.
 *
 * THE RULES THIS FOLLOWS, and why each one matters here:
 *
 *   * MONEY COMES FROM CHARGES, never from membership tiers. Tiers are also
 *     granted by hand, so counting them as sales would invent revenue that
 *     nobody paid.
 *   * A REFUND BELONGS TO THE DAY IT HAPPENED, not to the day of the purchase.
 *     Net revenue for a period is that period's charges minus that period's
 *     refunds, which is how the money actually moved.
 *   * DISCOUNTS ARE ALREADY GONE from a charge amount. `amount` is what the
 *     customer paid; the discount is reported separately, from the session, as
 *     context — adding it back would double-count.
 *   * A CHARGE WITH NO SESSION STILL COUNTS. Plan attribution comes from the
 *     checkout session, so a payment whose session cannot be found is reported
 *     as unattributed rather than dropped from the totals.
 *   * THERE IS NO RECURRING REVENUE. This product sells one-time lifetime
 *     access, so there is no MRR and no churn, and a "repeat purchase" means
 *     somebody bought twice — typically Premium and later Ultimate.
 */

export type RevenueRange = {
  readonly from: string | null
  readonly to: string
  readonly bucket: Bucket
  readonly timezone: string
  readonly comparison: { readonly from: string; readonly to: string } | null
}

export type PlanTotals = {
  readonly plan: PlanName | 'unattributed'
  readonly orders: number
  readonly gross: number
  readonly customers: number
}

export type PromoTotals = {
  readonly code: string
  readonly uses: number
  readonly discount: number
  readonly gross: number
}

export type RefundEntry = {
  readonly id: string
  readonly at: string
  readonly amount: number
  readonly plan: PlanName | 'unattributed'
}

export type RevenueSeries = {
  readonly keys: string[]
  readonly labels: string[]
  readonly gross: number[]
  readonly refunded: number[]
}

export type RevenueReport = {
  readonly currency: string
  readonly mode: 'live' | 'test'
  readonly fetchedAt: string

  readonly gross: number
  readonly refunded: number
  readonly net: number
  readonly fees: number
  readonly feesComplete: boolean
  readonly orders: number
  readonly averageOrder: number | null
  readonly payingCustomers: number

  readonly previous: { readonly gross: number; readonly net: number; readonly orders: number } | null

  readonly today: number
  readonly weekToDate: number
  readonly monthToDate: number

  readonly allTime: {
    readonly gross: number
    readonly refunded: number
    readonly net: number
    readonly orders: number
    readonly customers: number
    readonly repeatCustomers: number
    readonly firstPaymentAt: string | null
  }

  readonly byPlan: PlanTotals[]
  readonly discountTotal: number
  readonly discountedOrders: number
  readonly promoCodes: PromoTotals[]
  readonly refunds: RefundEntry[]

  readonly series: RevenueSeries
  readonly monthly: RevenueSeries

  readonly conversion: {
    readonly accounts: number
    readonly payingAccounts: number
    readonly rate: number | null
    readonly medianDaysToPurchase: number | null
    readonly unmatchedPayers: number
    readonly cohortAccounts: number
    readonly cohortPaid: number
    readonly cohortRate: number | null
  }

  readonly reconciliation: {
    readonly attributedGross: number
    readonly unattributedOrders: number
    readonly unattributedGross: number
    readonly otherCurrencies: { readonly currency: string; readonly orders: number; readonly gross: number }[]
    readonly disputedOrders: number
  }
}

const succeeded = (payment: Payment) => payment.succeeded

/** The currency most orders are in. Everything else is reported separately. */
export function primaryCurrency(payments: readonly Payment[]): string {
  const counts = new Map<string, number>()
  for (const payment of payments.filter(succeeded)) {
    counts.set(payment.currency, (counts.get(payment.currency) ?? 0) + 1)
  }
  let best = 'usd'
  let bestCount = -1
  for (const [currency, count] of counts) {
    if (count > bestCount || (count === bestCount && currency < best)) {
      best = currency
      bestCount = count
    }
  }
  return best
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function buildRevenueReport(
  snapshot: StripeSnapshot,
  range: RevenueRange,
  accounts: readonly AccountRecord[],
  now: Date = new Date()
): RevenueReport {
  const timezone = range.timezone || REPORTING_TIMEZONE
  const currency = primaryCurrency(snapshot.payments)

  const paid = snapshot.payments.filter(succeeded)
  const inCurrency = paid.filter((payment) => payment.currency === currency)
  const otherCurrencyPayments = paid.filter((payment) => payment.currency !== currency)

  // --- plan attribution, by payment intent ---------------------------------
  const sessionByIntent = new Map<string, Checkout>()
  for (const checkout of snapshot.checkouts) {
    if (checkout.paymentIntentId) sessionByIntent.set(checkout.paymentIntentId, checkout)
  }
  const planOf = (payment: Payment): PlanName | 'unattributed' => {
    const session = payment.paymentIntentId ? sessionByIntent.get(payment.paymentIntentId) : undefined
    return session?.plan ?? 'unattributed'
  }

  // --- the selected window --------------------------------------------------
  const windowPayments = inCurrency.filter((payment) => within(payment.createdAt, range.from, range.to))
  const windowRefunds = snapshot.refunds.filter(
    (refund) => refund.succeeded && refund.currency === currency && within(refund.createdAt, range.from, range.to)
  )

  const gross = sum(windowPayments.map((payment) => payment.amount))
  const refunded = sum(windowRefunds.map((refund) => refund.amount))
  const feesKnown = windowPayments.filter((payment) => typeof payment.fee === 'number')
  const fees = sum(feesKnown.map((payment) => payment.fee as number))

  const previous = range.comparison
    ? (() => {
        const previousPayments = inCurrency.filter((payment) =>
          within(payment.createdAt, range.comparison!.from, range.comparison!.to)
        )
        const previousRefunds = snapshot.refunds.filter(
          (refund) =>
            refund.succeeded &&
            refund.currency === currency &&
            within(refund.createdAt, range.comparison!.from, range.comparison!.to)
        )
        const previousGross = sum(previousPayments.map((payment) => payment.amount))
        return {
          gross: previousGross,
          net: previousGross - sum(previousRefunds.map((refund) => refund.amount)),
          orders: previousPayments.length,
        }
      })()
    : null

  // --- calendar to-date figures, independent of the window ------------------
  const todayKey = dayKey(now, timezone)
  const weekKey = weekStart(todayKey)
  const monthKey = todayKey.slice(0, 7)
  const keyOf = (value: string) => {
    try {
      return dayKey(value, timezone)
    } catch {
      return null
    }
  }

  const today = sum(inCurrency.filter((p) => keyOf(p.createdAt) === todayKey).map((p) => p.amount))
  const weekToDate = sum(
    inCurrency.filter((p) => {
      const key = keyOf(p.createdAt)
      return key !== null && key >= weekKey && key <= todayKey
    }).map((p) => p.amount)
  )
  const monthToDate = sum(
    inCurrency.filter((p) => keyOf(p.createdAt)?.slice(0, 7) === monthKey).map((p) => p.amount)
  )

  // --- lifetime -------------------------------------------------------------
  const allTimeGross = sum(inCurrency.map((payment) => payment.amount))
  const allTimeRefunded = sum(
    snapshot.refunds.filter((refund) => refund.succeeded && refund.currency === currency).map((r) => r.amount)
  )
  const ordersByEmail = new Map<string, number>()
  for (const payment of inCurrency) {
    const email = normaliseEmail(payment.email)
    if (!email) continue
    ordersByEmail.set(email, (ordersByEmail.get(email) ?? 0) + 1)
  }
  const firstPaymentAt = inCurrency.reduce<string | null>(
    (earliest, payment) => (!earliest || payment.createdAt < earliest ? payment.createdAt : earliest),
    null
  )

  // --- by plan --------------------------------------------------------------
  const planBuckets = new Map<PlanName | 'unattributed', { orders: number; gross: number; customers: Set<string> }>()
  for (const payment of windowPayments) {
    const plan = planOf(payment)
    const bucket = planBuckets.get(plan) ?? { orders: 0, gross: 0, customers: new Set<string>() }
    bucket.orders += 1
    bucket.gross += payment.amount
    const email = normaliseEmail(payment.email)
    if (email) bucket.customers.add(email)
    planBuckets.set(plan, bucket)
  }
  const planOrder: (PlanName | 'unattributed')[] = ['ultimate', 'premium', 'unattributed']
  const byPlan: PlanTotals[] = planOrder
    .filter((plan) => planBuckets.has(plan))
    .map((plan) => {
      const bucket = planBuckets.get(plan)!
      return { plan, orders: bucket.orders, gross: bucket.gross, customers: bucket.customers.size }
    })

  // --- discounts and promotion codes ---------------------------------------
  const windowIntents = new Set(windowPayments.map((payment) => payment.paymentIntentId).filter(Boolean) as string[])
  const windowSessions = snapshot.checkouts.filter(
    (checkout) => checkout.paymentIntentId && windowIntents.has(checkout.paymentIntentId)
  )
  const discountedSessions = windowSessions.filter((session) => session.amountDiscount > 0)
  const promoBuckets = new Map<string, { uses: number; discount: number; gross: number }>()
  for (const session of discountedSessions) {
    const code = session.promotionCode ?? '(discount without a code)'
    const bucket = promoBuckets.get(code) ?? { uses: 0, discount: 0, gross: 0 }
    bucket.uses += 1
    bucket.discount += session.amountDiscount
    bucket.gross += session.amountTotal ?? 0
    promoBuckets.set(code, bucket)
  }

  // --- refunds in the window, with the plan they came from ------------------
  const paymentById = new Map(snapshot.payments.map((payment) => [payment.id, payment]))
  const refundEntries: RefundEntry[] = windowRefunds
    .map((refund) => {
      const payment = refund.chargeId ? paymentById.get(refund.chargeId) : undefined
      return {
        id: refund.id,
        at: refund.createdAt,
        amount: refund.amount,
        plan: payment ? planOf(payment) : ('unattributed' as const),
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at))

  // --- series ---------------------------------------------------------------
  const seriesStart = range.from ?? firstPaymentAt ?? range.to
  const keys = bucketKeys(seriesStart, range.to, range.bucket, timezone)
  const series: RevenueSeries = {
    keys,
    labels: keys.map((key) => bucketLabel(key, range.bucket)),
    gross: bucketTotals(windowPayments, (p) => p.createdAt, (p) => p.amount, keys, range.bucket, timezone),
    refunded: bucketTotals(windowRefunds, (r) => r.createdAt, (r) => r.amount, keys, range.bucket, timezone),
  }

  const monthlyStart = firstPaymentAt ?? range.to
  const monthlyKeys = bucketKeys(monthlyStart, range.to, 'month', timezone)
  const monthly: RevenueSeries = {
    keys: monthlyKeys,
    labels: monthlyKeys.map((key) => bucketLabel(key, 'month')),
    gross: bucketTotals(inCurrency, (p) => p.createdAt, (p) => p.amount, monthlyKeys, 'month', timezone),
    refunded: bucketTotals(
      snapshot.refunds.filter((r) => r.succeeded && r.currency === currency),
      (r) => r.createdAt,
      (r) => r.amount,
      monthlyKeys,
      'month',
      timezone
    ),
  }

  // --- conversion, by matching a payment to an account ----------------------
  const firstPaymentByEmail = new Map<string, string>()
  for (const payment of inCurrency) {
    const email = normaliseEmail(payment.email)
    if (!email) continue
    const current = firstPaymentByEmail.get(email)
    if (!current || payment.createdAt < current) firstPaymentByEmail.set(email, payment.createdAt)
  }

  const accountEmails = new Set(
    accounts.map((account) => normaliseEmail(account.email)).filter((email): email is string => email !== null)
  )
  let payingAccounts = 0
  const daysToPurchase: number[] = []
  let cohortAccounts = 0
  let cohortPaid = 0

  for (const account of accounts) {
    const email = normaliseEmail(account.email)
    const paidAt = email ? firstPaymentByEmail.get(email) : undefined
    const inCohort = within(account.createdAt, range.from, range.to)
    if (inCohort) cohortAccounts += 1
    if (!paidAt) continue
    payingAccounts += 1
    if (inCohort) cohortPaid += 1
    const days = (Date.parse(paidAt) - Date.parse(account.createdAt)) / (24 * 60 * 60 * 1000)
    if (Number.isFinite(days) && days >= 0) daysToPurchase.push(days)
  }

  const unmatchedPayers = [...firstPaymentByEmail.keys()].filter((email) => !accountEmails.has(email)).length

  const attributedGross = byPlan
    .filter((entry) => entry.plan !== 'unattributed')
    .reduce((total, entry) => total + entry.gross, 0)
  const unattributed = byPlan.find((entry) => entry.plan === 'unattributed')

  return {
    currency,
    mode: snapshot.mode,
    fetchedAt: snapshot.fetchedAt,

    gross,
    refunded,
    net: gross - refunded,
    fees,
    feesComplete: feesKnown.length === windowPayments.length,
    orders: windowPayments.length,
    averageOrder: windowPayments.length > 0 ? gross / windowPayments.length : null,
    payingCustomers: new Set(
      windowPayments.map((payment) => normaliseEmail(payment.email)).filter(Boolean) as string[]
    ).size,

    previous,
    today,
    weekToDate,
    monthToDate,

    allTime: {
      gross: allTimeGross,
      refunded: allTimeRefunded,
      net: allTimeGross - allTimeRefunded,
      orders: inCurrency.length,
      customers: ordersByEmail.size,
      repeatCustomers: [...ordersByEmail.values()].filter((count) => count > 1).length,
      firstPaymentAt,
    },

    byPlan,
    discountTotal: sum(discountedSessions.map((session) => session.amountDiscount)),
    discountedOrders: discountedSessions.length,
    promoCodes: [...promoBuckets.entries()]
      .map(([code, bucket]) => ({ code, ...bucket }))
      .sort((a, b) => b.discount - a.discount || a.code.localeCompare(b.code)),
    refunds: refundEntries,

    series,
    monthly,

    conversion: {
      accounts: accounts.length,
      payingAccounts,
      rate: accounts.length > 0 ? (payingAccounts / accounts.length) * 100 : null,
      medianDaysToPurchase: median(daysToPurchase),
      unmatchedPayers,
      cohortAccounts,
      cohortPaid,
      cohortRate: cohortAccounts > 0 ? (cohortPaid / cohortAccounts) * 100 : null,
    },

    reconciliation: {
      attributedGross,
      unattributedOrders: unattributed?.orders ?? 0,
      unattributedGross: unattributed?.gross ?? 0,
      otherCurrencies: summariseCurrencies(otherCurrencyPayments),
      disputedOrders: windowPayments.filter((payment) => payment.disputed).length,
    },
  }
}

function bucketTotals<T>(
  rows: readonly T[],
  at: (row: T) => string,
  amount: (row: T) => number,
  keys: readonly string[],
  bucket: Bucket,
  timezone: string
): number[] {
  const index = new Map(keys.map((key, position) => [key, position]))
  const totals = new Array(keys.length).fill(0)
  for (const row of rows) {
    let key: string
    try {
      key = bucketOf(dayKey(at(row), timezone), bucket)
    } catch {
      continue
    }
    const position = index.get(key)
    if (position !== undefined) totals[position] += amount(row)
  }
  return totals
}

function summariseCurrencies(payments: readonly Payment[]) {
  const buckets = new Map<string, { orders: number; gross: number }>()
  for (const payment of payments) {
    const bucket = buckets.get(payment.currency) ?? { orders: 0, gross: 0 }
    bucket.orders += 1
    bucket.gross += payment.amount
    buckets.set(payment.currency, bucket)
  }
  return [...buckets.entries()]
    .map(([currency, bucket]) => ({ currency, ...bucket }))
    .sort((a, b) => b.gross - a.gross)
}
