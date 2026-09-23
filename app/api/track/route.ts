import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { RateLimiter, browserOf, deviceOf, validateEvent } from '@/lib/analytics/tracking/ingest'

export const dynamic = 'force-dynamic'

/**
 * The tracking endpoint.
 *
 * THIS IS THE ONLY PLACE ON THE SITE AN ANONYMOUS VISITOR CAN CAUSE A WRITE,
 * so it is built to be boring: one shape in, one row out, nothing reflected
 * back. The rules it enforces live in lib/analytics/tracking/ingest.ts where
 * they can be tested; this file is the plumbing around them.
 *
 * IT NEVER BREAKS A PAGE. Every failure — a refused payload, a missing table
 * before the migration is applied, a database that is down — answers 204 and
 * the visitor's browser carries on. An analytics endpoint that can 500 in
 * front of a real user is worse than one that quietly records nothing. The
 * only non-204 answers are 405 for the wrong method and 429 for a flood, and
 * the tracker treats both as "stop asking".
 *
 * IT IS NOT A CONVERSION PIXEL. The TikTok pixel and the Google Ads tag in
 * app/layout.tsx are untouched and keep reporting to those platforms exactly
 * as they did. Nothing here fires a platform event, so no conversion is
 * duplicated and no ad platform sees a second signal.
 */

const limiter = new RateLimiter(60, 1)

/**
 * THE SWITCH IS HONOURED ON BOTH SIDES.
 *
 * NEXT_PUBLIC_ANALYTICS_TRACKING gates the browser, and for a while that was
 * all it gated. Once the tables existed, this endpoint would happily write a
 * row for anyone who posted to it, whether or not tracking was supposed to be
 * on — which was found by posting one during the release verification and
 * discovering a visitor, a session and an event sitting in production.
 *
 * Real visitors were never the risk: their browser sends nothing while the
 * flag is off. But "disabled" has to mean disabled, not "disabled unless you
 * know the URL", and the collection has to be switchable off in an emergency
 * without waiting for a rebuild to reach every cached page.
 *
 * The same variable drives both sides, so enabling tracking stays one
 * decision: set it, redeploy, and the browser and the endpoint start together.
 */
function trackingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ANALYTICS_TRACKING === 'on'
}

/** Warn once per cold start rather than on every event. */
let warnedAboutMissingTables = false

function ownHosts(request: Request): string[] {
  const configured = (process.env.NEXT_PUBLIC_SITE_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (configured.length > 0) return configured

  const hosts = ['crnaprephub.com', 'www.crnaprephub.com', 'localhost', '127.0.0.1']
  // The deployment's own host, so preview URLs track themselves rather than
  // refusing every event with "not on this site".
  try {
    hosts.push(new URL(request.url).hostname)
  } catch {
    /* the request URL is always parseable in practice; ignore if not */
  }
  return hosts
}

const accepted = () => new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })

export async function POST(request: Request) {
  // Nothing is recorded while tracking is off. Answered 204 like every other
  // refusal, so a stale page still holding the old bundle sees no error.
  if (!trackingEnabled()) return accepted()

  // Same-origin only. A tracker runs on our pages; nothing else needs to post
  // here, and no CORS headers are sent, so a browser will not let it.
  const origin = request.headers.get('origin')
  if (origin) {
    try {
      const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, '')
      const allowed = ownHosts(request).map((value) => value.toLowerCase().replace(/^www\./, ''))
      if (!allowed.includes(host)) return accepted()
    } catch {
      return accepted()
    }
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return accepted()
  }

  const userAgent = request.headers.get('user-agent')
  const result = validateEvent({ body, userAgent, ownHosts: ownHosts(request) })
  if (!result.ok) return accepted()

  const event = result.event

  // Rate limited per visitor. 429 is one of the two answers the tracker acts
  // on: it stops sending for the rest of the page.
  if (!limiter.allow(event.visitorId)) {
    return new NextResponse(null, { status: 429, headers: { 'Cache-Control': 'no-store' } })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return accepted()

  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const agent = userAgent ?? ''

  const { error } = await admin.rpc('analytics_record_event', {
    p_event_id: event.eventId,
    p_visitor_id: event.visitorId,
    p_session_id: event.sessionId,
    p_kind: event.kind,
    p_channel: event.touch.channel,
    p_source: event.touch.source,
    p_medium: event.touch.medium,
    p_campaign: event.touch.campaign,
    p_content: event.touch.content,
    p_term: event.touch.term,
    p_referrer_host: event.touch.referrerHost,
    p_landing_path: event.touch.landingPath,
    p_device: deviceOf(agent),
    p_browser: browserOf(agent),
    p_is_first_visit: event.isFirstVisit,
    p_user_id: event.userId,
  })

  if (error) {
    // Before the migration is applied the function does not exist. That is an
    // expected state, not an incident: say so once and keep answering 204.
    const missing = error.code === 'PGRST202' || /analytics_record_event/.test(error.message ?? '')
    if (missing) {
      if (!warnedAboutMissingTables) {
        warnedAboutMissingTables = true
        console.warn('Analytics tracking is not active: the Phase 3 migration has not been applied.')
      }
    } else {
      console.error('Analytics ingest failed:', error.message)
    }
  }

  return accepted()
}

/** Anything other than a POST is simply not this endpoint. */
export async function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } })
}
