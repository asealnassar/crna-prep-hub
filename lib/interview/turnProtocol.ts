// The contract for a FAILED interview turn, shared by the API route (which
// produces it) and the interview page (which must recognise it). Pure: no
// server or browser dependencies, so both sides and the tests import it.
import type { InterviewTurnResponse } from './types.ts'

/**
 * What the applicant is told when a turn fails. These are UI notices, never
 * interviewer dialogue: they must not be stored in the transcript and must
 * never reach the model as something the interviewer said.
 *
 * The timeout wording is unchanged from before, so the applicant sees the same
 * message; what changed is that it can no longer become a transcript entry.
 */
export const TURN_TIMEOUT_NOTICE = 'The interviewer took too long to respond. Send your answer again.'
export const TURN_UNAVAILABLE_NOTICE = 'Interview service temporarily unavailable. Please try again.'

/** Thrown by the model call when the upstream request exceeds its time budget. */
export class TurnTimeoutError extends Error {
  readonly code = 'timeout'
  constructor() {
    super(TURN_TIMEOUT_NOTICE)
    this.name = 'TurnTimeoutError'
  }
}

export type TurnFailureCode = 'timeout' | 'unavailable'

export interface TurnFailureBody {
  ok: false
  error: TurnFailureCode
  message: string
  retryable: true
}

/**
 * The only shape a failed model turn is ever returned in.
 *
 * It deliberately carries NO `state`, `render`, `turnKind`, `questionAsked`,
 * `evaluation`, `finalReport` or `complete`. The previous error response echoed
 * the engine state "so a failed turn never corrupts the interview" -- but a
 * body holding state looked exactly like a successful turn to the page, which
 * then appended the timeout notice to the transcript as if the interviewer had
 * said it. With nothing turn-shaped in the body, no client can make that
 * mistake, including a browser still running the page from before this fix:
 * that page treats a body without `state` as a failure and rolls back.
 */
export function turnFailureBody(code: TurnFailureCode): TurnFailureBody {
  return {
    ok: false,
    error: code,
    message: code === 'timeout' ? TURN_TIMEOUT_NOTICE : TURN_UNAVAILABLE_NOTICE,
    retryable: true,
  }
}

export type TurnOutcome =
  | { ok: true; data: InterviewTurnResponse }
  | { ok: false; notice: string; code: string; retryable: boolean }

/**
 * Classifies a response from POST /api/interview.
 *
 * A turn exists only when the HTTP request succeeded AND the body carries
 * engine state. Everything else is a failure the caller must roll back and
 * never render as dialogue: a failed model call, an auth or allowance refusal,
 * a malformed body, and an error body in the old shape that echoed the state.
 */
export function readTurnResponse(httpOk: boolean, body: unknown): TurnOutcome {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  const failed = !httpOk || !b || b.ok === false || !b.state || typeof b.state !== 'object'
  if (!failed) return { ok: true, data: b as unknown as InterviewTurnResponse }

  const message = typeof b?.message === 'string' && b.message.trim() ? b.message : null
  // Older refusals (401/403/400) put their human-readable text in `error`.
  const errorText = typeof b?.error === 'string' && b.error.trim() ? b.error : null
  const code = b?.ok === false && errorText ? errorText : httpOk ? 'malformed' : 'http_error'
  const notice = message ?? (errorText && b?.ok !== false ? errorText : null) ?? TURN_UNAVAILABLE_NOTICE
  return { ok: false, notice, code, retryable: b?.retryable === true }
}
