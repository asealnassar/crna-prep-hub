import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The browser half, driven without a browser.
 *
 * The globals a page provides are stubbed here rather than mocked away, so the
 * cookie handling, the 30-minute session and the duplicate guard are all
 * exercised as written.
 */

type Sent = { url: string; body: any }

const sent: Sent[] = []
let cookieJar = ''
let status = 204

function installBrowser(pathname = '/pricing', doNotTrack: string | null = null) {
  sent.length = 0
  cookieJar = ''
  status = 204

  const document = {
    get cookie() {
      return cookieJar
    },
    set cookie(value: string) {
      const [pair] = value.split(';')
      const [name] = pair.split('=')
      const without = cookieJar
        .split('; ')
        .filter((entry) => entry.length > 0 && !entry.startsWith(`${name}=`))
      // Max-Age=0 would be a delete; nothing here does that.
      cookieJar = [...without, pair].join('; ')
    },
    referrer: 'https://www.tiktok.com/',
  }

  ;(globalThis as any).document = document
  ;(globalThis as any).window = {
    location: { pathname, href: `https://www.crnaprephub.com${pathname}`, protocol: 'https:' },
    doNotTrack: doNotTrack ?? undefined,
  }
  // Node ships its own read-only `navigator`, so this one has to be defined
  // over the top of it rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    value: { doNotTrack: doNotTrack ?? undefined },
    configurable: true,
    writable: true,
  })
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return { status }
  }
}

const load = async () => {
  // A fresh module each time, because the duplicate guard is module state.
  const module = await import(`./client.ts?case=${Math.random()}`)
  return module as typeof import('./client.ts')
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_ANALYTICS_TRACKING = 'on'
  installBrowser()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// --- the switch -------------------------------------------------------------

test('tracking is OFF unless it has been explicitly switched on', async () => {
  delete process.env.NEXT_PUBLIC_ANALYTICS_TRACKING
  const client = await load()
  assert.equal(client.isTrackingEnabled(), false)

  client.trackPageView('/pricing')
  await settle()
  assert.equal(sent.length, 0, 'nothing is sent while the switch is off')

  process.env.NEXT_PUBLIC_ANALYTICS_TRACKING = 'true'
  assert.equal(client.isTrackingEnabled(), false, "only the exact value 'on' enables it")
})

test('the admin section and the API are never tracked', async () => {
  const client = await load()

  assert.equal(client.isTrackablePath('/admin'), false)
  assert.equal(client.isTrackablePath('/admin/analytics'), false)
  assert.equal(client.isTrackablePath('/api/track'), false)
  assert.equal(client.isTrackablePath('/authprobe'), false)
  assert.equal(client.isTrackablePath('/pricing'), true)
  assert.equal(client.isTrackablePath('/'), true)
  assert.equal(client.isTrackablePath('/administrator-guide'), true, 'a path merely starting with "admin" is fine')
})

test('a visitor on an excluded path sends nothing even if asked directly', async () => {
  installBrowser('/admin/analytics')
  const client = await load()

  client.trackPageView('/admin/analytics')
  await settle()
  assert.equal(sent.length, 0)
})

test('Do Not Track is honoured', async () => {
  installBrowser('/pricing', '1')
  const client = await load()

  client.trackPageView('/pricing')
  await settle()
  assert.equal(sent.length, 0)
})

// --- duplicate prevention ---------------------------------------------------

test('the same path twice in a row is recorded once', async () => {
  const client = await load()

  client.trackPageView('/pricing')
  client.trackPageView('/pricing')
  client.trackPageView('/pricing')
  await settle()

  assert.equal(sent.length, 1, 'a re-render or a Strict Mode double effect must not double-count')
})

test('a real navigation is recorded, including a return to an earlier page', async () => {
  const client = await load()

  client.trackPageView('/')
  client.trackPageView('/pricing')
  client.trackPageView('/')
  await settle()

  assert.equal(sent.length, 3)
  assert.deepEqual(sent.map((item) => item.body.kind), ['page_view', 'page_view', 'page_view'])
})

test('every event carries its own id, so the server can deduplicate retries', async () => {
  const client = await load()

  client.trackPageView('/')
  client.trackPageView('/pricing')
  await settle()

  const ids = sent.map((item) => item.body.eventId)
  assert.equal(new Set(ids).size, 2)
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/)
})

// --- identity ---------------------------------------------------------------

test('the first visit mints a visitor and a session; the next page reuses both', async () => {
  const client = await load()

  client.trackPageView('/')
  await settle()
  client.trackPageView('/pricing')
  await settle()

  const [first, second] = sent
  assert.equal(first.body.isFirstVisit, true)
  assert.equal(first.body.startsSession, true)
  assert.equal(second.body.isFirstVisit, false, 'the visitor is not new on the second page')
  assert.equal(second.body.startsSession, false)
  assert.equal(first.body.visitorId, second.body.visitorId)
  assert.equal(first.body.sessionId, second.body.sessionId)
})

test('the referrer is sent once, on the event that opens the visit', async () => {
  const client = await load()

  client.trackPageView('/')
  await settle()
  client.trackPageView('/pricing')
  await settle()

  assert.equal(sent[0].body.referrer, 'https://www.tiktok.com/', 'the arrival carries where it came from')
  assert.equal(sent[1].body.referrer, null, 'an in-app navigation must not re-assert the source')
})

test('what is stored on the device is two opaque ids and nothing else', async () => {
  const client = await load()

  client.trackPageView('/')
  await settle()

  const names = cookieJar.split('; ').map((entry) => entry.split('=')[0]).sort()
  assert.deepEqual(names, ['cph_sid', 'cph_vid'])
  for (const entry of cookieJar.split('; ')) {
    assert.match(entry.split('=')[1], /^[0-9a-f-]{36}$/, 'a random id, carrying no information')
  }
})

// --- back pressure ----------------------------------------------------------

test('a 429 stops the tracker asking again', async () => {
  const client = await load()
  status = 429

  client.trackPageView('/')
  await settle()
  assert.equal(sent.length, 1)

  status = 204
  client.trackPageView('/pricing')
  client.trackPageView('/schools')
  await settle()
  assert.equal(sent.length, 1, 'it stays quiet for the rest of the page')
})

test('a failed request is swallowed rather than surfacing to the visitor', async () => {
  const client = await load()
  ;(globalThis as any).fetch = async () => {
    throw new Error('blocked by an extension')
  }

  await assert.doesNotReject(async () => {
    client.trackPageView('/')
    await settle()
  })
})

// --- the signup link --------------------------------------------------------

test('a signup names the account, and only a signup does', async () => {
  const client = await load()

  client.trackPageView('/signup')
  await settle()
  client.trackSignup('11111111-2222-4333-8444-555555555555')
  await settle()

  const pageView = sent.find((item) => item.body.kind === 'page_view')
  const signup = sent.find((item) => item.body.kind === 'signup')
  assert.equal(pageView?.body.userId, undefined, 'a page view never claims an account')
  assert.equal(signup?.body.userId, '11111111-2222-4333-8444-555555555555')
  assert.equal(signup?.body.visitorId, pageView?.body.visitorId, 'the same browser, now named')
})
