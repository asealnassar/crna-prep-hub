import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  PromptSubmissionInput, SubmissionKind, SubmissionStatus,
} from './promptSubmission.ts'
import {
  isSubmissionKind, isSubmissionStatus, provenanceOf, type PromptOrigin,
} from './promptSubmission.ts'
import type { StatementDraft } from './rows.ts'
import { draftFromRow, type StatementDraftRow } from './rows.ts'
import { submissionFieldsEnabled, promptChangeReportsEnabled } from './rollout.ts'

/**
 * The only module that reads or writes statement_prompt_submissions.
 *
 * SAME SHAPE AS draftRepo.ts: the client is the caller's, never constructed
 * here, so RLS stays in force and a route can decide whose session a statement
 * runs under. Nothing in this file creates a service-role client.
 *
 * THREE OF THE FOUR WRITES ARE FUNCTION CALLS, NOT STATEMENTS. Creating a
 * draft with a submission, withdrawing one, and deciding one all go through the
 * database functions in 20261002_003, because each needs something a single
 * statement cannot give: a shared transaction, a privilege the caller lacks, or
 * a lock. The functions are the boundary; this file is the wiring that calls
 * them and reads what comes back.
 *
 * EVERY FUNCTION RETURNS jsonb WITH AN `ok` FLAG rather than raising, so an
 * expected refusal -- a rate limit, an already-decided submission -- arrives as
 * data instead of as a Postgres error this code would have to pattern-match.
 * A raised error therefore means something genuinely went wrong.
 */

const SUBMISSIONS = 'statement_prompt_submissions'

/**
 * Columns an APPLICANT may read. The same list the column-scoped grant allows,
 * repeated here so a route asking for more fails in review rather than at
 * runtime -- and so this file states, where it can be read, that review_note
 * and reviewed_by are not ours to select.
 */
const OWN_SUBMISSION_COLUMNS_BASE =
  'id, school_id, prompt_text, stated_max_words, application_cycle, source_url, '
  + 'status, approved_prompt_id, created_at'

/** The same ten, minus nothing: 008 grants every one of them to the submitter. */
function ownSubmissionColumns(): string {
  const base = submissionFieldsEnabled()
    ? `${OWN_SUBMISSION_COLUMNS_BASE}, ${REVIEW_COLUMNS_FIELDS}`
    : OWN_SUBMISSION_COLUMNS_BASE
  return promptChangeReportsEnabled() ? `${base}, ${CHANGE_REPORT_FIELDS}` : base
}

/**
 * 20261008_012's two columns.
 *
 * SELECTED ONLY BEHIND THE FLAG, for the reason OWN_SUBMISSION_COLUMNS_BASE
 * gives: naming a column PostgREST cannot find fails the whole request with a
 * 42703 rather than degrading, so the queue would stop working entirely.
 */
const CHANGE_REPORT_FIELDS = 'submission_kind, challenged_requirement_id'

/**
 * Columns the REVIEW QUEUE reads. A superset, legitimate only for a caller the
 * route has already established is an administrator and only through a
 * service-role client.
 *
 * THE APPLICANT'S IDENTITY IS DELIBERATELY NOT HERE. Moderating a question does
 * not require knowing who pasted it, and a reviewer who cannot see a name
 * cannot be influenced by one. submitted_by stays unread by the queue; it
 * exists so a submission can be withdrawn by its author and counted against
 * their rate limit, which are machine uses rather than human ones.
 */
const REVIEW_COLUMNS_BASE =
  'id, school_id, prompt_text, stated_max_words, application_cycle, source_url, '
  + 'status, reviewed_at, review_note, approved_prompt_id, duplicate_of_id, '
  + 'text_fingerprint, created_at'

/**
 * What 20261006_008 adds to the review projection.
 *
 * GATED LIKE EVERY OTHER UNAPPLIED COLUMN LIST. Naming an absent column in a
 * PostgREST select does not degrade -- it fails the whole request with a 42703
 * -- so the queue would stop working entirely rather than losing one field.
 */
const REVIEW_COLUMNS_FIELDS =
  'document_label, document_type_hint, stated_min_words, stated_max_characters, '
  + 'stated_max_pages, stated_pages_text, formatting_instructions, '
  + 'other_instructions, submitter_note, approved_requirement_id'

function reviewColumns(): string {
  const base = submissionFieldsEnabled()
    ? `${REVIEW_COLUMNS_BASE}, ${REVIEW_COLUMNS_FIELDS}`
    : REVIEW_COLUMNS_BASE
  // THE QUEUE NEEDS THE KIND MOST OF ALL: it is what tells an administrator
  // they are looking at a report rather than a new prompt.
  return promptChangeReportsEnabled() ? `${base}, ${CHANGE_REPORT_FIELDS}` : base
}

export type SubmissionRefusalReason =
  | 'not-authenticated'
  | 'not-found'
  | 'already-decided'
  | 'rate-limited'
  | 'school-not-listed'
  | 'invalid'
  | 'read-failed'
  | 'write-failed'
  | 'data-integrity'

export type SubmissionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SubmissionRefusalReason; readonly detail: string }

/** One submission, as its own submitter may see it. No reviewer, no note. */
export interface OwnSubmission {
  readonly id: string
  readonly schoolId: string
  readonly promptText: string
  readonly statedMaxWords: number | null
  readonly applicationCycle: string | null
  readonly sourceUrl: string | null
  readonly status: SubmissionStatus
  readonly approvedPromptId: string | null
  readonly createdAt: string
  // ---- 20261006_008 ------------------------------------------------------
  // null WHEREVER THE COLUMN WAS NOT SELECTED, which is the same answer as
  // "the applicant did not say". That is deliberate and harmless: with the
  // flag off there are no submissions carrying these values, so the two cases
  // cannot be confused by anything that exists.
  readonly documentLabel: string | null
  readonly documentTypeHint: string | null
  readonly statedMinWords: number | null
  readonly statedMaxCharacters: number | null
  readonly statedMaxPages: number | null
  readonly statedPagesText: string | null
  readonly formattingInstructions: string | null
  readonly otherInstructions: string | null
  readonly submitterNote: string | null
  /** The catalog row this became, or null. Never implies it is active. */
  readonly approvedRequirementId: string | null
  // ---- 20261008_012 ------------------------------------------------------
  /**
   * What this submission CLAIMS to be.
   *
   * DEFAULTS TO 'new-prompt' WHERE THE COLUMN WAS NOT SELECTED, matching the
   * column's own default, so a reader behind the flag sees what the database
   * would say rather than a third state meaning "unknown".
   */
  readonly kind: SubmissionKind
  /** The catalog row a report contradicts. Null for a new prompt. */
  readonly challengedRequirementId: string | null
}

/** One submission, as the review queue shows it. */
export interface ReviewSubmission extends OwnSubmission {
  readonly reviewedAt: string | null
  readonly reviewNote: string | null
  readonly duplicateOfId: string | null
  readonly textFingerprint: string
}

function fail(reason: SubmissionRefusalReason, detail: unknown): SubmissionResult<never> {
  const message =
    typeof detail === 'string' ? detail
      : typeof (detail as { message?: unknown })?.message === 'string'
        ? String((detail as { message: string }).message)
        : 'unknown'
  return { ok: false, reason, detail: message }
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null

/**
 * A numeric(4,1) page count, from a number OR a decimal string.
 *
 * THE SAME PATTERN repo.ts uses for margins_inches and for the canonical page
 * bounds, and for the same reason: PostgREST may send a numeric as either, and
 * an integer-only reader silently drops every fractional page.
 */
const pageNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * One row as an OwnSubmission, or null when it cannot be read coherently.
 *
 * STRICT, like rows.ts: a row whose status is not one this application knows
 * is refused rather than rendered, because an unknown status would otherwise
 * reach a screen that has no wording for it.
 */
function ownSubmissionFrom(row: unknown): OwnSubmission | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  const id = text(r.id)
  const schoolId = text(r.school_id)
  const promptText = text(r.prompt_text)
  const createdAt = text(r.created_at)
  const status = r.status
  if (!id || !schoolId || promptText === null || !createdAt) return null
  if (!isSubmissionStatus(status)) return null
  return {
    id,
    schoolId,
    promptText,
    statedMaxWords: count(r.stated_max_words),
    applicationCycle: text(r.application_cycle),
    sourceUrl: text(r.source_url),
    status,
    approvedPromptId: text(r.approved_prompt_id),
    createdAt,
    documentLabel: text(r.document_label),
    documentTypeHint: text(r.document_type_hint),
    statedMinWords: count(r.stated_min_words),
    statedMaxCharacters: count(r.stated_max_characters),
    // numeric(4,1) ARRIVES AS A NUMBER OR A STRING depending on the driver, and
    // 1.5 is not an integer -- so count() would read Boston College's page and
    // a half as null, which is exactly the bug 20261005_007 was written to fix.
    statedMaxPages: pageNumber(r.stated_max_pages),
    statedPagesText: text(r.stated_pages_text),
    formattingInstructions: text(r.formatting_instructions),
    otherInstructions: text(r.other_instructions),
    submitterNote: text(r.submitter_note),
    approvedRequirementId: text(r.approved_requirement_id),
    // AN UNRECOGNISED KIND IS NOT GUESSED AT -- it reads as the column's own
    // default, which is the only value a row can have had before 012.
    kind: isSubmissionKind(r.submission_kind) ? r.submission_kind : 'new-prompt',
    challengedRequirementId: text(r.challenged_requirement_id),
  }
}

function reviewSubmissionFrom(row: unknown): ReviewSubmission | null {
  const base = ownSubmissionFrom(row)
  if (!base) return null
  const r = row as Record<string, unknown>
  const fingerprint = text(r.text_fingerprint)
  if (fingerprint === null) return null
  return {
    ...base,
    reviewedAt: text(r.reviewed_at),
    reviewNote: text(r.review_note),
    duplicateOfId: text(r.duplicate_of_id),
    textFingerprint: fingerprint,
  }
}

/** A function's refusal word as one of ours. An unknown one is not guessed at. */
function reasonFrom(value: unknown): SubmissionRefusalReason {
  switch (value) {
    case 'not-authenticated': return 'not-authenticated'
    case 'not-found': return 'not-found'
    case 'already-decided': return 'already-decided'
    case 'rate-limited': return 'rate-limited'
    case 'school-not-listed': return 'school-not-listed'
    default: return 'invalid'
  }
}

/**
 * A draft and its pending submission, in ONE database transaction.
 *
 * THE CALLER'S OWN CLIENT, and the function is SECURITY INVOKER, so both
 * inserts are subject to the same RLS a direct insert would face. This call
 * buys atomicity and the in-database rate limit; it buys no privilege, which is
 * why a fault in it cannot become an escalation.
 *
 * NO CANONICAL FIELD CROSSES THIS BOUNDARY EITHER. The arguments are the
 * applicant's own: a title, an essay, the school they picked and the wording
 * they pasted. prompt_id is not a parameter, so this path cannot claim catalog
 * provenance even by mistake -- and the exclusion CHECK would refuse it if it
 * tried.
 */
export async function createDraftWithSubmission(
  db: SupabaseClient,
  input: { readonly title: string; readonly essay: string } & PromptSubmissionInput,
): Promise<SubmissionResult<{ draft: StatementDraft; submissionId: string }>> {
  const { data, error } = await db.rpc('create_statement_draft_with_prompt_submission', {
    p_title: input.title,
    p_essay: input.essay,
    p_school_id: input.schoolId,
    p_prompt_text: input.promptText,
    p_stated_max_words: input.statedMaxWords,
    p_application_cycle: input.applicationCycle,
    p_source_url: input.sourceUrl,
    // ---- 20261006_008 ----------------------------------------------------
    // NAMED PARAMETERS WITH DEFAULTS, so this call still works against a
    // database where 008 has not been applied: PostgREST matches a function by
    // the argument names supplied, and the pre-008 signature has none of
    // these. That is why they are passed only when the flag that releases them
    // is on -- see submissionFieldsEnabled().
    ...(submissionFieldsEnabled() ? {
      p_document_label: input.documentLabel,
      p_document_type_hint: input.documentTypeHint,
      p_stated_min_words: input.statedMinWords,
      p_stated_max_characters: input.statedMaxCharacters,
      p_stated_max_pages: input.statedMaxPages,
      p_stated_pages_text: input.statedPagesText,
      p_formatting_instructions: input.formattingInstructions,
      p_other_instructions: input.otherInstructions,
      p_submitter_note: input.submitterNote,
    } : {}),
    // ---- 20261008_012 ----------------------------------------------------
    // SAME PATTERN, SAME REASON. A database without 012 has no parameter of
    // these names, and PostgREST matches on the names supplied -- so a report
    // can only be sent where the column exists to receive it.
    ...(promptChangeReportsEnabled() ? {
      p_submission_kind: input.kind,
      p_challenged_requirement_id: input.challengedRequirementId,
    } : {}),
  })
  if (error) return fail('write-failed', error)
  if (typeof data !== 'object' || data === null) {
    return fail('data-integrity', 'the create function returned no object')
  }

  const body = data as Record<string, unknown>
  if (body.ok !== true) return fail(reasonFrom(body.reason), String(body.reason ?? 'refused'))

  const submissionId = text(body.submissionId)
  const draft = draftFromRow(body.draft as StatementDraftRow)
  if (!submissionId || !draft) return fail('data-integrity', 'unreadable create result')
  return { ok: true, value: { draft, submissionId } }
}

/** The caller's own submission, or not-found. RLS decides which. */
export async function readOwnSubmission(
  db: SupabaseClient,
  submissionId: string,
): Promise<SubmissionResult<OwnSubmission>> {
  const { data, error } = await db
    .from(SUBMISSIONS)
    .select(ownSubmissionColumns())
    .eq('id', submissionId)
    .maybeSingle()
  if (error) return fail('read-failed', error)
  if (!data) return fail('not-found', '')
  const submission = ownSubmissionFrom(data)
  if (!submission) return fail('data-integrity', 'unreadable submission row')
  return { ok: true, value: submission }
}

/** Everything the caller has submitted, newest first. */
export async function listOwnSubmissions(
  db: SupabaseClient,
): Promise<SubmissionResult<readonly OwnSubmission[]>> {
  const { data, error } = await db
    .from(SUBMISSIONS)
    .select(ownSubmissionColumns())
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) return fail('read-failed', error)
  const rows: OwnSubmission[] = []
  for (const row of data ?? []) {
    const submission = ownSubmissionFrom(row)
    if (!submission) return fail('data-integrity', 'unreadable submission row')
    rows.push(submission)
  }
  return { ok: true, value: rows }
}

/**
 * Withdraw one's own pending submission.
 *
 * THE DRAFT IS NOT MENTIONED. Withdrawing is an instruction about the shared
 * catalog -- "do not consider publishing this" -- and has nothing to say about
 * the applicant's own writing. No statement in this path touches
 * statement_drafts, so there is no code here that could delete, clear or
 * rewrite one.
 */
export async function withdrawSubmission(
  db: SupabaseClient,
  submissionId: string,
): Promise<SubmissionResult<{ status: SubmissionStatus }>> {
  const { data, error } = await db.rpc('withdraw_statement_prompt_submission', {
    p_submission_id: submissionId,
  })
  if (error) return fail('write-failed', error)
  if (typeof data !== 'object' || data === null) {
    return fail('data-integrity', 'the withdraw function returned no object')
  }
  const body = data as Record<string, unknown>
  if (body.ok !== true) return fail(reasonFrom(body.reason), String(body.reason ?? 'refused'))
  return { ok: true, value: { status: 'withdrawn' } }
}

/**
 * The review queue. ADMIN ONLY, and that is the route's job to establish: this
 * function is handed whatever client it is given and will read with it.
 *
 * It is called with a service-role client because the submissions table grants
 * applicants row access to their OWN rows only -- an administrator reading
 * everyone's is precisely the case RLS is written to refuse, so it is done by
 * a role that bypasses RLS, behind an authorization check in the route.
 */
export async function listSubmissionsForReview(
  adminDb: SupabaseClient,
  filter: { readonly status?: SubmissionStatus },
): Promise<SubmissionResult<readonly ReviewSubmission[]>> {
  let query = adminDb.from(SUBMISSIONS).select(reviewColumns())
  if (filter.status) query = query.eq('status', filter.status)

  const { data, error } = await query.order('created_at', { ascending: false }).limit(500)
  if (error) return fail('read-failed', error)

  const rows: ReviewSubmission[] = []
  for (const row of data ?? []) {
    const submission = reviewSubmissionFrom(row)
    if (!submission) return fail('data-integrity', 'unreadable submission row')
    rows.push(submission)
  }
  return { ok: true, value: rows }
}

/**
 * ONE submission, as the review queue shows it. ADMIN ONLY, same client rules
 * as listSubmissionsForReview.
 *
 * WHY THE DECIDE PATH NEEDS IT. A report and a new prompt are published
 * differently, and the choice between replacing a row and adding another is
 * the administrator's. The handler has to KNOW which kind it is holding before
 * it can insist on that choice -- and reading it from the request body would
 * let the caller decide which rules apply to them.
 */
export async function readSubmissionForReview(
  adminDb: SupabaseClient,
  submissionId: string,
): Promise<SubmissionResult<ReviewSubmission>> {
  const { data, error } = await adminDb
    .from(SUBMISSIONS)
    .select(reviewColumns())
    .eq('id', submissionId)
    .maybeSingle()
  if (error) return fail('read-failed', error)
  if (!data) return fail('not-found', '')
  const submission = reviewSubmissionFrom(data)
  if (!submission) return fail('data-integrity', 'unreadable submission row')
  return { ok: true, value: submission }
}

/** One moderation decision, through the locking definer function. */
export async function decideSubmission(
  adminDb: SupabaseClient,
  input: {
    readonly submissionId: string
    readonly decision: 'approved' | 'rejected' | 'duplicate'
    readonly reviewerId: string
    readonly label?: string | null
    readonly promptText?: string | null
    readonly duplicateOf?: string | null
    readonly supersedes?: string | null
    readonly deactivateOld?: boolean
    readonly reviewNote?: string | null
  },
): Promise<SubmissionResult<{ status: string; promptId: string | null }>> {
  const { data, error } = await adminDb.rpc('decide_statement_prompt_submission', {
    p_submission_id: input.submissionId,
    p_decision: input.decision,
    p_reviewer_id: input.reviewerId,
    p_label: input.label ?? null,
    p_prompt_text: input.promptText ?? null,
    p_duplicate_of: input.duplicateOf ?? null,
    p_supersedes: input.supersedes ?? null,
    p_deactivate_old: input.deactivateOld === true,
    p_review_note: input.reviewNote ?? null,
  })
  if (error) return fail('write-failed', error)
  if (typeof data !== 'object' || data === null) {
    return fail('data-integrity', 'the decide function returned no object')
  }
  const body = data as Record<string, unknown>
  if (body.ok !== true) return fail(reasonFrom(body.reason), String(body.reason ?? 'refused'))
  return { ok: true, value: { status: String(body.status), promptId: text(body.promptId) } }
}

/**
 * Whether the school a submission names is one this product actually lists.
 *
 * THE FOREIGN KEY THAT COULD NOT BE DECLARED. public.schools predates the
 * migrations directory and has no DDL in this repository, so neither the
 * submissions table nor the catalog can declare REFERENCES without aborting on
 * every environment except production. This read is the enforcement in the
 * meantime, and it is deliberately the SAME directory the picker offered: a
 * school an applicant could not have been shown is a school they should not be
 * able to submit against.
 *
 * TAKES THE WHOLE INPUT, NOT AN ID, so the route that calls it never has to
 * name a canonical field to reach one -- the trust boundary asserted over the
 * collection route's source stays literally true.
 *
 * ONE COLUMN, AND ONLY TO LEARN WHETHER A ROW EXISTS. No school data is read,
 * returned or stored by this path.
 */
export async function verifySchoolListed(
  db: SupabaseClient,
  input: PromptSubmissionInput,
): Promise<SubmissionResult<true>> {
  const { data, error } = await db
    .from('schools')
    .select('id')
    .eq('id', input.schoolId)
    .maybeSingle()
  if (error) return fail('read-failed', error)
  if (!data) return fail('invalid', 'school is not listed')
  return { ok: true, value: true }
}

/**
 * The review status of the submission a draft's prompt was pasted from.
 *
 * TWO READS, NOT A JOIN, and deliberately so. The first asks the draft for one
 * column; the second asks the submissions table for one row. A join would have
 * to be expressed through PostgREST's embedding syntax, which needs a declared
 * foreign key -- and there is none, for the reasons every migration in this
 * family states.
 *
 * THE DRAFT'S OWN WORDING IS NOT READ HERE AND IS NOT RETURNED. This answers
 * "what happened to the submission", never "what does this draft say" -- the
 * editor already holds the snapshot and must keep rendering that. A function
 * that returned submission wording would be an invitation to display it, and
 * displaying it is how an admin's correction would silently replace somebody's
 * saved prompt.
 *
 * NULL IS A REAL ANSWER. A general draft and a catalog-prompt draft both have
 * no submission, and neither is an error.
 */
export async function readDraftPromptStatus(
  db: SupabaseClient,
  draftId: string,
): Promise<SubmissionResult<{ submissionId: string; status: SubmissionStatus } | null>> {
  const { data: draft, error: draftError } = await db
    .from('statement_drafts')
    .select('prompt_submission_id')
    .eq('id', draftId)
    .maybeSingle()
  if (draftError) return fail('read-failed', draftError)
  if (!draft) return fail('not-found', '')

  const submissionId = text((draft as Record<string, unknown>).prompt_submission_id)
  if (submissionId === null) return { ok: true, value: null }

  const { data: row, error } = await db
    .from(SUBMISSIONS)
    .select('id, status')
    .eq('id', submissionId)
    .maybeSingle()
  if (error) return fail('read-failed', error)
  // The draft points at a submission this caller cannot see, or that is gone.
  // The draft is still perfectly usable; its snapshot is its own.
  if (!row) return { ok: true, value: null }

  const status = (row as Record<string, unknown>).status
  if (!isSubmissionStatus(status)) return fail('data-integrity', 'unknown submission status')
  return { ok: true, value: { submissionId, status } }
}


/**
 * Whether a draft's prompt REALLY is the catalog's, decided by asking the
 * catalog rather than by reading the draft.
 *
 * THE PROBLEM THIS SOLVES. public.statement_drafts grants table-level UPDATE to
 * `authenticated`, so an applicant can write any column of their own row
 * directly through PostgREST -- prompt_id and prompt_text included. Every claim
 * stored on a draft is therefore a claim, not a finding, and a future analyser
 * that trusted prompt_id would be trusting a value its subject can set.
 *
 * WHAT CANNOT BE FORGED IS THE CATALOG. public.statement_prompts grants no
 * insert or update to any browser role, and the only path that writes it is a
 * definer function restricted to service_role. So a prompt is the catalog's
 * when the catalog holds a row with that id AND that row still says what the
 * draft says. Both halves are required: an id alone proves nothing, because an
 * applicant can copy a real id onto wording of their own.
 *
 * DELIBERATELY NOT CALLED BY AUTOSAVE OR THE EDITOR. It is a verification, not
 * a display rule: the editor shows the draft's own snapshot and labels its
 * origin from which column is populated, which is cheap and honest about being
 * a hint. This function is what a trust decision should use, and the analyser
 * is where that decision will live.
 *
 * A FAILED READ IS NOT 'catalog'. Any refusal returns 'user', because the
 * question is "can this be shown to be the catalog's" and a connection that
 * dropped has not shown it.
 */
export async function verifiedProvenance(
  db: SupabaseClient,
  draft: { readonly promptId: string | null; readonly promptText: string | null },
): Promise<PromptOrigin | null> {
  if (draft.promptText === null) return null
  if (draft.promptId === null) return 'user'

  const { data, error } = await db
    .from('statement_prompts')
    .select('prompt_text')
    .eq('id', draft.promptId)
    .maybeSingle()
  if (error) return 'user'

  const catalogText = data === null
    ? null
    : text((data as Record<string, unknown>).prompt_text)
  return provenanceOf({ promptText: draft.promptText, catalogText })
}
