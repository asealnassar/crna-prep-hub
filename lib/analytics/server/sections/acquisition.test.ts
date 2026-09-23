import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAcquisition } from './acquisition.ts'
import { resolveRange } from '../../range.ts'
import type { AuthUserRow, Reader, ReadResult } from '../reader.ts'

/**
 * The Acquisition tab, built against a fake database.
 *
 * TWO WORLDS ARE TESTED. The one before the migration is applied, where every
 * traffic figure must say what it needs rather than showing a zero; and the
 * one after, where the numbers have to be right AND the two attribution models
 * have to disagree in the way they are supposed to.
 */

type Tables = Record<string, Record<string, unknown>[]>

function fakeReader(users: AuthUserRow[], tables: Tables, missing: string[] = []): Reader {
  return {
    async rows<T>(table: string, _columns: string, query: any = {}): Promise<ReadResult<T>> {
      if (missing.includes(table)) {
        return { ok: false, reason: 'missing', detail: `relation "public.${table}" does not exist` }
      }
      let rows = (tables[table] ?? []) as any[]
      // The fake honours the window filter, because a section that forgets to
      // pass one would otherwise look correct here.
      if (query.dateColumn && (query.from || query.to)) {
        rows = rows.filter((row) => {
          const at = String(row[query.dateColumn] ?? '')
          if (query.from && at < query.from) return false
          if (query.to && at >= query.to) return false
          return true
        })
      }
      return { ok: true, rows: rows as T[], truncated: false }
    },
    async count(table: string) {
      return { ok: true, count: (tables[table] ?? []).length }
    },
    async earliest() {
      return null
    },
    async authUsers() {
      return { ok: true, rows: users, truncated: false }
    },
  }
}

const NOW = new Date('2026-09-22T12:00:00.000Z')
const range = () => resolveRange({ preset: '30d', now: NOW })

const account = (id: string, email: string, createdAt = '2026-09-10T10:00:00.000Z'): AuthUserRow => ({
  id,
  email,
  created_at: createdAt,
  email_confirmed_at: '2026-09-10T10:05:00.000Z',
  last_sign_in_at: null,
})

const find = (payload: any, id: string) => payload.metrics.find((metric: any) => metric.id === id)
const breakdown = (payload: any, id: string) => payload.breakdowns.find((item: any) => item.id === id)

// --- before the migration ---------------------------------------------------

const NO_TABLES = ['analytics_visitors', 'analytics_sessions', 'analytics_events', 'analytics_ad_spend']

test('with no tracking tables, every traffic figure says what it needs and shows no number', async () => {
  const reader = fakeReader([account('u1', 'one@example.com')], {}, NO_TABLES)

  const payload = await buildAcquisition(reader, range())

  for (const id of ['visitors', 'sessions', 'page_views', 'new_visitors', 'visitor_to_signup']) {
    const metric = find(payload, id)
    assert.equal(metric.value, null, `${id} must not invent a number`)
    assert.equal(metric.status, 'not_tracked', id)
    assert.match(metric.note, /migration|not active/i, `${id} must say what it needs`)
  }
})

test('a zero is never shown for a visitor count that is simply unknown', async () => {
  const reader = fakeReader([account('u1', 'one@example.com')], {}, NO_TABLES)

  const payload = await buildAcquisition(reader, range())
  const zeros = payload.metrics.filter((m: any) => m.value === 0 && m.status === 'not_tracked')

  assert.deepEqual(zeros, [], 'an untracked metric is null, never 0')
})

test('registrations are still real, because they never depended on tracking', async () => {
  const reader = fakeReader(
    [account('u1', 'one@example.com'), account('u2', 'two@example.com')],
    {},
    NO_TABLES
  )

  const payload = await buildAcquisition(reader, range())

  assert.equal(find(payload, 'registrations').value, 2)
  assert.equal(find(payload, 'registrations').status, 'ok')
})

test('the tracking tables being absent is reported as a diagnostic, not hidden', async () => {
  const reader = fakeReader([], {}, NO_TABLES)

  const payload = await buildAcquisition(reader, range())

  assert.ok(
    payload.diagnostics.failed.some((entry: any) => /tracking/i.test(entry.source)),
    'the reader should be told why the section is empty'
  )
})

// --- after the migration, with traffic --------------------------------------

const VISITORS = [
  // Found us on TikTok, came back via Google, bought. Registered as u1.
  {
    visitor_id: 'v1', first_seen_at: '2026-09-10T09:00:00.000Z', last_seen_at: '2026-09-12T09:00:00.000Z',
    first_channel: 'tiktok', first_source: 'tiktok', first_campaign: 'sept_launch',
    first_landing_path: '/', user_id: 'u1', linked_at: '2026-09-12T09:15:00.000Z',
  },
  // Arrived from Instagram, registered, never paid.
  {
    visitor_id: 'v2', first_seen_at: '2026-09-11T09:00:00.000Z', last_seen_at: '2026-09-11T09:00:00.000Z',
    first_channel: 'instagram', first_source: 'instagram', first_campaign: null,
    first_landing_path: '/pricing', user_id: 'u2', linked_at: '2026-09-11T09:20:00.000Z',
  },
  // Direct, never registered.
  {
    visitor_id: 'v3', first_seen_at: '2026-09-12T09:00:00.000Z', last_seen_at: '2026-09-12T09:00:00.000Z',
    first_channel: 'direct', first_source: 'direct', first_campaign: null,
    first_landing_path: '/schools', user_id: null, linked_at: null,
  },
]

const SESSIONS = [
  { session_id: 's1', visitor_id: 'v1', started_at: '2026-09-10T09:00:00.000Z', channel: 'tiktok', source: 'tiktok', medium: 'paid', campaign: 'sept_launch', referrer_host: 'www.tiktok.com', landing_path: '/', device: 'mobile', browser: 'Safari', is_first_visit: true, page_view_count: 4 },
  { session_id: 's2', visitor_id: 'v1', started_at: '2026-09-12T09:00:00.000Z', channel: 'google_organic', source: 'google.com', medium: 'organic', campaign: null, referrer_host: 'www.google.com', landing_path: '/pricing', device: 'desktop', browser: 'Chrome', is_first_visit: false, page_view_count: 3 },
  { session_id: 's3', visitor_id: 'v2', started_at: '2026-09-11T09:00:00.000Z', channel: 'instagram', source: 'instagram', medium: 'referral', campaign: null, referrer_host: 'l.instagram.com', landing_path: '/pricing', device: 'mobile', browser: 'Safari', is_first_visit: true, page_view_count: 2 },
  { session_id: 's4', visitor_id: 'v3', started_at: '2026-09-12T09:00:00.000Z', channel: 'direct', source: 'direct', medium: null, campaign: null, referrer_host: null, landing_path: '/schools', device: 'desktop', browser: 'Firefox', is_first_visit: true, page_view_count: 1 },
]

const EVENTS = [
  { event_id: 'e1', session_id: 's1', visitor_id: 'v1', occurred_at: '2026-09-10T09:00:00.000Z', kind: 'page_view', path: '/', referrer_host: 'www.tiktok.com' },
  { event_id: 'e2', session_id: 's1', visitor_id: 'v1', occurred_at: '2026-09-10T09:01:00.000Z', kind: 'page_view', path: '/pricing', referrer_host: null },
  { event_id: 'e3', session_id: 's3', visitor_id: 'v2', occurred_at: '2026-09-11T09:00:00.000Z', kind: 'page_view', path: '/pricing', referrer_host: null },
  { event_id: 'e4', session_id: 's2', visitor_id: 'v1', occurred_at: '2026-09-12T09:15:00.000Z', kind: 'signup', path: '/signup', referrer_host: null },
]

const tracked = () =>
  fakeReader([account('u1', 'one@example.com'), account('u2', 'two@example.com')], {
    analytics_visitors: VISITORS,
    analytics_sessions: SESSIONS,
    analytics_events: EVENTS,
    analytics_ad_spend: [],
  })

test('traffic counts come out right', async () => {
  const payload = await buildAcquisition(tracked(), range())

  assert.equal(find(payload, 'visitors').value, 3, 'three distinct browsers')
  assert.equal(find(payload, 'sessions').value, 4, 'four visits')
  assert.equal(find(payload, 'page_views').value, 10, '4 + 3 + 2 + 1')
  assert.equal(find(payload, 'new_visitors').value, 3, 'three visits created their visitor')
  assert.equal(find(payload, 'returning_visitors').value, 1, 'v1 came back once')
})

test('the funnel narrows one cohort, and every step is a subset of the one above', async () => {
  const payload = await buildAcquisition(tracked(), range())
  const steps = payload.funnels[0].steps

  const value = (id: string) => steps.find((step: any) => step.id === id).value
  assert.equal(value('visited'), 3)
  assert.equal(value('registered'), 2)
  assert.equal(value('paid'), 0, 'no Stripe payments in this fixture')
  assert.ok(value('registered') <= value('visited'))
})

test('the conversion rate is that same cohort, not two unrelated counts', async () => {
  const payload = await buildAcquisition(tracked(), range())

  // 2 of 3 first-time visitors registered.
  assert.equal(Math.round(find(payload, 'visitor_to_signup').value), 67)
})

test('first touch and last touch disagree, which is the whole point of showing both', async () => {
  const payload = await buildAcquisition(tracked(), range())

  const first = breakdown(payload, 'first_touch').rows
  const last = breakdown(payload, 'last_touch').rows

  // v1 arrived from TikTok and came back through Google organic.
  assert.equal(first.find((row: any) => row.key === 'tiktok')?.value, 1)
  assert.equal(last.find((row: any) => row.key === 'google_organic')?.value, 1)
  assert.equal(last.find((row: any) => row.key === 'tiktok'), undefined, 'the credit moved')
})

test('landing pages are where visits began; most-visited counts every view', async () => {
  const payload = await buildAcquisition(tracked(), range())

  const landings = breakdown(payload, 'landing_pages').rows
  assert.equal(landings.find((row: any) => row.key === '/pricing')?.value, 2, 's2 and s3 began on /pricing')

  const pages = breakdown(payload, 'top_pages').rows
  assert.equal(pages.find((row: any) => row.key === '/pricing')?.value, 2, 'two page views of /pricing')
  assert.equal(pages.find((row: any) => row.key === '/signup'), undefined, 'a signup event is not a page view')
})

test('Direct is reported as its own channel rather than being spread over the others', async () => {
  const payload = await buildAcquisition(tracked(), range())
  const channels = breakdown(payload, 'channels').rows

  assert.equal(channels.find((row: any) => row.label === 'Direct')?.value, 1)
})

test('a window reaching back before tracking began is marked partial, with the date', async () => {
  // Tracking started on 10 September; an all-time window predates it.
  const payload = await buildAcquisition(tracked(), resolveRange({ preset: 'all', now: NOW }))

  const visitors = find(payload, 'visitors')
  assert.equal(visitors.status, 'partial')
  assert.match(visitors.note, /Tracking began on 10 Sep 2026/)
})

// --- advertising ------------------------------------------------------------

test('with no imported spend, ROAS is unavailable and never zero', async () => {
  const payload = await buildAcquisition(tracked(), range())

  for (const id of ['ad_spend', 'roas', 'cost_per_acquisition']) {
    const metric = find(payload, id)
    assert.equal(metric.value, null, id)
    assert.equal(metric.status, 'not_tracked', id)
    assert.match(metric.note, /CSV|import/i, `${id} should say how to make it real`)
  }
})

test('imported spend appears, and is labelled as only covering what was imported', async () => {
  const reader = fakeReader([account('u1', 'one@example.com')], {
    analytics_visitors: VISITORS,
    analytics_sessions: SESSIONS,
    analytics_events: EVENTS,
    analytics_ad_spend: [
      { platform: 'tiktok', spend_cents: 25000, spend_date: '2026-09-11', campaign: 'sept_launch' },
      { platform: 'google_ads', spend_cents: 10000, spend_date: '2026-09-12', campaign: '(all campaigns)' },
    ],
  })

  const payload = await buildAcquisition(reader, range())

  assert.equal(find(payload, 'ad_spend').value, 350)
  assert.equal(find(payload, 'ad_spend').status, 'partial', 'never claims to be the whole spend')
  assert.equal(breakdown(payload, 'ad_spend_platform').rows.length, 2)
})

test('the platforms’ own conversion counts stay unavailable, and say the pixels are untouched', async () => {
  const payload = await buildAcquisition(tracked(), range())

  for (const id of ['tiktok_conversions', 'google_ads_conversions']) {
    assert.equal(find(payload, id).value, null)
    assert.equal(find(payload, id).status, 'not_tracked')
  }
  assert.match(find(payload, 'tiktok_conversions').note, /unchanged|untouched|second conversion/i)
})
