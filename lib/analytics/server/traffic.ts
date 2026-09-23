import { bucketLabel, dayKey } from '../range'
import type { MetricStatus } from '../types'
import { statusFromFailure } from './failures'
import type { Reader } from './reader'
import type { SessionRow, VisitorRow } from '../tracking/attribution'

/**
 * Reading the traffic tables, including the case where they do not exist.
 *
 * THE DEFAULT STATE OF THIS FILE IS "NOTHING YET". Until the Phase 3 migration
 * is applied and the tracker is switched on, every read here fails with
 * "missing" and every figure built from it renders as not tracked, with a
 * sentence saying what would make it real. That is the correct behaviour, not
 * a degraded one: there is no visitor history to recover, and a zero would be
 * a lie about a quiet website rather than an unwired one.
 *
 * COVERAGE IS PART OF THE ANSWER. `coverageStart` is the first visit ever
 * recorded. Any window that begins before it is reported as PARTIAL, because
 * half of it predates the tracker. Without that, the first month of traffic
 * would look like a collapse followed by a boom.
 *
 * WHY SESSIONS ARE READ WHOLE. First- and last-touch attribution needs a
 * visitor's entire history, not the slice inside the window: someone who
 * arrived from TikTok in March and bought in September is credited to March,
 * and that March session is outside every window that contains the purchase.
 * The read is capped and reports truncation rather than quietly narrowing.
 */

export type EventRow = {
  readonly event_id: string
  readonly session_id: string
  readonly visitor_id: string
  readonly occurred_at: string
  readonly kind: string
  readonly path: string | null
  readonly referrer_host: string | null
}

export type TrafficSnapshot = {
  /** False when the tables are absent, unreadable, or hold nothing at all. */
  readonly available: boolean
  /** The status every figure built from this should carry when unavailable. */
  readonly status: MetricStatus
  /** Shown to the reader verbatim when unavailable. */
  readonly reason: string | null
  readonly visitors: readonly VisitorRow[]
  readonly sessions: readonly SessionRow[]
  readonly events: readonly EventRow[]
  /** The first visit ever recorded, or null when nothing is recorded. */
  readonly coverageStart: string | null
  readonly truncated: readonly string[]
}

const NOT_APPLIED =
  'First-party tracking is not active yet. It needs the Phase 3 migration applied and NEXT_PUBLIC_ANALYTICS_TRACKING set to "on". There is no visitor history before that date to recover.'

const NOTHING_YET =
  'Tracking is installed but has not recorded a visit yet. Numbers appear here from the moment it is switched on — nothing earlier can be reconstructed.'

/** A cap high enough for years of this site's traffic, and reported when hit. */
const MAX_SESSIONS = 60_000
const MAX_EVENTS = 120_000

export async function loadTraffic(
  reader: Reader,
  window: { from: string | null; to: string }
): Promise<TrafficSnapshot> {
  const unavailable = (status: MetricStatus, reason: string): TrafficSnapshot => ({
    available: false,
    status,
    reason,
    visitors: [],
    sessions: [],
    events: [],
    coverageStart: null,
    truncated: [],
  })

  const [visitors, sessions] = await Promise.all([
    reader.rows<VisitorRow>(
      'analytics_visitors',
      'visitor_id, first_seen_at, last_seen_at, first_channel, first_source, first_campaign, first_landing_path, user_id, linked_at',
      { dateColumn: 'first_seen_at', tiebreak: 'visitor_id', maxRows: MAX_SESSIONS }
    ),
    reader.rows<SessionRow>(
      'analytics_sessions',
      'session_id, visitor_id, started_at, channel, source, medium, campaign, referrer_host, landing_path, device, browser, is_first_visit, page_view_count',
      { dateColumn: 'started_at', tiebreak: 'session_id', maxRows: MAX_SESSIONS }
    ),
  ])

  if (!visitors.ok) {
    return unavailable(
      statusFromFailure(visitors.reason),
      visitors.reason === 'missing' ? NOT_APPLIED : `analytics_visitors could not be read: ${visitors.detail}`
    )
  }
  if (!sessions.ok) {
    return unavailable(
      statusFromFailure(sessions.reason),
      sessions.reason === 'missing' ? NOT_APPLIED : `analytics_sessions could not be read: ${sessions.detail}`
    )
  }

  if (visitors.rows.length === 0 && sessions.rows.length === 0) {
    return unavailable('not_tracked', NOTHING_YET)
  }

  // Events are the only read that is windowed: they are the largest table and
  // the one question they answer — which pages were viewed — is about the
  // window, not about a visitor's whole history.
  const events = await reader.rows<EventRow>(
    'analytics_events',
    'event_id, session_id, visitor_id, occurred_at, kind, path, referrer_host',
    {
      dateColumn: 'occurred_at',
      from: window.from,
      to: window.to,
      tiebreak: 'event_id',
      maxRows: MAX_EVENTS,
    }
  )

  const truncated: string[] = []
  if (visitors.truncated) truncated.push('analytics_visitors')
  if (sessions.truncated) truncated.push('analytics_sessions')
  if (events.ok && events.truncated) truncated.push('analytics_events')

  const coverageStart = visitors.rows.reduce<string | null>(
    (earliest, visitor) =>
      !earliest || visitor.first_seen_at < earliest ? visitor.first_seen_at : earliest,
    null
  )

  return {
    available: true,
    status: 'ok',
    reason: null,
    visitors: visitors.rows,
    sessions: sessions.rows,
    events: events.ok ? events.rows : [],
    coverageStart,
    truncated,
  }
}

/**
 * The status a figure should carry given when tracking started.
 *
 * A window that reaches back before the first recorded visit is PARTIAL, and
 * says so with a date. Reporting it as `ok` would invite the reader to compare
 * a full month against a week of data and conclude that traffic had tripled.
 */
export function coverageStatus(coverageStart: string | null, windowFrom: string | null): MetricStatus {
  if (!coverageStart) return 'not_tracked'
  if (windowFrom === null) return 'partial'
  return Date.parse(coverageStart) > Date.parse(windowFrom) ? 'partial' : 'ok'
}

export function coverageNote(coverageStart: string | null, timezone: string): string | null {
  if (!coverageStart) return null
  // Formatted by the dashboard's own labeller rather than a second Intl call:
  // every other date on the page comes from range.ts, and two formatters would
  // eventually disagree with each other ("10 Sep" against "Sept 10").
  const day = dayKey(coverageStart, timezone)
  return `Tracking began on ${bucketLabel(day, 'day')} ${day.slice(0, 4)}; nothing before that date was recorded.`
}
