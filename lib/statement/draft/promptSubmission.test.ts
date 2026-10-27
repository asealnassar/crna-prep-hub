import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAX_SOURCE_URL_CHARS,
  MAX_STATED_MAX_WORDS,
  MAX_SUBMITTED_PROMPT_CHARS,
  SUBMISSION_STATUSES,
  checkApplicationCycle,
  checkPromptSubmission,
  checkSourceUrl,
  checkStatedMaxWords,
  checkSubmittedPromptText,
  isFinalStatus,
  isSubmissionStatus,
  PROMPT_STATUS_LABELS,
  mayWithdraw,
  normalizedPromptText,
  originOf,
  promptStatusLabel,
  provenanceOf,
} from './promptSubmission.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/**
 * SQL with its comments removed.
 *
 * Every "must not contain" assertion below runs against this rather than the
 * raw file. These migrations explain themselves at length -- one of them uses
 * the word "backfill" to promise it does no backfill -- so a blacklist checked
 * against the prose would fail on the sentence that states the guarantee.
 */
const stripSql = (sql: string) => sql.replace(/^\s*--.*$/gm, '')

/** Just the GRANT and REVOKE statements, which is what a privilege test means. */
const grantsIn = (sql: string) =>
  (stripSql(sql).match(/^\s*(grant|revoke)[\s\S]*?;/gm) ?? []).join('\n')
const SUBMISSIONS_SQL = read('../../../supabase/migrations/20261002_000_statement_prompt_submissions.sql')
const DRAFT_LINK_SQL = read('../../../supabase/migrations/20261002_001_statement_draft_prompt_submission.sql')
const CATALOG_SQL = read('../../../supabase/migrations/20261002_002_statement_prompts_review_write.sql')
const RPC_SQL = read('../../../supabase/migrations/20261002_003_statement_prompt_submission_rpcs.sql')
const PROMPTS_SQL = read('../../../supabase/migrations/20260930_000_statement_prompts.sql')

const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000003'
const PROMPT = 'c0ffee00-0000-4000-8000-000000000004'

const good = {
  schoolId: SCHOOL,
  promptText: 'Describe a clinical experience that shaped you.',
  confirmed: true,
}

// ===========================================================================
// THE WORDING
// ===========================================================================

test('wording is stored exactly as pasted, with its own formatting intact', () => {
  const multi = 'Part one.\n\n   Part two, indented.\n'
  const checked = checkSubmittedPromptText(multi)
  assert.equal(checked.ok, true)
  // Not trimmed, not collapsed: a school's own paragraphing is the question.
  assert.equal(checked.ok && checked.text, multi)
})

test('whitespace-only wording is not a question', () => {
  for (const blank of ['', '   ', '\t\n\n  ']) {
    const checked = checkSubmittedPromptText(blank)
    assert.equal(checked.ok, false)
    assert.equal(checked.ok === false && checked.code, 'invalid-prompt-text')
  }
})

test('the ceiling is measured in CODE POINTS, as Postgres measures it', () => {
  // An astral character is two UTF-16 units and one code point. A ceiling
  // measured with .length would accept wording the database then refuses.
  const astral = 'x'.repeat(MAX_SUBMITTED_PROMPT_CHARS - 1) + '\u{1F600}'
  assert.equal(astral.length, MAX_SUBMITTED_PROMPT_CHARS + 1, 'longer by UTF-16 units')
  assert.equal([...astral].length, MAX_SUBMITTED_PROMPT_CHARS, 'exactly at the limit by code points')
  assert.equal(checkSubmittedPromptText(astral).ok, true)

  const over = 'x'.repeat(MAX_SUBMITTED_PROMPT_CHARS + 1)
  const checked = checkSubmittedPromptText(over)
  assert.equal(checked.ok, false)
  assert.equal(checked.ok === false && checked.code, 'prompt-text-too-long')
})

test('non-strings are refused rather than coerced', () => {
  for (const bad of [null, undefined, 42, {}, ['text'], true]) {
    assert.equal(checkSubmittedPromptText(bad).ok, false)
  }
})

// ===========================================================================
// WHAT IS NOT KNOWN STAYS NOT KNOWN
// ===========================================================================

test('a blank word limit is NULL, never zero', () => {
  // THE SPECIFIC TRAP: an empty number input yields '', and Number('') is 0.
  // Recording that would claim a school allows zero words -- nobody said so.
  for (const blank of [undefined, null, '', '   ']) {
    const checked = checkStatedMaxWords(blank)
    assert.equal(checked.ok, true)
    assert.equal(checked.ok && checked.words, null)
  }
})

test('a real zero is REFUSED, not normalised into "no limit"', () => {
  // Somebody who typed 0 meant something. Turning it into "unlimited" would be
  // inventing the opposite of what they said.
  const checked = checkStatedMaxWords(0)
  assert.equal(checked.ok, false)
  assert.equal(checked.ok === false && checked.code, 'invalid-max-words')
})

test('a word limit is an integer inside the catalog range', () => {
  assert.equal(checkStatedMaxWords(1).ok, true)
  assert.equal(checkStatedMaxWords(MAX_STATED_MAX_WORDS).ok, true)
  for (const bad of [-1, 0, MAX_STATED_MAX_WORDS + 1, 1.5, NaN, Infinity, '500', true, {}]) {
    assert.equal(checkStatedMaxWords(bad).ok, false, `${String(bad)} must be refused`)
  }
})

test('a blank cycle is NULL, and a real one matches the catalog pattern', () => {
  for (const blank of [undefined, null, '', '  ']) {
    const checked = checkApplicationCycle(blank)
    assert.equal(checked.ok, true)
    assert.equal(checked.ok && checked.cycle, null)
  }
  for (const good of ['2026', '2026-2027', '2026-2031']) {
    const checked = checkApplicationCycle(` ${good} `)
    assert.equal(checked.ok, true)
    assert.equal(checked.ok && checked.cycle, good)
  }
  for (const bad of ['26', '2026x', 'x2026', '2026-', '2026/2027', '2026 2027', 2026]) {
    assert.equal(checkApplicationCycle(bad).ok, false, `${String(bad)} must be refused`)
  }
})

// ===========================================================================
// THE SOURCE LINK
// ===========================================================================

test('only http and https are accepted, by scheme and not by guesswork', () => {
  assert.equal(checkSourceUrl('https://example.edu/prompts').ok, true)
  assert.equal(checkSourceUrl('http://example.edu/prompts').ok, true)
  // A link an administrator may click must never be able to be any of these.
  for (const hostile of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.edu',
    'not a url at all',
  ]) {
    const checked = checkSourceUrl(hostile)
    assert.equal(checked.ok, false, `${hostile} must be refused`)
    assert.equal(checked.ok === false && checked.code, 'invalid-source')
  }
})

test('a blank source is NULL, and an overlong one is refused', () => {
  for (const blank of [undefined, null, '', '   ']) {
    const checked = checkSourceUrl(blank)
    assert.equal(checked.ok, true)
    assert.equal(checked.ok && checked.url, null)
  }
  const long = `https://example.edu/${'x'.repeat(MAX_SOURCE_URL_CHARS)}`
  assert.equal(checkSourceUrl(long).ok, false)
})

// ===========================================================================
// THE WHOLE SUBMISSION
// ===========================================================================

test('a complete submission normalises its optional fields', () => {
  const checked = checkPromptSubmission({
    ...good, statedMaxWords: 500, applicationCycle: ' 2026 ', sourceUrl: ' https://example.edu/a ',
  })
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.ok && checked.input, {
    schoolId: SCHOOL,
    // A SUBMISSION THAT DOES NOT SAY IS A NEW PROMPT. 012 adds the kind; an
    // absent one defaults rather than refusing, so every caller written before
    // reports existed keeps working and a report has to declare itself.
    kind: 'new-prompt',
    challengedRequirementId: null,
    promptText: good.promptText,
    statedMaxWords: 500,
    applicationCycle: '2026',
    sourceUrl: 'https://example.edu/a',
    // 20261006_008: every one unsupplied here, and every one explicitly null.
    documentLabel: null,
    documentTypeHint: null,
    statedMinWords: null,
    statedMaxCharacters: null,
    statedMaxPages: null,
    statedPagesText: null,
    formattingInstructions: null,
    otherInstructions: null,
    submitterNote: null,
  })
})

test('a submission with nothing optional carries three nulls', () => {
  const checked = checkPromptSubmission(good)
  assert.equal(checked.ok, true)
  assert.equal(checked.ok && checked.input.statedMaxWords, null)
  assert.equal(checked.ok && checked.input.applicationCycle, null)
  assert.equal(checked.ok && checked.input.sourceUrl, null)
})

test('CONSENT IS VALIDATION, not an interface detail', () => {
  // A caller that never rendered the checkbox cannot imply agreement.
  for (const notTrue of [undefined, null, false, 'true', 1, {}]) {
    const checked = checkPromptSubmission({ ...good, confirmed: notTrue })
    assert.equal(checked.ok, false, `${String(notTrue)} is not consent`)
    assert.equal(checked.ok === false && checked.code, 'not-confirmed')
  }
})

test('a malformed school id never reaches a query', () => {
  for (const bad of ['', 'nope', `${SCHOOL}x`, null, 42]) {
    const checked = checkPromptSubmission({ ...good, schoolId: bad })
    assert.equal(checked.ok, false)
    assert.equal(checked.ok === false && checked.code, 'invalid-school')
  }
})

test('the first problem is the one reported, in a fixed order', () => {
  const checked = checkPromptSubmission({
    schoolId: 'nope', promptText: '', statedMaxWords: 0, confirmed: false,
  })
  assert.equal(checked.ok === false && checked.code, 'invalid-school')
})

// ===========================================================================
// GROUPING, NOT IDENTITY
// ===========================================================================

test('normalisation folds case and collapses whitespace runs', () => {
  const a = '  Why   nurse\n\nanaesthesia?  '
  const b = 'why nurse anaesthesia?'
  assert.equal(normalizedPromptText(a), normalizedPromptText(b))
  assert.equal(normalizedPromptText(a), 'why nurse anaesthesia?')
})

test('normalisation does NOT fold punctuation or wording differences', () => {
  // Two genuinely different questions must not group, or review would hide one.
  assert.notEqual(
    normalizedPromptText('Why nurse anaesthesia?'),
    normalizedPromptText('Why nurse anaesthesia!'),
  )
  assert.notEqual(
    normalizedPromptText('Describe a challenge.'),
    normalizedPromptText('Describe a challenge you faced.'),
  )
})

// ===========================================================================
// STATUS
// ===========================================================================

test('the status vocabulary is closed, and matches the database CHECK', () => {
  for (const good of SUBMISSION_STATUSES) assert.equal(isSubmissionStatus(good), true)
  for (const bad of ['Pending', 'published', '', null, 1, {}]) {
    assert.equal(isSubmissionStatus(bad), false)
  }
  // The CHECK constraint lists exactly the same words.
  const check = SUBMISSIONS_SQL.slice(SUBMISSIONS_SQL.indexOf('statement_prompt_submissions_status\n'))
  for (const status of SUBMISSION_STATUSES) {
    assert.ok(check.includes(`'${status}'`), `the CHECK must list ${status}`)
  }
})

test('only pending is still awaiting a decision', () => {
  assert.equal(isFinalStatus('pending'), false)
  for (const done of ['approved', 'rejected', 'duplicate', 'withdrawn'] as const) {
    assert.equal(isFinalStatus(done), true)
  }
})

// ===========================================================================
// PROVENANCE
// ===========================================================================

test('origin is derived from which column is populated', () => {
  assert.equal(originOf({ promptId: PROMPT, promptSubmissionId: null }), 'catalog')
  assert.equal(originOf({ promptId: null, promptSubmissionId: PROMPT }), 'user')
  assert.equal(originOf({ promptId: null, promptSubmissionId: null }), null)
  // A row carrying both is refused by the database; this guesses at neither.
  assert.equal(originOf({ promptId: PROMPT, promptSubmissionId: PROMPT }), null)
})

test('TRUST IS THE CATALOG AGREEING, never a column on the draft', () => {
  const wording = 'Why have you chosen nurse anaesthesia?'
  // The catalog says the same thing: this really is an approved prompt.
  assert.equal(provenanceOf({ promptText: wording, catalogText: wording }), 'catalog')
  // A prompt_id that resolves to nothing -- forged, or since deleted.
  assert.equal(provenanceOf({ promptText: wording, catalogText: null }), 'user')
  // A prompt_id that resolves but to DIFFERENT wording. A forged snapshot
  // pointing at a real catalog row lands here, and so does a legitimate draft
  // whose prompt has since been revised. Both are 'user': this product does
  // not vouch for that wording today.
  assert.equal(provenanceOf({ promptText: wording, catalogText: 'Something else.' }), 'user')
  // No question at all.
  assert.equal(provenanceOf({ promptText: null, catalogText: null }), null)
  assert.equal(provenanceOf({ promptText: null, catalogText: wording }), null)
})

// ===========================================================================
// THE MIGRATIONS, AS TEXT
//
// These are SOURCE ASSERTIONS, not database tests. They prove the SQL says what
// the application assumes; they prove nothing about a database, because no
// migration in this repository has been applied by any test. Live enforcement
// is unverified until these files are run.
// ===========================================================================

test('the submissions table grants no UPDATE or DELETE to any browser role', () => {
  // The load-bearing absence: with no policy AND no privilege, an applicant
  // cannot move their own row to approved by any route.
  // Read the GRANT statements themselves: `updated_at` contains the word
  // "update", so a blacklist over the whole file would match a column name.
  const grants = grantsIn(SUBMISSIONS_SQL)
  assert.ok(grants.length > 0, 'the grants were not found')
  assert.doesNotMatch(grants, /\bgrant\s+update\b/i)
  assert.doesNotMatch(grants, /\bgrant\s+delete\b/i)
  assert.doesNotMatch(grants, /,\s*update\s*[(,]/i, 'nor update inside a privilege list')
  // And no policy admits either command.
  const policies = stripSql(SUBMISSIONS_SQL)
  assert.doesNotMatch(policies, /for update to authenticated/i)
  assert.doesNotMatch(policies, /for delete to authenticated/i)
  assert.match(grants, /revoke all on public\.statement_prompt_submissions from public;/)
})

test('review_note is excluded from the applicant SELECT grant', () => {
  // RLS filters rows, never columns. Without a column-scoped grant a submitter
  // could read an administrator's private note about them from PostgREST.
  const grant = SUBMISSIONS_SQL.slice(
    SUBMISSIONS_SQL.indexOf('grant select ('),
    SUBMISSIONS_SQL.indexOf(') on public.statement_prompt_submissions to authenticated'),
  )
  assert.ok(grant.length > 0, 'the select grant was not found')
  assert.equal(grant.includes('review_note'), false, 'review_note must not be selectable')
  assert.equal(grant.includes('reviewed_by'), false, 'nor the reviewer identity')
  for (const allowed of ['prompt_text', 'status', 'approved_prompt_id', 'created_at']) {
    assert.ok(grant.includes(allowed), `${allowed} should be readable by its submitter`)
  }
})

test('insert is column-scoped so status cannot be supplied', () => {
  const grant = SUBMISSIONS_SQL.slice(
    SUBMISSIONS_SQL.indexOf('grant insert ('),
    SUBMISSIONS_SQL.indexOf(') on public.statement_prompt_submissions to authenticated'),
  )
  for (const forbidden of ['status', 'reviewed_by', 'reviewed_at', 'review_note',
                           'approved_prompt_id', 'duplicate_of_id']) {
    assert.equal(grant.includes(forbidden), false, `${forbidden} must not be insertable`)
  }
})

test('THE CATALOG GAINS NO WRITE GRANT, which is the point of the design', () => {
  for (const [name, sql] of [['catalog', CATALOG_SQL], ['rpcs', RPC_SQL]] as const) {
    assert.doesNotMatch(sql, /grant\s+[^;]*insert[^;]*on public\.statement_prompts/i, name)
    assert.doesNotMatch(sql, /grant\s+[^;]*update[^;]*on public\.statement_prompts/i, name)
  }
  // And its read-only policy is not weakened to make approval work.
  assert.doesNotMatch(CATALOG_SQL, /create policy/i)
  assert.doesNotMatch(CATALOG_SQL, /drop policy/i)
  assert.match(PROMPTS_SQL, /for select to anon, authenticated using \(is_active\)/)
})

test('the mutual exclusion is a CHECK, not an application rule', () => {
  assert.match(DRAFT_LINK_SQL, /statement_drafts_prompt_source_exclusive/)
  assert.match(DRAFT_LINK_SQL, /check \(prompt_id is null or prompt_submission_id is null\)/)
  // A user-provided prompt must carry its wording, or the editor would be
  // tempted to resolve the submission to recover it.
  assert.match(DRAFT_LINK_SQL, /check \(prompt_submission_id is null or prompt_text is not null\)/)
  // Checked on the code: the header uses the word "backfill" to promise there
  // is none, so the prose would satisfy a blacklist that the statements must.
  const code = stripSql(DRAFT_LINK_SQL)
  assert.doesNotMatch(code, /\bupdate\s+public\.statement_drafts\b/i, 'no row is rewritten')
  assert.doesNotMatch(code, /\binsert\s+into\s+public\.statement_drafts\b/i)
})

test('every function fixes its search_path and takes no caller identity', () => {
  const bodies = RPC_SQL.split('create or replace function').slice(1)
  assert.equal(bodies.length, 3, 'three functions')
  for (const body of bodies) {
    assert.match(body, /set search_path = ''/, 'an unqualified name could be shadowed')
  }
  // No function accepts the acting user as an argument EXCEPT decide(), whose
  // caller is service_role and therefore has no auth.uid() of its own.
  // create() and withdraw() take their caller from the session. decide() cannot:
  // service_role has no auth.uid(), so the admin's identity is passed in for the
  // audit trail -- which is safe precisely because only service_role may call it.
  const code = stripSql(RPC_SQL)
  assert.equal(code.split('auth.uid()').length - 1, 2, 'identity comes from the session')
  assert.doesNotMatch(code, /p_user_id|p_submitted_by|p_owner/, 'no function can be told who to be')
  assert.match(code, /p_reviewer_id/, 'except the admin audit trail')
})

test('the catalog writer is definer and reachable only by service_role', () => {
  const decide = RPC_SQL.slice(RPC_SQL.indexOf('function public.decide_statement_prompt_submission'))
  assert.match(decide, /security definer/)
  assert.match(decide, /insert into public\.statement_prompts/)
  assert.match(RPC_SQL, /grant execute on function public\.decide_statement_prompt_submission[\s\S]*?to service_role;/)
  // Explicitly taken away from every browser role.
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(RPC_SQL, new RegExp(`revoke all on function public\\.decide_statement_prompt_submission[\\s\\S]*?from ${role};`))
  }
})

test('the create path is the ONLY path, and its limits live inside it', () => {
  // THIS TEST ONCE REQUIRED `security invoker`. That was the wrong shape: an
  // invoker function needs the caller to hold INSERT, and a caller who holds
  // INSERT can issue the statement directly and skip the function. The
  // privilege is withdrawn and the function runs as its owner instead -- see
  // 'NO ROLE MAY INSERT A SUBMISSION DIRECTLY' and the DEFINER audit below.
  const create = RPC_SQL.slice(
    RPC_SQL.indexOf('function public.create_statement_draft_with_prompt_submission'),
    RPC_SQL.indexOf('function public.withdraw_statement_prompt_submission'),
  )
  // The limit lives inside the boundary, which is now the only boundary there is.
  assert.match(create, /rate-limited/)
  assert.match(create, /interval '1 hour'/)
  assert.match(create, /interval '1 day'/)
  // It never INSERTS prompt_id: a pasted prompt is not a catalog prompt. It does
  // read the column back to return it, which is how the response reports null.
  const insert = create.slice(create.indexOf('insert into public.statement_drafts'))
  const columns = insert.slice(0, insert.indexOf(') values'))
  assert.ok(columns.includes('prompt_submission_id'), 'the provenance is written')
  assert.equal(columns.includes('prompt_id'), false, 'and no catalog claim is')
})

test('withdrawal re-establishes ownership inside the write itself', () => {
  // Stripped first: the slice runs up to decide()'s header, whose comment
  // explains that THAT function writes public.statement_prompts.
  const rpcCode = stripSql(RPC_SQL)
  const withdraw = rpcCode.slice(
    rpcCode.indexOf('function public.withdraw_statement_prompt_submission'),
    rpcCode.indexOf('function public.decide_statement_prompt_submission'),
  )
  assert.match(withdraw, /security definer/)
  // Ownership and pending-ness are part of the UPDATE, not a read before it:
  // two concurrent calls cannot both pass a check and then both act.
  assert.match(withdraw, /where id = p_submission_id\s*\n\s*and submitted_by = v_user\s*\n\s*and status = 'pending'/)
  // Published content is not withdrawable through this path.
  assert.doesNotMatch(withdraw, /public\.statement_prompts\b/, 'the catalog is not touched')
})

test('a decision locks the row before reading its status', () => {
  const decide = RPC_SQL.slice(RPC_SQL.indexOf('function public.decide_statement_prompt_submission'))
  const lock = decide.indexOf('for update')
  const statusRead = decide.indexOf("v_sub.status <> 'pending'")
  assert.ok(lock !== -1 && statusRead !== -1)
  assert.ok(lock < statusRead, 'the lock must precede the check it protects')
  assert.match(decide, /already-decided/, 'a settled decision is a safe answer, not an error')
  // Approval never rewrites the superseded row's wording.
  assert.doesNotMatch(decide, /update public\.statement_prompts\s+set prompt_text/)
})

// ===========================================================================
// WHAT THE APPLICANT IS TOLD
// ===========================================================================

test('a catalog prompt and a general draft carry no badge', () => {
  assert.equal(promptStatusLabel({ origin: 'catalog', status: null }), null)
  assert.equal(promptStatusLabel({ origin: null, status: null }), null)
  // Even if a submission somehow existed beside a catalog prompt -- which the
  // exclusion CHECK forbids -- the catalog prompt is what is shown.
  assert.equal(promptStatusLabel({ origin: 'catalog', status: 'pending' }), null)
})

test('a pending paste is labelled NOT YET VERIFIED, in those words', () => {
  const label = promptStatusLabel({ origin: 'user', status: 'pending' })
  assert.equal(label, 'User-provided prompt — Not yet verified by CRNAPREPHUB')
})

test('an unreadable submission still reads as user-provided, never as verified', () => {
  // Silence would be the one wrong answer: it would leave a pasted prompt
  // looking exactly like a catalog one.
  assert.equal(promptStatusLabel({ origin: 'user', status: null }),
    PROMPT_STATUS_LABELS.unverified)
})

test('APPROVAL DOES NOT RETROACTIVELY MAKE THE DRAFT A CATALOG PROMPT', () => {
  // The catalog gained a row; this draft's snapshot is still the wording the
  // applicant pasted, and the label keeps saying so.
  const label = promptStatusLabel({ origin: 'user', status: 'approved' })
  assert.ok(label !== null && label.startsWith('User-provided prompt'))
  assert.ok(label.includes('unchanged'))
})

test('every outcome tells the applicant their draft is unaffected', () => {
  for (const status of ['rejected', 'duplicate', 'withdrawn'] as const) {
    const label = promptStatusLabel({ origin: 'user', status })
    assert.ok(label !== null && label.includes('unaffected'), status)
  }
})

test('the five labels are distinct, so two states are never one', () => {
  const shown = (['pending', 'approved', 'rejected', 'duplicate', 'withdrawn'] as const)
    .map((status) => promptStatusLabel({ origin: 'user', status }))
  assert.equal(new Set(shown).size, shown.length)
})

test('only a pending submission may be withdrawn', () => {
  assert.equal(mayWithdraw('pending'), true)
  for (const settled of ['approved', 'rejected', 'duplicate', 'withdrawn'] as const) {
    assert.equal(mayWithdraw(settled), false, settled)
  }
  assert.equal(mayWithdraw(null), false)
  // Published catalog content is therefore not withdrawable through this path.
})

/* ===========================================================================
 * THE HARDENING PASS.
 *
 * These are STATIC assertions over the migration text. They prove the SQL says
 * what the application assumes; they prove nothing about a running database.
 * supabase/manual/statement_prompt_submissions_security_check.sql is the
 * companion that asks a database the same questions, and it has not been run.
 * ======================================================================== */

test('NO ROLE MAY INSERT A SUBMISSION DIRECTLY', () => {
  // THE BYPASS THIS CLOSES. An earlier version granted column-scoped INSERT to
  // authenticated. The RLS policy pinned submitted_by and status, so identity
  // and status were safe -- but three guarantees were not, because a direct
  // POST to PostgREST never enters the creation function:
  //   the 3/hour and 10/day rate limits,
  //   the check that the school is one the directory lists,
  //   and the atomic pairing of a submission with a draft.
  const grants = grantsIn(SUBMISSIONS_SQL)
  assert.doesNotMatch(grants, /\bgrant\s+insert\b/i, 'no insert privilege may exist')
  assert.doesNotMatch(grants, /grant insert \(/i)
  // Read is still column-scoped, so withdrawing insert did not widen anything.
  assert.match(grants, /grant select \(/)
})

test('the insert POLICY is kept even though it is now unreachable', () => {
  // Defence in depth: if a future migration restores an INSERT privilege by
  // accident, the policy is still standing behind it.
  assert.match(SUBMISSIONS_SQL, /create policy "own prompt submission insert"/)
  assert.match(SUBMISSIONS_SQL, /submitted_by = \(select auth\.uid\(\)\)/)
  assert.match(SUBMISSIONS_SQL, /and status = 'pending'/)
})

test('the creation function is DEFINER and takes NO identity argument', () => {
  const code = stripSql(RPC_SQL)
  const create = code.slice(
    code.indexOf('function public.create_statement_draft_with_prompt_submission'),
    code.indexOf('function public.withdraw_statement_prompt_submission'),
  )
  assert.match(create, /security definer/)
  assert.doesNotMatch(create, /security invoker/)
  // Identity comes from the session and from nowhere else: no parameter could
  // name another applicant, which is the property that makes DEFINER safe here.
  assert.match(create, /v_user\s+uuid := auth\.uid\(\)/)
  const signature = create.slice(0, create.indexOf(') returns jsonb'))
  assert.doesNotMatch(signature, /p_user|p_submitted_by|p_owner|p_actor/,
    'no parameter can name an applicant')
  // Both inserts take their owner from that variable, never from an argument.
  assert.match(create, /values \(\s*\n?\s*v_user,/)
})

test('RLS no longer scopes the rate count, so the WHERE clause must', () => {
  // Under INVOKER the select policy limited the count to the caller's rows.
  // A definer function bypasses RLS, so this filter became load-bearing:
  // without it the function would count everyone and lock everyone out.
  const code = stripSql(RPC_SQL)
  assert.equal(
    code.split('where submitted_by = v_user').length - 1, 2,
    'both the hour and the day window filter by the caller',
  )
})

test('concurrent submissions cannot both pass the same limit', () => {
  // Count-then-insert is a check with a gap before the write. Two requests
  // arriving together would both count under the ceiling and both insert.
  const code = stripSql(RPC_SQL)
  const lock = code.indexOf('pg_advisory_xact_lock')
  const firstCount = code.indexOf('v_hour_count')
  const insert = code.indexOf('insert into public.statement_prompt_submissions')
  assert.notEqual(lock, -1, 'a lock must serialise the window')
  assert.ok(lock < insert, 'and be taken before the write')
  assert.ok(lock < code.indexOf('select count(*) into v_hour_count'),
    'and before the count it protects')
  assert.ok(firstCount !== -1)
  // Per applicant, so two different people never wait for each other.
  assert.match(code, /pg_advisory_xact_lock\(hashtext\(v_user::text\)\)/)
})

test('school legitimacy is enforced INSIDE the only path that can create', () => {
  const code = stripSql(RPC_SQL)
  assert.match(code, /if not exists \(select 1 from public\.schools where id = p_school_id\)/)
  assert.match(code, /'school-not-listed'/)
  // Before any write: a submission naming no real school creates nothing.
  const check = code.indexOf('from public.schools')
  const insert = code.indexOf('insert into public.statement_prompt_submissions')
  assert.ok(check < insert)
})

test('the fingerprint is sha256, computed by the only writer', () => {
  const code = stripSql(RPC_SQL)
  assert.match(code, /encode\(\s*\n?\s*sha256\(convert_to\(/)
  assert.doesNotMatch(code, /\bmd5\(/, 'md5 was the generated-column compromise')
  assert.doesNotMatch(stripSql(SUBMISSIONS_SQL), /generated always as/, 'no longer generated')
  assert.doesNotMatch(stripSql(SUBMISSIONS_SQL), /\bmd5\(/)
  // No extension is required, which is why sha256 rather than pgcrypto digest.
  assert.doesNotMatch(stripSql(RPC_SQL), /pgcrypto|create extension/i)
  assert.doesNotMatch(stripSql(SUBMISSIONS_SQL), /pgcrypto|create extension/i)
})

test('the SQL normalisation and the JavaScript one agree on what is the same', () => {
  // The digest is computed in SQL; grouping is reasoned about in JS. If the two
  // normalisations drifted, the admin queue would group what the tests do not.
  const code = stripSql(RPC_SQL)
  assert.match(code, /lower\(btrim\(regexp_replace\(p_prompt_text, '\\s\+', ' ', 'g'\)\)\)/)
  // The JS mirror: trim, collapse runs, fold case -- same three operations.
  assert.equal(normalizedPromptText('  Why   nurse\n\nanaesthesia?  '), 'why nurse anaesthesia?')
})

/*
 * THE PRIVILEGE ASSERTIONS ARE SCOPED TO ONE FUNCTION BLOCK EACH, AND THE REASON
 * IS A FALSE PASS THIS FILE ACTUALLY HAD.
 *
 * These three used to run against the whole migration as
 * /...create_statement_draft_with_prompt_submission[\s\S]*?from anon;/. When
 * `service_role` was added to create's revoke, the non-greedy wildcard skipped
 * create's own line and matched decide's `from anon;` 234 lines further on -- a
 * 10,098-character span crossing all three functions. The test kept passing
 * while asserting nothing whatever about create, and would have passed with
 * create's revoke deleted outright.
 *
 * So: a slice bounded by the NEXT function's header, and a pattern that pins the
 * exact argument list with no wildcard able to span statements. A match can only
 * be the function's own privilege line.
 */
const CREATE_ARGS = '\\(\\s*text, text, uuid, text, integer, text, text\\)'

test('the create function is unreachable by anon and service_role, by privilege not by guard', () => {
  const create = RPC_SQL.slice(
    RPC_SQL.indexOf('function public.create_statement_draft_with_prompt_submission'),
    RPC_SQL.indexOf('function public.withdraw_statement_prompt_submission'),
  )
  const fn = 'public\\.create_statement_draft_with_prompt_submission'
  // service_role is named because Supabase's ALTER DEFAULT PRIVILEGES ... ON
  // FUNCTIONS grants EXECUTE to it on every new function; production inherited
  // exactly that on this RPC and had to be corrected by hand.
  assert.match(create, new RegExp(`revoke all on function ${fn}${CREATE_ARGS} from anon, service_role;`))
  assert.match(create, new RegExp(`revoke all on function ${fn}${CREATE_ARGS} from public;`))
  assert.match(create, new RegExp(`grant execute on function ${fn}${CREATE_ARGS} to authenticated;`))
})

test('the withdraw function is revoked from anon and service_role too', () => {
  // Same inheritance, same correction, same scoping. These three statements are
  // single-line and the signature is pinned, so nothing can span past them.
  const withdraw = RPC_SQL.slice(
    RPC_SQL.indexOf('function public.withdraw_statement_prompt_submission'),
    RPC_SQL.indexOf('function public.decide_statement_prompt_submission'),
  )
  assert.match(withdraw, /revoke all on function public\.withdraw_statement_prompt_submission\(uuid\) from anon, service_role;/)
  assert.match(withdraw, /revoke all on function public\.withdraw_statement_prompt_submission\(uuid\) from public;/)
  assert.match(withdraw, /grant execute on function public\.withdraw_statement_prompt_submission\(uuid\) to authenticated;/)
})

test('a definer function introduces no injection surface', () => {
  // Running as the owner is only safe while every statement is static.
  const code = stripSql(RPC_SQL)
  for (const dynamic of [/\bexecute\s+format\(/i, /\bexecute\s+'/i, /\|\|\s*quote_/i]) {
    assert.doesNotMatch(code, dynamic, 'no dynamic SQL in a definer function')
  }
})
