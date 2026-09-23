import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCEPT_ALL, REJECT_ALL, defaultState, effective, googleConsentSignals,
  needsDecision, parse, regimeFor, serialize,
} from './policy.ts'

/**
 * The consent rules, which decide what is allowed to run before somebody has
 * answered. Getting these wrong in one direction loses a measurement; in the
 * other it is the thing the law is about.
 */

// --- who gets asked rather than told ----------------------------------------

test('the EEA, the UK and Switzerland require being asked first', () => {
  for (const country of ['DE', 'FR', 'IE', 'IT', 'ES', 'NL', 'PL', 'GB', 'CH', 'NO', 'IS', 'LI']) {
    assert.equal(regimeFor(country), 'opt_in', country)
  }
})

test('the United States and elsewhere are told, with a way to opt out', () => {
  for (const country of ['US', 'CA', 'MX', 'AU', 'JP', 'BR', 'IN', 'PH', 'NG']) {
    assert.equal(regimeFor(country), 'opt_out', country)
  }
})

test('an unknown location is treated as though it were Berlin', () => {
  // Guessing wrong this way costs a measurement. Guessing wrong the other way
  // is the breach, so the default leans here.
  assert.equal(regimeFor(null), 'opt_in')
  assert.equal(regimeFor(undefined), 'opt_in')
  assert.equal(regimeFor(''), 'opt_in')
  assert.equal(regimeFor('XX'), 'opt_out', 'a real but unlisted code is still a real answer')
  assert.equal(regimeFor('NONSENSE'), 'opt_in', 'a malformed code is not an answer')
})

test('country codes are matched whatever case they arrive in', () => {
  assert.equal(regimeFor('de'), 'opt_in')
  assert.equal(regimeFor(' Gb '), 'opt_in')
  assert.equal(regimeFor('us'), 'opt_out')
})

// --- what runs before anyone has answered -----------------------------------

test('NOTHING non-essential runs for a visitor who must be asked first', () => {
  const state = defaultState('opt_in')

  assert.equal(state.advertising, 'denied')
  assert.equal(state.analytics, 'denied')
})

test('advertising keeps running where the law allows it, so campaigns are unaffected', () => {
  const state = defaultState('opt_out')

  assert.equal(state.advertising, 'granted')
  assert.equal(state.analytics, 'granted')
})

test('everyone with no stored answer is shown something', () => {
  assert.equal(needsDecision(null), true)
  assert.equal(needsDecision(ACCEPT_ALL), false)
  assert.equal(needsDecision(REJECT_ALL), false)
})

test('a stored answer overrides the regional default in both directions', () => {
  // A German visitor who accepted.
  assert.equal(effective(ACCEPT_ALL, 'opt_in').advertising, 'granted')
  // An American visitor who opted out. This is the one that must work.
  assert.equal(effective(REJECT_ALL, 'opt_out').advertising, 'denied')
  assert.equal(effective(REJECT_ALL, 'opt_out').analytics, 'denied')
})

// --- the stored form --------------------------------------------------------

test('a decision survives a round trip through the cookie', () => {
  for (const state of [ACCEPT_ALL, REJECT_ALL, { version: 1, analytics: 'granted', advertising: 'denied' } as const]) {
    assert.deepEqual(parse(serialize(state)), state)
  }
})

test('the stored form stays tiny and positional, because the head script parses it', () => {
  assert.equal(serialize(ACCEPT_ALL), 'v1:1:1')
  assert.equal(serialize(REJECT_ALL), 'v1:0:0')
})

test('anything unparseable reads as "not asked yet" rather than as consent', () => {
  for (const value of [null, undefined, '', 'yes', 'true', 'v1', 'v1:1', 'v1:2:1', '{"analytics":true}', 'v1:1:1:1']) {
    assert.equal(parse(value), null, String(value))
  }
})

test('a decision made against an older version of the question is not reused', () => {
  assert.equal(parse('v0:1:1'), null)
  assert.equal(parse('v2:1:1'), null)
})

// --- what Google is told ----------------------------------------------------

test('Consent Mode v2 gets all four signals, so the tag behaves rather than breaking', () => {
  const granted = googleConsentSignals(ACCEPT_ALL)

  assert.deepEqual(granted, {
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
    analytics_storage: 'granted',
  })
})

test('analytics and advertising are separate choices, and Google is told so', () => {
  const signals = googleConsentSignals({ version: 1, analytics: 'granted', advertising: 'denied' })

  assert.equal(signals.analytics_storage, 'granted')
  assert.equal(signals.ad_storage, 'denied')
  assert.equal(signals.ad_user_data, 'denied')
  assert.equal(signals.ad_personalization, 'denied')
})
