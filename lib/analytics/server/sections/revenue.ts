import type { ResolvedRange } from '../../range'
import { percent } from '../../aggregate'
import { notTracked, type Breakdown, type Funnel, type Metric, type SectionPayload, type Series } from '../../types'
import { buildRevenueReport, type RevenueReport } from '../../../billing/revenue'
import { fetchStripeSnapshot, stripeConfigured } from '../../../billing/stripeSource'
import { within } from '../../range'
import type { AccountRecord } from '../../../billing/model'
import { TIER_LABELS, loadProfiles } from '../profiles'
import { Diagnostics } from '../failures'
import type { Reader } from '../reader'

/**
 * Revenue, from Stripe's own payment records.
 *
 * NOT FROM MEMBERSHIP TIERS. A tier is access, and access is also granted by
 * hand; counting tiers as sales would invent revenue nobody paid. Every figure
 * with a currency on it here comes from a charge in Stripe.
 *
 * NO RECURRING REVENUE. This product sells one-time lifetime access, so there
 * is no MRR and no churn to show. A "repeat purchase" is someone who bought
 * twice — typically Premium and later Ultimate.
 *
 * Amounts arrive from Stripe in cents and are divided by 100 exactly once,
 * here, on their way to the screen.
 */

const money = (cents: number | null | undefined): number | null =>
  cents === null || cents === undefined ? null : cents / 100

export async function buildRevenue(reader: Reader, range: ResolvedRange, force = false): Promise<SectionPayload> {
  const diagnostics = new Diagnostics()

  const [users, profiles, snapshot] = await Promise.all([
    reader.authUsers(),
    loadProfiles(reader),
    stripeConfigured() ? fetchStripeSnapshot({ force }) : Promise.resolve(null),
  ])

  if (!users.ok) diagnostics.note('auth.users', 'failed', users.detail)
  if (!profiles.available) diagnostics.note('user_profiles', 'failed', profiles.reason ?? 'unavailable')

  const accounts: AccountRecord[] = users.ok
    ? users.rows.map((user) => ({ email: user.email, createdAt: user.created_at }))
    : []

  const accountsWithoutProfile = users.ok
    ? users.rows.filter((user) => !profiles.tierById.has(user.id)).length
    : 0

  const tierBreakdown: Breakdown = {
    id: 'tier_mix',
    label: 'Membership access held today',
    group: 'membership',
    status: profiles.available ? 'ok' : 'error',
    note: 'What members can use right now. Includes access granted by hand, so it is deliberately not a sales figure.',
    source: { label: 'user_profiles' },
    rows: [
      ...[...profiles.counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([tier, count]) => ({
          key: tier,
          label: TIER_LABELS[tier] ?? tier,
          value: count,
          note: tier === 'security-test' ? 'Internal test cohort.' : undefined,
        })),
      // So this panel adds up to the member count instead of quietly
      // falling short of it.
      ...(accountsWithoutProfile > 0
        ? [{
            key: 'no_profile',
            label: 'No membership record',
            value: accountsWithoutProfile,
            note: 'Signed-up accounts with no row in user_profiles.',
          }]
        : []),
    ],
  }

  // Stripe unavailable: say so plainly rather than showing zeroes.
  if (!snapshot) {
    const reason = stripeConfigured()
      ? 'Stripe could not be reached.'
      : 'STRIPE_SECRET_KEY is not configured in this environment, so no payment can be read.'
    diagnostics.failed.push({ source: 'Stripe', reason })
    return {
      section: 'revenue',
      generatedAt: new Date().toISOString(),
      range: payloadRange(range),
      metrics: [
        notTracked('gross_revenue', 'Gross revenue', reason, 'currency'),
        notTracked('net_revenue', 'Net revenue', reason, 'currency'),
        notTracked('orders', 'Purchases', reason),
      ],
      series: [],
      breakdowns: [tierBreakdown],
      funnels: [],
      diagnostics: diagnostics.finish(),
    }
  }

  for (const warning of snapshot.warnings) diagnostics.failed.push({ source: 'Stripe', reason: warning })

  const report = buildRevenueReport(
    snapshot,
    {
      from: range.from,
      to: range.to,
      bucket: range.bucket,
      timezone: range.timezone,
      comparison: range.comparison,
    },
    accounts
  )

  const currencyNote = `${report.currency.toUpperCase()} · Stripe ${report.mode} mode`
  const stripeSource = { label: 'Stripe charges', detail: `Read at ${report.fetchedAt}` }

  const metrics: Metric[] = [
    {
      id: 'gross_revenue',
      label: 'Gross revenue',
      group: 'headline',
      value: money(report.gross),
      previous: money(report.previous?.gross),
      unit: 'currency',
      status: 'ok',
      note: `What customers paid in this window, after discounts. ${currencyNote}.`,
      source: stripeSource,
      spark: report.series.gross.map((cents) => cents / 100),
    },
    {
      id: 'refunds',
      label: 'Refunds',
      group: 'headline',
      value: money(report.refunded),
      unit: 'currency',
      status: 'ok',
      note: 'Refunds issued in this window, whenever the original purchase was made.',
      source: { label: 'Stripe refunds' },
    },
    {
      id: 'net_revenue',
      label: 'Net revenue (after refunds)',
      group: 'headline',
      value: money(report.net),
      previous: money(report.previous?.net),
      unit: 'currency',
      status: 'ok',
      note: 'Gross minus refunds issued in this window. Stripe fees are NOT deducted here.',
      source: stripeSource,
    },
    {
      id: 'stripe_fees',
      label: 'Stripe fees',
      group: 'headline',
      value: money(report.fees),
      unit: 'currency',
      status: report.feesComplete ? 'ok' : 'partial',
      note: report.feesComplete
        ? 'Processing fees on this window’s payments.'
        : 'Some payments did not carry a balance transaction, so this is a lower bound.',
      source: { label: 'Stripe balance transactions' },
    },
    {
      id: 'after_fees',
      label: 'Net after refunds and fees',
      group: 'headline',
      value: money(report.net - report.fees),
      unit: 'currency',
      status: report.feesComplete ? 'ok' : 'partial',
      note: 'Net revenue minus Stripe processing fees. This is what reaches the bank, before tax.',
      source: stripeSource,
    },
    {
      id: 'orders',
      label: 'Purchases',
      group: 'headline',
      value: report.orders,
      previous: report.previous?.orders ?? null,
      status: 'ok',
      note: 'Successful payments in this window.',
      source: stripeSource,
    },
    {
      id: 'aov',
      label: 'Average purchase',
      group: 'headline',
      value: money(report.averageOrder),
      unit: 'currency',
      status: 'ok',
      source: stripeSource,
    },
    {
      id: 'paying_customers',
      label: 'Paying customers',
      group: 'headline',
      value: report.payingCustomers,
      status: 'ok',
      note: 'Distinct customers in this window; someone who bought twice counts once.',
      source: stripeSource,
    },

    // --- calendar to-date ----------------------------------------------------
    {
      id: 'today',
      label: 'Revenue today',
      group: 'todate',
      value: money(report.today),
      unit: 'currency',
      status: 'ok',
      note: `Calendar day in ${range.timezone.replace('_', ' ')}, regardless of the window above.`,
      source: stripeSource,
    },
    {
      id: 'week',
      label: 'Revenue this week',
      group: 'todate',
      value: money(report.weekToDate),
      unit: 'currency',
      status: 'ok',
      note: 'Monday to now.',
      source: stripeSource,
    },
    {
      id: 'month',
      label: 'Revenue this month',
      group: 'todate',
      value: money(report.monthToDate),
      unit: 'currency',
      status: 'ok',
      note: 'The 1st to now.',
      source: stripeSource,
    },

    // --- lifetime ------------------------------------------------------------
    {
      id: 'all_time_gross',
      label: 'Total revenue, all time',
      group: 'lifetime',
      value: money(report.allTime.gross),
      unit: 'currency',
      status: 'ok',
      note: report.allTime.firstPaymentAt
        ? `Every payment since ${report.allTime.firstPaymentAt.slice(0, 10)}.`
        : 'No payment has been recorded yet.',
      source: stripeSource,
    },
    {
      id: 'all_time_net',
      label: 'Total net, all time',
      group: 'lifetime',
      value: money(report.allTime.net),
      unit: 'currency',
      status: 'ok',
      note: 'All payments less all refunds, ever. Before Stripe fees.',
      source: stripeSource,
    },
    {
      id: 'all_time_orders',
      label: 'Purchases, all time',
      group: 'lifetime',
      value: report.allTime.orders,
      status: 'ok',
      source: stripeSource,
    },
    {
      id: 'all_time_customers',
      label: 'Customers, all time',
      group: 'lifetime',
      value: report.allTime.customers,
      status: 'ok',
      note: 'Distinct people who have ever paid.',
      source: stripeSource,
    },
    {
      id: 'repeat_customers',
      label: 'Repeat purchasers',
      group: 'lifetime',
      value: report.allTime.repeatCustomers,
      status: 'ok',
      note: 'Bought more than once — typically Premium first, then Ultimate. These are one-time purchases, not renewals.',
      source: stripeSource,
    },

    // --- conversion ----------------------------------------------------------
    {
      id: 'free_to_paid',
      label: 'Free to paid conversion',
      group: 'conversion',
      value: report.conversion.rate,
      unit: 'percent',
      status: report.conversion.unmatchedPayers > 0 ? 'partial' : 'ok',
      note:
        report.conversion.unmatchedPayers > 0
          ? `Accounts that have ever paid, out of all accounts. ${report.conversion.unmatchedPayers} payer(s) could not be matched to an account by email, so the true figure is slightly higher.`
          : 'Accounts that have ever paid, out of all accounts. Matched by email.',
      source: { label: 'Stripe charges + auth.users' },
    },
    {
      id: 'paying_accounts',
      label: 'Accounts that have paid',
      group: 'conversion',
      value: report.conversion.payingAccounts,
      status: 'ok',
      note: `Of ${report.conversion.accounts.toLocaleString()} accounts.`,
      source: { label: 'Stripe charges + auth.users' },
    },
    {
      id: 'cohort_conversion',
      label: 'Conversion of this window’s signups',
      group: 'conversion',
      value: report.conversion.cohortRate,
      unit: 'percent',
      status: 'partial',
      note: `${report.conversion.cohortPaid} of ${report.conversion.cohortAccounts} accounts created in this window have paid so far. Recent signups have had less time to buy.`,
      source: { label: 'Stripe charges + auth.users' },
    },
    // Under a day, "0.0 days" hides the answer instead of giving it: most
    // buyers here sign up and pay in the same sitting, which is worth seeing.
    (() => {
      const days = report.conversion.medianDaysToPurchase
      const useHours = days !== null && days < 1
      return {
        id: 'days_to_purchase',
        label: useHours ? 'Median hours from signup to purchase' : 'Median days from signup to purchase',
        group: 'conversion',
        value: days === null ? null : useHours ? days * 24 : days,
        unit: 'score' as const,
        status: 'ok' as const,
        note: useHours
          ? 'Most buyers sign up and pay in the same session. Across every matched account that has ever paid.'
          : 'Across every matched account that has ever paid.',
        source: { label: 'Stripe charges + auth.users' },
      }
    })(),

    // --- discounts -----------------------------------------------------------
    {
      id: 'discount_total',
      label: 'Discounts given',
      group: 'discounts',
      value: money(report.discountTotal),
      unit: 'currency',
      status: 'ok',
      note: 'Taken off the list price by promotion codes in this window. Not part of revenue.',
      source: { label: 'Stripe checkout sessions' },
    },
    {
      id: 'discounted_orders',
      label: 'Purchases with a discount',
      group: 'discounts',
      value: report.discountedOrders,
      status: 'ok',
      note: percentLabel(report.discountedOrders, report.orders),
      source: { label: 'Stripe checkout sessions' },
    },
  ]

  const series: Series[] = [
    {
      id: 'revenue_daily',
      label: 'Revenue over the window',
      group: 'headline',
      buckets: report.series.keys,
      labels: report.series.labels,
      status: 'ok',
      note: `Gross payments and refunds, in ${report.currency.toUpperCase()}.`,
      source: stripeSource,
      points: [
        { key: 'gross', label: 'Gross', values: report.series.gross.map((c) => c / 100), kind: 'bar' },
        { key: 'refunded', label: 'Refunded', values: report.series.refunded.map((c) => c / 100), kind: 'bar' },
      ],
    },
    {
      id: 'revenue_monthly',
      label: 'Revenue by month, all time',
      group: 'lifetime',
      buckets: report.monthly.keys,
      labels: report.monthly.labels,
      status: 'ok',
      note: 'Every month since the first payment. One-time purchases, so this is revenue earned in each month, not recurring revenue.',
      source: stripeSource,
      points: [
        { key: 'gross', label: 'Gross', values: report.monthly.gross.map((c) => c / 100), kind: 'bar' },
        { key: 'refunded', label: 'Refunded', values: report.monthly.refunded.map((c) => c / 100), kind: 'bar' },
      ],
    },
  ]

  const planLabels: Record<string, string> = {
    premium: 'Premium',
    ultimate: 'Ultimate',
    unattributed: 'Plan not recorded',
  }

  const breakdowns: Breakdown[] = [
    {
      id: 'by_plan_revenue',
      label: 'Revenue by plan',
      group: 'headline',
      unit: 'currency',
      status: report.reconciliation.unattributedOrders > 0 ? 'partial' : 'ok',
      note:
        report.reconciliation.unattributedOrders > 0
          ? `${report.reconciliation.unattributedOrders} payment(s) had no checkout session to name a plan. They are counted in revenue and shown here as unattributed.`
          : 'From the plan recorded on each checkout session.',
      source: { label: 'Stripe charges + sessions' },
      rows: report.byPlan.map((entry) => ({
        key: entry.plan,
        label: planLabels[entry.plan] ?? entry.plan,
        value: entry.gross / 100,
        note: `${entry.orders} purchase${entry.orders === 1 ? '' : 's'} · ${entry.customers} customer${entry.customers === 1 ? '' : 's'}`,
      })),
    },
    {
      id: 'by_plan_orders',
      label: 'Purchases by plan',
      group: 'headline',
      status: 'ok',
      source: { label: 'Stripe checkout sessions' },
      rows: report.byPlan.map((entry) => ({
        key: entry.plan,
        label: planLabels[entry.plan] ?? entry.plan,
        value: entry.orders,
      })),
    },
    tierBreakdown,
  ]

  if (report.promoCodes.length > 0) {
    breakdowns.push({
      id: 'promo_codes',
      label: 'Promotion codes used',
      group: 'discounts',
      unit: 'currency',
      status: 'ok',
      note: 'The discount each code gave in this window.',
      source: { label: 'Stripe checkout sessions' },
      rows: report.promoCodes.map((code) => ({
        key: code.code,
        label: code.code,
        value: code.discount / 100,
        note: `${code.uses} use${code.uses === 1 ? '' : 's'} · ${(code.gross / 100).toLocaleString('en-US', { style: 'currency', currency: report.currency.toUpperCase() })} still paid`,
      })),
    })
  }

  if (report.refunds.length > 0) {
    breakdowns.push({
      id: 'refund_list',
      label: 'Refunds in this window',
      group: 'discounts',
      unit: 'currency',
      status: 'ok',
      source: { label: 'Stripe refunds' },
      rows: report.refunds.slice(0, 10).map((refund) => ({
        key: refund.id,
        label: `${refund.at.slice(0, 10)} · ${planLabels[refund.plan] ?? refund.plan}`,
        value: refund.amount / 100,
      })),
    })
  }

  // --- checkout funnel, from sessions ---------------------------------------
  // Matched session by session: the denominator is the sessions created in
  // this window and the numerator is the subset of THOSE that completed.
  // Comparing sessions here against charges would mix two populations.
  const sessionsInWindow = snapshot.checkouts.filter((checkout) => within(checkout.createdAt, range.from, range.to))
  const completedSessions = sessionsInWindow.filter(
    (checkout) => checkout.status === 'complete' && checkout.paymentStatus !== 'unpaid'
  )

  const funnels: Funnel[] = [
    {
      id: 'checkout',
      label: 'Checkout in this window',
      steps: [
        {
          id: 'started',
          label: 'Checkout started',
          value: sessionsInWindow.length,
          status: 'ok',
          note: 'Stripe checkout sessions created. A member who tried twice counts twice.',
        },
        {
          id: 'completed',
          label: 'Paid',
          value: completedSessions.length,
          status: 'ok',
          note:
            sessionsInWindow.length > 0
              ? `${Math.round((1 - completedSessions.length / sessionsInWindow.length) * 100)}% of checkouts were abandoned or expired.`
              : undefined,
        },
      ],
    },
  ]

  if (report.reconciliation.otherCurrencies.length > 0) {
    diagnostics.failed.push({
      source: 'Stripe',
      reason: `Payments in other currencies are excluded from these totals: ${report.reconciliation.otherCurrencies
        .map((entry) => `${entry.orders} in ${entry.currency.toUpperCase()}`)
        .join(', ')}.`,
    })
  }
  if (report.reconciliation.disputedOrders > 0) {
    diagnostics.failed.push({
      source: 'Stripe',
      reason: `${report.reconciliation.disputedOrders} payment(s) in this window are disputed. A dispute is not deducted here until it becomes a refund.`,
    })
  }

  return {
    section: 'revenue',
    generatedAt: new Date().toISOString(),
    range: payloadRange(range),
    metrics,
    series,
    breakdowns,
    funnels,
    diagnostics: diagnostics.finish(),
  }
}

function percentLabel(part: number, whole: number): string | undefined {
  const share = percent(part, whole)
  return share === null ? undefined : `${share.toFixed(0)}% of purchases in this window.`
}

function payloadRange(range: ResolvedRange) {
  return {
    preset: range.preset,
    from: range.from,
    to: range.to,
    bucket: range.bucket,
    timezone: range.timezone,
    label: range.label,
    comparison: range.comparison,
  }
}

export type { RevenueReport }
