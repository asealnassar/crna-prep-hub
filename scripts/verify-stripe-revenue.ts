/**
 * Proves the dashboard's revenue figures against Stripe itself.
 *
 * READ ONLY. It lists charges, refunds, balance transactions and checkout
 * sessions. It creates, updates and cancels nothing, so it cannot touch a
 * customer, a payment or an entitlement.
 *
 * HOW IT PROVES ANYTHING. Summing the same list twice proves nothing, so the
 * cross-check runs down a different road: the dashboard totals come from the
 * CHARGES endpoint, and the control totals come from Stripe's BALANCE
 * TRANSACTION ledger — the record of money actually moving. If those two
 * disagree, the dashboard is wrong and this exits non-zero.
 *
 *   npx tsx scripts/verify-stripe-revenue.ts        (or: node --import ...)
 *
 * It prints totals and counts only. No email address, no customer, no key.
 */

import { readFileSync } from 'node:fs'
import Stripe from 'stripe'
import { buildRevenueReport } from '../lib/billing/revenue.ts'
import { fetchStripeSnapshot, stripeMode } from '../lib/billing/stripeSource.ts'

function loadEnv() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    /* the environment may already carry them */
  }
}
loadEnv()

const money = (cents: number, currency: string) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: currency.toUpperCase() })

async function main() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set; nothing to verify.')
    process.exit(2)
  }

  console.log(`Stripe mode: ${stripeMode()}`)
  console.log('Reading the full payment history…\n')

  const snapshot = await fetchStripeSnapshot({ force: true })
  if (!snapshot) {
    console.error('Stripe could not be reached.')
    process.exit(2)
  }

  // All time, so the comparison covers every record Stripe holds.
  const report = buildRevenueReport(
    snapshot,
    { from: null, to: new Date().toISOString(), bucket: 'month', timezone: 'America/New_York', comparison: null },
    []
  )
  const currency = report.currency

  // --- the control: Stripe's own ledger -------------------------------------
  const stripe = new Stripe(key, { apiVersion: '2023-10-16', maxNetworkRetries: 2 })
  const ledger = { charges: 0, chargeCount: 0, refunds: 0, refundCount: 0, fees: 0 }

  for await (const entry of stripe.balanceTransactions.list({ limit: 100 })) {
    if (entry.currency !== currency) continue
    if (entry.type === 'charge' || entry.type === 'payment') {
      ledger.charges += entry.amount
      ledger.chargeCount += 1
      ledger.fees += entry.fee
    } else if (entry.type === 'refund' || entry.type === 'payment_refund') {
      ledger.refunds += Math.abs(entry.amount)
      ledger.refundCount += 1
    }
  }

  const rows: [string, string, string, boolean][] = [
    [
      'Gross revenue',
      money(report.allTime.gross, currency),
      money(ledger.charges, currency),
      report.allTime.gross === ledger.charges,
    ],
    [
      'Refunds',
      money(report.allTime.refunded, currency),
      money(ledger.refunds, currency),
      report.allTime.refunded === ledger.refunds,
    ],
    [
      'Net revenue',
      money(report.allTime.net, currency),
      money(ledger.charges - ledger.refunds, currency),
      report.allTime.net === ledger.charges - ledger.refunds,
    ],
    [
      'Successful payments',
      String(report.allTime.orders),
      String(ledger.chargeCount),
      report.allTime.orders === ledger.chargeCount,
    ],
  ]

  console.log('                        dashboard        Stripe ledger     match')
  for (const [label, mine, theirs, ok] of rows) {
    console.log(`${label.padEnd(22)}  ${mine.padStart(14)}  ${theirs.padStart(16)}     ${ok ? 'yes' : 'NO'}`)
  }

  console.log('\nBreakdown the dashboard shows:')
  for (const plan of report.byPlan) {
    console.log(`  ${plan.plan.padEnd(14)} ${String(plan.orders).padStart(4)} purchases  ${money(plan.gross, currency).padStart(12)}`)
  }
  console.log(`  customers      ${String(report.allTime.customers).padStart(4)}`)
  console.log(`  repeat buyers  ${String(report.allTime.repeatCustomers).padStart(4)}`)
  console.log(`  discounts      ${money(report.discountTotal, currency).padStart(12)} across ${report.discountedOrders} purchase(s)`)
  for (const code of report.promoCodes) {
    console.log(`    ${code.code}: ${code.uses} use(s), ${money(code.discount, currency)} off`)
  }

  console.log(`\nRecords read: ${snapshot.payments.length} charges, ${snapshot.refunds.length} refunds, ${snapshot.checkouts.length} checkout sessions.`)
  console.log(`Plan attribution: ${report.reconciliation.unattributedOrders} payment(s) could not be matched to a checkout session.`)
  if (report.reconciliation.otherCurrencies.length > 0) {
    console.log(`Other currencies present: ${report.reconciliation.otherCurrencies.map((c) => `${c.orders} in ${c.currency}`).join(', ')}`)
  }
  for (const warning of snapshot.warnings) console.log(`Warning: ${warning}`)

  const mismatched = rows.filter(([, , , ok]) => !ok)
  if (mismatched.length > 0) {
    console.error(`\nFAILED: ${mismatched.length} figure(s) do not match Stripe's ledger.`)
    process.exit(1)
  }
  console.log('\nEvery figure matches Stripe to the cent.')
}

main().catch((error) => {
  console.error('Verification failed:', error?.message ?? error)
  process.exit(1)
})
