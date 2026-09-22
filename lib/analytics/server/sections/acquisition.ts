import { bucketKeys, bucketLabel, within, type ResolvedRange } from '../../range'
import { countByBucket } from '../../aggregate'
import { notTracked, type Metric, type SectionPayload, type Series } from '../../types'
import { Diagnostics } from '../failures'
import type { Reader } from '../reader'

/**
 * Acquisition: almost none of this can be answered yet, and saying so is the
 * section's job.
 *
 * WHAT EXISTS: a Google Ads tag that fires no conversion event, and a TikTok
 * pixel that reports one page view per full page load and never sees an
 * in-app navigation. Neither writes anything this dashboard can read, and
 * nothing anywhere captures a referrer, a UTM parameter or an ad click id.
 *
 * WHAT THAT MEANS: visitors, sources, landing pages and campaign performance
 * have NO HISTORY to recover. They begin on the day first-party tracking
 * ships. Registrations are the one real number here, and they are shown
 * without a source, because the source was never recorded.
 */
export async function buildAcquisition(reader: Reader, range: ResolvedRange): Promise<SectionPayload> {
  const diagnostics = new Diagnostics()
  const users = await reader.authUsers()
  if (!users.ok) diagnostics.note('auth.users', 'failed', users.detail)
  if (users.ok && users.truncated) diagnostics.cut('auth.users')

  const accounts = users.ok ? users.rows : []
  const registered = accounts.filter((user) => within(user.created_at, range.from, range.to))
  const confirmed = registered.filter((user) => user.email_confirmed_at)
  const previous = range.comparison
    ? accounts.filter((user) => within(user.created_at, range.comparison!.from, range.comparison!.to)).length
    : null

  const firstAccount = accounts.reduce<string | null>(
    (earliest, user) => (!earliest || user.created_at < earliest ? user.created_at : earliest),
    null
  )
  const keys = bucketKeys(range.from ?? firstAccount ?? range.to, range.to, range.bucket, range.timezone)
  const labels = keys.map((key) => bucketLabel(key, range.bucket))
  const registrationsPerBucket = countByBucket(accounts, (user) => user.created_at, keys, range.bucket, range.timezone)

  const metrics: Metric[] = [
    notTracked(
      'visitors',
      'Website visitors',
      'Nothing records a visit. The TikTok pixel and Google Ads tag report to those platforms, not to this database, and neither fires on an in-app navigation.'
    ),
    notTracked('sessions', 'Visits', 'Needs first-party session tracking.'),
    {
      id: 'registrations',
      label: 'Registrations',
      value: users.ok ? registered.length : null,
      previous,
      status: users.ok ? 'ok' : 'error',
      note: 'Real and complete — but with no traffic data, there is nothing to attribute them to yet.',
      source: { label: 'auth.users.created_at' },
      spark: registrationsPerBucket,
    },
    {
      id: 'confirmed',
      label: 'Confirmed their email',
      value: users.ok ? confirmed.length : null,
      status: users.ok ? 'ok' : 'error',
      note: 'Of the registrations in this window.',
      source: { label: 'auth.users.email_confirmed_at' },
    },
    notTracked(
      'visitor_to_signup',
      'Visitor to registration rate',
      'Needs a visitor count before it can have a denominator.',
      'percent'
    ),
    notTracked(
      'traffic_sources',
      'Traffic sources',
      'No referrer or UTM parameter is captured anywhere on the site. Needs a landing-page capture plus a visitor record.'
    ),
    notTracked(
      'landing_pages',
      'Landing pages',
      'Needs first-party page view tracking. The blog, the school pages and the state pages are the likely entry points, and none of them is instrumented.'
    ),
    notTracked(
      'campaigns',
      'Campaign performance',
      'Spend and clicks live in TikTok Ads Manager and Google Ads. Bringing them here needs a spend import plus click-id capture on landing.'
    ),
    notTracked(
      'tiktok_conversions',
      'TikTok reported conversions',
      'The pixel sends a page view only; the one server-side event is a registration whose payload has never been verified as accepted.'
    ),
    notTracked(
      'google_ads_conversions',
      'Google Ads reported conversions',
      'The tag is installed with no conversion event in the code. Unless a URL-based conversion is configured in the Ads account, Google cannot see a signup or a purchase.'
    ),
  ]

  const series: Series[] = [
    {
      id: 'registrations',
      label: 'Registrations',
      buckets: keys,
      labels,
      status: users.ok ? 'ok' : 'error',
      note: 'Shown without a source breakdown, because no source is recorded.',
      source: { label: 'auth.users.created_at' },
      points: [{ key: 'registrations', label: 'Registrations', values: registrationsPerBucket, kind: 'bar' }],
    },
  ]

  return {
    section: 'acquisition',
    generatedAt: new Date().toISOString(),
    range: {
      preset: range.preset,
      from: range.from,
      to: range.to,
      bucket: range.bucket,
      timezone: range.timezone,
      label: range.label,
      comparison: range.comparison,
    },
    metrics,
    series,
    breakdowns: [],
    funnels: [],
    diagnostics: diagnostics.finish(),
  }
}
