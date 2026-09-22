import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { allowsPromotionCode, isPurchasablePlan, resolvePriceId } from './checkout'

/**
 * These cover the part of the promo-code feature that lives in our own code:
 * plan validation, server-side price resolution, and which plan even shows a
 * promotion code field. Whether a given code is valid, discounted correctly,
 * expired, or Ultimate-only is enforced entirely by Stripe (the coupon's
 * "applies to" product restriction plus Stripe's own Promotion Code checks),
 * so that behavior isn't something this app's test suite can assert without
 * live Stripe test-mode calls — see the manual verification steps this PR's
 * description lists instead.
 */

// --- plan validation ---------------------------------------------------

test('premium and ultimate are purchasable plans', () => {
  assert.equal(isPurchasablePlan('premium'), true)
  assert.equal(isPurchasablePlan('ultimate'), true)
})

test('free, unknown, and malformed values are never purchasable plans', () => {
  assert.equal(isPurchasablePlan('free'), false)
  assert.equal(isPurchasablePlan('security-test'), false)
  assert.equal(isPurchasablePlan('Ultimate'), false) // case-sensitive
  assert.equal(isPurchasablePlan(''), false)
  assert.equal(isPurchasablePlan(null), false)
  assert.equal(isPurchasablePlan(undefined), false)
  assert.equal(isPurchasablePlan(42), false)
  assert.equal(isPurchasablePlan({ plan: 'ultimate' }), false)
})

// --- price resolution ---------------------------------------------------

test('resolvePriceId reads the price for each plan from its own env var', () => {
  const prevPremium = process.env.NEXT_PUBLIC_PREMIUM_PRICE_ID
  const prevUltimate = process.env.NEXT_PUBLIC_ULTIMATE_PRICE_ID
  try {
    process.env.NEXT_PUBLIC_PREMIUM_PRICE_ID = 'price_premium_test'
    process.env.NEXT_PUBLIC_ULTIMATE_PRICE_ID = 'price_ultimate_test'

    assert.equal(resolvePriceId('premium'), 'price_premium_test')
    assert.equal(resolvePriceId('ultimate'), 'price_ultimate_test')
  } finally {
    process.env.NEXT_PUBLIC_PREMIUM_PRICE_ID = prevPremium
    process.env.NEXT_PUBLIC_ULTIMATE_PRICE_ID = prevUltimate
  }
})

test('an unconfigured plan price resolves to undefined, never a fallback price', () => {
  const prevUltimate = process.env.NEXT_PUBLIC_ULTIMATE_PRICE_ID
  try {
    delete process.env.NEXT_PUBLIC_ULTIMATE_PRICE_ID
    assert.equal(resolvePriceId('ultimate'), undefined)
  } finally {
    process.env.NEXT_PUBLIC_ULTIMATE_PRICE_ID = prevUltimate
  }
})

// --- promotion code gating ---------------------------------------------

test('only Ultimate checkout offers a promotion code field', () => {
  assert.equal(allowsPromotionCode('ultimate'), true)
  assert.equal(allowsPromotionCode('premium'), false)
})

// --- regression guards on the route files -------------------------------
// Static checks, in the style of lib/resume/writeBoundary.test.ts, since this
// repo has no Stripe mocking harness to exercise the routes end-to-end.

const CHECKOUT_ROUTE = readFileSync(
  fileURLToPath(new URL('../app/api/checkout/route.ts', import.meta.url)),
  'utf8'
)
const WEBHOOK_ROUTE = readFileSync(
  fileURLToPath(new URL('../app/api/webhook/route.ts', import.meta.url)),
  'utf8'
)

test('checkout no longer computes its own discount — Stripe owns that', () => {
  for (const banned of ['coupons.create', 'amount_off', 'discounts:', 'promo_codes', 'promo_code_usage']) {
    assert.equal(
      CHECKOUT_ROUTE.includes(banned),
      false,
      `checkout route should not contain "${banned}" — discounts must come from Stripe Promotion Codes, not app code`
    )
  }
})

test('checkout derives the price and promo-code visibility from the validated plan, not the request body', () => {
  assert.ok(CHECKOUT_ROUTE.includes('resolvePriceId(plan)'), 'price must be resolved server-side from plan')
  assert.ok(CHECKOUT_ROUTE.includes('allowsPromotionCode(plan)'), 'promo code field must be gated by plan')
  assert.ok(CHECKOUT_ROUTE.includes('isPurchasablePlan(plan)'), 'plan must be validated before use')
  assert.equal(/const\s*\{\s*priceId/.test(CHECKOUT_ROUTE), false, 'priceId must never be read from the request body')
})

test('checkout resolves the buyer email from the verified session, not the request body', () => {
  assert.ok(CHECKOUT_ROUTE.includes('authenticateRequest()'), 'checkout must authenticate the caller')
  assert.equal(/const\s*\{\s*[^}]*userEmail/.test(CHECKOUT_ROUTE), false, 'userEmail must never be read from the request body')
})

test('the webhook only ever writes a plan it validated, never a default', () => {
  assert.ok(WEBHOOK_ROUTE.includes('isPurchasablePlan(plan)'), 'webhook must validate plan before writing subscription_tier')
  assert.equal(WEBHOOK_ROUTE.includes("|| 'premium'"), false, 'a silent default tier must not exist')
})
