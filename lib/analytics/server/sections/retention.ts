import { bucketKeys, bucketLabel, bucketOf, dayKey, within, type ResolvedRange } from '../../range'
import { distinctSet, percent } from '../../aggregate'
import type { Breakdown, Metric, SectionPayload, Series } from '../../types'
import { FEATURE_LABELS, actionCounts, lastSeen, loadActivity, usersByFeature } from '../activity'
import { TIER_LABELS, loadProfiles } from '../profiles'
import { Diagnostics } from '../failures'
import type { Reader } from '../reader'

/**
 * Retention, from the only activity this project records: rows members wrote.
 *
 * Everything here inherits one caveat, stated on every figure. Without page
 * views, a member who signs in and reads is indistinguishable from one who
 * never came back. These numbers are therefore a floor on engagement, and the
 * honest way to read "dormant" is "has not DONE anything", not "has not
 * visited".
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** How far back dormancy is judged. Bounds the read and covers 30 and 90 days. */
const HORIZON_DAYS = 180

export async function buildRetention(reader: Reader, range: ResolvedRange): Promise<SectionPayload> {
  const diagnostics = new Diagnostics()
  const now = new Date()
  const horizonStart = new Date(now.getTime() - HORIZON_DAYS * DAY_MS).toISOString()

  // Dormancy needs more history than the selected window, so the read covers
  // whichever reaches furthest back.
  const activityFrom =
    range.from === null ? null : range.from < horizonStart ? range.from : horizonStart

  const [users, profiles, activity] = await Promise.all([
    reader.authUsers(),
    loadProfiles(reader),
    loadActivity(reader, { from: activityFrom, to: range.to }),
  ])

  if (!users.ok) diagnostics.note('auth.users', 'failed', users.detail)
  if (!profiles.available) diagnostics.note('user_profiles', 'failed', profiles.reason ?? 'unavailable')
  for (const source of activity.unavailable) {
    diagnostics.failed.push({ source: source.table, reason: source.reason ?? 'unavailable' })
  }
  for (const table of activity.truncated) diagnostics.cut(table)

  const accounts = users.ok ? users.rows : []
  const signupById = new Map(accounts.map((user) => [user.id, user.created_at]))
  const events = activity.events
  const seen = lastSeen(events)
  const counts = actionCounts(events)

  const activityNote =
    'Counts members who wrote a row: an interview, a resume, a GPA calculation, a saved school, a request or a message. Reading the site leaves no record, so this is a floor.'

  // --- trailing activity windows ---------------------------------------------
  const activeSince = (days: number) => {
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString()
    return distinctSet(
      events.filter((event) => event.at >= cutoff),
      (event) => event.userId
    ).size
  }

  const dau = activeSince(1)
  const wau = activeSince(7)
  const mau = activeSince(30)

  // --- new versus returning inside the selected window -----------------------
  const eventsInWindow = events.filter((event) => within(event.at, range.from, range.to))
  const activeInWindow = distinctSet(eventsInWindow, (event) => event.userId)

  let newActive = 0
  let returningActive = 0
  for (const userId of activeInWindow) {
    const signedUp = signupById.get(userId)
    if (signedUp && within(signedUp, range.from, range.to)) newActive++
    else returningActive++
  }

  const keys = bucketKeys(range.from ?? range.to, range.to, range.bucket, range.timezone)
  const labels = keys.map((key) => bucketLabel(key, range.bucket))

  // Per bucket, split the active members by whether they joined in that bucket.
  const newPerBucket = new Array(keys.length).fill(0)
  const returningPerBucket = new Array(keys.length).fill(0)
  const bucketIndex = new Map(keys.map((key, index) => [key, index]))
  const seenPerBucket: Map<number, Set<string>> = new Map()

  for (const event of eventsInWindow) {
    let key: string
    try {
      key = bucketOf(dayKey(event.at, range.timezone), range.bucket)
    } catch {
      continue
    }
    const index = bucketIndex.get(key)
    if (index === undefined) continue
    const already = seenPerBucket.get(index) ?? new Set<string>()
    if (already.has(event.userId)) continue
    already.add(event.userId)
    seenPerBucket.set(index, already)

    const signedUp = signupById.get(event.userId)
    let signupKey: string | null = null
    if (signedUp) {
      try {
        signupKey = bucketOf(dayKey(signedUp, range.timezone), range.bucket)
      } catch {
        signupKey = null
      }
    }
    if (signupKey === key) newPerBucket[index]++
    else returningPerBucket[index]++
  }

  // --- dormancy ---------------------------------------------------------------
  const dormancyBuckets = { recent: 0, month: 0, quarter: 0, stale: 0, silent: 0 }
  for (const user of accounts) {
    const last = seen.get(user.id)
    if (!last) {
      dormancyBuckets.silent++
      continue
    }
    const days = (now.getTime() - Date.parse(last)) / DAY_MS
    if (days <= 7) dormancyBuckets.recent++
    else if (days <= 30) dormancyBuckets.month++
    else if (days <= 90) dormancyBuckets.quarter++
    else dormancyBuckets.stale++
  }

  const dormant30 = dormancyBuckets.quarter + dormancyBuckets.stale
  const totalActions = eventsInWindow.length

  const metrics: Metric[] = [
    {
      id: 'dau',
      label: 'Active today',
      value: users.ok ? dau : null,
      status: 'partial',
      note: `${activityNote} Trailing 24 hours, regardless of the window above.`,
      source: { label: 'product tables' },
    },
    {
      id: 'wau',
      label: 'Active this week',
      value: users.ok ? wau : null,
      status: 'partial',
      note: `${activityNote} Trailing 7 days.`,
      source: { label: 'product tables' },
    },
    {
      id: 'mau',
      label: 'Active this month',
      value: users.ok ? mau : null,
      status: 'partial',
      note: `${activityNote} Trailing 30 days.`,
      source: { label: 'product tables' },
    },
    {
      id: 'stickiness',
      label: 'Stickiness (daily of monthly)',
      value: percent(dau, mau),
      unit: 'percent',
      status: 'partial',
      note: 'Share of this month’s active members who were active today.',
      source: { label: 'product tables' },
    },
    {
      id: 'new_active',
      label: 'Active and new',
      value: accounts.length > 0 ? newActive : null,
      status: 'partial',
      note: 'Members who joined inside this window and did something in it.',
      source: { label: 'auth.users + product tables' },
    },
    {
      id: 'returning_active',
      label: 'Active and returning',
      value: accounts.length > 0 ? returningActive : null,
      status: 'partial',
      note: 'Members who joined before this window and came back to do something in it.',
      source: { label: 'auth.users + product tables' },
    },
    {
      id: 'actions_per_active',
      label: 'Actions per active member',
      value: activeInWindow.size > 0 ? totalActions / activeInWindow.size : null,
      unit: 'score',
      status: 'partial',
      note: 'Recorded actions in this window, divided by the members who made them.',
      source: { label: 'product tables' },
    },
    {
      id: 'dormant_30',
      label: 'No activity in 30+ days',
      value: users.ok ? dormant30 : null,
      status: 'partial',
      note: `Accounts whose last recorded action is more than 30 days old. Dormancy is judged over the last ${HORIZON_DAYS} days.`,
      source: { label: 'auth.users + product tables' },
    },
    {
      id: 'never_active',
      label: 'Never took a recorded action',
      value: users.ok ? dormancyBuckets.silent : null,
      status: 'partial',
      note: `No row written by this account in the last ${HORIZON_DAYS} days. Some of them read the site without leaving a trace.`,
      source: { label: 'auth.users + product tables' },
    },
  ]

  const series: Series[] = [
    {
      id: 'new_vs_returning',
      label: 'Active members: new and returning',
      buckets: keys,
      labels,
      status: 'partial',
      note: activityNote,
      source: { label: 'auth.users + product tables' },
      points: [
        { key: 'new', label: 'New', values: newPerBucket, kind: 'bar' },
        { key: 'returning', label: 'Returning', values: returningPerBucket, kind: 'bar' },
      ],
    },
  ]

  // --- engagement by tier -----------------------------------------------------
  const tierActive = new Map<string, Set<string>>()
  const tierActions = new Map<string, number>()
  for (const event of eventsInWindow) {
    const tier = profiles.tierById.get(event.userId) ?? '(not recorded)'
    const set = tierActive.get(tier) ?? new Set<string>()
    set.add(event.userId)
    tierActive.set(tier, set)
    tierActions.set(tier, (tierActions.get(tier) ?? 0) + 1)
  }

  const tierRows = [...profiles.counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tier, members]) => {
      const active = tierActive.get(tier)?.size ?? 0
      return {
        key: tier,
        label: TIER_LABELS[tier] ?? tier,
        value: active,
        note: `${active} of ${members} members active · ${(tierActions.get(tier) ?? 0).toLocaleString()} actions`,
      }
    })

  const featureUsers = usersByFeature(eventsInWindow)
  const adoptionRows = [...featureUsers.entries()]
    .map(([feature, set]) => ({
      key: feature,
      label: FEATURE_LABELS[feature],
      value: set.size,
      note:
        activeInWindow.size > 0
          ? `${Math.round((set.size / activeInWindow.size) * 100)}% of active members`
          : undefined,
    }))
    .sort((a, b) => b.value - a.value)

  const breakdowns: Breakdown[] = [
    {
      id: 'engagement_by_tier',
      label: 'Active members by membership tier',
      rows: tierRows,
      status: profiles.available ? 'partial' : 'error',
      note: 'Tier as it stands today — the column keeps no history, so a member who upgraded mid-window counts under their current tier.',
      source: { label: 'user_profiles + product tables' },
    },
    {
      id: 'feature_adoption',
      label: 'Features used by active members',
      rows: adoptionRows,
      status: 'partial',
      note: activityNote,
      source: { label: 'product tables' },
    },
    {
      id: 'dormancy',
      label: 'How recently each account did something',
      status: 'partial',
      note: `Every account, by the age of its last recorded action, over the last ${HORIZON_DAYS} days.`,
      source: { label: 'auth.users + product tables' },
      rows: [
        { key: 'recent', label: 'Within 7 days', value: dormancyBuckets.recent },
        { key: 'month', label: '8 to 30 days', value: dormancyBuckets.month },
        { key: 'quarter', label: '31 to 90 days', value: dormancyBuckets.quarter },
        { key: 'stale', label: 'More than 90 days', value: dormancyBuckets.stale },
        { key: 'silent', label: 'No recorded action', value: dormancyBuckets.silent },
      ],
    },
  ]

  return {
    section: 'retention',
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
    funnels: [],
    diagnostics: diagnostics.finish(),
  }
}
