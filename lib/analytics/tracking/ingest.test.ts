import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RateLimiter, browserOf, deviceOf, isBot, validateEvent } from './ingest.ts'

/**
 * The gate in front of the one table an anonymous visitor can cause a write to.
 *
 * Every test here is a request somebody could actually send.
 */

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const uuid = (seed: string) => `${seed.padEnd(8, '0').slice(0, 8)}-1111-4222-8333-444444444444`

const good = (over: Record<string, unknown> = {}) => ({
  eventId: uuid('aaaaaaaa'),
  visitorId: uuid('bbbbbbbb'),
  sessionId: uuid('cccccccc'),
  kind: 'page_view',
  url: 'https://www.crnaprephub.com/pricing?utm_source=tiktok',
  referrer: 'https://www.tiktok.com/',
  ...over,
})

const validate = (body: unknown, userAgent: string | null = CHROME) =>
  validateEvent({ body, userAgent })

// --- bots -------------------------------------------------------------------

test('a browser is not a bot', () => {
  assert.equal(isBot(CHROME), false)
  assert.equal(isBot(IPHONE), false)
})

test('crawlers, headless browsers and scripts are all refused', () => {
  for (const agent of [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36',
    'python-requests/2.31.0',
    'curl/8.4.0',
    'facebookexternalhit/1.1',
    'Mozilla/5.0 ... AhrefsBot/7.0',
    'node-fetch/1.0',
  ]) {
    assert.equal(isBot(agent), true, agent)
  }
})

test('no User-Agent at all is treated as automated, because every browser sends one', () => {
  assert.equal(isBot(null), true)
  assert.equal(isBot(''), true)
  assert.equal(isBot('   '), true)
})

test('a bot is refused before anything else is even parsed', () => {
  const result = validate({ nonsense: true }, 'Googlebot/2.1')

  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.status, 403)
})

// --- device and browser -----------------------------------------------------

test('device and browser are coarse labels, never a fingerprint', () => {
  assert.equal(deviceOf(IPHONE), 'mobile')
  assert.equal(deviceOf(CHROME), 'desktop')
  assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1'), 'tablet')

  assert.equal(browserOf(CHROME), 'Chrome')
  assert.equal(browserOf(IPHONE), 'Safari')
  assert.equal(browserOf('Mozilla/5.0 Firefox/130.0'), 'Firefox')
  // No version number survives.
  assert.doesNotMatch(browserOf(CHROME), /\d/)
})

// --- the payload ------------------------------------------------------------

test('a well-formed page view is accepted and classified', () => {
  const result = validate(good())

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.event.kind, 'page_view')
    assert.equal(result.event.touch.channel, 'tiktok')
    assert.equal(result.event.touch.landingPath, '/pricing')
    assert.equal(result.event.userId, null)
  }
})

test('ids must be UUIDs: a caller does not get to choose the shape of a key', () => {
  for (const field of ['eventId', 'visitorId', 'sessionId']) {
    const result = validate(good({ [field]: 'not-a-uuid' }))
    assert.equal(result.ok, false, field)
    assert.equal(!result.ok && result.status, 400)
  }
})

test('an unknown event kind is refused rather than reaching the CHECK constraint', () => {
  const result = validate(good({ kind: 'purchase' }))

  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.reason : '', /unknown event kind/)
})

test('a URL on somebody else’s site is refused', () => {
  const result = validate(good({ url: 'https://evil.example.com/page' }))

  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.status, 403)
})

test('a non-http URL is refused', () => {
  assert.equal(validate(good({ url: 'javascript:alert(1)' })).ok, false)
  assert.equal(validate(good({ url: 'file:///etc/passwd' })).ok, false)
})

test('a body that is not an object is refused rather than crashing', () => {
  for (const body of [null, 'a string', 42, [], undefined]) {
    assert.equal(validate(body).ok, false)
  }
})

// --- the account link, which is the only personal thing this endpoint takes --

test('a signup carries the account it created', () => {
  const result = validate(good({ kind: 'signup', userId: uuid('dddddddd') }))

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.event.userId, uuid('dddddddd'))
})

test('a signup with no account id is refused, because the link is the point', () => {
  const result = validate(good({ kind: 'signup' }))

  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.reason : '', /must name the account/)
})

test('a PAGE VIEW may not claim an account, or anyone could attach any visitor to any user', () => {
  const result = validate(good({ kind: 'page_view', userId: uuid('eeeeeeee') }))

  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.reason : '', /only a signup/)
})

// --- what never reaches the database ----------------------------------------

test('nothing from the query string survives validation except the UTMs', () => {
  const result = validate(
    good({ url: 'https://www.crnaprephub.com/reset-password?token=SECRET&email=someone%40example.com' })
  )

  assert.equal(result.ok, true)
  const written = JSON.stringify(result.ok ? result.event : {})
  assert.doesNotMatch(written, /SECRET/)
  assert.doesNotMatch(written, /example\.com/)
  assert.match(written, /\/reset-password/)
})

test('the referrer is reduced to a host before it can be stored', () => {
  const result = validate(good({ referrer: 'https://mail.google.com/mail/u/0/#inbox/FMfcgzabcd' }))

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.event.touch.referrerHost, 'mail.google.com')
  assert.doesNotMatch(JSON.stringify(result.ok ? result.event : {}), /FMfcgzabcd/)
})

// --- rate limiting ----------------------------------------------------------

test('a burst is allowed up to the capacity, then refused', () => {
  const limiter = new RateLimiter(5, 1)
  const key = 'visitor-1'

  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(limiter.allow(key, 1000), true, `attempt ${attempt}`)
  }
  assert.equal(limiter.allow(key, 1000), false, 'the sixth in the same instant is refused')
})

test('the bucket refills over time, so a normal visitor is never locked out', () => {
  const limiter = new RateLimiter(5, 1)
  const key = 'visitor-2'
  for (let attempt = 0; attempt < 5; attempt++) limiter.allow(key, 1000)

  assert.equal(limiter.allow(key, 1000), false)
  assert.equal(limiter.allow(key, 3000), true, 'two seconds later there are two tokens')
})

test('one visitor flooding does not spend another visitor’s allowance', () => {
  const limiter = new RateLimiter(3, 1)
  for (let attempt = 0; attempt < 4; attempt++) limiter.allow('noisy', 1000)

  assert.equal(limiter.allow('noisy', 1000), false)
  assert.equal(limiter.allow('quiet', 1000), true)
})

test('the bucket map cannot grow without limit', () => {
  const limiter = new RateLimiter(10, 1, 50)
  for (let index = 0; index < 500; index++) limiter.allow(`visitor-${index}`, 1000 + index)

  assert.ok(limiter.size <= 50, `expected the map to stay capped, saw ${limiter.size}`)
})
