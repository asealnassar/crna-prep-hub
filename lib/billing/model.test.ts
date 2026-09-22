import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isPlan, normaliseEmail, promotionLabel } from './model.ts'

/**
 * Naming a discount. Both shapes below were found in the live account: one
 * purchase carried a promotion code the customer typed, another carried a
 * coupon applied directly, whose name is the only record of what the promotion
 * was called.
 */

const KNOWN = new Map([['promo_abc', 'ULTIMATE20']])

test('a promotion code id is resolved to the code the customer typed', () => {
  assert.equal(promotionLabel([{ promotionCodeId: 'promo_abc' }], KNOWN), 'ULTIMATE20')
})

test('an unknown promotion code id falls back to the code text, then the id', () => {
  assert.equal(promotionLabel([{ promotionCodeId: 'promo_gone', promotionCodeText: 'SPRING10' }], KNOWN), 'SPRING10')
  assert.equal(promotionLabel([{ promotionCodeId: 'promo_gone' }], KNOWN), 'promo_gone')
})

test('a coupon with no promotion code is named by the coupon', () => {
  // This is the case that used to read as "(discount without a code)".
  assert.equal(promotionLabel([{ couponId: '97ZdStgb', couponName: 'Promo: CRNA15' }], KNOWN), 'Promo: CRNA15')
})

test('an unnamed coupon falls back to its id rather than to nothing', () => {
  assert.equal(promotionLabel([{ couponId: '97ZdStgb' }], KNOWN), '97ZdStgb')
})

test('no discount at all is null, so it is never labelled as a promotion', () => {
  assert.equal(promotionLabel([], KNOWN), null)
  assert.equal(promotionLabel([{}], KNOWN), null)
})

test('the first discount wins when a session carries more than one', () => {
  assert.equal(
    promotionLabel([{ promotionCodeId: 'promo_abc' }, { couponName: 'Second' }], KNOWN),
    'ULTIMATE20'
  )
})

test('only the two purchasable plans are plans', () => {
  assert.equal(isPlan('premium'), true)
  assert.equal(isPlan('ultimate'), true)
  assert.equal(isPlan('free'), false)
  assert.equal(isPlan(null), false)
  assert.equal(isPlan('Ultimate'), false)
})

test('emails are compared lower-cased and trimmed, and blanks are null', () => {
  assert.equal(normaliseEmail('  Alice@Example.COM '), 'alice@example.com')
  assert.equal(normaliseEmail(''), null)
  assert.equal(normaliseEmail('   '), null)
  assert.equal(normaliseEmail(null), null)
  assert.equal(normaliseEmail(undefined), null)
})
