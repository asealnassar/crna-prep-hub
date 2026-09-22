/**
 * Payments, as this dashboard needs them.
 *
 * WHY A MODEL AND NOT STRIPE'S OBJECTS. Two reasons. Revenue arithmetic should
 * be testable without a network, and it should be obvious which field every
 * number came from — `amount` on a charge is not the same thing as
 * `amount_total` on a checkout session, and mixing them is how a dashboard
 * ends up double-counting a discounted purchase.
 *
 * WHAT EACH SOURCE IS FOR:
 *
 *   * CHARGES are the money. They are permanent, they carry what the customer
 *     actually paid after any discount, and their balance transaction carries
 *     Stripe's fee. Every revenue total is computed from these.
 *   * CHECKOUT SESSIONS are the context: which plan was bought, which
 *     promotion code was used, how much was discounted. They are joined to
 *     charges by payment intent, and a charge with no session still counts as
 *     revenue — it is simply reported as unattributed rather than dropped.
 *   * REFUNDS carry their own date, which is rarely the date of the purchase.
 *     A refund belongs to the window it happened in.
 *
 * All amounts are integer minor units (cents), exactly as Stripe stores them.
 * Nothing here converts to a float until it is formatted for the screen.
 */

export type PlanName = 'premium' | 'ultimate'

export type Payment = {
  /** Stripe charge id. */
  readonly id: string
  readonly createdAt: string
  /** What the customer paid, in cents, after discounts and including tax. */
  readonly amount: number
  /** How much of it has since been refunded, in cents. */
  readonly amountRefunded: number
  readonly currency: string
  readonly succeeded: boolean
  /** Stripe's fee and net, from the balance transaction. Null when unexpanded. */
  readonly fee: number | null
  readonly net: number | null
  /** Lower-cased, used only to join a payment to an account. */
  readonly email: string | null
  readonly paymentIntentId: string | null
  readonly disputed: boolean
}

export type Refund = {
  readonly id: string
  readonly chargeId: string | null
  readonly createdAt: string
  readonly amount: number
  readonly currency: string
  /** Stripe marks a failed or cancelled refund; only succeeded ones count. */
  readonly succeeded: boolean
}

export type Checkout = {
  readonly id: string
  readonly createdAt: string
  readonly status: string | null
  readonly paymentStatus: string | null
  /** From our own metadata. Null when a session predates it or was not ours. */
  readonly plan: PlanName | null
  readonly paymentIntentId: string | null
  readonly email: string | null
  readonly amountTotal: number | null
  readonly amountSubtotal: number | null
  readonly amountDiscount: number
  /** The human code where it could be resolved, else the promotion code id. */
  readonly promotionCode: string | null
  readonly currency: string | null
}

export type StripeSnapshot = {
  readonly mode: 'live' | 'test'
  readonly fetchedAt: string
  readonly payments: readonly Payment[]
  readonly refunds: readonly Refund[]
  readonly checkouts: readonly Checkout[]
  /** Anything the reader wants the dashboard to say out loud. */
  readonly warnings: readonly string[]
  readonly truncated: boolean
}

/** An account, as the conversion figures need it. */
export type AccountRecord = {
  readonly email: string | null
  readonly createdAt: string
}

export function isPlan(value: unknown): value is PlanName {
  return value === 'premium' || value === 'ultimate'
}

/** Stripe emails are compared lower-cased and trimmed, never raw. */
export function normaliseEmail(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * What to call a discount.
 *
 * A discount reaches a checkout session two ways, and both are "a promotion"
 * to whoever ran it: a promotion code the customer typed, or a coupon applied
 * directly. Only the first carries a code, so a real promotion would otherwise
 * show up as anonymous. The order here is most specific first.
 *
 * Shaped as a pure function over the parts, so the fallback chain can be
 * tested without Stripe.
 */
export type DiscountShape = {
  readonly promotionCodeId?: string | null
  readonly promotionCodeText?: string | null
  readonly couponId?: string | null
  readonly couponName?: string | null
}

export function promotionLabel(
  discounts: readonly DiscountShape[],
  knownCodes: ReadonlyMap<string, string>
): string | null {
  for (const discount of discounts) {
    if (discount.promotionCodeId) {
      const resolved = knownCodes.get(discount.promotionCodeId)
      if (resolved) return resolved
      if (discount.promotionCodeText) return discount.promotionCodeText
      return discount.promotionCodeId
    }
    if (discount.promotionCodeText) return discount.promotionCodeText
    if (discount.couponName) return discount.couponName
    if (discount.couponId) return discount.couponId
  }
  return null
}
