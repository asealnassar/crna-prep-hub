import type { Reader } from './reader'

/**
 * Who did something, and when — assembled from the tables that already record
 * product actions.
 *
 * THE HONEST NAME FOR THIS IS A LOWER BOUND. Nothing in this project records a
 * page view, so a member who signs in, reads their saved schools and leaves is
 * invisible here. What these tables hold is actions that WROTE a row: an
 * interview started, a resume saved, a transcript calculated, a school unlock
 * requested. Every figure derived from this is labelled accordingly, because
 * calling it "active users" without that caveat would be inventing a number.
 *
 * Each source is read independently. One that fails — the GPA tables grant
 * service_role nothing by design — is reported as unavailable rather than
 * quietly lowering the count.
 */

export type ActivityFeature = 'interview' | 'resume' | 'gpa' | 'schools' | 'feedback' | 'messages'

export type ActivityEvent = {
  readonly userId: string
  readonly at: string
  readonly feature: ActivityFeature
}

export type ActivitySourceState = {
  readonly table: string
  readonly feature: ActivityFeature
  readonly available: boolean
  readonly reason?: string
  readonly truncated: boolean
}

export type ActivitySnapshot = {
  readonly events: ActivityEvent[]
  readonly sources: ActivitySourceState[]
  /** Sources that could not be read at all. */
  readonly unavailable: ActivitySourceState[]
  readonly truncated: string[]
}

type SourceSpec = {
  readonly table: string
  readonly dateColumn: string
  readonly userColumn: string
  readonly feature: ActivityFeature
  readonly tiebreak?: string
}

/**
 * Every table that records "a member did something", with the column that
 * dates it. Tables the browser can forge (interview_sessions,
 * user_asked_questions) are included deliberately: for "was this person
 * active", a row they wrote themselves is still evidence they were here.
 */
export const ACTIVITY_SOURCES: readonly SourceSpec[] = [
  { table: 'interview_grants', dateColumn: 'created_at', userColumn: 'user_id', feature: 'interview', tiebreak: 'id' },
  { table: 'user_asked_questions', dateColumn: 'asked_at', userColumn: 'user_id', feature: 'interview', tiebreak: 'id' },
  { table: 'interview_sessions', dateColumn: 'created_at', userColumn: 'user_id', feature: 'interview', tiebreak: 'id' },
  { table: 'resumes', dateColumn: 'created_at', userColumn: 'user_id', feature: 'resume', tiebreak: 'id' },
  { table: 'resume_ai_usage', dateColumn: 'created_at', userColumn: 'user_id', feature: 'resume', tiebreak: 'id' },
  { table: 'resume_imports', dateColumn: 'created_at', userColumn: 'user_id', feature: 'resume', tiebreak: 'id' },
  { table: 'gpa_calculations', dateColumn: 'created_at', userColumn: 'user_id', feature: 'gpa', tiebreak: 'id' },
  { table: 'school_unlock_requests', dateColumn: 'requested_at', userColumn: 'user_id', feature: 'schools', tiebreak: 'id' },
  { table: 'saved_schools', dateColumn: 'created_at', userColumn: 'user_id', feature: 'schools' },
  { table: 'feature_requests', dateColumn: 'created_at', userColumn: 'user_id', feature: 'feedback', tiebreak: 'id' },
  { table: 'thread_messages', dateColumn: 'created_at', userColumn: 'sender_id', feature: 'messages', tiebreak: 'id' },
]

export const FEATURE_LABELS: Record<ActivityFeature, string> = {
  interview: 'Mock interview',
  resume: 'Resume Builder',
  gpa: 'GPA Analyzer',
  schools: 'Schools',
  feedback: 'Feedback',
  messages: 'Messages',
}

export async function loadActivity(
  reader: Reader,
  window: { from: string | null; to: string },
  sources: readonly SourceSpec[] = ACTIVITY_SOURCES
): Promise<ActivitySnapshot> {
  const events: ActivityEvent[] = []
  const states: ActivitySourceState[] = []
  const truncated: string[] = []

  const reads = await Promise.all(
    sources.map(async (source) => {
      const result = await reader.rows<Record<string, unknown>>(
        source.table,
        `${source.userColumn}, ${source.dateColumn}`,
        {
          dateColumn: source.dateColumn,
          from: window.from,
          to: window.to,
          tiebreak: source.tiebreak,
        }
      )
      return { source, result }
    })
  )

  for (const { source, result } of reads) {
    if (!result.ok) {
      states.push({
        table: source.table,
        feature: source.feature,
        available: false,
        reason: result.reason === 'denied'
          ? `service_role has no privilege on ${source.table}`
          : result.reason === 'missing'
            ? `${source.table}.${source.dateColumn} does not exist`
            : result.detail,
        truncated: false,
      })
      continue
    }

    for (const row of result.rows) {
      const userId = row[source.userColumn]
      const at = row[source.dateColumn]
      if (typeof userId !== 'string' || typeof at !== 'string') continue
      events.push({ userId, at, feature: source.feature })
    }

    states.push({ table: source.table, feature: source.feature, available: true, truncated: result.truncated })
    if (result.truncated) truncated.push(source.table)
  }

  return {
    events,
    sources: states,
    unavailable: states.filter((state) => !state.available),
    truncated,
  }
}

/** The last time each member did anything we can see. */
export function lastSeen(events: readonly ActivityEvent[]): Map<string, string> {
  const seen = new Map<string, string>()
  for (const event of events) {
    const current = seen.get(event.userId)
    if (!current || event.at > current) seen.set(event.userId, event.at)
  }
  return seen
}

/** How many actions each member took. */
export function actionCounts(events: readonly ActivityEvent[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.userId, (counts.get(event.userId) ?? 0) + 1)
  return counts
}

/** Distinct members per feature, for adoption. */
export function usersByFeature(events: readonly ActivityEvent[]): Map<ActivityFeature, Set<string>> {
  const users = new Map<ActivityFeature, Set<string>>()
  for (const event of events) {
    const set = users.get(event.feature) ?? new Set<string>()
    set.add(event.userId)
    users.set(event.feature, set)
  }
  return users
}
