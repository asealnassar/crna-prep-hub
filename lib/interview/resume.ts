import type { ChatMessage, InterviewState } from './types.ts'
import { normalizeState } from './state.ts'
import { MAX_TURNS_PER_INTERVIEW } from '@/lib/interviewSession'
import { isSystemNotice } from './modelInput.ts'
import { applyGrantAuthority, lengthAuthority } from './authority.ts'

// Shared with the turn route, so a resumed interview and a live one are held to
// the same precedence. Re-exported for the callers that already import it here.
export { applyGrantAuthority }

/**
 * Deciding whether an interview may be resumed, and rebuilding it safely.
 *
 * Everything here is pure: it takes rows that a caller has already read and
 * returns a verdict. The database access and the authentication live in the
 * route, so every rule below can be exercised directly in tests without a
 * network or a Supabase client.
 *
 * The governing principle is that nothing is reconstructed by inference. A
 * session either carries a complete, self-consistent interview or it is not
 * resumable, and the applicant is told so plainly. There is no repair path,
 * and in particular no path that calls the model to regenerate a question --
 * the turn that produced it was already spent.
 */

/** How long after the grant was issued an interview can still be resumed. */
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Why an interview cannot be resumed.
 *
 * `not_found` deliberately covers "no such session", "not yours" and "never
 * bound". A caller probing session ids must not be able to tell the three
 * apart, because the difference is exactly what maps out which ids exist.
 */
export type ResumeBlocker =
  | 'not_found'
  | 'completed'
  | 'abandoned'
  | 'expired'
  | 'turn_cap_reached'
  | 'no_state'
  | 'invalid_state'
  | 'state_transcript_mismatch'

export type ResumeVerdict =
  | { resumable: true; state: InterviewState; messages: ChatMessage[]; pendingTurn: PendingTurn | null }
  | { resumable: false; reason: ResumeBlocker }

/** The deferred half of a Practice checkpoint, as persisted. */
export interface PendingTurn {
  message: ChatMessage
  state: InterviewState
  questionAsked: string
  isFinal: boolean
}

/** The grant columns the decision needs. Read with the service role. */
export interface GrantRow {
  id: string
  user_id: string
  session_id: string | null
  turns_used: number | null
  completed: boolean | null
  abandoned_at: string | null
  created_at: string
  follow_ups_enabled?: boolean | null
  /**
   * The interview's length: 5 (Quick) or 10 (Full), written once when the
   * grant is issued. NULL on grants issued before Phase 3, which were all ten
   * questions. Applied over the stored state by applyGrantAuthority, so a
   * refresh cannot turn a Quick interview into a Full one or back.
   */
  max_primary_questions?: number | null
}

/** The session columns the decision needs. Written by the browser. */
export interface SessionRow {
  id: string
  user_id: string
  conversation: unknown
  engine_state: unknown
  pending_turn?: unknown
}

/** A transcript entry the applicant actually saw, in the shape the page renders. */
function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m.role === 'string' && typeof m.content === 'string'
}

/**
 * The transcript, exactly as stored, minus anything that was never the
 * interviewer speaking.
 *
 * A Phase 0 failure notice can sit in a transcript saved by a browser running
 * the older page, and replaying one as an interviewer turn is the defect that
 * phase existed to remove. Filtering here keeps a resumed interview at least as
 * clean as a fresh one; message ORDER is otherwise untouched, because the
 * stored order is the order the applicant read.
 */
export function restoreTranscript(conversation: unknown): ChatMessage[] | null {
  if (!Array.isArray(conversation)) return null
  const out: ChatMessage[] = []
  for (const raw of conversation) {
    if (!isChatMessage(raw)) return null
    if (raw.role === 'assistant' && isSystemNotice(raw.content)) continue
    out.push(raw)
  }
  return out
}

/**
 * Validates a persisted engine state hard enough to continue from it.
 *
 * normalizeState already clamps every counter into range, which is what the
 * turn route relies on. Resume needs one thing more: that the state and the
 * transcript describe the same interview. A state claiming question 7 against a
 * two-message transcript is not something to clamp into shape -- it is a sign
 * the two were written by different interviews, and continuing from it would
 * produce a coherent-looking interview that never happened.
 */
export function validateState(
  raw: unknown,
  messages: ChatMessage[],
  /**
   * How far ahead of the transcript the state may legitimately be.
   *
   * Zero for the interview's own state. ONE for a Practice checkpoint's
   * deferred state, which describes a question the model has already produced
   * but the applicant has not been shown yet -- so it is one question ahead of
   * the transcript by construction, not by corruption.
   */
  aheadAllowance = 0
): { ok: true; state: InterviewState } | { ok: false; reason: ResumeBlocker } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'no_state' }

  const candidate = raw as Record<string, unknown>
  // normalizeState defaults a missing number to a legal one, which is right for
  // a turn and wrong here: an absent question number means this row never held
  // a real interview state.
  if (typeof candidate.primaryQuestionNumber !== 'number') return { ok: false, reason: 'invalid_state' }
  if (candidate.mode !== 'real' && candidate.mode !== 'practice') return { ok: false, reason: 'invalid_state' }

  // The fallback is never reached for a well-formed row; it exists because
  // normalizeState requires one.
  const state = normalizeState(raw, {
    ...(raw as InterviewState),
    version: 1,
  } as InterviewState)

  if (state.complete) return { ok: false, reason: 'completed' }
  if (state.finalReport) return { ok: false, reason: 'completed' }
  if (state.primaryQuestionNumber < 1) return { ok: false, reason: 'invalid_state' }

  // One interviewer message per question at an absolute minimum: a question
  // cannot have been asked without having been said.
  const interviewerTurns = messages.filter((m) => m.role === 'assistant').length
  if (interviewerTurns + aheadAllowance < state.primaryQuestionNumber) {
    return { ok: false, reason: 'state_transcript_mismatch' }
  }
  if (messages.length === 0) return { ok: false, reason: 'state_transcript_mismatch' }

  return { ok: true, state }
}

/**
 * Validates a stored Practice checkpoint.
 *
 * Returning null is not a failure: most sessions have no checkpoint open. A
 * MALFORMED one is a failure, and deliberately fails the whole resume rather
 * than being dropped — silently discarding it would strand the applicant on a
 * review with a Continue button that has nothing to continue to, and the only
 * way to rebuild it is a model call the interview has already paid for.
 */
export function validatePendingTurn(
  raw: unknown,
  messages: ChatMessage[]
): { ok: true; pending: PendingTurn | null } | { ok: false; reason: ResumeBlocker } {
  if (raw === null || raw === undefined) return { ok: true, pending: null }
  if (typeof raw !== 'object') return { ok: false, reason: 'invalid_state' }

  const p = raw as Record<string, unknown>
  if (!isChatMessage(p.message)) return { ok: false, reason: 'invalid_state' }
  if (typeof p.isFinal !== 'boolean') return { ok: false, reason: 'invalid_state' }
  if (typeof p.questionAsked !== 'string') return { ok: false, reason: 'invalid_state' }

  const inner = validateState(p.state, messages, 1)
  if (!inner.ok) {
    // A final checkpoint legitimately carries a completed state: it holds the
    // closing line and the report until the applicant clicks Finish.
    if (p.isFinal && inner.reason === 'completed') {
      const forced = normalizeState(p.state, p.state as InterviewState)
      return { ok: true, pending: { message: p.message, state: forced, questionAsked: p.questionAsked, isFinal: true } }
    }
    return { ok: false, reason: 'invalid_state' }
  }

  return {
    ok: true,
    pending: { message: p.message, state: inner.state, questionAsked: p.questionAsked, isFinal: p.isFinal },
  }
}

/** True once the grant is old enough that the interview is no longer offered. */
export function isExpired(grant: GrantRow, now: number = Date.now()): boolean {
  const issued = Date.parse(grant.created_at)
  if (!Number.isFinite(issued)) return true
  return now - issued > RESUME_WINDOW_MS
}

/**
 * The whole decision, in one place.
 *
 * Ownership is checked against BOTH rows rather than one: a session the caller
 * owns is not enough if the grant behind it belongs to someone else, and the
 * reverse is equally true. The binding must also point back at this exact
 * session, so a grant cannot be aimed at a different transcript.
 */
export function evaluateResume(
  session: SessionRow | null,
  grant: GrantRow | null,
  userId: string,
  now: number = Date.now()
): ResumeVerdict {
  if (!session || session.user_id !== userId) return { resumable: false, reason: 'not_found' }
  if (!grant || grant.user_id !== userId) return { resumable: false, reason: 'not_found' }
  if (grant.session_id !== session.id) return { resumable: false, reason: 'not_found' }

  if (grant.abandoned_at) return { resumable: false, reason: 'abandoned' }
  if (grant.completed) return { resumable: false, reason: 'completed' }
  if ((grant.turns_used ?? 0) >= MAX_TURNS_PER_INTERVIEW) {
    return { resumable: false, reason: 'turn_cap_reached' }
  }
  // Server-issued timestamp. interview_sessions.created_at is written by the
  // browser, so using it would let a client hold an interview open forever.
  if (isExpired(grant, now)) return { resumable: false, reason: 'expired' }
  // A length the grant could never legitimately hold is not guessed at. The
  // CHECK constraint makes this unreachable; the turn route refuses it too.
  if (lengthAuthority(grant).source === 'invalid') return { resumable: false, reason: 'invalid_state' }

  const messages = restoreTranscript(session.conversation)
  if (!messages) return { resumable: false, reason: 'invalid_state' }

  const stateCheck = validateState(session.engine_state, messages)
  if (!stateCheck.ok) return { resumable: false, reason: stateCheck.reason }

  const pendingCheck = validatePendingTurn(session.pending_turn, messages)
  if (!pendingCheck.ok) return { resumable: false, reason: pendingCheck.reason }

  const state = applyGrantAuthority(stateCheck.state, grant)
  const pending = pendingCheck.pending
    ? { ...pendingCheck.pending, state: applyGrantAuthority(pendingCheck.pending.state, grant) }
    : null

  return { resumable: true, state, messages, pendingTurn: pending }
}

/** One-line explanation for the applicant. Never names another user's data. */
export function blockerMessage(reason: ResumeBlocker): string {
  switch (reason) {
    case 'completed':
      return 'This interview is already complete. Start a new one to keep practicing.'
    case 'abandoned':
      return 'This interview was ended. Start a new one to keep practicing.'
    case 'expired':
      return 'Interviews can be resumed for 24 hours. This one has expired, but the transcript is still in your history.'
    case 'turn_cap_reached':
      return 'This interview has reached its maximum length. Please start a new one.'
    case 'no_state':
    case 'invalid_state':
    case 'state_transcript_mismatch':
      return 'This interview cannot be resumed. The transcript is still in your history.'
    case 'not_found':
    default:
      return 'This interview is no longer available to resume.'
  }
}
