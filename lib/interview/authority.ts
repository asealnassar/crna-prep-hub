import type { InterviewState } from './types.ts'
import {
  MAX_PRIMARY_QUESTIONS,
  QUICK_PRIMARY_QUESTIONS,
  isInterviewLength,
  withInterviewLength,
} from './state.ts'
import type { InterviewLength } from './state.ts'

/**
 * What the server, rather than the browser, decides about an interview.
 *
 * The engine state travels with every request, so anything it says is only a
 * claim. The grant is written once, by the server, when the interview starts:
 * whatever it records wins over the state on every later turn and on resume,
 * which is what stops an edited state -- or a refresh -- from quietly changing
 * the interview the applicant chose. Both the turn route and resume call
 * applyGrantAuthority, so there is one precedence, not two to keep in step.
 */

/** The two lengths as the browser names them. */
export type LengthChoice = 'quick' | 'full'

/**
 * Validates the length the browser asks for when STARTING an interview.
 *
 * Absent means Full: a page loaded before Phase 3 sends nothing, and Full is
 * the interview it was built for. Anything present must be exactly one of the
 * two names -- a number, a larger length, or a typo is refused rather than
 * rounded to something plausible.
 */
export function parseRequestedLength(
  value: unknown
): { ok: true; length: InterviewLength } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, length: MAX_PRIMARY_QUESTIONS }
  if (value === 'quick') return { ok: true, length: QUICK_PRIMARY_QUESTIONS }
  if (value === 'full') return { ok: true, length: MAX_PRIMARY_QUESTIONS }
  return { ok: false }
}

/** The grant columns authority is read from. Any subset may be missing. */
export interface GrantAuthorityFields {
  follow_ups_enabled?: boolean | null
  max_primary_questions?: number | null
}

/**
 * The grant's answer to "how long is this interview".
 *
 *   grant        5 or 10, written by Phase 3 code. Authoritative, and V2 by
 *                construction: Phase 3 starts nothing else.
 *   historical   NULL. The grant predates Phase 3, when every interview was ten
 *                questions -- so it is Full, and its policy version is whatever
 *                its state says, exactly as Phase 2 reads it.
 *   unavailable  No grant row, or no column yet (the migration has not run).
 *                The grant cannot answer -- and a Quick interview cannot exist
 *                without a grant that says so, because createGrant refuses to
 *                start one. So this is Full, whatever the state claims.
 *   invalid      Any other value. The CHECK constraint makes this impossible to
 *                store; if one appears anyway the interview is refused, never
 *                guessed at.
 */
export type LengthAuthority =
  | { source: 'grant'; length: InterviewLength }
  | { source: 'historical' }
  | { source: 'unavailable' }
  | { source: 'invalid' }

export function lengthAuthority(grant: GrantAuthorityFields | null | undefined): LengthAuthority {
  if (!grant || grant.max_primary_questions === undefined) return { source: 'unavailable' }
  const value = grant.max_primary_questions
  if (value === null) return { source: 'historical' }
  if (isInterviewLength(value)) return { source: 'grant', length: value }
  return { source: 'invalid' }
}

export function applyLengthAuthority(state: InterviewState, authority: LengthAuthority): InterviewState {
  switch (authority.source) {
    case 'grant':
      return withInterviewLength(state, authority.length, { forceV2: true })
    case 'historical':
      return withInterviewLength(state, MAX_PRIMARY_QUESTIONS)
    case 'unavailable':
      // Only an explicit grant value can make an interview Quick. A Full state
      // is left exactly as Phase 2 read it; a state claiming anything else is
      // held to Full.
      return state.maxPrimaryQuestions === MAX_PRIMARY_QUESTIONS
        ? state
        : withInterviewLength(state, MAX_PRIMARY_QUESTIONS)
    default:
      // invalid: the caller refuses the interview before it gets here.
      return state
  }
}

/**
 * Fields the grant owns outright, applied over whatever the browser stored.
 *
 * Callers must refuse the interview first when lengthAuthority(grant) is
 * 'invalid'; this function only ever applies an answer the grant actually gave.
 */
export function applyGrantAuthority(
  state: InterviewState,
  grant: GrantAuthorityFields | null | undefined
): InterviewState {
  let next = state
  if (typeof grant?.follow_ups_enabled === 'boolean') {
    next = { ...next, followUpsEnabled: grant.follow_ups_enabled }
  }
  return applyLengthAuthority(next, lengthAuthority(grant))
}
