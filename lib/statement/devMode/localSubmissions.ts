/**
 * Applicant-submitted school prompts, served locally for simulated-live review.
 *
 * WHY THIS MODULE EXISTS. The submission subsystem is built, migrated and
 * tested, and every one of its three writes is a SECURITY DEFINER function --
 * deliberately, because no browser role may write the prompt catalog. The
 * guarded client refuses every rpc() in simulated-live, so on localhost the
 * whole feature answered "blocked" rather than working. This is the local
 * stand-in for those three functions and for reads of the submissions table.
 *
 * IT IMITATES THE FUNCTIONS, NOT THE TABLE GRANTS. The real protection is that
 * applicants hold no INSERT or UPDATE on public.statement_prompt_submissions
 * and no write grant at all on the catalog; a local file cannot reproduce a
 * grant, so the properties that matter are reproduced as behaviour instead:
 *
 *   * the only way in is the create function, which stamps submitted_by from
 *     the caller and status 'pending' -- neither is read from the request;
 *   * a decide is refused unless the caller is an administrator, which the
 *     route establishes before this module is reached;
 *   * a withdraw is refused unless the row belongs to the caller;
 *   * every direct write to the table throws, as it does in production.
 *
 * AND IT NEVER TOUCHES THE CANONICAL CATALOG. Approving a submission here
 * records the decision and nothing else: no statement_prompts row, no
 * statement_requirements row. Promotion is a separate, explicit admin action --
 * which is the behaviour production has too, and the distinction the owner
 * asked to keep uncollapsed.
 */
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { readJsonStore, writeJsonStore } from './jsonStore.ts'
import { SimulatedLiveWriteBlocked } from './gate.ts'
import { insertLocalDraftRow } from './localDrafts.ts'
import { promoteLocally } from './localCanonical.ts'

type Row = Record<string, unknown>
type Result = { data: unknown; error: { code: string; message: string } | null }

/** Same containment rules as the other local stores. */
const STORE = path.join(
  process.cwd(),
  'local-review',
  path.basename(process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE ?? 'dev-submissions.json'),
)

export const SUBMISSIONS_TABLE = 'statement_prompt_submissions'

/**
 * Every column the submission readers select.
 *
 * COMPLETED ON WRITE, so a stored row is never short one: PostgREST returns a
 * named column as null rather than omitting it, and a reader that saw
 * `undefined` where the database would have said null would take a different
 * branch locally than in production.
 */
const COLUMNS = [
  'id', 'submitted_by', 'school_id', 'prompt_text',
  'stated_max_words', 'application_cycle', 'source_url',
  'status', 'reviewed_by', 'reviewed_at', 'review_note',
  'approved_prompt_id', 'approved_requirement_id', 'duplicate_of_id',
  'text_fingerprint', 'created_at', 'updated_at',
  // 20261006_008: what the applicant could tell us beyond the wording.
  'document_label', 'document_type_hint', 'stated_min_words',
  'stated_max_characters', 'stated_max_pages', 'stated_pages_text',
  'formatting_instructions', 'other_instructions', 'submitter_note',
  // 20261008_012: whether this is a new prompt or a report that an existing
  // catalog row is out of date, and which row it challenges.
  'submission_kind', 'challenged_requirement_id',
] as const

function complete(row: Row): Row {
  const out: Row = {}
  for (const column of COLUMNS) out[column] = row[column] ?? null
  return out
}

/**
 * Every stored submission.
 *
 * AN UNREADABLE STORE THROWS. It used to log and return [], which reads as
 * "this applicant has submitted nothing" -- and the next write persisted that,
 * deleting every submission in the file. A log line is not a safe response to
 * data you cannot read.
 */
function readAll(): Row[] {
  const parsed = readJsonStore<unknown>(STORE, [])
  return Array.isArray(parsed) ? parsed as Row[] : []
}

function writeAll(rows: readonly Row[]): void {
  writeJsonStore(STORE, rows)
}

/**
 * The grouping key, computed exactly as the migration's comment specifies:
 * SHA-256 of the wording case folded, whitespace runs collapsed, ends trimmed.
 *
 * THE SAME RULE, SO LOCAL DUPLICATE GROUPING MATCHES PRODUCTION'S. It is not a
 * security control in either place: it puts likely duplicates next to each
 * other on a review screen and a human decides.
 */
export function submissionFingerprint(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * The caller a read is answered for.
 *
 * THIS IS THE RLS STAND-IN, AND IT IS NOT OPTIONAL. listOwnSubmissions() issues
 * `.select(...).order(...).limit(100)` with NO submitted_by filter, because in
 * production the own-row SELECT policy supplies it -- that is the whole design:
 * the query cannot forget a predicate the database applies. A local file has no
 * policies, so a builder that ignored the caller would hand one applicant
 * everybody else's submissions, which is precisely the thing the policy exists
 * to prevent. So the predicate is applied here instead.
 *
 * AN ADMINISTRATOR SEES EVERY ROW, because the review queue uses a service-role
 * client in production and service_role is not subject to RLS. The route
 * establishes that before this module is reached.
 */
class LocalSubmissionQuery implements PromiseLike<Result> {
  private filters: [string, unknown][] = []
  private ordering: { column: string; ascending: boolean } | null = null
  private cap: number | null = null
  private singleRow = false

  private readonly caller: { userId: string | null; isAdmin: boolean }

  // A PLAIN FIELD, NOT A PARAMETER PROPERTY: the test runner strips types
  // rather than compiling them, and `constructor(private x)` is syntax it
  // cannot strip.
  constructor(caller: { userId: string | null; isAdmin: boolean }) {
    this.caller = caller
  }

  select(): this { return this }
  eq(column: string, value: unknown): this { this.filters.push([column, value]); return this }
  in(column: string, values: readonly unknown[]): this {
    this.filters.push([column, { in: values }])
    return this
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering = { column, ascending: options?.ascending !== false }
    return this
  }
  limit(count: number): this { this.cap = count; return this }
  maybeSingle(): this { this.singleRow = true; return this }
  single(): this { this.singleRow = true; return this }

  insert(): never { throw new SimulatedLiveWriteBlocked('insert', SUBMISSIONS_TABLE) }
  update(): never { throw new SimulatedLiveWriteBlocked('update', SUBMISSIONS_TABLE) }
  upsert(): never { throw new SimulatedLiveWriteBlocked('upsert', SUBMISSIONS_TABLE) }
  delete(): never { throw new SimulatedLiveWriteBlocked('delete', SUBMISSIONS_TABLE) }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => {
      if (value !== null && typeof value === 'object' && 'in' in (value as Row)) {
        return ((value as { in: readonly unknown[] }).in).includes(row[column])
      }
      return row[column] === value
    })
  }

  private run(): Result {
    // THE POLICY FIRST, THE QUERY'S OWN FILTERS SECOND. An administrator is
    // exempt, as service_role is; everybody else can only ever see their own.
    const visible = this.caller.isAdmin
      ? readAll()
      : readAll().filter((row) => row.submitted_by === this.caller.userId)
    let found = visible.filter((row) => this.matches(row))
    if (this.ordering !== null) {
      const { column, ascending } = this.ordering
      found = [...found].sort((a, b) => {
        const left = String(a[column] ?? '')
        const right = String(b[column] ?? '')
        return ascending ? left.localeCompare(right) : right.localeCompare(left)
      })
    }
    if (this.cap !== null) found = found.slice(0, this.cap)
    // THE COLUMN GRANT, TOO. Applicants hold SELECT on a named column list that
    // excludes review_note -- a note saying "this looks like a troll" must not
    // be readable by the person it is about. A column that is not granted
    // cannot be selected at all, so locally it is removed rather than nulled.
    const shown = this.caller.isAdmin ? found : found.map(withoutPrivateColumns)
    if (this.singleRow) return { data: shown[0] ?? null, error: null }
    return { data: shown, error: null }
  }
}

/**
 * The columns an applicant holds no SELECT grant on.
 *
 * TWO, NOT ONE. 20261002_000 grants `reviewed_at` and withholds both
 * `review_note` and `reviewed_by`: the note must not be readable by the person
 * it is about, and neither must the identity of the administrator who wrote it.
 */
function withoutPrivateColumns(row: Row): Row {
  const { review_note: _note, reviewed_by: _reviewer, ...rest } = row
  return rest
}

export function localSubmissionsBuilder(
  caller: { userId: string | null; isAdmin: boolean },
): LocalSubmissionQuery {
  return new LocalSubmissionQuery(caller)
}

// ---------------------------------------------------------------------------
// the three privileged functions
// ---------------------------------------------------------------------------

/** The names the repository calls. Anything else still throws. */
export const SUBMISSION_FUNCTIONS = [
  'create_statement_draft_with_prompt_submission',
  'withdraw_statement_prompt_submission',
  'decide_statement_prompt_submission',
  // 20261015_017. EXECUTE on the real one is service_role only, so it is
  // reachable solely through the admin route -- and the stand-in re-checks the
  // caller anyway, because a local file has no privileges to lean on.
  'promote_statement_submission_to_requirement',
] as const

const HOUR_LIMIT = 3
const DAY_LIMIT = 10

function refuse(reason: string, extra: Row = {}): Result {
  return { data: { ok: false, reason, ...extra }, error: null }
}

/**
 * The local stand-in for the three definer functions.
 *
 * `userId` IS THE SERVER'S ANSWER, NOT THE REQUEST'S, exactly as auth.uid() is
 * inside the real functions: the guarded client is built from the caller's own
 * token and passes the id it authenticated. No parameter names a submitter.
 */
export function localSubmissionRpc(
  name: string,
  params: Row,
  context: { readonly userId: string | null; readonly isAdmin: boolean },
): Result {
  if (name === 'create_statement_draft_with_prompt_submission') {
    return create(params, context.userId)
  }
  if (name === 'withdraw_statement_prompt_submission') {
    return withdraw(params, context.userId)
  }
  if (name === 'decide_statement_prompt_submission') {
    return decide(params, context)
  }
  if (name === 'promote_statement_submission_to_requirement') {
    return promote(params, context)
  }
  throw new SimulatedLiveWriteBlocked('rpc', name)
}

function create(params: Row, userId: string | null): Result {
  if (userId === null) return refuse('not-authenticated')

  const schoolId = params.p_school_id
  if (typeof schoolId !== 'string' || schoolId.length === 0) return refuse('invalid-school')
  const promptText = params.p_prompt_text
  if (typeof promptText !== 'string' || promptText.trim().length === 0) {
    return refuse('invalid-prompt-text')
  }
  const title = params.p_title
  if (typeof title !== 'string' || title.trim().length === 0) return refuse('invalid-title')

  /*
   * 20261008_012's statement_prompt_submissions_challenge_shape, APPLIED HERE
   * BECAUSE A JSON FILE HAS NO CHECK CONSTRAINTS.
   *
   * The route refuses both halves already. This is not redundant: the
   * constraint is what makes "the kind and its target travel together" true of
   * the DATA rather than of one code path, and a stand-in that accepted a row
   * production would refuse would let a test pass against a state that cannot
   * exist.
   */
  const kind = params.p_submission_kind ?? 'new-prompt'
  if (kind !== 'new-prompt' && kind !== 'prompt-change') return refuse('invalid-kind')
  const challenged = params.p_challenged_requirement_id ?? null
  if (kind === 'prompt-change' && typeof challenged !== 'string') {
    return refuse('invalid-challenged-requirement')
  }
  if (kind === 'new-prompt' && challenged !== null) {
    return refuse('invalid-challenged-requirement')
  }

  // THE SAME TWO WINDOWS THE FUNCTION APPLIES, so a reviewer meets the real
  // rate limit rather than discovering it after release.
  const mine = readAll().filter((row) => row.submitted_by === userId)
  const since = (ms: number) => Date.now() - ms
  const within = (ms: number) => mine.filter(
    (row) => Date.parse(String(row.created_at)) > since(ms)).length
  if (within(60 * 60 * 1000) >= HOUR_LIMIT) {
    return refuse('rate-limited', { window: 'hour' })
  }
  if (within(24 * 60 * 60 * 1000) >= DAY_LIMIT) {
    return refuse('rate-limited', { window: 'day' })
  }

  const submissionId = randomUUID()
  const now = new Date().toISOString()
  // ONE WRITE EACH, IN THIS ORDER, AND NEITHER IS CONDITIONAL. The real
  // function is one transaction; there is no partial state to reach here
  // because nothing between these two lines can fail.
  const draft = insertLocalDraftRow({
    user_id: userId,
    title: String(title).trim(),
    essay: typeof params.p_essay === 'string' ? params.p_essay : '',
    school_id: schoolId,
    prompt_id: null,
    prompt_text: promptText,
    stated_max_words: params.p_stated_max_words ?? null,
    requirement_id: null,
    requirement_snapshot: null,
    prompt_submission_id: submissionId,
  })
  writeAll([...readAll(), complete({
    id: submissionId,
    // STAMPED, NEVER READ FROM THE REQUEST. These two are the whole trust
    // boundary of a submission: who made it, and that it is only pending.
    submitted_by: userId,
    status: 'pending',
    school_id: schoolId,
    prompt_text: promptText,
    stated_max_words: params.p_stated_max_words ?? null,
    application_cycle: params.p_application_cycle ?? null,
    source_url: params.p_source_url ?? null,
    document_label: params.p_document_label ?? null,
    document_type_hint: params.p_document_type_hint ?? null,
    stated_min_words: params.p_stated_min_words ?? null,
    stated_max_characters: params.p_stated_max_characters ?? null,
    stated_max_pages: params.p_stated_max_pages ?? null,
    stated_pages_text: params.p_stated_pages_text ?? null,
    formatting_instructions: params.p_formatting_instructions ?? null,
    other_instructions: params.p_other_instructions ?? null,
    submitter_note: params.p_submitter_note ?? null,
    /*
     * 20261008_012. STORED, BECAUSE A REPORT THAT ARRIVES AS A NEW PROMPT IS
     * THE BUG THE MIGRATION EXISTS TO PREVENT.
     *
     * These two were being passed by submissionRepo and dropped here, so every
     * "this prompt has changed" report reached the local queue indistinguish-
     * able from "here is a prompt you do not have" -- which is exactly the
     * loss of information 012's header describes, reproduced by the stand-in
     * that was supposed to demonstrate the fix.
     *
     * DEFAULTED THE WAY THE COLUMN IS, so a create that names neither stores
     * 'new-prompt' and a null target rather than two nulls the reader would
     * have to interpret.
     */
    submission_kind: kind,
    challenged_requirement_id: challenged,
    text_fingerprint: submissionFingerprint(promptText),
    created_at: now,
    updated_at: now,
  })])

  return { data: { ok: true, submissionId, draft }, error: null }
}

function withdraw(params: Row, userId: string | null): Result {
  if (userId === null) return refuse('not-authenticated')
  const rows = readAll()
  const index = rows.findIndex(
    (row) => row.id === params.p_submission_id && row.submitted_by === userId)
  // NOT-FOUND COVERS SOMEBODY ELSE'S ROW TOO, which is the indistinguishability
  // the real function produces by re-checking ownership itself.
  if (index < 0) return refuse('not-found')
  if (rows[index]!.status !== 'pending') return refuse('already-decided')
  rows[index] = { ...rows[index]!, status: 'withdrawn', updated_at: new Date().toISOString() }
  writeAll(rows)
  return { data: { ok: true }, error: null }
}

function decide(
  params: Row,
  context: { readonly userId: string | null; readonly isAdmin: boolean },
): Result {
  // THE ROUTE HAS ALREADY ESTABLISHED THIS, and it is re-checked anyway: in
  // production the EXECUTE privilege on decide() is service_role only, and a
  // local file has no privileges to lean on.
  if (!context.isAdmin) return refuse('not-authorized')
  const rows = readAll()
  const index = rows.findIndex((row) => row.id === params.p_submission_id)
  if (index < 0) return refuse('not-found')
  if (rows[index]!.status !== 'pending') return refuse('already-decided')

  /*
   * THE PARAMETER NAMES ARE THE REPOSITORY'S, NOT THIS FILE'S.
   *
   * This read p_status and p_duplicate_of_id. decideSubmission() sends
   * p_decision and p_duplicate_of -- so every Approve, Reject and
   * mark-duplicate in the local queue was refused as 'invalid-status', and the
   * admin page reported "That decision could not be applied."
   *
   * IT WAS HIDDEN BY THE TESTS THAT SHOULD HAVE CAUGHT IT. They called
   * db.rpc('decide_statement_prompt_submission', ...) with the names THIS file
   * expected, so both sides of a mismatch agreed with each other and neither
   * agreed with the repository. A stand-in for a function is only worth
   * anything if it is called the way the function is called, which is why the
   * tests now go through decideSubmission().
   */
  const decision = params.p_decision
  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'duplicate') {
    return refuse('invalid-decision')
  }
  const status = decision

  // A DECISION, AND ONLY A DECISION. Production's approve branch inserts a
  // statement_prompts row; this does not, and the difference is deliberate:
  // promotion into the canonical catalog is a separate admin action against the
  // requirements catalog, so that "reviewed" and "published" stay two states.
  rows[index] = {
    ...rows[index]!,
    status,
    // THE SERVER'S OWN ANSWER, NOT THE PARAMETER. The route passes
    // p_reviewer_id from the verified session and the real function trusts it;
    // preferring the context here means a hand-written call cannot file one
    // administrator's decision under another's name.
    reviewed_by: context.userId ?? params.p_reviewer_id ?? null,
    reviewed_at: new Date().toISOString(),
    review_note: params.p_review_note ?? rows[index]!.review_note ?? null,
    duplicate_of_id: status === 'duplicate'
      ? (params.p_duplicate_of ?? null)
      : rows[index]!.duplicate_of_id ?? null,
    updated_at: new Date().toISOString(),
  }
  writeAll(rows)
  return { data: { ok: true, status }, error: null }
}

/**
 * Promote a submission into the LOCAL canonical catalog.
 *
 * THE AUTHORISATION IS RE-CHECKED HERE. In production EXECUTE on this function
 * is granted to service_role alone, so an applicant cannot call it however they
 * are authenticated. There is no EXECUTE privilege on a JSON file, so the
 * route's own verified answer is the only thing standing in for it -- and it is
 * checked before anything is read, let alone written.
 */
function promote(
  params: Row,
  context: { readonly userId: string | null; readonly isAdmin: boolean },
): Result {
  if (!context.isAdmin) return refuse('not-authorized')

  const submissionId = params.p_submission_id
  if (typeof submissionId !== 'string') return refuse('invalid-submission')
  const rows = readAll()
  const index = rows.findIndex((row) => row.id === submissionId)
  if (index < 0) return refuse('not-found')

  const outcome = promoteLocally({
    submission: rows[index]!,
    reviewerId: context.userId,
    mode: params.p_mode,
    setId: params.p_set_id ?? null,
    set: (params.p_set ?? {}) as Row,
    requirement: (params.p_requirement ?? {}) as Row,
  })
  if (!outcome.ok) return refuse(outcome.reason)

  // THE LINK BACK, AND THE ENDORSEMENT. A submission still pending becomes
  // approved, because publishing one is accepting it; one already approved
  // keeps its earlier reviewed_at and only gains the link. The same two lines
  // 20261015_017 writes.
  rows[index] = {
    ...rows[index]!,
    status: 'approved',
    reviewed_by: rows[index]!.reviewed_by ?? context.userId,
    reviewed_at: rows[index]!.reviewed_at ?? new Date().toISOString(),
    approved_requirement_id: outcome.requirementId,
    updated_at: new Date().toISOString(),
  }
  writeAll(rows)

  return {
    data: {
      ok: true,
      setId: outcome.setId,
      requirementId: outcome.requirementId,
      created: outcome.created,
      isActive: false,
    },
    error: null,
  }
}

// ---------------------------------------------------------------------------
// used by tests, by the admin screen and by hand
// ---------------------------------------------------------------------------

export function localSubmissions(): readonly Row[] {
  return readAll()
}

export function localSubmissionById(id: string): Row | null {
  return readAll().find((row) => row.id === id) ?? null
}

export function localSubmissionCount(): number {
  return readAll().length
}

export function resetLocalSubmissions(): void {
  writeAll([])
}
