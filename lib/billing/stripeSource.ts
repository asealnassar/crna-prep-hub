import Stripe from 'stripe'
import {
  isPlan,
  normaliseEmail,
  promotionLabel,
  type Checkout,
  type DiscountShape,
  type Payment,
  type Refund,
  type StripeSnapshot,
} from './model'

/**
 * Reading the whole payment history out of Stripe, safely.
 *
 * SAFELY MEANS THREE THINGS HERE:
 *
 *   1. READ ONLY. This module lists charges, refunds, checkout sessions and
 *      promotion codes. It creates nothing, updates nothing and cancels
 *      nothing, so it cannot affect a customer, a payment or an entitlement.
 *   2. BOUNDED. Every list is paged to the end through Stripe's own cursor,
 *      with a hard ceiling. Reaching the ceiling is reported rather than
 *      quietly returning a smaller history.
 *   3. CACHED. The history is fetched once and reused for a few minutes, so
 *      switching tabs or comparing windows does not re-read the account and
 *      does not spend Stripe's rate limit.
 *
 * CHARGES ARE THE HISTORY. They are permanent and complete, which is what
 * makes past revenue visible rather than only purchases made from today on.
 * Checkout sessions add the plan and the promotion code; where they do not
 * reach as far back as the charges, the gap is reported and those payments are
 * counted as unattributed rather than dropped.
 */

/** Stripe's maximum page size. */
const PAGE = 100

/** Nothing about this business approaches these numbers; the caps are a stop. */
const MAX_CHARGES = 20_000
const MAX_REFUNDS = 5_000
const MAX_SESSIONS = 20_000

const CACHE_MS = 5 * 60 * 1000

type CacheEntry = { at: number; snapshot: StripeSnapshot }
let cache: CacheEntry | null = null

export function stripeConfigured(): boolean {
  return typeof process.env.STRIPE_SECRET_KEY === 'string' && process.env.STRIPE_SECRET_KEY.length > 0
}

/** live or test, from the key's own prefix. The key itself is never logged. */
export function stripeMode(): 'live' | 'test' {
  return (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live') ? 'live' : 'test'
}

function client(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  // The same API version the checkout and webhook routes pin, so this module
  // sees exactly the shapes the rest of the app was written against.
  return new Stripe(key, { apiVersion: '2023-10-16', maxNetworkRetries: 2 })
}

async function collect<T extends { id: string }>(
  list: Stripe.ApiListPromise<T>,
  cap: number
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  let truncated = false
  for await (const row of list) {
    rows.push(row)
    if (rows.length >= cap) {
      truncated = true
      break
    }
  }
  return { rows, truncated }
}

export type FetchOptions = {
  /** Ignore the cache and read Stripe again. */
  readonly force?: boolean
  /** Only used by the verification script, to keep its output small. */
  readonly since?: Date
}

export async function fetchStripeSnapshot(options: FetchOptions = {}): Promise<StripeSnapshot | null> {
  if (!options.force && cache && Date.now() - cache.at < CACHE_MS) return cache.snapshot

  const stripe = client()
  if (!stripe) return null

  const warnings: string[] = []
  const created = options.since ? { gte: Math.floor(options.since.getTime() / 1000) } : undefined
  let truncated = false

  // --- promotion codes, so a discount can be named rather than shown as an id
  const promotionCodes = new Map<string, string>()
  try {
    const { rows } = await collect(stripe.promotionCodes.list({ limit: PAGE }), 1000)
    for (const code of rows) promotionCodes.set(code.id, code.code)
  } catch (error: any) {
    warnings.push(`Promotion codes could not be read (${error?.message ?? 'unknown error'}), so codes appear as ids.`)
  }

  // --- checkout sessions, for plan and discount context
  const checkouts: Checkout[] = []
  let oldestSession: number | null = null
  try {
    const { rows, truncated: cut } = await collect(
      stripe.checkout.sessions.list({
        limit: PAGE,
        ...(created ? { created } : {}),
        expand: ['data.total_details.breakdown'],
      }),
      MAX_SESSIONS
    )
    truncated = truncated || cut
    for (const session of rows) {
      if (oldestSession === null || session.created < oldestSession) oldestSession = session.created
      const discounts = session.total_details?.breakdown?.discounts ?? []
      const shapes: DiscountShape[] = discounts.map((entry) => {
        const discount = entry.discount as Stripe.Discount | undefined
        const code = discount?.promotion_code
        const coupon = discount?.coupon
        return {
          promotionCodeId: typeof code === 'string' ? code : (code?.id ?? null),
          promotionCodeText: typeof code === 'string' ? null : (code?.code ?? null),
          couponId: typeof coupon === 'string' ? coupon : (coupon?.id ?? null),
          couponName: typeof coupon === 'string' ? null : (coupon?.name ?? null),
        }
      })
      const promotion = promotionLabel(shapes, promotionCodes)

      checkouts.push({
        id: session.id,
        createdAt: new Date(session.created * 1000).toISOString(),
        status: session.status ?? null,
        paymentStatus: session.payment_status ?? null,
        plan: isPlan(session.metadata?.plan) ? session.metadata!.plan : null,
        paymentIntentId:
          typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null),
        email: normaliseEmail(session.customer_email ?? session.customer_details?.email ?? null),
        amountTotal: session.amount_total ?? null,
        amountSubtotal: session.amount_subtotal ?? null,
        amountDiscount: session.total_details?.amount_discount ?? 0,
        promotionCode: promotion ?? null,
        currency: session.currency ?? null,
      })
    }
  } catch (error: any) {
    warnings.push(
      `Checkout sessions could not be read (${error?.message ?? 'unknown error'}). Revenue totals are unaffected, but purchases cannot be split by plan.`
    )
  }

  // --- charges: the money itself
  const emailByIntent = new Map<string, string>()
  for (const checkout of checkouts) {
    if (checkout.paymentIntentId && checkout.email) emailByIntent.set(checkout.paymentIntentId, checkout.email)
  }

  const payments: Payment[] = []
  let oldestCharge: number | null = null
  try {
    const { rows, truncated: cut } = await collect(
      stripe.charges.list({ limit: PAGE, ...(created ? { created } : {}), expand: ['data.balance_transaction'] }),
      MAX_CHARGES
    )
    truncated = truncated || cut
    for (const charge of rows) {
      if (oldestCharge === null || charge.created < oldestCharge) oldestCharge = charge.created
      const balance = charge.balance_transaction
      const intent = typeof charge.payment_intent === 'string' ? charge.payment_intent : (charge.payment_intent?.id ?? null)
      payments.push({
        id: charge.id,
        createdAt: new Date(charge.created * 1000).toISOString(),
        amount: charge.amount,
        amountRefunded: charge.amount_refunded ?? 0,
        currency: charge.currency,
        succeeded: charge.status === 'succeeded' && charge.paid,
        fee: balance && typeof balance !== 'string' ? balance.fee : null,
        net: balance && typeof balance !== 'string' ? balance.net : null,
        email:
          normaliseEmail(charge.billing_details?.email ?? charge.receipt_email ?? null) ??
          (intent ? (emailByIntent.get(intent) ?? null) : null),
        paymentIntentId: intent,
        disputed: charge.disputed === true,
      })
    }
  } catch (error: any) {
    warnings.push(`Payments could not be read from Stripe (${error?.message ?? 'unknown error'}).`)
  }

  // --- refunds: dated when the money went back
  const refunds: Refund[] = []
  try {
    const { rows, truncated: cut } = await collect(
      stripe.refunds.list({ limit: PAGE, ...(created ? { created } : {}) }),
      MAX_REFUNDS
    )
    truncated = truncated || cut
    for (const refund of rows) {
      refunds.push({
        id: refund.id,
        chargeId: typeof refund.charge === 'string' ? refund.charge : (refund.charge?.id ?? null),
        createdAt: new Date(refund.created * 1000).toISOString(),
        amount: refund.amount,
        currency: refund.currency,
        succeeded: refund.status === 'succeeded',
      })
    }
  } catch (error: any) {
    warnings.push(`Refunds could not be read from Stripe (${error?.message ?? 'unknown error'}).`)
  }

  if (truncated) {
    warnings.push('The read reached its ceiling, so the history shown is incomplete.')
  }
  if (payments.length > 0 && checkouts.length === 0) {
    warnings.push('No checkout sessions were returned, so no purchase can be split by plan.')
  }
  if (oldestCharge !== null && oldestSession !== null && oldestSession > oldestCharge + 86_400) {
    warnings.push(
      `Checkout sessions only reach back to ${new Date(oldestSession * 1000).toISOString().slice(0, 10)}, while payments reach back to ${new Date(oldestCharge * 1000).toISOString().slice(0, 10)}. Earlier purchases are counted in revenue but cannot be split by plan.`
    )
  }

  const snapshot: StripeSnapshot = {
    mode: stripeMode(),
    fetchedAt: new Date().toISOString(),
    payments,
    refunds,
    checkouts,
    warnings,
    truncated,
  }

  if (!options.since) cache = { at: Date.now(), snapshot }
  return snapshot
}

/** Used by tests and by the verification script; never by a request handler. */
export function clearStripeCache(): void {
  cache = null
}
