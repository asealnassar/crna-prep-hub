/**
 * What one interview IS, for counting purposes.
 *
 * The old dashboard mixed three different things and called them all
 * interviews:
 *
 *   * a row in `user_asked_questions` is ONE PRIMARY QUESTION. A ten-question
 *     mock writes ten of them, so counting these as interviews multiplied every
 *     total by the length of the interview.
 *   * a row in `interview_sessions` is a TRANSCRIPT THE BROWSER SAVED. It is
 *     written by the client, so a member can create one without an interview
 *     ever happening.
 *   * a row in `interview_grants` is the SERVER'S OWN RECORD that an interview
 *     was authorised and charged. Nothing else adds one: resuming reuses it, a
 *     retried start reuses it, and follow-up questions never create one.
 *
 * Grants are therefore the unit here, and this module decides what state each
 * one is in. The distinctions matter: a grant voided because the entitlement
 * charge failed is not an interview anyone started, and an interview somebody
 * gave up on is not a completed mock.
 */

export type GrantRow = {
  readonly id?: string | null
  readonly user_id?: string | null
  readonly mode?: string | null
  readonly interview_type?: string | null
  readonly completed?: boolean | null
  readonly created_at: string
  readonly follow_ups_enabled?: boolean | null
  readonly session_id?: string | null
  readonly abandoned_at?: string | null
  readonly max_primary_questions?: number | null
}

export type GrantState =
  /** Ran to a final report. */
  | 'completed'
  /** The applicant gave it up. Never a completed mock. */
  | 'abandoned'
  /** The entitlement charge failed, so the grant id never left the server. */
  | 'voided'
  /** Still resumable. */
  | 'in_progress'
  /** Neither finished nor given up, and past the point it could be resumed. */
  | 'unfinished'

/** An interview stays resumable for 24 hours (lib/interview/resume.ts). */
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000

export function grantState(row: GrantRow, now: Date = new Date()): GrantState {
  if (row.completed === true) return 'completed'

  if (row.abandoned_at) {
    // A grant that was never bound to a session was never handed to a browser:
    // issueInterview() voids it that way when the charge fails. A grant with a
    // session is one the applicant actually ran and then abandoned.
    return row.session_id ? 'abandoned' : 'voided'
  }

  const age = now.getTime() - Date.parse(row.created_at)
  if (Number.isNaN(age)) return 'unfinished'
  return age <= RESUME_WINDOW_MS ? 'in_progress' : 'unfinished'
}

/** A voided grant was never an interview. Everything else was started. */
export function isStarted(state: GrantState): boolean {
  return state !== 'voided'
}

export const INTERVIEW_TYPE_LABELS: Record<string, string> = {
  clinical: 'Clinical',
  emotional: 'Emotional intelligence',
  mixed: 'Mixed',
  custom: 'Custom topic',
}

export const INTERVIEW_MODE_LABELS: Record<string, string> = {
  practice: 'Practice (feedback as you go)',
  real: 'Real interview (feedback at the end)',
}

export function typeLabel(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
  return INTERVIEW_TYPE_LABELS[value] ?? value
}

export function modeLabel(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
  return INTERVIEW_MODE_LABELS[value] ?? value
}

/**
 * Quick and Full, and the third case that is neither.
 *
 * NULL is not missing data: every grant issued before the Quick/Full choice
 * shipped was a ten-question interview, and the application still reads it
 * that way. Counting those as "Full" would overstate how often Full is chosen
 * now, so they are named for what they are.
 */
export function lengthLabel(value: number | null | undefined): string {
  if (value === 5) return 'Quick (5 questions)'
  if (value === 10) return 'Full (10 questions)'
  if (value === null || value === undefined) return 'Before Quick/Full existed (10 questions)'
  return `${value} questions`
}

export function followUpLabel(value: boolean | null | undefined): string {
  if (value === true) return 'Follow-ups on'
  if (value === false) return 'Follow-ups off'
  return 'Before the choice existed (on)'
}

export type GrantTotals = {
  readonly started: number
  readonly completed: number
  readonly abandoned: number
  readonly voided: number
  readonly inProgress: number
  readonly unfinished: number
}

export function totalGrants(rows: readonly GrantRow[], now: Date = new Date()): GrantTotals {
  let completed = 0
  let abandoned = 0
  let voided = 0
  let inProgress = 0
  let unfinished = 0

  for (const row of rows) {
    switch (grantState(row, now)) {
      case 'completed':
        completed++
        break
      case 'abandoned':
        abandoned++
        break
      case 'voided':
        voided++
        break
      case 'in_progress':
        inProgress++
        break
      default:
        unfinished++
    }
  }

  return {
    started: completed + abandoned + inProgress + unfinished,
    completed,
    abandoned,
    voided,
    inProgress,
    unfinished,
  }
}

/**
 * Completion rate over interviews that have had their chance to finish.
 *
 * Interviews still inside their resume window are excluded from the
 * denominator: one started ten minutes ago has not failed to complete, and
 * counting it as a miss makes the rate sag every time the window ends near now.
 */
export function completionRate(totals: GrantTotals): number | null {
  const settled = totals.completed + totals.abandoned + totals.unfinished
  if (settled <= 0) return null
  return (totals.completed / settled) * 100
}
