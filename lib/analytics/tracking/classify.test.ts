import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyTouch, hostOf, isOwnHost, type Channel } from './classify.ts'

/**
 * The attribution table.
 *
 * Every row is a real arrival: a URL and whatever the browser said the
 * referrer was. If this table is right, the source breakdown is right, because
 * nothing else in the pipeline decides where a visit came from.
 */

const SITE = 'https://www.crnaprephub.com'

type Case = {
  readonly name: string
  readonly url: string
  readonly referrer?: string
  readonly channel: Channel
  readonly source?: string
  readonly medium?: string | null
  readonly campaign?: string | null
}

const CASES: readonly Case[] = [
  // --- nothing at all ------------------------------------------------------
  { name: 'a bare visit is Direct, not "unknown campaign"', url: `${SITE}/`, channel: 'direct', source: 'direct', medium: null },
  { name: 'an empty referrer string is still Direct', url: `${SITE}/pricing`, referrer: '', channel: 'direct' },

  // --- our own site is not a source ---------------------------------------
  { name: 'an in-app navigation does not credit us for our own traffic', url: `${SITE}/schools`, referrer: `${SITE}/`, channel: 'direct', source: 'direct' },
  { name: 'the apex referring the www host is still internal', url: `${SITE}/schools`, referrer: 'https://crnaprephub.com/blog', channel: 'direct' },

  // --- referrers -----------------------------------------------------------
  { name: 'TikTok by referrer', url: `${SITE}/`, referrer: 'https://www.tiktok.com/@someone', channel: 'tiktok', source: 'www.tiktok.com', medium: 'referral' },
  { name: 'Instagram by referrer', url: `${SITE}/`, referrer: 'https://l.instagram.com/', channel: 'instagram' },
  { name: 'Google with no click id is organic, not Ads', url: `${SITE}/schools`, referrer: 'https://www.google.com/', channel: 'google_organic', medium: 'organic' },
  { name: 'a non-Google search engine is Other search', url: `${SITE}/`, referrer: 'https://duckduckgo.com/', channel: 'other_search', medium: 'organic' },
  { name: 'an unknown site is a referral, never guessed into a channel', url: `${SITE}/`, referrer: 'https://allnurses.com/thread/123', channel: 'referral', source: 'allnurses.com' },

  // --- ad click ids, even with no UTM -------------------------------------
  { name: 'ttclid proves a TikTok ad click', url: `${SITE}/?ttclid=ABC123`, channel: 'tiktok', source: 'tiktok', medium: 'cpc' },
  { name: 'gclid proves a Google ad click', url: `${SITE}/pricing?gclid=XYZ`, channel: 'google_ads', source: 'google', medium: 'cpc' },
  { name: 'wbraid counts as Google Ads too', url: `${SITE}/?wbraid=abc`, channel: 'google_ads' },
  { name: 'a gclid beats a Google organic referrer', url: `${SITE}/?gclid=XYZ`, referrer: 'https://www.google.com/', channel: 'google_ads' },

  // --- UTMs win outright ---------------------------------------------------
  { name: 'utm_source names the channel', url: `${SITE}/?utm_source=tiktok&utm_medium=paid&utm_campaign=sept_launch`, channel: 'tiktok', source: 'tiktok', campaign: 'sept_launch' },
  { name: 'utm_source=google with a paid medium is Google Ads', url: `${SITE}/?utm_source=google&utm_medium=cpc`, channel: 'google_ads' },
  { name: 'utm_source=google with no paid medium stays organic', url: `${SITE}/?utm_source=google&utm_medium=organic`, channel: 'google_organic' },
  { name: 'a UTM overrides the referrer it arrived with', url: `${SITE}/?utm_source=newsletter&utm_medium=email`, referrer: 'https://www.tiktok.com/', channel: 'email', source: 'newsletter' },
  { name: 'ig is Instagram', url: `${SITE}/?utm_source=IG&utm_medium=bio`, channel: 'instagram', source: 'ig' },
  { name: 'an unrecognised utm_source is a referral, not invented', url: `${SITE}/?utm_source=some_partner`, channel: 'referral', source: 'some_partner' },
]

for (const item of CASES) {
  test(`classify: ${item.name}`, () => {
    const touch = classifyTouch({ url: item.url, referrer: item.referrer })
    assert.equal(touch.channel, item.channel, `channel for ${item.url}`)
    if (item.source !== undefined) assert.equal(touch.source, item.source)
    if (item.medium !== undefined) assert.equal(touch.medium, item.medium)
    if (item.campaign !== undefined) assert.equal(touch.campaign, item.campaign)
  })
}

// --- what must never be recorded --------------------------------------------

test('the landing path never carries the query string', () => {
  const touch = classifyTouch({
    url: `${SITE}/reset-password?token=secret-token-value&email=someone%40example.com`,
  })

  assert.equal(touch.landingPath, '/reset-password')
  assert.doesNotMatch(JSON.stringify(touch), /secret-token-value/)
  assert.doesNotMatch(JSON.stringify(touch), /example\.com/)
})

test('a referrer is reduced to a host, so a referring URL path is never stored', () => {
  const touch = classifyTouch({ url: `${SITE}/`, referrer: 'https://allnurses.com/very/specific/thread?user=jane' })

  assert.equal(touch.referrerHost, 'allnurses.com')
  assert.doesNotMatch(JSON.stringify(touch), /jane/)
  assert.doesNotMatch(JSON.stringify(touch), /specific/)
})

test('UTM values are capped, so a hostile link cannot write a novel into a column', () => {
  const touch = classifyTouch({ url: `${SITE}/?utm_campaign=${'x'.repeat(5000)}` })

  assert.ok((touch.campaign ?? '').length <= 120)
})

// --- the odd cases that would otherwise drop a visit ------------------------

test('an unparseable URL still counts as a visit rather than vanishing', () => {
  const touch = classifyTouch({ url: 'not a url at all' })

  assert.equal(touch.channel, 'direct')
  assert.equal(touch.landingPath, '/')
})

test('an unparseable referrer is simply no referrer', () => {
  const touch = classifyTouch({ url: `${SITE}/`, referrer: 'android-app://com.something' })

  assert.equal(touch.referrerHost, null)
  assert.equal(touch.channel, 'direct')
})

test('host helpers agree about what counts as our own site', () => {
  assert.equal(hostOf('https://www.tiktok.com/x'), 'www.tiktok.com')
  assert.equal(hostOf(''), null)
  assert.equal(isOwnHost('crnaprephub.com'), true)
  assert.equal(isOwnHost('www.crnaprephub.com'), true)
  assert.equal(isOwnHost('crnaprephub.com.evil.net'), false)
})
