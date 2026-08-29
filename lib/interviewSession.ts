import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_PRIMARY_QUESTIONS, FOLLOW_UP_BUDGET } from '@/lib/interview/state'

/**
 * Server-owned authorization for an in-progress interview.
 *
 * The engine state travels with the request, so continuing an interview used
 * to require nothing but a plausible-looking JSON body: a free user who had
 * spent their allowance could hand-craft `state` and keep spending model
 * calls indefinitely. A grant row is created by the server when an interview
 * is legitimately started, and every later turn must present its id.
 *
 * Deliberately separate from `interview_sessions`, which the browser writes
 * directly (conversation, engine_state, scores). A table the client can insert
 * into cannot authorize the client: a user could fabricate a row and "continue"
 * it. This table is written only with the service role and carries no
 * conversation content — just who, when, how far, and whether it is finished.
 */

/**
 * Ceiling on model calls for one interview, derived from the engine's own
 * limits: every primary question, the whole follow-up budget, the final
 * report, and a small margin for retried turns.
 *
 * COUPLING: this value is duplicated as a literal inside the
 * consume_interview_turn() SQL function, because a plpgsql function cannot
 * import a TypeScript constant and a caller-supplied maximum would be exactly
 * the parameter an attacker wants. The database is the authority; this
 * constant only mirrors it. Changing one REQUIRES changing the other —
 * see supabase/migrations/20260830_002_interview_grants.sql.
 */
export const MAX_TURNS_PER_INTERVIEW = MAX_PRIMARY_QUESTIONS + FOLLOW_UP_BUDGET + 6

export type InterviewGrant = {
  id: string
  user_id: string
  turns_used: number
  completed: boolean
}

/** Postgres "relation does not exist" — the migration has not been run yet. */
const MISSING_TABLE = '42P01'
/** Postgres/PostgREST "function does not exist", same cause. */
const MISSING_FUNCTION = ['42883', 'PGRST202']

export type TurnReservation =
  | { ok: true }
  | { ok: false; status: number; error: string }

export type GrantCheck =
  | { ok: true; grant: InterviewGrant | null }
  | { ok: false; status: number; error: string }

export async function createGrant(
  admin: SupabaseClient,
  userId: string,
  mode: string,
  type: string
): Promise<string | null> {
  const { data, error } = await admin
    .from('interview_grants')
    .insert({ user_id: userId, mode, interview_type: type })
    .select('id')
    .single()

  if (error) {
    if (error.code === MISSING_TABLE) {
      console.warn('interview_grants table missing — continuation checks inactive')
      return null
    }
    console.error('Interview grant creation failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Validates a continuation. Returns ok:true with a null grant only when the
 * table does not exist yet, so the feature keeps working between the code
 * deploy and the migration; every other failure denies the turn.
 */
export async function checkGrant(
  admin: SupabaseClient,
  grantId: unknown,
  userId: string
): Promise<GrantCheck> {
  if (typeof grantId !== 'string' || grantId.length === 0) {
    return { ok: false, status: 403, error: 'This interview session is no longer valid. Please start a new interview.' }
  }

  const { data, error } = await admin
    .from('interview_grants')
    .select('id, user_id, turns_used, completed')
    .eq('id', grantId)
    .maybeSingle()

  if (error) {
    if (error.code === MISSING_TABLE) {
      console.warn('interview_grants table missing — continuation checks inactive')
      return { ok: true, grant: null }
    }
    // A malformed id makes Postgres reject the uuid cast; treat as not found.
    console.error('Interview grant lookup failed:', error.message)
    return { ok: false, status: 403, error: 'This interview session is no longer valid. Please start a new interview.' }
  }

  // Unknown id and someone else's id return the same response, so a caller
  // cannot use the difference to discover which session ids exist.
  if (!data || data.user_id !== userId) {
    return { ok: false, status: 403, error: 'This interview session is no longer valid. Please start a new interview.' }
  }
  if (data.completed) {
    return { ok: false, status: 403, error: 'This interview is already complete. Start a new one to keep practicing.' }
  }
  if ((data.turns_used ?? 0) >= MAX_TURNS_PER_INTERVIEW) {
    return { ok: false, status: 403, error: 'This interview has reached its maximum length. Please start a new one.' }
  }

  return { ok: true, grant: data as InterviewGrant }
}

/**
 * Reserves one turn, atomically.
 *
 * The cap is enforced inside the UPDATE's WHERE clause rather than by reading
 * turns_used and comparing it here: two concurrent requests could both pass a
 * read-then-check at 23 and drive the counter to 25. A conditional UPDATE
 * takes a row lock, so the second request sees the committed value and matches
 * no row.
 *
 * Called BEFORE the model request, so a refusal costs nothing. Returns ok:true
 * with no reservation only when the migration has not been applied yet.
 */
export async function reserveTurn(
  admin: SupabaseClient,
  grantId: string
): Promise<TurnReservation> {
  const { data, error } = await admin.rpc('consume_interview_turn', { p_grant_id: grantId })

  if (error) {
    if (error.code === MISSING_TABLE || MISSING_FUNCTION.includes(error.code ?? '')) {
      console.warn('interview_grants not migrated — turn reservation inactive')
      return { ok: true }
    }
    console.error('Interview turn reservation failed:', error.message)
    return {
      ok: false,
      status: 403,
      error: 'This interview session is no longer valid. Please start a new interview.',
    }
  }

  // No row updated: the grant is missing, already completed, or at the cap.
  if (typeof data !== 'number') {
    return {
      ok: false,
      status: 403,
      error: 'This interview has reached its maximum length. Please start a new one.',
    }
  }

  return { ok: true }
}

export async function completeGrant(admin: SupabaseClient, grantId: string): Promise<void> {
  const { error } = await admin
    .from('interview_grants')
    .update({ completed: true })
    .eq('id', grantId)
  if (error) console.warn('Interview grant completion failed:', error.message)
}
