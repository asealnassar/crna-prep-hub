import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import * as consent from '../../consent/client.ts'
import { ACCEPT_ALL, REJECT_ALL } from '../../consent/policy.ts'
import {
  isTrackablePath, isTrackingEnabled, pendingCountForTests, resetForTests,
  trackPageView, trackSignup,
} from './client.ts'

/**
 * The browser half, driven without a browser.
 *
 * THE SCENARIO THAT FAILED IN PRODUCTION IS THE FIRST TEST. A US visitor
 * arrived at /?utm_source=tiktok&utm_medium=paid&utm_campaign=release_check
 * and moved to /schools. The page view fired before the banner had finished
 * asking the server which consent regime applied, saw "no consent yet",
 * dropped the event, and never retried — so the session began on /schools,
 * as Direct, with no campaign. The whole point of the Acquisition tab,
 * lost on the page that mattered.
 */

const SITE = 'https://www.crnaprephub.com'

type Sent = { body: any }
const sent: Sent[] = []
let cookieJar = ''
let status = 204

function at(path: string, search = '') {
  ;(globalThis as any).window.location = {
    pathname: path,
    href: `${SITE}${path}${search}`,
    protocol: 'https:',
  }
}

function installBrowser({
  path = '/',
  search = '',
  referrer = 'https://www.tiktok.com/',
  cookies = '',
  doNotTrack = null as string | null,
} = {}) {
  sent.length = 0
  cookieJar = cookies
  status = 204

  ;(globalThis as any).document = {
    get cookie() {
      return cookieJar
    },
    set cookie(value: string) {
      const [pair] = value.split(';')
      const [name] = pair.split('=')
      const expired = /Max-Age=0/.test(value)
      const without = cookieJar.split('; ').filter((e) => e.length > 0 && !e.startsWith(`${name}=`))
      cookieJar = expired ? without.join('; ') : [...without, pair].join('; ')
    },
    referrer,
  }
  ;(globalThis as any).window = {
    location: { pathname: path, href: `${SITE}${path}${search}`, protocol: 'https:' },
    dataLayer: [],
    ttq: { grantConsent() {}, revokeConsent() {} },
    __cphConsent: null,
    doNotTrack: doNotTrack ?? undefined,
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { doNotTrack: doNotTrack ?? undefined },
    configurable: true,
    writable: true,
  })
  ;(globalThis as any).fetch = async (_url: string, init: any) => {
    sent.push({ body: JSON.parse(init.body) })
    return { status }
  }

  resetForTests()
}

const settle = async () => {
  for (let turn = 0; turn < 8; turn++) await new Promise((r) => setTimeout(r, 0))
}

/** What the banner does once it learns which regime applies. */
const consentResolves = async (state: typeof ACCEPT_ALL) => {
  consent.applyConsent(state)
  await settle()
}

/** What the visitor does when they click a button on the banner. */
const visitorDecides = async (state: typeof ACCEPT_ALL) => {
  consent.saveConsent(state)
  await settle()
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_ANALYTICS_TRACKING = 'on'
  installBrowser()
})

const paths = () => sent.map((s) => new URL(s.body.url).pathname)

// ---------------------------------------------------------------------------
// The exact production failure
// ---------------------------------------------------------------------------

test('THE FAILURE: the landing page and its campaign survive consent resolving late', async () => {
  installBrowser({ path: '/', search: '?utm_source=tiktok&utm_medium=paid&utm_campaign=release_check' })

  // The page view fires before the banner knows the regime.
  trackPageView('/')
  await settle()
  assert.equal(sent.length, 0, 'nothing may be sent before consent is known')
  assert.equal(pendingCountForTests(), 1, 'but it is HELD, not dropped')

  // The visitor moves on before the answer arrives.
  at('/schools')
  trackPageView('/schools')
  await settle()
  assert.equal(pendingCountForTests(), 2)

  // US visitor: the banner resolves to opt-out and applies granted.
  await consentResolves(ACCEPT_ALL)

  assert.equal(sent.length, 2, 'both page views arrive')
  assert.deepEqual(paths(), ['/', '/schools'], 'in the order they happened')

  const landing = sent[0].body
  assert.match(landing.url, /utm_source=tiktok/, 'the campaign is still on the landing URL')
  assert.match(landing.url, /utm_campaign=release_check/)
  assert.equal(landing.referrer, 'https://www.tiktok.com/', 'and the referrer it arrived with')
  assert.equal(landing.startsSession, true, 'the landing page is what opens the session')
  assert.equal(sent[1].body.startsSession, false, 'the second page does not open a second one')
  assert.equal(sent[1].body.referrer, null, 'and does not re-assert the source')
})

test('the held events share one visitor and one session', async () => {
  installBrowser({ path: '/', search: '?utm_source=tiktok' })
  trackPageView('/')
  at('/schools')
  trackPageView('/schools')
  await settle()
  await consentResolves(ACCEPT_ALL)

  assert.equal(new Set(sent.map((s) => s.body.visitorId)).size, 1)
  assert.equal(new Set(sent.map((s) => s.body.sessionId)).size, 1)
  assert.equal(sent[0].body.isFirstVisit, true)
  assert.equal(sent[1].body.isFirstVisit, false)
})

test('NO COOKIE IS WRITTEN while consent is still unknown', async () => {
  // Writing a tracking cookie before permission is the exact thing consent
  // exists to prevent, so identity is minted only at send time.
  installBrowser({ path: '/' })
  trackPageView('/')
  await settle()

  assert.equal(cookieJar.includes('cph_vid'), false)
  assert.equal(cookieJar.includes('cph_sid'), false)

  await consentResolves(ACCEPT_ALL)
  assert.equal(cookieJar.includes('cph_vid'), true, 'and only then')
})

// ---------------------------------------------------------------------------
// The other shapes of visit
// ---------------------------------------------------------------------------

test('a single-page visitor is recorded once, on the page they landed on', async () => {
  installBrowser({ path: '/', search: '?utm_source=tiktok&utm_campaign=release_check' })
  trackPageView('/')
  await settle()
  await consentResolves(ACCEPT_ALL)

  assert.equal(sent.length, 1)
  assert.equal(new URL(sent[0].body.url).pathname, '/')
  assert.match(sent[0].body.url, /release_check/)
})

test('a returning visitor with a stored decision is recorded immediately', async () => {
  installBrowser({
    path: '/pricing',
    cookies: 'cph_consent=v1:1:1; cph_vid=fa637d03-58f6-4b6f-8206-571469cb3358',
  })

  trackPageView('/pricing')
  await settle()

  assert.equal(sent.length, 1, 'no waiting: the answer is already on the device')
  assert.equal(sent[0].body.isFirstVisit, false, 'and they are not a new visitor')
  assert.equal(sent[0].body.visitorId, 'fa637d03-58f6-4b6f-8206-571469cb3358')
})

test('an opt-in visitor who accepts gets their landing page recorded', async () => {
  installBrowser({ path: '/', search: '?utm_source=tiktok&utm_campaign=release_check' })
  trackPageView('/')
  await settle()

  // Europe: the banner applies "denied" and waits to be asked.
  await consentResolves(REJECT_ALL)
  assert.equal(sent.length, 0)

  await visitorDecides(ACCEPT_ALL)
  assert.equal(sent.length, 1, 'the page they arrived on is recorded when they agree')
  assert.equal(new URL(sent[0].body.url).pathname, '/')
})

test('an opt-in visitor who REJECTS has their held event discarded', async () => {
  installBrowser({ path: '/', search: '?utm_source=tiktok' })
  trackPageView('/')
  await settle()
  assert.equal(pendingCountForTests(), 1)

  await visitorDecides(REJECT_ALL)

  assert.equal(sent.length, 0, 'nothing is sent')
  assert.equal(pendingCountForTests(), 0, 'and nothing is kept for later')
})

test('a rejected visitor stays untracked on every subsequent page', async () => {
  installBrowser({ path: '/' })
  await visitorDecides(REJECT_ALL)

  trackPageView('/')
  at('/schools')
  trackPageView('/schools')
  at('/pricing')
  trackPageView('/pricing')
  await settle()

  assert.equal(sent.length, 0)
  assert.equal(pendingCountForTests(), 0)
})

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

test('withdrawing consent stops the very next page view', async () => {
  installBrowser({ path: '/', cookies: 'cph_consent=v1:1:1' })

  trackPageView('/')
  await settle()
  assert.equal(sent.length, 1)

  await visitorDecides(REJECT_ALL)

  at('/schools')
  trackPageView('/schools')
  await settle()
  assert.equal(sent.length, 1, 'no further events')
})

// ---------------------------------------------------------------------------
// Exactly once
// ---------------------------------------------------------------------------

test('consent resolving twice does not send the held event twice', async () => {
  installBrowser({ path: '/' })
  trackPageView('/')
  await settle()

  await consentResolves(ACCEPT_ALL)
  await consentResolves(ACCEPT_ALL)

  assert.equal(sent.length, 1)
})

test('a re-render while waiting does not queue the same page twice', async () => {
  installBrowser({ path: '/' })
  trackPageView('/')
  trackPageView('/')
  trackPageView('/')
  await settle()

  assert.equal(pendingCountForTests(), 1)
  await consentResolves(ACCEPT_ALL)
  assert.equal(sent.length, 1)
})

test('every event carries its own id, so a retry cannot double-count', async () => {
  installBrowser({ path: '/' })
  trackPageView('/')
  at('/schools')
  trackPageView('/schools')
  await settle()
  await consentResolves(ACCEPT_ALL)

  const ids = sent.map((s) => s.body.eventId)
  assert.equal(new Set(ids).size, 2)
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/)
})

test('a visitor who never answers cannot grow the queue without limit', async () => {
  installBrowser({ path: '/' })
  for (let index = 0; index < 200; index++) {
    at(`/page-${index}`)
    trackPageView(`/page-${index}`)
  }
  await settle()

  assert.ok(pendingCountForTests() <= 20, `queue capped, saw ${pendingCountForTests()}`)
})

// ---------------------------------------------------------------------------
// The gates that were already there
// ---------------------------------------------------------------------------

test('tracking is OFF unless it has been explicitly switched on', async () => {
  delete process.env.NEXT_PUBLIC_ANALYTICS_TRACKING
  installBrowser({ path: '/', cookies: 'cph_consent=v1:1:1' })

  assert.equal(isTrackingEnabled(), false)
  trackPageView('/')
  await settle()
  assert.equal(sent.length, 0)
  assert.equal(pendingCountForTests(), 0, 'and nothing is even held')
})

test('the admin section and the API are never tracked', () => {
  assert.equal(isTrackablePath('/admin'), false)
  assert.equal(isTrackablePath('/admin/analytics'), false)
  assert.equal(isTrackablePath('/api/track'), false)
  assert.equal(isTrackablePath('/authprobe'), false)
  assert.equal(isTrackablePath('/'), true)
  assert.equal(isTrackablePath('/administrator-guide'), true)
})

test('Do Not Track is honoured, with nothing held for later', async () => {
  installBrowser({ path: '/', cookies: 'cph_consent=v1:1:1', doNotTrack: '1' })
  trackPageView('/')
  await settle()

  assert.equal(sent.length, 0)
  assert.equal(pendingCountForTests(), 0)
})

test('a 429 stops the tracker asking again', async () => {
  installBrowser({ path: '/', cookies: 'cph_consent=v1:1:1' })
  status = 429

  trackPageView('/')
  await settle()
  assert.equal(sent.length, 1)

  status = 204
  at('/schools')
  trackPageView('/schools')
  await settle()
  assert.equal(sent.length, 1, 'it stays quiet for the rest of the page')
})

test('a failed request is swallowed rather than surfacing to the visitor', async () => {
  installBrowser({ path: '/', cookies: 'cph_consent=v1:1:1' })
  ;(globalThis as any).fetch = async () => {
    throw new Error('blocked by an extension')
  }

  await assert.doesNotReject(async () => {
    trackPageView('/')
    await settle()
  })
})

test('a signup names the account, and only a signup does', async () => {
  installBrowser({ path: '/signup', cookies: 'cph_consent=v1:1:1' })

  trackPageView('/signup')
  await settle()
  trackSignup('11111111-2222-4333-8444-555555555555')
  await settle()

  const pageView = sent.find((s) => s.body.kind === 'page_view')
  const signup = sent.find((s) => s.body.kind === 'signup')
  assert.equal(pageView?.body.userId, undefined)
  assert.equal(signup?.body.userId, '11111111-2222-4333-8444-555555555555')
  assert.equal(signup?.body.visitorId, pageView?.body.visitorId)
})

test('a signup that happens while consent is unknown is held, not lost', async () => {
  installBrowser({ path: '/signup' })

  trackPageView('/signup')
  trackSignup('11111111-2222-4333-8444-555555555555')
  await settle()
  assert.equal(pendingCountForTests(), 2)

  await consentResolves(ACCEPT_ALL)
  assert.equal(sent.filter((s) => s.body.kind === 'signup').length, 1)
})

test('what the tracker stores is two opaque ids and nothing else', async () => {
  installBrowser({ path: '/', cookies: 'cph_consent=v1:1:1' })
  trackPageView('/')
  await settle()

  const names = cookieJar.split('; ').map((e) => e.split('=')[0]).sort()
  assert.deepEqual(names, ['cph_consent', 'cph_sid', 'cph_vid'])
  for (const entry of cookieJar.split('; ')) {
    const [name, value] = entry.split('=')
    if (name === 'cph_consent') continue
    assert.match(value, /^[0-9a-f-]{36}$/, 'a random id, carrying no information')
  }
})
