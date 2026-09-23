import { bucketKey, bucketKeys, bucketLabel, within, type ResolvedRange } from '../../range'
import { countByBucket, distinctByBucket } from '../../aggregate'
import {
  notTracked,
  type Breakdown,
  type Funnel,
  type Metric,
  type MetricStatus,
  type SectionPayload,
  type Series,
} from '../../types'
import { CHANNEL_LABELS } from '../../tracking/classify'
import {
  channelLabel,
  splitAttributedRevenue,
  cohortFunnel,
  performanceByChannel,
  rate,
  type SessionRow,
  type VisitorRow,
} from '../../tracking/attribution'
import { fetchStripeSnapshot, stripeConfigured } from '../../../billing/stripeSource'
import { Diagnostics } from '../failures'
import type { Reader } from '../reader'
import { coverageNote, coverageStatus, loadTraffic, type TrafficSnapshot } from '../traffic'

/**
 * Acquisition: how people find the site, and which of those ways produce
 * customers.
 *
 * EVERY FIGURE HERE BEGINS ON THE DAY TRACKING WAS SWITCHED ON. There is no
 * visitor history before it, and none is invented: a window reaching further
 * back is marked partial and says when recording started. Until the migration
 * is applied every panel says what it needs rather than showing a zero.
 *
 * TWO ATTRIBUTION MODELS, SHOWN SIDE BY SIDE, because they answer different
 * questions and a dashboard that shows only one invites the reader to believe
 * it is the truth. First touch is what introduced someone; last touch is what
 * was in front of them when they decided. The definitions are on the panels.
 *
 * THE FUNNEL IS A COHORT, not a set of independent counts. Visitors whose
 * FIRST visit falls in the window, narrowed to those who registered, then to
 * those who paid. Every step is a subset of the one above it, so the rates
 * between them are real rates. Counting "signups this month" against
 * "visitors this month" would divide two populations that only overlap by
 * accident.
 */

const money = (cents: number) => cents / 100

export async function buildAcquisition(
  reader: Reader,
  range: ResolvedRange,
  force = false
): Promise<SectionPayload> {
  const diagnostics = new Diagnostics()

  const [users, traffic, stripe] = await Promise.all([
    reader.authUsers(),
    loadTraffic(reader, { from: range.from, to: range.to }),
    stripeConfigured() ? fetchStripeSnapshot({ force }) : Promise.resolve(null),
  ])

  if (!users.ok) diagnostics.note('auth.users', 'failed', users.detail)
  if (users.ok && users.truncated) diagnostics.cut('auth.users')
  for (const table of traffic.truncated) diagnostics.cut(table)
  if (!traffic.available && traffic.reason) {
    diagnostics.failed.push({ source: 'first-party tracking', reason: traffic.reason })
  }

  const accounts = users.ok ? users.rows : []
  const registered = accounts.filter((user) => within(user.created_at, range.from, range.to))
  const previousRegistered = range.comparison
    ? accounts.filter((user) => within(user.created_at, range.comparison!.from, range.comparison!.to)).length
    : null

  // --- the window, as buckets ----------------------------------------------
  const firstAccount = accounts.reduce<string | null>(
    (earliest, user) => (!earliest || user.created_at < earliest ? user.created_at : earliest),
    null
  )
  const keys = bucketKeys(range.from ?? firstAccount ?? range.to, range.to, range.bucket, range.timezone)
  const labels = keys.map((key) => bucketLabel(key, range.bucket))

  // --- who paid, keyed by account ------------------------------------------
  const emailToUser = new Map<string, string>()
  for (const user of accounts) {
    if (user.email) emailToUser.set(user.email.trim().toLowerCase(), user.id)
  }

  const grossByUser = new Map<string, number>()
  const netByUser = new Map<string, number>()
  const purchasesByUser = new Map<string, number>()
  /** The FIRST payment per account: the instant last-touch is resolved at. */
  const paidAtByUser = new Map<string, string>()

  if (stripe) {
    for (const payment of stripe.payments) {
      if (!payment.succeeded) continue
      const userId = payment.email ? emailToUser.get(payment.email.trim().toLowerCase()) : undefined
      // A payment with no matching account still counts as revenue; it simply
      // cannot be credited to anyone. The attributed/unattributed split below
      // is where that is reported.
      if (!userId) continue
      const existing = paidAtByUser.get(userId)
      if (!existing || payment.createdAt < existing) paidAtByUser.set(userId, payment.createdAt)
      grossByUser.set(userId, (grossByUser.get(userId) ?? 0) + payment.amount)
      netByUser.set(userId, (netByUser.get(userId) ?? 0) + (payment.amount - payment.amountRefunded))
      purchasesByUser.set(userId, (purchasesByUser.get(userId) ?? 0) + 1)
    }
  }

  const confirmedUserIds = new Set(accounts.filter((user) => user.email_confirmed_at).map((user) => user.id))
  const payingUserIds = new Set(purchasesByUser.keys())

  // --- traffic in the window ------------------------------------------------
  const sessionsInWindow = traffic.sessions.filter((session) =>
    within(session.started_at, range.from, range.to)
  )
  const visitorsInWindow = new Set(sessionsInWindow.map((session) => session.visitor_id))
  const pageViews = sessionsInWindow.reduce((total, session) => total + (session.page_view_count ?? 0), 0)
  const newSessions = sessionsInWindow.filter((session) => session.is_first_visit === true).length
  const returningSessions = sessionsInWindow.length - newSessions

  const previousSessions = range.comparison
    ? traffic.sessions.filter((session) =>
        within(session.started_at, range.comparison!.from, range.comparison!.to)
      )
    : null

  const status: MetricStatus = traffic.available
    ? coverageStatus(traffic.coverageStart, range.from)
    : traffic.status
  const note = traffic.available ? coverageNote(traffic.coverageStart, range.timezone) : traffic.reason
  const trafficSource = { label: 'analytics_sessions', coverageStart: traffic.coverageStart }

  /** A traffic figure, or the reason there isn't one. */
  const trafficMetric = (
    id: string,
    label: string,
    value: number,
    extra: Partial<Metric> = {}
  ): Metric =>
    traffic.available
      ? { id, label, group: 'traffic', value, status, note: note ?? undefined, source: trafficSource, ...extra }
      : notTracked(id, label, traffic.reason ?? '', extra.unit ?? 'count', 'traffic')

  const metrics: Metric[] = [
    trafficMetric('visitors', 'Unique visitors', visitorsInWindow.size, {
      previous: previousSessions ? new Set(previousSessions.map((s) => s.visitor_id)).size : null,
      spark: distinctByBucket(sessionsInWindow, (s) => s.started_at, (s) => s.visitor_id, keys, range.bucket, range.timezone),
    }),
    trafficMetric('sessions', 'Visits', sessionsInWindow.length, {
      previous: previousSessions ? previousSessions.length : null,
      note: `${note ? note + ' ' : ''}A visit ends after 30 minutes of inactivity.`,
    }),
    trafficMetric('page_views', 'Page views', pageViews, {
      previous: previousSessions
        ? previousSessions.reduce((total, s) => total + (s.page_view_count ?? 0), 0)
        : null,
      note: `${note ? note + ' ' : ''}Counted on every in-app navigation, not only on a full page load.`,
    }),
    trafficMetric('new_visitors', 'New visitors', newSessions, {
      note: `${note ? note + ' ' : ''}Visits that created the visitor. A returning visitor who cleared their cookies counts as new again.`,
    }),
    trafficMetric('returning_visitors', 'Returning visits', returningSessions),
    traffic.available && sessionsInWindow.length > 0
      ? {
          id: 'pages_per_visit',
          label: 'Pages per visit',
          group: 'traffic',
          value: pageViews / sessionsInWindow.length,
          unit: 'score',
          status,
          note: note ?? undefined,
          source: trafficSource,
        }
      : notTracked('pages_per_visit', 'Pages per visit', traffic.reason ?? '', 'score', 'traffic'),

    // --- registrations: real since long before tracking ---------------------
    {
      id: 'registrations',
      label: 'Registrations',
      group: 'funnel',
      value: users.ok ? registered.length : null,
      previous: previousRegistered,
      status: users.ok ? 'ok' : 'error',
      note: 'Every account created in this window, from the auth table. Complete since launch, whether or not its visit was tracked.',
      source: { label: 'auth.users.created_at' },
      spark: countByBucket(accounts, (user) => user.created_at, keys, range.bucket, range.timezone),
    },
  ]

  // --- the cohort funnel ----------------------------------------------------
  const cohort = traffic.visitors.filter((visitor) => within(visitor.first_seen_at, range.from, range.to))
  const counts = cohortFunnel({
    visitors: cohort,
    sessions: traffic.sessions,
    confirmedUserIds,
    payingUserIds,
  })

  const funnels: Funnel[] = [
    {
      id: 'acquisition_funnel',
      label: 'From first visit to purchase',
      steps: [
        {
          id: 'visited',
          label: 'Visited for the first time',
          value: traffic.available ? counts.visitors : null,
          status: traffic.available ? status : traffic.status,
          note: traffic.available
            ? 'Everyone whose FIRST ever visit falls in this window. Every step below is a subset of these same people, which is what makes the rates real.'
            : traffic.reason ?? undefined,
        },
        {
          id: 'registered',
          label: 'Created an account',
          value: traffic.available ? counts.signedUp : null,
          status: traffic.available ? status : traffic.status,
          note: 'Of those same visitors. A registration whose first visit predates tracking is not counted here, and is in "Registrations" above.',
        },
        {
          id: 'confirmed',
          label: 'Confirmed their email',
          value: traffic.available ? counts.confirmed : null,
          status: traffic.available ? status : traffic.status,
        },
        {
          id: 'paid',
          label: 'Paid',
          value: traffic.available ? counts.paid : null,
          status: traffic.available ? status : traffic.status,
          note: 'Matched to Stripe by the account email. Recent arrivals have had less time to buy, so a fresh window always understates this.',
        },
      ],
    },
  ]

  metrics.push(
    traffic.available
      ? {
          id: 'visitor_to_signup',
          label: 'Visitor to registration',
          group: 'funnel',
          value: rate(counts.signedUp, counts.visitors),
          unit: 'percent',
          status,
          note: 'Of visitors whose first visit was in this window, the share that created an account — the same people, narrowed.',
          source: trafficSource,
        }
      : notTracked('visitor_to_signup', 'Visitor to registration', traffic.reason ?? '', 'percent', 'funnel'),
    traffic.available
      ? {
          id: 'signup_to_paid',
          label: 'Registration to purchase',
          group: 'funnel',
          value: rate(counts.paid, counts.signedUp),
          unit: 'percent',
          status,
          note: 'Of those registrations, the share that has paid so far.',
          source: { label: 'analytics_visitors + Stripe' },
        }
      : notTracked('signup_to_paid', 'Registration to purchase', traffic.reason ?? '', 'percent', 'funnel')
  )

  // --- series ---------------------------------------------------------------
  const series: Series[] = [
    {
      id: 'traffic',
      label: 'Visits and visitors',
      group: 'traffic',
      buckets: keys,
      labels,
      status: traffic.available ? status : traffic.status,
      note: traffic.available ? note ?? undefined : traffic.reason ?? undefined,
      source: trafficSource,
      points: traffic.available
        ? [
            { key: 'sessions', label: 'Visits', kind: 'bar', values: countByBucket(sessionsInWindow, (s) => s.started_at, keys, range.bucket, range.timezone) },
            { key: 'visitors', label: 'Unique visitors', kind: 'line', values: distinctByBucket(sessionsInWindow, (s) => s.started_at, (s) => s.visitor_id, keys, range.bucket, range.timezone) },
          ]
        : [],
    },
    {
      id: 'page_views',
      label: 'Page views',
      group: 'traffic',
      buckets: keys,
      labels,
      status: traffic.available ? status : traffic.status,
      note: traffic.available ? note ?? undefined : traffic.reason ?? undefined,
      source: trafficSource,
      points: traffic.available
        ? [
            {
              key: 'views',
              label: 'Page views',
              kind: 'bar',
              values: sumByBucket(sessionsInWindow, keys, range.bucket, range.timezone),
            },
          ]
        : [],
    },
    {
      id: 'registrations',
      label: 'Registrations',
      group: 'funnel',
      buckets: keys,
      labels,
      status: users.ok ? 'ok' : 'error',
      source: { label: 'auth.users.created_at' },
      points: [
        {
          key: 'registrations',
          label: 'Registrations',
          kind: 'bar',
          values: countByBucket(accounts, (user) => user.created_at, keys, range.bucket, range.timezone),
        },
      ],
    },
  ]

  // --- breakdowns -----------------------------------------------------------
  const breakdowns: Breakdown[] = []

  const unavailable = (id: string, label: string, group: string, extra?: string): Breakdown => ({
    id,
    label,
    group,
    rows: [],
    status: traffic.status,
    note: `${traffic.reason ?? ''}${extra ? ' ' + extra : ''}`.trim(),
    source: { label: 'analytics_sessions' },
  })

  if (traffic.available) {
    const cohortPerformance = (model: 'first' | 'last') =>
      performanceByChannel({
        visitors: cohort,
        sessions: traffic.sessions,
        revenue: { grossByUser, netByUser, purchasesByUser },
        paidAtByUser,
        model,
      })

    const bySessionChannel = new Map<string, number>()
    for (const session of sessionsInWindow) {
      const label = channelLabel(session.channel)
      bySessionChannel.set(label, (bySessionChannel.get(label) ?? 0) + 1)
    }

    breakdowns.push({
      id: 'channels',
      label: 'Where visits came from',
      group: 'sources',
      rows: [...bySessionChannel.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, value]) => ({ key: label, label, value })),
      status,
      note: 'Every visit in this window, counted where that visit came from. "Direct" means no referrer and no campaign tag — it is "not known", not a channel.',
      source: trafficSource,
    })

    const firstTouchRows = cohortPerformance('first')
    breakdowns.push({
      id: 'first_touch',
      label: 'First touch: what introduced them',
      group: 'sources',
      // Only channels that actually introduced somebody. A channel with visits
      // but no credited visitor belongs in "Where visits came from", not here.
      rows: firstTouchRows.filter((row) => row.visitors > 0).map((row) => ({
        key: row.channel,
        label: row.label,
        value: row.visitors,
        note: row.signups > 0 ? `${row.signups} registered, ${row.customers} paid` : undefined,
      })),
      status,
      note: 'Visitors whose first visit was in this window, credited to the source of that first visit. Frozen when the visitor was created and never rewritten.',
      source: { label: 'analytics_visitors.first_channel' },
    })

    const lastTouchRows = cohortPerformance('last')
    breakdowns.push({
      id: 'last_touch',
      label: 'Last touch: what was in front of them at the end',
      group: 'sources',
      // Only channels that actually introduced somebody. A channel with visits
      // but no credited visitor belongs in "Where visits came from", not here.
      rows: lastTouchRows.filter((row) => row.visitors > 0).map((row) => ({
        key: row.channel,
        label: row.label,
        value: row.visitors,
        note: row.signups > 0 ? `${row.signups} registered, ${row.customers} paid` : undefined,
      })),
      status,
      note: 'The same people, credited to the most recent visit that HAD a known source at the moment they converted — their purchase if they bought, otherwise their registration. A Direct return visit does not take the credit away from the campaign that earned it.',
      source: { label: 'analytics_sessions' },
    })

    // Revenue by source, under both models.
    for (const [model, rows, label] of [
      ['first', firstTouchRows, 'Revenue by first touch'],
      ['last', lastTouchRows, 'Revenue by last touch'],
    ] as const) {
      const withMoney = rows.filter((row) => row.grossCents > 0)
      breakdowns.push({
        id: `revenue_${model}_touch`,
        label,
        group: 'money',
        unit: 'currency',
        rows: withMoney.map((row) => ({
          key: row.channel,
          label: row.label,
          value: money(row.grossCents),
          note: `${row.customers} customer(s), ${row.purchases} purchase(s) · ${formatMoney(row.netCents)} after refunds`,
        })),
        status,
        note:
          model === 'first'
            ? 'Gross revenue from customers whose first visit was in this window, credited to how they first arrived.'
            : 'The same revenue, credited to the last known source before they bought.',
        source: { label: 'analytics_visitors + Stripe' },
      })
    }

    // Campaigns: only sessions that actually carried one.
    const byCampaign = new Map<string, { sessions: number; channel: string }>()
    for (const session of sessionsInWindow) {
      if (!session.campaign) continue
      const key = `${channelLabel(session.channel)} · ${session.campaign}`
      const entry = byCampaign.get(key) ?? { sessions: 0, channel: session.channel ?? 'direct' }
      entry.sessions += 1
      byCampaign.set(key, entry)
    }
    breakdowns.push({
      id: 'campaigns',
      label: 'Campaigns',
      group: 'sources',
      rows: [...byCampaign.entries()]
        .sort((a, b) => b[1].sessions - a[1].sessions)
        .slice(0, 20)
        .map(([label, entry]) => ({ key: label, label, value: entry.sessions })),
      status,
      note:
        byCampaign.size === 0
          ? 'No visit in this window carried a utm_campaign. Tag your ad and post links with utm_source, utm_medium and utm_campaign and they will appear here.'
          : 'Visits carrying a utm_campaign, by campaign.',
      source: trafficSource,
    })

    // Landing pages: where a visit began.
    const byLanding = new Map<string, number>()
    for (const session of sessionsInWindow) {
      const path = session.landing_path ?? '(not recorded)'
      byLanding.set(path, (byLanding.get(path) ?? 0) + 1)
    }
    breakdowns.push({
      id: 'landing_pages',
      label: 'Landing pages',
      group: 'pages',
      rows: [...byLanding.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([label, value]) => ({ key: label, label, value })),
      status,
      note: 'The first page of each visit — what people actually arrive on.',
      source: trafficSource,
    })

    // Most visited pages, from the event log.
    const byPath = new Map<string, number>()
    for (const event of traffic.events) {
      if (event.kind !== 'page_view') continue
      const path = event.path ?? '(not recorded)'
      byPath.set(path, (byPath.get(path) ?? 0) + 1)
    }
    breakdowns.push({
      id: 'top_pages',
      label: 'Most visited pages',
      group: 'pages',
      rows: [...byPath.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([label, value]) => ({ key: label, label, value })),
      status,
      note: 'Page views in this window. Paths only — a query string is never recorded.',
      source: { label: 'analytics_events' },
    })

    // Devices, which costs nothing now the sessions are loaded.
    const byDevice = new Map<string, number>()
    for (const session of sessionsInWindow) {
      const device = session.device ?? '(not recorded)'
      byDevice.set(device, (byDevice.get(device) ?? 0) + 1)
    }
    breakdowns.push({
      id: 'devices',
      label: 'Devices',
      group: 'pages',
      rows: [...byDevice.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, value]) => ({ key: label, label: label[0].toUpperCase() + label.slice(1), value })),
      status,
      source: trafficSource,
    })
  } else {
    breakdowns.push(
      unavailable('channels', 'Where visits came from', 'sources'),
      unavailable('first_touch', 'First touch: what introduced them', 'sources'),
      unavailable('last_touch', 'Last touch: what was in front of them at the end', 'sources'),
      unavailable('campaigns', 'Campaigns', 'sources'),
      unavailable('landing_pages', 'Landing pages', 'pages'),
      unavailable('top_pages', 'Most visited pages', 'pages'),
      unavailable('revenue_first_touch', 'Revenue by first touch', 'money')
    )
  }

  // --- attributed against unattributed money --------------------------------
  //
  // A DIFFERENT QUESTION FROM THE PANELS ABOVE, and kept separate on purpose.
  // The "revenue by source" panels follow a COHORT: visitors who first arrived
  // in this window, and everything they have paid since. These two figures
  // follow the WINDOW: the money actually taken in it, and how much of it can
  // be traced to a source at all. Mixing the two would produce a percentage
  // whose numerator and denominator came from different populations.
  if (stripe) {
    const visitorByUser = new Map<string, VisitorRow>()
    for (const visitor of traffic.visitors) {
      if (visitor.user_id && !visitorByUser.has(visitor.user_id)) {
        visitorByUser.set(visitor.user_id, visitor)
      }
    }

    const split = splitAttributedRevenue({
      payments: stripe.payments,
      from: range.from,
      to: range.to,
      emailToUser,
      visitorByUser,
    })
    const { attributedCents: attributedInWindow, unattributedCents: unattributedInWindow } = split
    const { noAccountMatch, noTrackedVisit } = split
    const totalInWindow = attributedInWindow + unattributedInWindow
    const reasons: string[] = []
    if (noTrackedVisit > 0) {
      reasons.push(
        `${noTrackedVisit} from account(s) with no tracked first visit or no known source — mostly customers who registered before tracking existed`
      )
    }
    if (noAccountMatch > 0) {
      reasons.push(`${noAccountMatch} payment(s) whose email matches no account`)
    }

    metrics.push(
      {
        id: 'attributed_revenue',
        label: 'Revenue traced to a source',
        group: 'money',
        value: money(attributedInWindow),
        unit: 'currency',
        status: traffic.available ? status : traffic.status,
        note: traffic.available
          ? `Payments in this window from customers whose first visit was tracked and had a known source${totalInWindow > 0 ? ` — ${Math.round((attributedInWindow / totalInWindow) * 100)}% of the money taken` : ''}.`
          : traffic.reason ?? undefined,
        source: { label: 'Stripe + analytics_visitors' },
      },
      {
        id: 'unattributed_revenue',
        label: 'Revenue with no known source',
        group: 'money',
        value: money(unattributedInWindow),
        unit: 'currency',
        status: 'ok',
        note: `Payments in this window that cannot be credited to any traffic source: ${reasons.join('; ') || 'none'}. Shown separately rather than folded into a channel.`,
        source: { label: 'Stripe' },
      }
    )
  }

  // --- advertising spend ----------------------------------------------------
  const spend = await reader.rows<{ platform: string; spend_cents: number; spend_date: string; campaign: string }>(
    'analytics_ad_spend',
    'platform, spend_cents, spend_date, campaign',
    { dateColumn: 'spend_date', from: range.from, to: range.to, tiebreak: 'id' }
  )

  const spendNote =
    'No advertising spend has been imported. TikTok Ads Manager and Google Ads hold it, and neither can be read without their own API credentials. Import a CSV and cost per acquisition and ROAS appear here. Nothing is estimated in the meantime.'

  if (spend.ok && spend.rows.length > 0) {
    const byPlatform = new Map<string, number>()
    for (const row of spend.rows) {
      byPlatform.set(row.platform, (byPlatform.get(row.platform) ?? 0) + row.spend_cents)
    }
    const totalSpend = [...byPlatform.values()].reduce((sum, value) => sum + value, 0)
    const attributedRevenue = traffic.available
      ? performanceByChannel({
          visitors: cohort,
          sessions: traffic.sessions,
          revenue: { grossByUser, netByUser, purchasesByUser },
          paidAtByUser,
          model: 'last',
        })
          .filter((row) => row.channel === 'tiktok' || row.channel === 'google_ads')
          .reduce((sum, row) => sum + row.grossCents, 0)
      : 0

    metrics.push({
      id: 'ad_spend',
      label: 'Advertising spend',
      group: 'ads',
      value: money(totalSpend),
      unit: 'currency',
      status: 'partial',
      note: 'Imported by hand from the ad platforms. Only the days that were imported are included.',
      source: { label: 'analytics_ad_spend' },
    })
    metrics.push({
      id: 'roas',
      label: 'Return on ad spend',
      group: 'ads',
      value: totalSpend > 0 && traffic.available ? attributedRevenue / totalSpend : null,
      unit: 'score',
      status: traffic.available ? 'partial' : traffic.status,
      note: 'Revenue attributed to TikTok and Google Ads by last touch, divided by imported spend for the same window. Both sides are incomplete unless every day was imported.',
      source: { label: 'analytics_ad_spend + Stripe' },
    })
    breakdowns.push({
      id: 'ad_spend_platform',
      label: 'Spend by platform',
      group: 'ads',
      unit: 'currency',
      rows: [...byPlatform.entries()].map(([platform, cents]) => ({
        key: platform,
        label: platform === 'tiktok' ? 'TikTok' : 'Google Ads',
        value: money(cents),
      })),
      status: 'partial',
      source: { label: 'analytics_ad_spend' },
    })
  } else {
    metrics.push(
      notTracked('ad_spend', 'Advertising spend', spendNote, 'currency', 'ads'),
      notTracked('cost_per_acquisition', 'Cost per customer', spendNote, 'currency', 'ads'),
      notTracked('roas', 'Return on ad spend', spendNote, 'score', 'ads')
    )
  }

  // --- what the platforms report, which is not ours to read -----------------
  metrics.push(
    notTracked(
      'tiktok_conversions',
      'TikTok reported conversions',
      'TikTok counts these in its own Events Manager and does not report them back to us. The pixel and the server-side registration event are unchanged by this release; nothing here sends a second conversion.',
      'count',
      'ads'
    ),
    notTracked(
      'google_ads_conversions',
      'Google Ads reported conversions',
      'The Google Ads tag is installed and untouched. A conversion still has to be configured in the Ads account; this dashboard cannot read what Google records.',
      'count',
      'ads'
    )
  )

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
    breakdowns,
    funnels,
    diagnostics: diagnostics.finish(),
  }
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Page views per bucket, summed from each visit's own counter.
 *
 * A visit is counted in the bucket it STARTED in, so the handful of visits
 * that straddle midnight put all of their views on the day they began. The
 * alternative is reading the whole event log to place each view exactly, which
 * costs a hundred times the rows to move a few page views across one boundary.
 */
function sumByBucket(
  sessions: readonly SessionRow[],
  keys: readonly string[],
  bucket: ResolvedRange['bucket'],
  timezone: string
): number[] {
  const totals = new Array(keys.length).fill(0)
  const index = new Map(keys.map((key, position) => [key, position]))
  for (const session of sessions) {
    let key: string
    try {
      key = bucketKey(session.started_at, bucket, timezone)
    } catch {
      continue
    }
    const position = index.get(key)
    if (position !== undefined) totals[position] += session.page_view_count ?? 0
  }
  return totals
}
