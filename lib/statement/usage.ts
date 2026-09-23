/**
 * The abuse ledger for the Personal Statement Analyzer.
 *
 * ----------------------------------------------------------------------------
 * WHY THERE IS NO NEW TABLE, AND WHAT THAT COSTS.
 *
 * Phase 0 is meant to ship without a migration, so this reuses
 * `public.resume_ai_usage`. That is possible because of two properties of
 * migration 20260910_004 that were not written with this in mind:
 *
 *   * `resume_id` is nullable (`references public.resumes(id) on delete set
 *     null`), so a row can exist that belongs to no resume, and
 *   * `operation` is unconstrained free text, truncated to 64 characters by
 *     `record_ai_usage`. There is no check constraint naming the resume
 *     operations.
 *
 * So `record_ai_usage(null, 'statement-analyze', 'attempted')` is a legal call
 * for any authenticated user, through the same SECURITY DEFINER function, under
 * the same RLS, with the same "no client INSERT, so a client cannot delete its
 * way out of its own rate limit" guarantee.
 *
 * THE COST is that a table called `resume_ai_usage` now holds rows that are not
 * about resumes. Two consequences, both handled:
 *
 *   1. BUDGETS. The rate check below reads ONLY rows whose operation starts
 *      with `statement-`, so heavy resume use cannot throttle an essay and vice
 *      versa. Two budgets, one table.
 *   2. ANALYTICS. lib/analytics/server/sections/product.ts counts every row in
 *      this table as a "Resume AI action". Statement rows are filtered out
 *      there so that metric keeps meaning what its label says.
 *
 * THIS IS DEBT, and it is named as such: the right home is a
 * `statement_ai_usage` table that is a near-copy of migration 004. That is a
 * migration, it needs to be run by hand in the Supabase editor, and Phase 0 was
 * scoped to avoid exactly that. The prefix is what makes the move a rename
 * later rather than a rewrite.
 * ----------------------------------------------------------------------------
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { STATEMENT_RATE_LIMITS, checkStatementRate, statementLedgerWindowMs } from './entitlement.ts'
import type { RateDecision } from './entitlement.ts'

/**
 * The namespace. Every statement row carries it, and every statement read
 * filters on it -- which is what keeps the two features' budgets and the two
 * features' analytics apart inside one table.
 */
export const STATEMENT_OPERATION_PREFIX = 'statement-'

export const STATEMENT_OPERATIONS = {
  analyze: 'statement-analyze',
  rewrite: 'statement-rewrite',
} as const

export type StatementOperation =
  (typeof STATEMENT_OPERATIONS)[keyof typeof STATEMENT_OPERATIONS]

/** The PostgREST pattern for "rows belonging to this feature". */
export const STATEMENT_OPERATION_PATTERN = `${STATEMENT_OPERATION_PREFIX}%`

/**
 * Whether a ledger row belongs to the statement analyzer.
 *
 * Pure, exported, and used on BOTH sides of the split -- here to count a
 * budget, and in the analytics product section to exclude these rows from the
 * resume figures. One predicate, so the two can never disagree about which
 * rows are whose.
 */
export function isStatementOperation(operation: string | null | undefined): boolean {
  return typeof operation === 'string' && operation.startsWith(STATEMENT_OPERATION_PREFIX)
}

/**
 * Epoch milliseconds from ledger rows, unreadable ones dropped.
 *
 * Split out from the query so the filtering and the parsing are testable
 * without a database.
 *
 * `excludeNewest` drops exactly one row: the caller's OWN attempt, which was
 * written immediately before this read. See `statementRateDecision` for why
 * the write comes first. Dropping the newest is correct even when a genuinely
 * concurrent sibling wrote a later row than ours -- either way exactly one
 * attempt is discounted, and the count is the same.
 */
export function timestampsFrom(
  rows: readonly { created_at?: unknown; operation?: unknown }[],
  excludeNewest = false
): number[] {
  const out: number[] = []
  for (const row of rows) {
    if (!isStatementOperation(row.operation as string)) continue
    const at = Date.parse(String(row.created_at ?? ''))
    if (Number.isFinite(at)) out.push(at)
  }
  if (!excludeNewest || out.length === 0) return out
  const newest = out.reduce((max, at) => (at > max ? at : max), out[0])
  out.splice(out.indexOf(newest), 1)
  return out
}

// ---------------------------------------------------------------------------
// The impure edge
// ---------------------------------------------------------------------------

/**
 * Whether this user may make another call.
 *
 * Fails CLOSED on an unreadable ledger, exactly as the resume propose route
 * does: an abuse control that opens when its own storage misbehaves is not a
 * control. The `.like` filter is applied in the query AND re-applied in
 * `timestampsFrom`, so a PostgREST filter that silently stopped working would
 * be caught rather than quietly widening the budget.
 *
 * THE ATTEMPT IS RECORDED BEFORE THIS RUNS, and `selfRecorded` says so.
 *
 * The resume routes check first and record second, and their migration notes
 * the consequence: "two simultaneous requests can both pass the check". That is
 * a read-modify-write race, and with a check-then-record order the overshoot is
 * bounded by arrival concurrency rather than by the limit -- a burst arriving
 * inside one ledger round trip ALL passes, because none of them can see the
 * others yet.
 *
 * Writing first closes most of that window at no cost: a request is visible to
 * its siblings before it asks whether it is allowed, so a burst that would
 * previously have passed as one now mostly refuses itself. Discounting the
 * caller's own row keeps the effective limit identical in the ordinary
 * sequential case -- the Nth call in a window still sees N-1 others.
 *
 * IT IS STILL NOT ATOMIC. Two requests whose reads both complete before either
 * write lands can still both pass. Making it exact needs the decision to happen
 * inside the database, which needs a migration, which Phase 0 is scoped to
 * avoid. What remains is bounded, recorded, and visible in the ledger.
 */
export async function statementRateDecision(
  db: SupabaseClient,
  userId: string,
  options: { readonly selfRecorded?: boolean } = {},
  now: number = Date.now()
): Promise<RateDecision> {
  const since = new Date(now - statementLedgerWindowMs()).toISOString()
  const { data, error } = await db
    .from('resume_ai_usage')
    .select('created_at, operation')
    .eq('user_id', userId)
    .like('operation', STATEMENT_OPERATION_PATTERN)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    console.error('statement: usage ledger unreadable', error.code, error.message)
    return {
      allowed: false,
      retryAfterSeconds: 30,
      message: 'Too many requests just now. Please try again shortly.',
    }
  }

  return checkStatementRate(
    timestampsFrom(data ?? [], options.selfRecorded === true),
    now,
    STATEMENT_RATE_LIMITS
  )
}

/**
 * Records that a call was attempted, before the model is reached.
 *
 * EVERY ATTEMPT COUNTS, including the ones that fail. This is an abuse control,
 * not a quota: if a failed call were free, causing failures would be the way
 * around it. `resume_id` is null because there is no resume -- the statement
 * analyzer stores nothing, which is the point.
 */
export async function recordStatementAttempt(
  db: SupabaseClient,
  operation: StatementOperation
): Promise<string | null> {
  const { data, error } = await db.rpc('record_ai_usage', {
    p_resume_id: null,
    p_operation: operation,
    p_outcome: 'attempted',
  })
  if (error) {
    console.error('statement: could not record usage', error.code, error.message)
    return null
  }
  return typeof data === 'string' ? data : null
}

/** Settles an attempt once its fate is known. Never moves the timestamp. */
export async function settleStatementUsage(
  db: SupabaseClient,
  usageId: string | null,
  outcome: 'proposed' | 'rejected' | 'failed'
): Promise<void> {
  if (!usageId) return
  const { error } = await db.rpc('settle_ai_usage', { p_id: usageId, p_outcome: outcome })
  if (error) console.error('statement: could not settle usage', error.code, error.message)
}
