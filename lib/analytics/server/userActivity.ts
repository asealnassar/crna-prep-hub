import { grantState, type GrantRow } from '../interviews'
import { actionCounts, lastSeen, loadActivity, usersByFeature, type ActivityFeature } from './activity'
import { loadProfiles } from './profiles'
import { Diagnostics } from './failures'
import type { Reader } from './reader'

/**
 * The member list, with what each person has actually done.
 *
 * The page this replaces shipped every account, every profile and every
 * question row to the browser and joined them there, which is why its columns
 * were wrong: the question read stopped at 1000 rows, so most members appeared
 * to have done nothing. Here the joining happens on the server, over complete
 * reads, and the browser receives one page of rows.
 *
 * Interview counts come from `interview_grants` — one row per authorised
 * interview — not from question rows, which would multiply every total by the
 * length of the interview.
 */

export type UserActivityRow = {
  readonly userId: string
  readonly email: string | null
  readonly tier: string
  readonly signedUpAt: string
  readonly emailConfirmed: boolean
  readonly lastActiveAt: string | null
  readonly actions: number
  readonly interviewsStarted: number
  readonly interviewsCompleted: number
  readonly features: readonly ActivityFeature[]
}

export type UserActivitySort = 'recent' | 'signup' | 'actions' | 'interviews' | 'email'

export type UserActivityQuery = {
  readonly search?: string
  readonly tier?: string
  readonly sort?: UserActivitySort
  readonly page?: number
  readonly pageSize?: number
}

export type UserActivityResult = {
  readonly rows: UserActivityRow[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly generatedAt: string
  readonly diagnostics: ReturnType<Diagnostics['finish']>
}

const MAX_PAGE_SIZE = 100

export async function buildUserActivity(reader: Reader, query: UserActivityQuery = {}): Promise<UserActivityResult> {
  const diagnostics = new Diagnostics()
  const now = new Date()

  const [users, profiles, activity, grants] = await Promise.all([
    reader.authUsers(),
    loadProfiles(reader),
    // All of it: "when did this person last do anything" is the column an
    // admin actually looks at, and a window would answer a different question.
    loadActivity(reader, { from: null, to: now.toISOString() }),
    reader.rows<GrantRow>('interview_grants', 'user_id, completed, created_at, session_id, abandoned_at', {
      dateColumn: 'created_at',
      tiebreak: 'id',
    }),
  ])

  if (!users.ok) diagnostics.note('auth.users', 'failed', users.detail)
  if (!profiles.available) diagnostics.note('user_profiles', 'failed', profiles.reason ?? 'unavailable')
  for (const source of activity.unavailable) {
    diagnostics.failed.push({ source: source.table, reason: source.reason ?? 'unavailable' })
  }
  for (const table of activity.truncated) diagnostics.cut(table)

  const seen = lastSeen(activity.events)
  const counts = actionCounts(activity.events)

  const featuresByUser = new Map<string, Set<ActivityFeature>>()
  for (const [feature, members] of usersByFeature(activity.events)) {
    for (const userId of members) {
      const set = featuresByUser.get(userId) ?? new Set<ActivityFeature>()
      set.add(feature)
      featuresByUser.set(userId, set)
    }
  }

  const started = new Map<string, number>()
  const completed = new Map<string, number>()
  if (grants.ok) {
    if (grants.truncated) diagnostics.cut('interview_grants')
    for (const row of grants.rows) {
      const userId = row.user_id
      if (!userId) continue
      const state = grantState(row, now)
      if (state === 'voided') continue
      started.set(userId, (started.get(userId) ?? 0) + 1)
      if (state === 'completed') completed.set(userId, (completed.get(userId) ?? 0) + 1)
    }
  } else {
    diagnostics.note('interview_grants', grants.reason, grants.detail)
  }

  const all: UserActivityRow[] = (users.ok ? users.rows : []).map((user) => ({
    userId: user.id,
    email: user.email,
    tier: profiles.tierById.get(user.id) ?? '(no profile)',
    signedUpAt: user.created_at,
    emailConfirmed: !!user.email_confirmed_at,
    lastActiveAt: seen.get(user.id) ?? null,
    actions: counts.get(user.id) ?? 0,
    interviewsStarted: started.get(user.id) ?? 0,
    interviewsCompleted: completed.get(user.id) ?? 0,
    features: [...(featuresByUser.get(user.id) ?? [])].sort(),
  }))

  const search = (query.search ?? '').trim().toLowerCase()
  const tier = (query.tier ?? '').trim().toLowerCase()
  const filtered = all.filter((row) => {
    if (search && !(row.email ?? '').toLowerCase().includes(search)) return false
    if (tier && tier !== 'all' && row.tier !== tier) return false
    return true
  })

  const sort: UserActivitySort = query.sort ?? 'recent'
  filtered.sort((a, b) => {
    switch (sort) {
      case 'signup':
        return b.signedUpAt.localeCompare(a.signedUpAt)
      case 'actions':
        return b.actions - a.actions || b.signedUpAt.localeCompare(a.signedUpAt)
      case 'interviews':
        return b.interviewsStarted - a.interviewsStarted || b.signedUpAt.localeCompare(a.signedUpAt)
      case 'email':
        return (a.email ?? '').localeCompare(b.email ?? '')
      default:
        // Never active sorts last rather than first.
        if (!a.lastActiveAt && !b.lastActiveAt) return b.signedUpAt.localeCompare(a.signedUpAt)
        if (!a.lastActiveAt) return 1
        if (!b.lastActiveAt) return -1
        return b.lastActiveAt.localeCompare(a.lastActiveAt)
    }
  })

  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), MAX_PAGE_SIZE)
  const page = Math.max(query.page ?? 1, 1)
  const start = (page - 1) * pageSize

  return {
    rows: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    generatedAt: now.toISOString(),
    diagnostics: diagnostics.finish(),
  }
}
