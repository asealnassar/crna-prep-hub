'use client'

/**
 * The browser half of tracking: who this visitor is, which visit this is, and
 * sending one event without ever sending it twice.
 *
 * WHAT IS STORED ON THE DEVICE. Two first-party cookies and nothing else:
 *
 *   cph_vid   a random UUID, 180 days. It identifies a BROWSER, not a person.
 *             It is not derived from anything about the visitor, carries no
 *             information, and is useless to anyone who obtains it.
 *   cph_sid   a random UUID with a 30-minute sliding expiry. When it lapses,
 *             the next page view starts a new visit. That is the whole
 *             definition of a session: 30 minutes of inactivity ends it.
 *
 * No fingerprinting, no localStorage, no third-party anything, no cross-site
 * identifier, and nothing that survives the visitor clearing their cookies.
 *
 * OFF UNTIL SWITCHED ON. `isTrackingEnabled()` is false unless
 * NEXT_PUBLIC_ANALYTICS_TRACKING is exactly 'on'. Shipping the code and
 * enabling the collection are two separate decisions.
 */

import { analyticsStatus, onConsentChange } from '@/lib/consent/client'

const VISITOR_COOKIE = 'cph_vid'
const SESSION_COOKIE = 'cph_sid'
const VISITOR_DAYS = 180
const SESSION_MINUTES = 30

/** Paths that are never tracked. The admin's own use is not audience data. */
const EXCLUDED = [/^\/admin(\/|$)/, /^\/api(\/|$)/, /^\/authprobe(\/|$)/]

export function isTrackingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ANALYTICS_TRACKING === 'on'
}

export function isTrackablePath(path: string): boolean {
  return !EXCLUDED.some((pattern) => pattern.test(path))
}

/**
 * Do Not Track is honoured even though it is not legally binding anywhere we
 * operate. A visitor who has gone out of their way to ask not to be counted
 * has said something unambiguous.
 */
function refusesTracking(): boolean {
  if (typeof navigator === 'undefined') return true
  const dnt =
    (navigator as unknown as { doNotTrack?: string }).doNotTrack ??
    (window as unknown as { doNotTrack?: string }).doNotTrack
  return dnt === '1' || dnt === 'yes'
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  if (typeof document === 'undefined') return
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Older Safari. Still a v4-shaped random id, just assembled by hand.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

type Identity = { visitorId: string; sessionId: string; isFirstVisit: boolean; startsSession: boolean }

function identify(): Identity {
  const existingVisitor = readCookie(VISITOR_COOKIE)
  const visitorId = existingVisitor ?? newId()
  writeCookie(VISITOR_COOKIE, visitorId, VISITOR_DAYS * 24 * 60 * 60)

  const existingSession = readCookie(SESSION_COOKIE)
  const sessionId = existingSession ?? newId()
  // Written on every event, which is what makes the 30 minutes slide.
  writeCookie(SESSION_COOKIE, sessionId, SESSION_MINUTES * 60)

  return {
    visitorId,
    sessionId,
    isFirstVisit: existingVisitor === null,
    startsSession: existingSession === null,
  }
}

/** Set once the server answers 429, so a flood stops asking. */
let silenced = false

/** The last page path handed to trackPageView, so a re-render cannot repeat it. */
let lastPath: string | null = null

/** The last path actually sent. Differs from lastPath only if consent blocked it. */
let transmittedPath: string | null = null

type SendOptions = { readonly kind: 'page_view' | 'signup'; readonly userId?: string }

/**
 * An event that happened, captured where and when it happened.
 *
 * THE URL AND THE REFERRER ARE FROZEN HERE, at the moment of the page view,
 * and NOT read again at send time. That is the whole fix: a visitor arriving
 * on /?utm_source=tiktok and moving to /schools before consent resolves must
 * still be recorded as having landed on / from TikTok. Reading
 * window.location later would report /schools and lose the campaign.
 *
 * THE IDENTITY IS DELIBERATELY ABSENT. Minting a visitor id means writing a
 * cookie, and writing a tracking cookie before the visitor has agreed is the
 * exact thing consent exists to prevent. Identity is assigned at send time,
 * which is always after permission.
 */
type CapturedEvent = {
  readonly eventId: string
  readonly kind: 'page_view' | 'signup'
  readonly url: string
  readonly referrer: string | null
  readonly userId?: string
}

/** Events waiting for consent to resolve, oldest first. */
const pending: CapturedEvent[] = []

/** A visitor who never answers must not accumulate an unbounded queue. */
const MAX_PENDING = 20

let flushing = false
let watchingConsent = false

/** Subscribes once, the first time anything has to wait. */
function watchConsent(): void {
  if (watchingConsent) return
  watchingConsent = true

  onConsentChange((state) => {
    if (state.analytics === 'granted') {
      void flushPending()
    } else {
      // Declined. The held events are discarded, not deferred.
      pending.length = 0
    }
  })
}

/**
 * Sends everything that was waiting, in the order it happened.
 *
 * SEQUENTIALLY, on purpose. The first event of a visit is what creates the
 * session row and therefore what sets its landing page and its source; the
 * second only increments a counter. Firing them together would let the
 * second arrive first and record /schools as the landing page.
 *
 * The `flushing` guard is what makes "exactly once" true when consent
 * resolves and the visitor clicks Accept in the same instant.
 */
async function flushPending(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    while (pending.length > 0) {
      const next = pending.shift() as CapturedEvent
      await transmit(next)
    }

    // Nothing was held, but the current page was never recorded — which
    // happens when somebody rejects and then changes their mind. Record where
    // they are now; the page they were on when they said no is not ours.
    if (
      lastPath !== null &&
      lastPath !== transmittedPath &&
      isTrackablePath(lastPath) &&
      analyticsStatus() === 'granted' &&
      typeof window !== 'undefined'
    ) {
      await transmit(capture({ kind: 'page_view' }))
    }
  } finally {
    flushing = false
  }
}

/** Freezes what is true right now into something sendable later. */
function capture(options: SendOptions): CapturedEvent {
  return {
    eventId: newId(),
    kind: options.kind,
    url: window.location.href,
    referrer: document.referrer || null,
    ...(options.kind === 'signup' && options.userId ? { userId: options.userId } : {}),
  }
}

async function transmit(event: CapturedEvent): Promise<void> {
  if (silenced) return

  // Identity is minted HERE, never at capture time: this is the first moment
  // a cookie may lawfully be written.
  const identity = identify()

  // The referrer belongs to the event that opens the visit. On an in-app
  // navigation document.referrer still holds the ORIGINAL external referrer,
  // and sending it again would re-assert a source the session already has.
  const referrer = identity.startsSession ? event.referrer : null

  try {
    const response = await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        eventId: event.eventId,
        visitorId: identity.visitorId,
        sessionId: identity.sessionId,
        kind: event.kind,
        url: event.url,
        referrer,
        isFirstVisit: identity.isFirstVisit,
        startsSession: identity.startsSession,
        ...(event.userId ? { userId: event.userId } : {}),
      }),
    })
    if (response.status === 429) silenced = true
    else transmittedPath = new URL(event.url).pathname
  } catch {
    // A blocked request, an ad blocker, an offline device: none of it is the
    // visitor's problem and none of it should surface.
  }
}

async function send(options: SendOptions): Promise<void> {
  if (silenced || !isTrackingEnabled() || refusesTracking()) return
  if (typeof window === 'undefined') return
  if (!isTrackablePath(window.location.pathname)) return

  const captured = capture(options)

  // CONSENT DECIDES, AND "NOT YET" IS NOT "NO". Checked on every event rather
  // than once at start-up, so withdrawing consent stops the next page view
  // rather than the next session.
  switch (analyticsStatus()) {
    case 'denied':
      return
    case 'unknown':
      watchConsent()
      if (pending.length < MAX_PENDING) pending.push(captured)
      return
    case 'granted':
      await transmit(captured)
  }
}

/**
 * Records a page view for `path`, and only if it is not the path already
 * recorded. React re-renders, Strict Mode's double effect and a query-string
 * change all arrive here as the same path and are ignored; a genuine
 * navigation back to a page visited earlier is a different path from the last
 * one and is counted.
 */
export function trackPageView(path: string): void {
  if (lastPath === path) return
  lastPath = path
  void send({ kind: 'page_view' })
}

/**
 * Links this browser to the account it just created, which is the only join
 * between anonymous traffic and a real person. Called from the signup form
 * after Supabase returns a user.
 *
 * Fire-and-forget on purpose: signing up must not wait on, or fail because of,
 * analytics.
 */
export function trackSignup(userId: string): void {
  void send({ kind: 'signup', userId })
}

/** Test seam: forget what has been sent. */
export function resetForTests(): void {
  lastPath = null
  transmittedPath = null
  silenced = false
  pending.length = 0
  flushing = false
  watchingConsent = false
}

/** Test seam: how many events are waiting on consent. */
export function pendingCountForTests(): number {
  return pending.length
}
