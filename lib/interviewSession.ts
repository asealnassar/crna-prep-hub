import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_PRIMARY_QUESTIONS, FOLLOW_UP_BUDGET } from '@/lib/interview/state'
import type { InterviewLength } from '@/lib/interview/state'

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
  /**
   * The applicant's setup choice, and the ONLY authority on it for the life of
   * the session. Undefined only while the column migration has not been
   * applied; callers treat that as "fall back to the serialized state".
   */
  follow_ups_enabled?: boolean | null
  /**
   * The interview_sessions row this grant authorizes, written once by
   * bindGrantToSession and never changed. Null on every grant issued before
   * resume existed, which is precisely what makes those interviews
   * non-resumable without any special-case code.
   */
  session_id?: string | null
  /**
   * Set when the applicant deliberately gives an interview up. Distinct from
   * `completed`, which means the interview ran to its final report — an
   * abandoned interview must not be counted as a finished mock.
   */
  abandoned_at?: string | null
  /** When the server issued this grant. The authority for resume expiry. */
  created_at?: string
  /**
   * The interview's length, 5 (Quick) or 10 (Full), and the ONLY authority on
   * it. NULL on grants issued before Phase 3 (all ten questions); undefined
   * only while the column migration has not been applied. See
   * lib/interview/authority.ts for how each case is read.
   */
  max_primary_questions?: number | null
}

/** Postgres "relation does not exist" — the migration has not been run yet. */
const MISSING_TABLE = '42P01'
/**
 * Postgres "column does not exist" / PostgREST's schema-cache equivalent.
 *
 * Lets follow_ups_enabled be read and written before its migration is applied:
 * the statement is retried without the column instead of failing. Without this
 * the deploy would be order-dependent in BOTH directions -- code first and the
 * INSERT names an unknown column, migration first and the NOT NULL rejects an
 * INSERT that omits it -- and a failed createGrant hands the client a null
 * grantId, which makes its very next turn a 403.
 */
const MISSING_COLUMN = ['42703', 'PGRST204', 'PGRST116']

function isMissingColumn(error: any): boolean {
  if (!error) return false
  if (MISSING_COLUMN.includes(error.code)) return true
  return /follow_ups_enabled|session_id|abandoned_at|pending_turn/.test(error.message || '')
}

/**
 * "Column does not exist" for the LENGTH column specifically, identified by
 * error code and not by message alone.
 *
 * Deliberately stricter than isMissingColumn: the length column's CHECK
 * constraint carries the column's name, so a message match would read a
 * refused value as a missing column -- and quietly write the grant without
 * its length, which is the one outcome this column exists to prevent.
 */
function isMissingLengthColumn(error: any): boolean {
  if (!error) return false
  return (error.code === '42703' || error.code === 'PGRST204') && /max_primary_questions/.test(error.message || '')
}
/** Postgres "unique_violation" — the one-session-one-grant index refused a bind. */
const UNIQUE_VIOLATION = '23505'
/** Postgres/PostgREST "function does not exist", same cause. */
const MISSING_FUNCTION = ['42883', 'PGRST202']

export type TurnReservation =
  | { ok: true }
  | { ok: false; status: number; error: string }

/** ok means a grant row exists, belongs to the caller, and still authorizes turns. */
export type GrantCheck =
  | { ok: true; grant: InterviewGrant }
  | { ok: false; status: number; error: string }

/**
 * The outcome of writing the grant for a new interview. Anything that is not
 * ok means the interview must not start: the caller discards the opening turn,
 * and nothing has been charged.
 */
export type GrantCreation =
  | { ok: true; id: string }
  | { ok: false; reason: 'schema_unavailable' | 'failed' }

export async function createGrant(
  admin: SupabaseClient,
  userId: string,
  mode: string,
  type: string,
  followUpsEnabled: boolean,
  maxPrimaryQuestions: InterviewLength
): Promise<GrantCreation> {
  // ONE insert, carrying every column the server owns, or no grant at all.
  //
  // There is deliberately no fallback that retries without a column. A grant
  // without its length reads as Full on the very next turn -- a Quick
  // interview would quietly become a Full one -- and NULL is reserved for
  // grants issued before Phase 3, so a Phase 3 start must never write one,
  // for either length. If the database cannot hold what this interview needs,
  // the interview does not start. (READING an older grant still falls back:
  // see checkGrant and findGrantBySession.)
  const { data, error } = await admin
    .from('interview_grants')
    .insert({
      user_id: userId,
      mode,
      interview_type: type,
      // Written once, here, and never updated. Every later turn reads it back
      // rather than trusting what the browser echoes.
      follow_ups_enabled: followUpsEnabled,
      // Same contract for the length: the server's own validated copy, 5 or
      // 10, read back on every turn and on resume.
      max_primary_questions: maxPrimaryQuestions,
    })
    .select('id')
    .single()

  if (error || typeof data?.id !== 'string') {
    const unavailable =
      !!error && (isMissingLengthColumn(error) || isMissingColumn(error) || error.code === MISSING_TABLE)
    console.error(
      unavailable
        ? 'interview_grants cannot hold a Phase 3 grant — no interview can start until 20260921_002_interview_length.sql is applied'
        : `Interview grant creation failed: ${error?.message ?? 'no id returned'}`
    )
    return { ok: false, reason: unavailable ? 'schema_unavailable' : 'failed' }
  }
  return { ok: true, id: data.id }
}

/**
 * The steps a new interview needs before its opening question may be shown,
 * injected so the route wires the real ones and the tests can fail each one.
 */
export type IssueSteps = {
  /** Writes the grant, length included, or reports why it could not. */
  createGrant: () => Promise<GrantCreation>
  /**
   * Consumes the entitlement: the new usage count, or null when that failed.
   * Absent for an account that is not metered.
   */
  charge?: () => Promise<number | null>
  /** Makes a grant permanently unusable. */
  voidGrant: (grantId: string) => Promise<boolean>
}

export type InterviewIssue =
  | { ok: true; grantId: string; usageCount: number | null }
  | { ok: false; reason: 'schema_unavailable' | 'grant_failed' | 'charge_failed' }

/**
 * Issues a new interview: its grant, then -- for a metered account -- the
 * entitlement it consumes. The invariant is
 *
 *     a usable grant  =>  a successfully consumed entitlement
 *
 * and the order is what gives it:
 *
 *   grant fails   -> nothing has been charged; the start is refused.
 *   charge fails  -> the grant, whose id has not left the server, is voided
 *                    (abandoned_at, which checkGrant and resume refuse); the
 *                    start is refused. A retry issues a NEW grant and must
 *                    charge for it -- the voided one is never reused.
 *   both succeed  -> only now is the grant id handed back, to be returned to
 *                    the browser.
 */
export async function issueInterview(steps: IssueSteps): Promise<InterviewIssue> {
  const created = await steps.createGrant()
  if (!created.ok) {
    return { ok: false, reason: created.reason === 'schema_unavailable' ? 'schema_unavailable' : 'grant_failed' }
  }
  if (!steps.charge) return { ok: true, grantId: created.id, usageCount: null }

  let usageCount: number | null = null
  try {
    usageCount = await steps.charge()
  } catch (error) {
    console.error('Interview charge threw:', (error as any)?.message)
  }
  if (typeof usageCount !== 'number') {
    let voided = false
    try {
      voided = await steps.voidGrant(created.id)
    } catch {
      voided = false
    }
    if (!voided) {
      // Still unusable: its id was never returned, it is bound to no session,
      // and nothing looks a grant up any other way.
      console.error('An uncharged interview grant could not be voided; it remains unreachable')
    }
    return { ok: false, reason: 'charge_failed' }
  }
  return { ok: true, grantId: created.id, usageCount }
}

/**
 * Validates a continuation. ok:true only for a grant row that exists, belongs
 * to the caller, and still authorizes turns; every other outcome denies the
 * turn. Missing COLUMNS are tolerated (an older grant still answers what it
 * can), but a missing grant never is -- not even when the whole table is
 * absent, which once let continuation checks go inactive.
 */
export async function checkGrant(
  admin: SupabaseClient,
  grantId: unknown,
  userId: string
): Promise<GrantCheck> {
  if (typeof grantId !== 'string' || grantId.length === 0) {
    return { ok: false, status: 403, error: 'This interview session is no longer valid. Please start a new interview.' }
  }

  // The column list is chosen at runtime, so the client cannot infer the row
  // shape; asserted to the shape this function actually reads.
  const select = (columns: string) =>
    admin.from('interview_grants').select(columns).eq('id', grantId).maybeSingle() as unknown as
      Promise<{ data: InterviewGrant | null; error: any }>

  let { data, error } = await select(
    'id, user_id, turns_used, completed, follow_ups_enabled, abandoned_at, session_id, created_at, max_primary_questions'
  )

  if (error && isMissingColumn(error)) {
    // The length column is not deployed yet. Drop only it first: the grant then
    // cannot answer on length (see lengthAuthority), but still answers on
    // everything it already could.
    ;({ data, error } = await select(
      'id, user_id, turns_used, completed, follow_ups_enabled, abandoned_at, session_id, created_at'
    ))
  }

  if (error && isMissingColumn(error)) {
    // Resume's columns are not deployed yet. Fall back in the same stepwise way
    // follow_ups_enabled already does, so the turn route keeps working through
    // a deploy in either order.
    ;({ data, error } = await select('id, user_id, turns_used, completed, follow_ups_enabled'))
    if (error && isMissingColumn(error)) {
      ;({ data, error } = await select('id, user_id, turns_used, completed'))
    }
  }

  if (error) {
    if (error.code === MISSING_TABLE) {
      // No table, so no grant: nothing can vouch for this turn. This used to
      // return ok with no grant, which let a request carrying any made-up id
      // continue with no reservation and a length nobody had recorded.
      console.error('interview_grants table missing — continuation refused')
      return { ok: false, status: 503, error: 'Interview service temporarily unavailable. Please try again.' }
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
  // An abandoned interview authorizes nothing further. Checked here rather than
  // only in the resume path, because otherwise a browser holding the old grant
  // id in memory could keep taking turns in an interview the applicant has
  // already given up and replaced.
  if (data.abandoned_at) {
    return { ok: false, status: 403, error: 'This interview was ended. Start a new one to keep practicing.' }
  }
  if ((data.turns_used ?? 0) >= MAX_TURNS_PER_INTERVIEW) {
    return { ok: false, status: 403, error: 'This interview has reached its maximum length. Please start a new one.' }
  }

  return { ok: true, grant: data }
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

// ==========================================================================
// Resume: binding a grant to its session, and finding it again afterwards.
// ==========================================================================

export type BindResult =
  | { ok: true; alreadyBound: boolean }
  | { ok: false; status: number; error: string }

/**
 * Binds a grant to the interview_sessions row it authorizes. Once.
 *
 * This is the whole basis of resume: afterwards the browser never has to hold
 * or present a grant id again, because the server can find the grant from a
 * session the applicant demonstrably owns.
 *
 * The write is conditional in SQL rather than read-then-write. Checking
 * session_id in TypeScript and then updating is a time-of-check/time-of-use
 * race, and the thing being raced is an authorization pointer -- two requests
 * could otherwise aim one grant at two different transcripts. `is('session_id',
 * null)` in the WHERE clause means the second writer matches no row.
 *
 * Re-binding the SAME pair is deliberately success, not an error: the browser
 * retries this call, and a retry that lands after the original succeeded must
 * not look like a failure.
 */
export async function bindGrantToSession(
  admin: SupabaseClient,
  grantId: string,
  sessionId: string,
  userId: string
): Promise<BindResult> {
  const denied = {
    ok: false as const,
    status: 403,
    error: 'This interview session is no longer valid. Please start a new interview.',
  }

  // Ownership of the SESSION is verified here, with the service role, rather
  // than trusted from the request: RLS protects the browser's own queries, not
  // an id it puts in a POST body.
  const { data: session, error: sessionError } = await admin
    .from('interview_sessions')
    .select('id, user_id')
    .eq('id', sessionId)
    .maybeSingle()
  if (sessionError) {
    console.error('Resume bind: session lookup failed:', sessionError.message)
    return denied
  }
  if (!session || session.user_id !== userId) return denied

  const { data, error } = await admin
    .from('interview_grants')
    .update({ session_id: sessionId })
    .eq('id', grantId)
    .eq('user_id', userId)
    .is('session_id', null)
    .select('id')

  if (error) {
    if (error.code === MISSING_TABLE || isMissingColumn(error)) {
      // Migration not applied yet. The interview still runs; it simply is not
      // resumable, which the caller surfaces rather than hides.
      console.warn('interview_grants.session_id missing — interviews not resumable yet')
      return { ok: false, status: 503, error: 'Resume is not available yet.' }
    }
    // 23505: the partial unique index refused a SECOND grant for this session.
    // The database is the arbiter here, not the conditional UPDATE above, which
    // only narrows the race. The caller is told the same thing as any other
    // refusal -- naming the conflict would confirm that some other grant holds
    // this session.
    if (error.code === UNIQUE_VIOLATION) {
      console.warn('Resume bind refused: session already bound to another grant')
      return denied
    }
    console.error('Resume bind failed:', error.message)
    return denied
  }

  if (data && data.length > 0) return { ok: true, alreadyBound: false }

  // No row matched: either already bound, or not this user's grant. Only the
  // first is acceptable, and only when it points at THIS session.
  const { data: existing } = await admin
    .from('interview_grants')
    .select('id, user_id, session_id')
    .eq('id', grantId)
    .maybeSingle()

  if (existing && existing.user_id === userId && existing.session_id === sessionId) {
    return { ok: true, alreadyBound: true }
  }
  return denied
}

/**
 * The grant that authorizes a session, or null.
 *
 * Takes the session id the applicant owns and returns the server's own record.
 * The client never names a grant, so it cannot aim one at a transcript it did
 * not run.
 */
export async function findGrantBySession(
  admin: SupabaseClient,
  sessionId: string,
  userId: string
): Promise<InterviewGrant | null> {
  const lookup = (columns: string) =>
    admin
      .from('interview_grants')
      .select(columns)
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .maybeSingle()

  let { data, error } = await lookup(
    'id, user_id, turns_used, completed, follow_ups_enabled, session_id, abandoned_at, created_at, max_primary_questions'
  )
  // Without the length column the interview is still resumable -- the grant
  // simply cannot answer on length. Failing here instead would make every
  // resume look like "not found" whenever this code runs ahead of its migration.
  if (error && isMissingColumn(error)) {
    ;({ data, error } = await lookup(
      'id, user_id, turns_used, completed, follow_ups_enabled, session_id, abandoned_at, created_at'
    ))
  }

  if (error) {
    if (error.code === MISSING_TABLE || isMissingColumn(error)) return null
    console.error('Resume grant lookup failed:', error.message)
    return null
  }
  return (data as unknown as InterviewGrant) ?? null
}

/**
 * Gives an interview up at the applicant's request.
 *
 * Sets abandoned_at, NOT completed. An abandoned interview never ran to a final
 * report, and recording it as complete would corrupt both the report path and
 * every completion metric. No entitlement is refunded: model calls were already
 * made, and a refund would make "start, read question one, abandon" a way to
 * mint free interviews.
 *
 * Also how issueInterview voids a grant whose entitlement failed to charge:
 * abandoned_at is what checkGrant and resume already refuse, and service_role
 * deliberately holds no DELETE privilege on interview_grants.
 */
export async function abandonGrant(
  admin: SupabaseClient,
  grantId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await admin
    .from('interview_grants')
    .update({ abandoned_at: new Date().toISOString() })
    .eq('id', grantId)
    .eq('user_id', userId)
    .is('abandoned_at', null)
    .select('id')

  if (error) {
    if (error.code === MISSING_TABLE || isMissingColumn(error)) return false
    console.error('Abandon failed:', error.message)
    return false
  }
  // Already abandoned is success: the applicant asked for a state that holds.
  return true
}
