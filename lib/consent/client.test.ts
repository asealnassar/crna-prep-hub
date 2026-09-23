import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * What each platform is actually told when somebody decides.
 *
 * This is the half of consent that cannot be checked by looking at the page:
 * the browser pane records no third-party requests, so whether TikTok is told
 * has to be proved against a stand-in for its pixel. The stand-in behaves the
 * way ttq does — a queue with methods hung off it.
 */

let cookieJar = ''
let ttqCalls: string[] = []
let dataLayer: any[] = []

function installBrowser(consent = '') {
  cookieJar = consent ? `cph_consent=${consent}` : ''
  ttqCalls = []
  dataLayer = []

  ;(globalThis as any).document = {
    get cookie() {
      return cookieJar
    },
    set cookie(value: string) {
      const [pair] = value.split(';')
      const [name] = pair.split('=')
      const without = cookieJar.split('; ').filter((e) => e.length > 0 && !e.startsWith(`${name}=`))
      cookieJar = [...without, pair].join('; ')
    },
  }
  ;(globalThis as any).window = {
    location: { protocol: 'https:' },
    dataLayer,
    ttq: {
      grantConsent: () => ttqCalls.push('grantConsent'),
      revokeConsent: () => ttqCalls.push('revokeConsent'),
    },
  }
}

const load = async () => (await import(`./client.ts?case=${Math.random()}`)) as typeof import('./client.ts')

beforeEach(() => installBrowser())

const lastConsentUpdate = () => {
  const entries = ((globalThis as any).window.dataLayer as any[]).filter(
    (entry) => Array.isArray(entry) && entry[0] === 'consent' && entry[1] === 'update'
  )
  return entries.length > 0 ? entries[entries.length - 1][2] : null
}

// --- TikTok -----------------------------------------------------------------

test('accepting advertising tells TikTok to release what it held', async () => {
  const client = await load()

  client.applyConsent(client.ACCEPT_ALL)

  assert.deepEqual(ttqCalls, ['grantConsent'])
})

test('rejecting advertising tells TikTok to revoke, not merely stay silent', async () => {
  const client = await load()

  client.applyConsent(client.REJECT_ALL)

  assert.deepEqual(ttqCalls, ['revokeConsent'])
})

test('consenting to measurement but NOT to advertising still revokes TikTok', async () => {
  const client = await load()

  client.applyConsent({ version: 1, analytics: 'granted', advertising: 'denied' })

  assert.deepEqual(ttqCalls, ['revokeConsent'])
})

test('TikTok is told exactly once per decision, so no conversion is duplicated', async () => {
  const client = await load()

  client.applyConsent(client.ACCEPT_ALL)

  assert.equal(ttqCalls.filter((call) => call === 'grantConsent').length, 1)
})

test('a page where the pixel never loaded does not throw', async () => {
  const client = await load()
  ;(globalThis as any).window.ttq = undefined

  assert.doesNotThrow(() => client.applyConsent(client.ACCEPT_ALL))
})

// --- Google -----------------------------------------------------------------

test('Google receives all four Consent Mode v2 signals', async () => {
  const client = await load()

  client.applyConsent(client.ACCEPT_ALL)

  assert.deepEqual(lastConsentUpdate(), {
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
    analytics_storage: 'granted',
  })
})

test('rejecting denies all four rather than removing the tag', async () => {
  const client = await load()

  client.applyConsent(client.REJECT_ALL)

  assert.deepEqual(lastConsentUpdate(), {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  })
})

// --- what is written --------------------------------------------------------

test('saving a decision writes the cookie AND tells both platforms', async () => {
  const client = await load()

  client.saveConsent(client.ACCEPT_ALL)

  assert.match(cookieJar, /cph_consent=v1%3A1%3A1|cph_consent=v1:1:1/)
  assert.deepEqual(ttqCalls, ['grantConsent'])
  assert.equal(lastConsentUpdate()?.ad_storage, 'granted')
})

test('the consent cookie is SameSite=Lax and Secure over https', async () => {
  const client = await load()
  let written = ''
  Object.defineProperty((globalThis as any).document, 'cookie', {
    set: (value: string) => { written = value },
    get: () => cookieJar,
    configurable: true,
  })

  client.saveConsent(client.REJECT_ALL)

  assert.match(written, /SameSite=Lax/)
  assert.match(written, /Secure/)
  assert.match(written, /Path=\//)
})

// --- the gates the rest of the app asks about -------------------------------

test('with no decision stored, nothing is allowed', async () => {
  const client = await load()

  assert.equal(client.analyticsAllowed(), false)
  assert.equal(client.advertisingAllowed(), false)
})

test('the two permissions are independent', async () => {
  installBrowser('v1:1:0')
  const client = await load()

  assert.equal(client.analyticsAllowed(), true)
  assert.equal(client.advertisingAllowed(), false)
})

test('a tampered or truncated cookie is read as no consent', async () => {
  for (const value of ['v1:1', 'yes', 'v9:1:1', 'v1:2:2']) {
    installBrowser(value)
    const client = await load()
    assert.equal(client.analyticsAllowed(), false, value)
    assert.equal(client.advertisingAllowed(), false, value)
  }
})
