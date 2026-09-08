import { createHash } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { MAX_ANALYSES_PER_USER } from './analyses.ts'

/**
 * D60 — server-side entitlement for transcript analysis.
 *
 * FREE and PREMIUM may successfully analyze ONE transcript per account, ever.
 * ULTIMATE is not limited.
 *
 * "Ever" is the whole point: deleting the resulting analysis, deleting its
 * courses, renaming it or copying it does NOT restore the allowance. So the
 * decision is never taken from what the user currently holds -- it comes from
 * the permanent ledger in gpa_transcript_sources, which the client can read but
 * can never write (RLS grants SELECT only, and the functions below are
 * executable by service_role alone).
 *
 * A FAILED attempt must not burn the allowance, so a source is RESERVED before
 * the analysis and only CONSUMED once it has actually succeeded. A reservation
 * still blocks a concurrent second request, and is released on failure.
 */

/** Sent to the browser so the workspace can tell this apart from a 403 for a
 *  signed-out session. The wording of the upgrade prompt depends on it. */
export const TRANSCRIPT_ALLOWANCE_CODE = 'transcript-allowance-used'

/**
 * D35's analysis cap, refused before the AI call rather than after it. Distinct
 * from the allowance code because the two need opposite answers: one is
 * "upgrade", the other is "delete an analysis you no longer need" -- and only
 * the second one leaves the transcript entitlement untouched.
 */
export const ANALYSIS_LIMIT_CODE = 'analysis-limit-reached'

/** Free and Premium share one lifetime source. Ultimate has no limit. */
export function transcriptAllowanceFor(tier: string): number | null {
  return String(tier ?? '').trim().toLowerCase() === 'ultimate' ? null : 1
}

/**
 * A one-way fingerprint of the transcript text -- never the text itself.
 *
 * It exists so the second analysis pass of ONE import, and a retry after a
 * failure, are recognised as the same document and cost one allowance between
 * them instead of one each. Nothing is stored that could be read back into
 * coursework, a school name or a grade.
 */
export function documentFingerprint(text: string): string {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** Built only after the caller has been authenticated. */
export function serviceClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    console.error('Transcript entitlement: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return null
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export type AccessDecision =
  | { allowed: true; unlimited: boolean }
  | { allowed: false; reason: 'allowance-used' | 'unavailable' }

/**
 * Reads the database function's answer.
 *
 * Split out from the call so the fail-closed behaviour is testable without a
 * database: anything that is not an explicit `allowed: true` is a refusal, and
 * only an explicit 'allowance-used' is reported as one -- a malformed or
 * missing answer is 'unavailable', never permission.
 */
export function decideAccess(row: unknown): AccessDecision {
  if (!row || typeof row !== 'object') return { allowed: false, reason: 'unavailable' }
  const r = row as Record<string, unknown>
  if (r.allowed === true) return { allowed: true, unlimited: r.unlimited === true }
  return { allowed: false, reason: r.reason === 'allowance-used' ? 'allowance-used' : 'unavailable' }
}

/**
 * Read-only pre-check. Changes nothing, and is never the last word: the
 * reservation below re-decides under a lock. Its job is to refuse a blocked
 * user BEFORE the expensive work rather than after it.
 *
 * Fails CLOSED. An unconfigured service key or an unreachable database is
 * 'unavailable', never "go ahead".
 */
export async function transcriptAccess(
  userId: string,
  documentHash?: string
): Promise<AccessDecision> {
  const admin = serviceClient()
  if (!admin) return { allowed: false, reason: 'unavailable' }

  const { data, error } = await admin.rpc('gpa_transcript_access', {
    p_user_id: userId,
    p_document_hash: documentHash ?? null,
  })
  if (error) console.error('Transcript entitlement: access check failed', error.message)
  return decideAccess(error ? null : data)
}

export type Reservation =
  | { ok: true; sourceId: string; reused: boolean; alreadyConsumed: boolean }
  | { ok: false; reason: 'allowance-used' | 'unavailable' }

/** Same fail-closed reading as decideAccess, for the reservation answer. */
export function decideReservation(row: unknown): Reservation {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'unavailable' }
  const r = row as Record<string, unknown>
  if (r.ok === true && typeof r.source_id === 'string' && r.source_id) {
    return {
      ok: true,
      sourceId: r.source_id,
      reused: r.reused === true,
      alreadyConsumed: r.status === 'consumed',
    }
  }
  return { ok: false, reason: r.reason === 'allowance-used' ? 'allowance-used' : 'unavailable' }
}

/**
 * Takes the one allowance, or refuses.
 *
 * Race safety lives in the database function, which holds a transaction-scoped
 * advisory lock on the user while it counts and inserts (the pattern D35
 * already uses for the 50-analysis limit). Two simultaneous first-transcript
 * requests therefore cannot both succeed. Counting in this process, or
 * check-then-insert without the lock, would let them.
 */
export async function reserveTranscriptSource(
  userId: string,
  documentHash: string
): Promise<Reservation> {
  const admin = serviceClient()
  if (!admin) return { ok: false, reason: 'unavailable' }

  const { data, error } = await admin.rpc('gpa_reserve_transcript_source', {
    p_user_id: userId,
    p_document_hash: documentHash,
  })
  if (error) console.error('Transcript entitlement: reservation failed', error.message)
  return decideReservation(error ? null : data)
}

/**
 * Makes the allowance permanent. Called only once a transcript analysis has
 * actually produced a result.
 */
export async function consumeTranscriptSource(
  userId: string,
  sourceId: string
): Promise<boolean> {
  const admin = serviceClient()
  if (!admin) return false
  const { data, error } = await admin.rpc('gpa_consume_transcript_source', {
    p_user_id: userId, p_source_id: sourceId,
  })
  if (error) {
    console.error('Transcript entitlement: consume failed', error.message)
    return false
  }
  return (data as Record<string, unknown> | null)?.ok === true
}

/**
 * Gives back a reservation whose analysis failed, so a parser, network or
 * upstream failure never costs the user their one transcript.
 *
 * Only a PENDING reservation can be released -- the database function has no
 * way to express "un-consume", so a successful analysis can never be undone by
 * a later error path.
 */
export async function releaseTranscriptSource(
  userId: string,
  sourceId: string
): Promise<void> {
  const admin = serviceClient()
  if (!admin) return
  const { error } = await admin.rpc('gpa_release_transcript_source', {
    p_user_id: userId, p_source_id: sourceId,
  })
  if (error) console.error('Transcript entitlement: release failed', error.message)
}

/**
 * D35 pre-flight: can this account still hold another analysis?
 *
 * There is exactly one 50-analysis rule, and it lives in the database trigger
 * D35 added. This is not a second one -- it is that same limit, read before the
 * expensive work, to stop one specific known sequence:
 *
 *   Free user has their transcript allowance, already holds 50 analyses ->
 *   the AI analyzes the transcript -> the analysis cannot be created ->
 *   the lifetime entitlement is spent on nothing.
 *
 * Counted with the CALLER'S OWN token, not the service key: gpa_drafts grants
 * nothing to service_role (D22), and RLS then guarantees this counts only the
 * caller's own analyses.
 *
 * Returns null when the count cannot be read. That is deliberately NOT a block:
 * this check exists to protect the user, and the database trigger remains the
 * thing that actually enforces the cap. An unreadable count leaves the previous
 * behaviour exactly as it was rather than refusing a legitimate import.
 */
export async function canCreateAnotherAnalysis(
  accessToken: string,
  userId: string
): Promise<boolean | null> {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      }
    )
    const { count, error } = await supabase
      .from('gpa_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
    if (error || typeof count !== 'number') {
      console.error('Transcript entitlement: analysis count unavailable', error?.message)
      return null
    }
    return count < MAX_ANALYSES_PER_USER
  } catch (error: any) {
    console.error('Transcript entitlement: analysis count failed', error?.message)
    return null
  }
}

export { MAX_ANALYSES_PER_USER }
