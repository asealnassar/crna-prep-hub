import type { SupabaseClient } from '@supabase/supabase-js'
import type { PromptOrigin } from './promptSubmission.ts'
import { RUBRIC_VERSION } from './rubric.ts'
import { REVIEW_SCHEMA_VERSION, type StatementReview } from './reviewSchema.ts'

/**
 * The only module that reads or writes statement_analyses.
 *
 * TWO WRITES, BOTH THROUGH DEFINER FUNCTIONS, because applicants hold no INSERT
 * or UPDATE on the table -- deliberately. A browser that could write it could
 * fabricate a completed analysis against a fingerprint of its choosing and read
 * it back as though it had been paid for and validated.
 *
 * READS ARE ORDINARY AND CALLER-SCOPED. The select policy limits them to the
 * caller's own rows, so a bug here could return fewer than it should, never
 * another applicant's feedback.
 *
 * NO QUERY IN THIS FILE RUNS UNLESS THE CACHE IS SWITCHED ON. The route checks
 * analysisCacheEnabled() before calling anything here; until 20261002_004 is
 * applied the table and both functions do not exist.
 */

const ANALYSES = 'statement_analyses'

/** Columns an applicant may read. The essay is not among them: it is not here. */
const ANALYSIS_COLUMNS =
  'id, draft_id, fingerprint, status, revision, prompt_attached, provenance, '
  + 'words, stated_max_words, over_limit, overall, review, rubric_version, '
  + 'schema_version, created_at'

export type AnalysisRefusal =
  | 'not-authenticated'
  | 'not-found'
  | 'invalid'
  | 'read-failed'
  | 'write-failed'
  | 'data-integrity'

export type AnalysisResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: AnalysisRefusal; readonly detail: string }

/** A completed analysis, as it is read back. */
export interface StoredAnalysis {
  readonly id: string
  readonly fingerprint: string
  readonly review: StatementReview
  readonly revision: number
  readonly words: number
  readonly overLimit: boolean
  readonly statedMaxWords: number | null
  readonly provenance: PromptOrigin | null
  readonly createdAt: string
}

/** What claiming the work produced. */
export type Claim =
  /** Nobody has analysed these inputs; this caller owns the attempt. */
  | { readonly state: 'claimed'; readonly id: string }
  /** Another request is already running for exactly these inputs. */
  | { readonly state: 'running'; readonly id: string }
  /** A validated result already exists. No model call is needed. */
  | { readonly state: 'complete'; readonly analysis: StoredAnalysis }

function fail(reason: AnalysisRefusal, detail: unknown): AnalysisResult<never> {
  const message = typeof detail === 'string'
    ? detail
    : String((detail as { message?: unknown })?.message ?? 'unknown')
  return { ok: false, reason, detail: message }
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null

/**
 * A row as a StoredAnalysis, or null when it cannot be read coherently.
 *
 * THE REVIEW IS NOT RE-VALIDATED HERE. It was validated by parseReview before
 * it was ever stored, and the database refuses a 'complete' row without one.
 * Re-parsing on every read would mean a tightened schema silently discarding
 * results an applicant has already been shown.
 */
function analysisFrom(row: unknown): StoredAnalysis | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  const id = text(r.id)
  const fingerprint = text(r.fingerprint)
  const createdAt = text(r.created_at)
  const revision = int(r.revision)
  const words = int(r.words)
  const review = r.review
  if (!id || !fingerprint || !createdAt || revision === null || words === null) return null
  if (typeof review !== 'object' || review === null) return null
  const provenance = r.provenance
  return {
    id,
    fingerprint,
    review: review as StatementReview,
    revision,
    words,
    overLimit: r.over_limit === true,
    statedMaxWords: int(r.stated_max_words),
    provenance: provenance === 'catalog' || provenance === 'user' ? provenance : null,
    createdAt,
  }
}

/**
 * The newest completed analysis for a draft, whatever it was about.
 *
 * USED TO DECIDE WHAT THE EDITOR OFFERS, not to serve a result. Its fingerprint
 * is compared with the current one: equal means "View previous analysis",
 * different means "Analyze updated draft". Serving it without that comparison
 * would show feedback about an essay the applicant has since rewritten.
 */
export async function latestAnalysis(
  db: SupabaseClient,
  draftId: string,
): Promise<AnalysisResult<StoredAnalysis | null>> {
  const { data, error } = await db
    .from(ANALYSES)
    .select(ANALYSIS_COLUMNS)
    .eq('draft_id', draftId)
    .eq('status', 'complete')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return fail('read-failed', error)
  if (!data) return { ok: true, value: null }
  const analysis = analysisFrom(data)
  if (!analysis) return fail('data-integrity', 'unreadable analysis row')
  return { ok: true, value: analysis }
}

/**
 * The completed analysis for EXACTLY these inputs, if one exists.
 *
 * KEYED ON THE FINGERPRINT, NOT ON RECENCY, and that difference matters for a
 * real sequence: analyse A, edit to B, analyse B, then undo back to A. The
 * newest analysis is B's, so a recency lookup would offer "Analyze updated
 * draft" and charge again for A -- work already paid for and still stored.
 * Asking for the fingerprint finds it.
 */
export async function analysisFor(
  db: SupabaseClient,
  draftId: string,
  fingerprint: string,
): Promise<AnalysisResult<StoredAnalysis | null>> {
  const { data, error } = await db
    .from(ANALYSES)
    .select(ANALYSIS_COLUMNS)
    .eq('draft_id', draftId)
    .eq('fingerprint', fingerprint)
    .eq('status', 'complete')
    .maybeSingle()
  if (error) return fail('read-failed', error)
  if (!data) return { ok: true, value: null }
  const analysis = analysisFrom(data)
  if (!analysis) return fail('data-integrity', 'unreadable analysis row')
  return { ok: true, value: analysis }
}

/**
 * Claim the work, or discover it is already done or already running.
 *
 * ONE STATEMENT DECIDES. The unique constraint on (draft_id, fingerprint) is
 * what makes two simultaneous requests safe: the database admits one claim and
 * the other caller is told the work is running. No transaction is held open
 * across the model call -- the claim commits, the model is called outside it,
 * and the result is written by a separate statement.
 */
export async function claimAnalysis(
  db: SupabaseClient,
  input: {
    readonly draftId: string
    readonly fingerprint: string
    readonly revision: number
    readonly promptAttached: boolean
    readonly provenance: PromptOrigin | null
    readonly words: number
    readonly statedMaxWords: number | null
    readonly overLimit: boolean
  },
): Promise<AnalysisResult<Claim>> {
  const { data, error } = await db.rpc('claim_statement_analysis', {
    p_draft_id: input.draftId,
    p_fingerprint: input.fingerprint,
    p_revision: input.revision,
    p_prompt_attached: input.promptAttached,
    p_provenance: input.provenance,
    p_words: input.words,
    p_stated_max: input.statedMaxWords,
    p_over_limit: input.overLimit,
    p_rubric_version: RUBRIC_VERSION,
    p_schema_version: REVIEW_SCHEMA_VERSION,
  })
  if (error) return fail('write-failed', error)
  if (typeof data !== 'object' || data === null) {
    return fail('data-integrity', 'the claim function returned no object')
  }

  const body = data as Record<string, unknown>
  if (body.ok !== true) {
    const reason = body.reason === 'not-authenticated' ? 'not-authenticated'
      : body.reason === 'not-found' ? 'not-found' : 'invalid'
    return fail(reason, String(body.reason ?? 'refused'))
  }

  const id = text(body.id)
  if (body.state === 'complete') {
    const analysis = analysisFrom({
      id: body.id,
      fingerprint: input.fingerprint,
      created_at: body.createdAt,
      revision: body.revision,
      words: body.words,
      over_limit: body.overLimit,
      stated_max_words: body.statedMaxWords,
      provenance: body.provenance,
      review: body.review,
    })
    if (!analysis) return fail('data-integrity', 'unreadable stored analysis')
    return { ok: true, value: { state: 'complete', analysis } }
  }
  if (!id) return fail('data-integrity', 'the claim returned no id')
  if (body.state === 'running') return { ok: true, value: { state: 'running', id } }
  return { ok: true, value: { state: 'claimed', id } }
}

/**
 * Write a validated result onto a claim, or release the claim.
 *
 * A NULL REVIEW RELEASES. Nothing is stored for a failed or malformed attempt,
 * so a failure can never be read back as a success -- and the released claim
 * leaves no state behind, which is what keeps the next attempt an ordinary
 * first attempt rather than a retry that has to reason about old rows.
 */
export async function settleAnalysis(
  db: SupabaseClient,
  input: {
    readonly id: string
    readonly review: StatementReview | null
    readonly overall: number | null
  },
): Promise<AnalysisResult<'complete' | 'released'>> {
  const { data, error } = await db.rpc('settle_statement_analysis', {
    p_id: input.id,
    p_review: input.review,
    p_overall: input.overall,
  })
  if (error) return fail('write-failed', error)
  if (typeof data !== 'object' || data === null) {
    return fail('data-integrity', 'the settle function returned no object')
  }
  const body = data as Record<string, unknown>
  if (body.ok !== true) return fail('not-found', String(body.reason ?? 'refused'))
  return { ok: true, value: body.state === 'complete' ? 'complete' : 'released' }
}
