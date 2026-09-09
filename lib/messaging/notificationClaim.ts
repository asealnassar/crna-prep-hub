import type { SupabaseClient } from '@supabase/supabase-js'
import { LEASE_MS, type JobRow } from './notificationWorker.ts'

/**
 * Taking a lease on due notification jobs.
 *
 * Extracted from the worker route so the integration suite can exercise THIS
 * function against real rows rather than a reimplementation of it. A copy in a
 * test proves a claim works; it does not prove the claim works.
 *
 * There is no test mode and no extra parameter. The suite scopes itself using
 * `now`, which production already passes: it hands in a historical timestamp,
 * and the `next_attempt_at <= now` predicate below then excludes every real
 * job on its own terms. The isolation is the production predicate's doing, not
 * a special case.
 */

/** How many jobs one invocation takes. Bounded so a backlog drains over
 *  several runs rather than one request that risks the timeout. */
export const BATCH = 25

const COLUMNS =
  'message_id, recipient_user_id, status, attempts, next_attempt_at, lease_owner, lease_expires_at'

/**
 * Read the due rows, then take each lease with a conditional update that
 * repeats the eligibility predicates.
 *
 * Read-then-write rather than one atomic statement because PostgREST offers no
 * UPDATE ... RETURNING over a subquery. The lease is what makes that safe: the
 * update only matches while the row is still unleased, so a peer that wrote
 * first keeps it and this caller simply gets fewer rows back.
 *
 * 'sending' is eligible deliberately -- a worker that died mid-send leaves the
 * row in that state, and only a later claim can resolve it. Whether such a job
 * may be RE-SENT is decided separately by isSafeToReplay.
 */
export async function claimJobs(
  db: SupabaseClient,
  workerId: string,
  now: number,
): Promise<JobRow[]> {
  const nowIso = new Date(now).toISOString()
  const leaseUntil = new Date(now + LEASE_MS).toISOString()

  const { data: candidates } = await db
    .from('email_notification_jobs')
    .select(COLUMNS)
    .in('status', ['pending', 'sending'])
    .lte('next_attempt_at', nowIso)
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH)

  const claimed: JobRow[] = []
  for (const job of (candidates ?? []) as JobRow[]) {
    const { data: won } = await db
      .from('email_notification_jobs')
      .update({ status: 'sending', lease_owner: workerId, lease_expires_at: leaseUntil })
      .eq('message_id', job.message_id)
      .in('status', ['pending', 'sending'])
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
      .select('message_id')

    // No row back means a peer leased it between the read and the write.
    if ((won ?? []).length === 1) claimed.push(job)
  }
  return claimed
}
