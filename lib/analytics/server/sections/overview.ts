import { bucketKeys, bucketLabel, bucketOf, dayKey, within, type ResolvedRange } from '../../range'
import { countByBucket, cumulative, distinctByBucket, distinctSet, percent } from '../../aggregate'
import { notTracked, type Breakdown, type Funnel, type Metric, type SectionPayload, type Series } from '../../types'
import { buildRevenueReport } from '../../../billing/revenue'
import { fetchStripeSnapshot, stripeConfigured } from '../../../billing/stripeSource'
import { loadActivity } from '../activity'
import { TIER_LABELS, loadProfiles } from '../profiles'
import type { AuthUserRow, Reader } from '../reader'

/**
 * Overview: the shape of the business in one screen.
 *
 * Registrations and membership are real and complete — they come from
 * auth.users and user_profiles, which have existed for the life of the site.
 * Activity is a lower bound: nothing records a page view, so a member who
 * reads without writing a row is invisible.
 *
 * Money comes from Stripe and only from Stripe. Membership tiers are access,
 * and access is also granted by hand, so counting tiers as sales would invent
 * revenue nobody paid. When Stripe cannot be reached the money figures say so
 * rather than falling back to a tier count.
 */
export async function buildOverview(reader: Reader, range: ResolvedRange): Promise<SectionPayload> {
  const started = Date.now()
  const truncated: string[] = []
  const failed: { source: string; reason: string }[] = []

  // One activity read covers this window and the one it is compared against.
  const unionFrom = range.comparison?.from ?? range.from

  const [users, profiles, activity, snapshot] = await Promise.all([
    reader.authUsers(),
    loadProfiles(reader),
    loadActivity(reader, { from: unionFrom, to: range.to }),
    stripeConfigured() ? fetchStripeSnapshot() : Promise.resolve(null),
  ])

  if (!users.ok) failed.push({ source: 'auth.users', reason: users.detail })
  if (users.ok && users.truncated) truncated.push('auth.users')
  if (!profiles.available) failed.push({ source: 'user_profiles', reason: profiles.reason ?? 'unavailable' })
  if (profiles.truncated) truncated.push('user_profiles')
  for (const source of activity.unavailable) failed.push({ source: source.table, reason: source.reason ?? 'unavailable' })
  truncated.push(...activity.truncated)

  const accounts: AuthUserRow[] = users.ok ? users.rows : []
  const inWindow = (value: string | null) => (value ? within(value, range.from, range.to) : false)
  const inComparison = (value: string | null) =>
    !!value && !!range.comparison && within(value, range.comparison.from, range.comparison.to)

  const registered = accounts.filter((user) => inWindow(user.created_at)).length
  const registeredBefore = range.comparison ? accounts.filter((user) => inComparison(user.created_at)).length : null
  const confirmed = accounts.filter((user) => inWindow(user.created_at) && user.email_confirmed_at).length

  // Money comes from Stripe, never from membership tiers.
  const revenue = snapshot
    ? buildRevenueReport(
        snapshot,
        { from: range.from, to: range.to, bucket: range.bucket, timezone: range.timezone, comparison: range.comparison },
        accounts.map((user) => ({ email: user.email, createdAt: user.created_at }))
      )
    : null
  if (snapshot) {
    for (const warning of snapshot.warnings) failed.push({ source: 'Stripe', reason: warning })
  } else if (stripeConfigured()) {
    failed.push({ source: 'Stripe', reason: 'Stripe could not be reached, so revenue is unavailable rather than zero.' })
  }

  const eventsInWindow = activity.events.filter((event) => within(event.at, range.from, range.to))
  const eventsInComparison = range.comparison
    ? activity.events.filter((event) => within(event.at, range.comparison!.from, range.comparison!.to))
    : []
  const activeNow = distinctSet(eventsInWindow, (event) => event.userId).size
  const activeBefore = range.comparison ? distinctSet(eventsInComparison, (event) => event.userId).size : null

  // --- the series need a bucket axis that starts where the data does --------
  const firstAccount = accounts.reduce<string | null>(
    (earliest, user) => (!earliest || user.created_at < earliest ? user.created_at : earliest),
    null
  )
  const seriesStart = range.from ?? firstAccount ?? range.to
  const keys = bucketKeys(seriesStart, range.to, range.bucket, range.timezone)
  const labels = keys.map((key) => bucketLabel(key, range.bucket))

  const registrationsPerBucket = countByBucket(accounts, (user) => user.created_at, keys, range.bucket, range.timezone)

  // Everyone who registered before the first bucket, so the cumulative line is
  // the real total rather than a count that restarts at the window edge.
  const firstKey = keys[0]
  const priorAccounts = firstKey
    ? accounts.filter((user) => {
        try {
          return bucketOf(dayKey(user.created_at, range.timezone), range.bucket) < firstKey
        } catch {
          return false
        }
      }).length
    : 0

  const activePerBucket = distinctByBucket(
    activity.events,
    (event) => event.at,
    (event) => event.userId,
    keys,
    range.bucket,
    range.timezone
  )

  const activitySourceNote = activity.unavailable.length
    ? `Counts actions recorded in the database, so browsing alone is invisible. ${activity.unavailable.length} source(s) unreadable: ${activity.unavailable.map((source) => source.table).join(', ')}.`
    : 'Counts members who took a recorded action (interview, resume, GPA, schools, feedback, messages). Browsing alone is invisible, so this is a lower bound.'

  const metrics: Metric[] = [
    {
      id: 'total_users',
      label: 'Total users',
      value: users.ok ? accounts.length : null,
      status: users.ok ? 'ok' : 'error',
      note: users.ok
        ? 'Every account that exists today. Deleted accounts are not included, here or in history.'
        : 'The account list could not be read.',
      source: { label: 'auth.users', detail: 'one row per account' },
    },
    {
      id: 'new_registrations',
      label: 'New registrations',
      value: users.ok ? registered : null,
      previous: registeredBefore,
      status: users.ok ? 'ok' : 'error',
      source: { label: 'auth.users.created_at' },
      spark: registrationsPerBucket,
    },
    {
      id: 'confirmed_registrations',
      label: 'Confirmed their email',
      value: users.ok ? confirmed : null,
      status: users.ok ? 'ok' : 'error',
      note: 'Of the registrations in this window.',
      source: { label: 'auth.users.email_confirmed_at' },
    },
    {
      id: 'active_members',
      label: 'Active members',
      value: users.ok ? activeNow : null,
      previous: activeBefore,
      status: 'partial',
      note: activitySourceNote,
      source: { label: 'product tables', detail: 'distinct members with a recorded action' },
      spark: activePerBucket,
    },
    {
      id: 'paid_entitlements',
      label: 'Premium + Ultimate members',
      value: profiles.available ? profiles.paidTierCount : null,
      status: profiles.available ? 'ok' : 'error',
      note: 'Access held right now, including plans granted by hand. Not a count of purchases.',
      source: { label: 'user_profiles.subscription_tier' },
    },
    {
      id: 'entitlement_share',
      label: 'Share of members on a paid tier',
      value: profiles.available ? percent(profiles.paidTierCount, profiles.total) : null,
      unit: 'percent',
      status: profiles.available ? 'ok' : 'error',
      note: 'Paid tiers as a share of all profiles. Free upgrades are included, so this is not the purchase conversion rate.',
      source: { label: 'user_profiles.subscription_tier' },
    },
    revenue
      ? {
          id: 'revenue',
          label: 'Net revenue',
          value: revenue.net / 100,
          previous: revenue.previous ? revenue.previous.net / 100 : null,
          unit: 'currency' as const,
          status: 'ok' as const,
          note: `Payments in this window less refunds issued in it, from Stripe. ${revenue.currency.toUpperCase()}, ${revenue.mode} mode.`,
          source: { label: 'Stripe charges' },
          spark: revenue.series.gross.map((cents) => cents / 100),
        }
      : notTracked(
          'revenue',
          'Net revenue',
          'Stripe is not configured in this environment, so no payment can be read.',
          'currency'
        ),
    revenue
      ? {
          id: 'paid_conversion',
          label: 'Free to paid conversion',
          value: revenue.conversion.rate,
          unit: 'percent' as const,
          status: revenue.conversion.unmatchedPayers > 0 ? ('partial' as const) : ('ok' as const),
          note: `${revenue.conversion.payingAccounts} of ${revenue.conversion.accounts} accounts have ever paid, matched to Stripe by email.`,
          source: { label: 'Stripe charges + auth.users' },
        }
      : notTracked(
          'paid_conversion',
          'Free to paid conversion',
          'Needs payments from Stripe matched to accounts.',
          'percent'
        ),
  ]

  const series: Series[] = [
    {
      id: 'growth',
      label: 'Registrations and total users',
      buckets: keys,
      labels,
      status: users.ok ? 'ok' : 'error',
      source: { label: 'auth.users.created_at' },
      points: [
        { key: 'registrations', label: 'New registrations', values: registrationsPerBucket, kind: 'bar' },
        {
          key: 'total',
          label: 'Total users',
          values: cumulative(registrationsPerBucket, priorAccounts),
          kind: 'line',
          axis: 'right',
        },
      ],
    },
    {
      id: 'active',
      label: 'Active members',
      buckets: keys,
      labels,
      status: 'partial',
      note: activitySourceNote,
      source: { label: 'product tables' },
      points: [{ key: 'active', label: 'Members with a recorded action', values: activePerBucket, kind: 'bar' }],
    },
  ]

  const tierRows = [...profiles.counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tier, count]) => ({
      key: tier,
      label: TIER_LABELS[tier] ?? tier,
      value: count,
    }))

  const breakdowns: Breakdown[] = [
    {
      id: 'tiers',
      label: 'Membership tiers held today',
      rows: tierRows,
      status: profiles.available ? 'ok' : 'error',
      note: 'Current access, including plans granted by hand. Not purchases.',
      source: { label: 'user_profiles' },
    },
  ]

  // Who registered in this window and then did something we can see.
  const registeredIds = new Set(accounts.filter((user) => inWindow(user.created_at)).map((user) => user.id))
  const activatedIds = distinctSet(
    eventsInWindow.filter((event) => registeredIds.has(event.userId)),
    (event) => event.userId
  )

  const funnels: Funnel[] = [
    {
      id: 'acquisition',
      label: 'From visitor to paying member',
      steps: [
        {
          id: 'visitors',
          label: 'Visitors',
          value: null,
          status: 'not_tracked',
          note: 'No first-party web analytics exists yet.',
        },
        {
          id: 'registrations',
          label: 'Registered',
          value: users.ok ? registered : null,
          status: users.ok ? 'ok' : 'error',
        },
        {
          id: 'activated',
          label: 'Took a first action',
          value: users.ok ? activatedIds.size : null,
          status: 'partial',
          note: 'Registered in this window and has a recorded action.',
        },
        {
          id: 'checkout',
          label: 'Started checkout',
          value: snapshot
            ? snapshot.checkouts.filter((checkout) => within(checkout.createdAt, range.from, range.to)).length
            : null,
          status: snapshot ? 'ok' : 'not_tracked',
          note: snapshot
            ? 'Stripe checkout sessions created in this window.'
            : 'Stripe is not configured in this environment.',
        },
        {
          id: 'paid',
          label: 'Paid',
          value: revenue ? revenue.orders : null,
          status: revenue ? 'ok' : 'not_tracked',
          note: revenue ? 'Successful payments in this window, from Stripe.' : 'Needs Stripe.',
        },
      ],
    },
  ]

  return {
    section: 'overview',
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
    diagnostics: { truncated, failed, durationMs: Date.now() - started },
  }
}
