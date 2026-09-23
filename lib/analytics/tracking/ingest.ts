import { classifyTouch, type Touch } from './classify'

/**
 * Everything the ingest endpoint decides before it writes a row.
 *
 * All of it is pure, so the rules that protect this table can be tested
 * without a database and without a browser: what a bot looks like, what a
 * payload must contain, what is allowed through, and how much of it.
 *
 * THE POSTURE IS DISTRUSTFUL. This is the one endpoint on the site that any
 * anonymous visitor may write to. It therefore accepts a fixed shape, rejects
 * everything else, never stores a free-text field it was handed, and derives
 * what it can server-side rather than believing the client.
 */

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/**
 * Known non-humans. This is deliberately a plain list rather than a clever
 * heuristic: a false positive here silently deletes real traffic from the
 * numbers, which is worse than a crawler slipping through and being visible.
 */
const BOT_PATTERNS: readonly RegExp[] = [
  /bot\b/i, /\bcrawler\b/i, /\bspider\b/i, /\bscrape/i,
  /googlebot/i, /bingbot/i, /duckduckbot/i, /yandex/i, /baiduspider/i,
  /slurp/i, /applebot/i, /petalbot/i, /ahrefs/i, /semrush/i, /mj12/i, /dotbot/i,
  /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i, /discordbot/i,
  /telegrambot/i, /whatsapp/i, /slackbot/i, /embedly/i, /pinterest/i,
  /headlesschrome/i, /phantomjs/i, /puppeteer/i, /playwright/i, /selenium/i,
  /python-requests/i, /curl\//i, /wget/i, /axios\//i, /node-fetch/i, /go-http-client/i,
  /lighthouse/i, /pagespeed/i, /gtmetrix/i, /pingdom/i, /uptimerobot/i,
  /vercel-screenshot/i, /prerender/i,
]

/** Whether a User-Agent belongs to something that is not a person browsing. */
export function isBot(userAgent: string | null | undefined): boolean {
  // No User-Agent at all is not a browser. Every real one sends it.
  if (!userAgent || userAgent.trim().length === 0) return true
  return BOT_PATTERNS.some((pattern) => pattern.test(userAgent))
}

// ---------------------------------------------------------------------------
// Device and browser, coarsely
// ---------------------------------------------------------------------------

/**
 * Two low-cardinality labels, derived server-side and then the User-Agent is
 * thrown away. A full UA string is a fingerprint; 'mobile' and 'Safari' are
 * not, and they answer the only question the dashboard asks of them.
 */
export function deviceOf(userAgent: string): 'mobile' | 'tablet' | 'desktop' {
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(userAgent)) return 'tablet'
  if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(userAgent)) return 'mobile'
  return 'desktop'
}

export function browserOf(userAgent: string): string {
  if (/edg\//i.test(userAgent)) return 'Edge'
  if (/opr\/|opera/i.test(userAgent)) return 'Opera'
  if (/firefox|fxios/i.test(userAgent)) return 'Firefox'
  if (/samsungbrowser/i.test(userAgent)) return 'Samsung Internet'
  if (/chrome|crios|chromium/i.test(userAgent)) return 'Chrome'
  if (/safari/i.test(userAgent)) return 'Safari'
  return 'Other'
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

export const TRACKED_KINDS = ['page_view', 'signup'] as const
export type TrackedKind = (typeof TRACKED_KINDS)[number]

export type AcceptedEvent = {
  readonly eventId: string
  readonly visitorId: string
  readonly sessionId: string
  readonly kind: TrackedKind
  readonly userId: string | null
  readonly isFirstVisit: boolean
  readonly startsSession: boolean
  readonly touch: Touch
}

export type Rejection = { readonly ok: false; readonly reason: string; readonly status: 400 | 403 | 429 }
export type Acceptance = { readonly ok: true; readonly event: AcceptedEvent }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ValidateInput = {
  readonly body: unknown
  readonly userAgent: string | null
  /** Hosts this deployment answers on. A URL from anywhere else is refused. */
  readonly ownHosts?: readonly string[]
}

/**
 * Turns an untrusted request body into something safe to write, or says no.
 *
 * WHAT IT REFUSES, and why each one matters:
 *   - a bot User-Agent            — crawler traffic is not audience.
 *   - an id that is not a UUID    — ids are keys; a caller does not get to
 *                                   choose their shape.
 *   - an unknown event kind       — the table's CHECK constraint would reject
 *                                   it anyway; better to say so here.
 *   - a URL on another host       — stops this endpoint being used to record
 *                                   traffic for somebody else's site.
 *   - a signup with no account id — the only event that may carry one.
 */
export function validateEvent(input: ValidateInput): Acceptance | Rejection {
  if (isBot(input.userAgent)) return { ok: false, reason: 'automated client', status: 403 }

  const body = input.body
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'body must be an object', status: 400 }
  }
  const raw = body as Record<string, unknown>

  for (const field of ['eventId', 'visitorId', 'sessionId'] as const) {
    const value = raw[field]
    if (typeof value !== 'string' || !UUID.test(value)) {
      return { ok: false, reason: `${field} must be a UUID`, status: 400 }
    }
  }

  const kind = raw.kind
  if (typeof kind !== 'string' || !TRACKED_KINDS.includes(kind as TrackedKind)) {
    return { ok: false, reason: 'unknown event kind', status: 400 }
  }

  const url = raw.url
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
    return { ok: false, reason: 'url is required', status: 400 }
  }

  // The URL must be one of ours. Parse failures are refused here rather than
  // falling back the way classifyTouch does for a genuine visit.
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'url must be http(s)', status: 400 }
    }
    host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return { ok: false, reason: 'url is not a URL', status: 400 }
  }

  const ownHosts = (input.ownHosts ?? ['crnaprephub.com', 'localhost', '127.0.0.1']).map((value) =>
    value.toLowerCase().replace(/^www\./, '')
  )
  if (!ownHosts.includes(host)) {
    return { ok: false, reason: 'url is not on this site', status: 403 }
  }

  const referrer = typeof raw.referrer === 'string' ? raw.referrer.slice(0, 2048) : null

  const userIdValue = raw.userId
  const userId = typeof userIdValue === 'string' && UUID.test(userIdValue) ? userIdValue : null
  if (kind === 'signup' && userId === null) {
    return { ok: false, reason: 'a signup must name the account it created', status: 400 }
  }
  // Only a signup may carry an account id: a page view has no business
  // claiming one, and accepting it would let any caller attach any visitor to
  // any account.
  if (kind !== 'signup' && userIdValue !== undefined && userIdValue !== null) {
    return { ok: false, reason: 'only a signup may carry an account id', status: 400 }
  }

  return {
    ok: true,
    event: {
      eventId: raw.eventId as string,
      visitorId: raw.visitorId as string,
      sessionId: raw.sessionId as string,
      kind: kind as TrackedKind,
      userId,
      isFirstVisit: raw.isFirstVisit === true,
      startsSession: raw.startsSession === true,
      touch: classifyTouch({ url, referrer, ownHosts: input.ownHosts }),
    },
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * A token bucket per visitor, in memory.
 *
 * HONEST ABOUT WHAT THIS IS. Serverless instances do not share memory, so a
 * determined flood spread across instances gets a multiple of this allowance.
 * It is here to stop a runaway loop or a bored visitor holding down F5 from
 * writing thousands of rows, and it does that. The defences that do not depend
 * on it are the UNIQUE event_id (a replay writes nothing) and the fact that
 * every row is small, typed and unreachable from the browser.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly maxKeys: number

  // Written out rather than as constructor parameter properties: the test
  // runner strips types rather than compiling them, and parameter properties
  // are the one piece of TypeScript that cannot be stripped away.
  constructor(capacity = 60, refillPerSecond = 1, maxKeys = 20_000) {
    this.capacity = capacity
    this.refillPerSecond = refillPerSecond
    this.maxKeys = maxKeys
  }

  /** True when this event is within the allowance. */
  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key)
    if (!bucket) {
      // A map that only ever grows is a leak; the oldest entries go first.
      if (this.buckets.size >= this.maxKeys) this.evictOldest(now)
      this.buckets.set(key, { tokens: this.capacity - 1, at: now })
      return true
    }

    const elapsedSeconds = Math.max(0, (now - bucket.at) / 1000)
    const tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond)
    if (tokens < 1) {
      bucket.tokens = tokens
      bucket.at = now
      return false
    }
    bucket.tokens = tokens - 1
    bucket.at = now
    return true
  }

  private evictOldest(now: number): void {
    // Drop anything idle for more than five minutes; if that frees nothing,
    // drop the single oldest so the map can never wedge.
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > 5 * 60 * 1000) this.buckets.delete(key)
      if (bucket.at < oldestAt) {
        oldestAt = bucket.at
        oldestKey = key
      }
    }
    if (this.buckets.size >= this.maxKeys && oldestKey) this.buckets.delete(oldestKey)
  }

  /** Test seam. */
  get size(): number {
    return this.buckets.size
  }
}
