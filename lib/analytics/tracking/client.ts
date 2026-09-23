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

/** The last page path recorded, so a re-render cannot record it twice. */
let lastPath: string | null = null

type SendOptions = { readonly kind: 'page_view' | 'signup'; readonly userId?: string }

async function send(options: SendOptions): Promise<void> {
  if (silenced || !isTrackingEnabled() || refusesTracking()) return
  if (typeof window === 'undefined') return
  if (!isTrackablePath(window.location.pathname)) return

  const identity = identify()

  // The referrer is only meaningful on the first event of a visit. On an
  // in-app navigation document.referrer still holds the ORIGINAL external
  // referrer, and sending it again would re-assert a source the session
  // already has.
  const referrer = identity.startsSession ? document.referrer || null : null

  try {
    const response = await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        eventId: newId(),
        visitorId: identity.visitorId,
        sessionId: identity.sessionId,
        kind: options.kind,
        url: window.location.href,
        referrer,
        isFirstVisit: identity.isFirstVisit,
        startsSession: identity.startsSession,
        ...(options.kind === 'signup' && options.userId ? { userId: options.userId } : {}),
      }),
    })
    if (response.status === 429) silenced = true
  } catch {
    // A blocked request, an ad blocker, an offline device: none of it is the
    // visitor's problem and none of it should surface.
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
  silenced = false
}
