/**
 * Server-side checkout plan resolution.
 *
 * The client sends only a plan name ('premium' | 'ultimate'); everything that
 * determines what gets charged — the Stripe Price ID, and whether a promotion
 * code field is even shown — is decided here, not trusted from the request
 * body. This is what stops a manipulated checkout request from paying the
 * Ultimate price for Premium, or vice versa.
 */

export const PURCHASABLE_PLANS = ['premium', 'ultimate'] as const
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number]

export function isPurchasablePlan(plan: unknown): plan is PurchasablePlan {
  return typeof plan === 'string' && (PURCHASABLE_PLANS as readonly string[]).includes(plan)
}

/** Reads the Stripe Price ID for a plan from env, never from the request. */
export function resolvePriceId(plan: PurchasablePlan): string | undefined {
  return plan === 'premium'
    ? process.env.NEXT_PUBLIC_PREMIUM_PRICE_ID
    : process.env.NEXT_PUBLIC_ULTIMATE_PRICE_ID
}

/**
 * Only Ultimate checkout shows Stripe's promotion code field. Eligibility of
 * any given code is then enforced entirely by Stripe: a promotion code's
 * coupon is scoped to the Ultimate product via "Limit to specific products"
 * in the Dashboard, so Stripe itself rejects that code on a Premium session.
 * No promo/discount logic lives in this app.
 */
export function allowsPromotionCode(plan: PurchasablePlan): boolean {
  return plan === 'ultimate'
}
