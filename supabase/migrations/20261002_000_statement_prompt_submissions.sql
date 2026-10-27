-- Personal Statement Studio V2 -- applicant-submitted school prompts.
--
-- ADDITIVE ONLY. This migration creates ONE new table,
-- public.statement_prompt_submissions, and nothing else. It does not touch,
-- rewrite, backfill or delete any existing row, column, index, policy, grant,
-- function or trigger. In particular it does NOT alter public.schools,
-- public.statement_prompts or public.statement_drafts.
--
-- WHY THIS TABLE EXISTS. The approved catalog is empty and will stay sparse for
-- a long time: there are hundreds of CRNA programmes and their questions change
-- each cycle. An applicant whose question is not listed currently has no way to
-- write against it. This table is the queue between "somebody pasted their
-- school's question" and "this product vouches for that question" -- and the
-- two must never be the same thing, which is what every line below is about.
--
-- THIS TABLE IS NOT THE CATALOG, AND CANNOT BECOME IT. A row here is one
-- applicant's claim. public.statement_prompts holds what has been reviewed.
-- Nothing in this file grants any browser role a way to move a row from here to
-- there; that path is a definer function restricted to service_role, created in
-- 20261002_003.
--
-- NO FOREIGN KEY TO public.schools, for exactly the reason 20260930_000 gives:
-- that table predates the migrations directory and has no DDL here, so a
-- REFERENCES clause would abort on CI, a local Supabase, and any rebuilt
-- staging, while succeeding only against production. School legitimacy is
-- enforced in the application against the same directory the picker offered,
-- and the FK arrives with the rest once the legacy schema is captured.
--
-- NO FOREIGN KEY TO auth.users EITHER. statement_drafts does not declare one
-- for user_id, and this file follows it rather than inventing a second
-- convention for the same kind of column.
--
-- WHAT IS DELIBERATELY ABSENT:
--
--   * Any applicant personal information. No name, no email, no essay, no
--     draft id. The submitter is a uuid, because the only questions review has
--     to answer about them are "may they withdraw this" and "is one person
--     submitting a hundred of these".
--   * An updated_at trigger. Whatever writes a row sets it, as statement_drafts
--     and statement_prompts both do.
--   * Any uniqueness on the fingerprint. Two applicants submitting the same
--     question is NORMAL and both rows are kept: deduplication is a review
--     decision a human makes, not a write this table refuses.
--   * Update and delete policies for applicants. See section 4.
--   * Seed rows.

begin;

-- ============================================================
-- 1. THE TABLE
-- ============================================================
create table if not exists public.statement_prompt_submissions (
  id                 uuid        primary key default gen_random_uuid(),

  -- The applicant. NOT NULL: an unattributed submission could not be withdrawn
  -- by its author, rate limited, or counted against anyone.
  submitted_by       uuid        not null,

  -- The school this question belongs to. Same uuid as public.schools.id.
  school_id          uuid        not null,

  -- The question, verbatim and unmodified. See the length constraint.
  prompt_text        text        not null,

  -- What the school stated, when the applicant knew it. NULL means "not
  -- stated", which is a different fact from zero and is never inferred.
  stated_max_words   integer,

  -- 'YYYY' or 'YYYY-YYYY'. NULL means not cycle-specific.
  application_cycle  text,

  -- Where they found it. NULL means they did not say. Never fetched by this
  -- application; it is shown to an administrator to check by hand.
  source_url         text,

  -- Where the submission is in review. 'pending' is the only status a browser
  -- may ever write, and section 4 is what enforces that.
  status             text        not null default 'pending',

  -- Review. All three stay NULL until a decision is made.
  reviewed_by        uuid,
  reviewed_at        timestamptz,

  -- ADMIN-ONLY, AND THAT IS ENFORCED BY RLS, NOT BY THE INTERFACE. The select
  -- policy in section 4 is column-blind, so this column is readable by its
  -- submitter unless privileges say otherwise -- which is why section 5 grants
  -- applicants SELECT on a named column list that excludes it, and why the
  -- applicant-facing view exists. A note saying "this looks like a troll" must
  -- not be readable by the person it is about.
  review_note        text,

  -- Set when approval produced a catalog row. The provenance link, pointing at
  -- public.statement_prompts(id). No FK: see 20261002_002, which adds the
  -- reverse link, and the header above on why FKs wait for the schools capture.
  approved_prompt_id uuid,

  -- Set when review decided this duplicates an earlier submission. Points at
  -- another row of THIS table.
  duplicate_of_id    uuid,

  -- The grouping key: SHA-256 of the wording case folded, whitespace runs
  -- collapsed and ends trimmed.
  --
  -- NOT A GENERATED COLUMN, and the reason is specific. A generated expression
  -- must be IMMUTABLE, and the only immutable hash in Postgres core is md5():
  -- sha256() needs its input as bytea, and convert_to(text,'UTF8') is STABLE
  -- rather than immutable because it depends on the database encoding. The
  -- alternative was pgcrypto's digest(), and no migration in this repository
  -- depends on that extension -- 20260930_000 chose gen_random_uuid()
  -- specifically to stay free of it, and a file that fails wherever an
  -- extension is missing is a file that fails on CI.
  --
  -- SO IT IS WRITTEN BY ITS SOLE WRITER INSTEAD. No role holds INSERT on this
  -- table (see section 5), so the only statement that can ever populate this
  -- column is inside create_statement_draft_with_prompt_submission(), which computes
  -- it from the same text it stores. There is no caller who could supply one
  -- that disagrees with their own wording, because there is no caller.
  --
  -- NOT A SECURITY CONTROL EITHER WAY. Nothing is authenticated, authorised,
  -- published or rejected on the strength of a fingerprint; it groups likely
  -- duplicates on a review screen and a human decides. A collision costs an
  -- administrator one glance.
  text_fingerprint   text        not null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ============================================================
-- 2. CONSTRAINTS
-- ============================================================
-- drop-then-add, so this file is re-runnable against a partially applied table.

-- THE SAME TWO CLAUSES statement_prompts_text_length USES, and for the same
-- reasons: btrim >= 1 refuses whitespace-only wording, and the ceiling is
-- measured on the text AS GIVEN so trailing whitespace cannot push a row past
-- the storage bound while passing the check. A submission that could never be
-- approved is refused when it is made.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_text_length;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_text_length
  check (char_length(btrim(prompt_text)) >= 1 and char_length(prompt_text) <= 5000);

-- NULL or a real count. The explicit `is null or` states that NULL is permitted
-- rather than merely tolerated -- a bare BETWEEN would already admit NULL,
-- because a comparison against NULL is NULL and a CHECK rejects only FALSE.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_max_words_range;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_max_words_range
  check (stated_max_words is null or stated_max_words between 1 and 5000);

-- The catalog's cycle pattern, character for character.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_cycle_format;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_cycle_format
  check (application_cycle is null or application_cycle ~ '^[0-9]{4}(-[0-9]{4})?$');

-- http and https only, and a length bound. A link an administrator may click
-- must not be able to be `javascript:` or `data:`; the application parses the
-- URL and reads its protocol, and this is the second, independent refusal.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_source_url;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_source_url
  check (
    source_url is null
    or (char_length(source_url) <= 2000 and source_url ~* '^https?://')
  );

-- The whole status vocabulary, in one place.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_status;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_status
  check (status in ('pending', 'approved', 'rejected', 'duplicate', 'withdrawn'));

-- A DECISION CARRIES ITS REVIEWER, AND A PENDING ROW CARRIES NEITHER. This is
-- what stops a row being quietly moved to 'approved' with no record of who did
-- it, and what stops a pending row claiming a reviewer it never had.
--
-- 'withdrawn' IS THE APPLICANT'S OWN ACT, so it is the one non-pending status
-- that does not require a reviewer.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_review_shape;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_review_shape
  check (
    (status = 'pending'   and reviewed_by is null and reviewed_at is null)
    or (status = 'withdrawn')
    or (status in ('approved', 'rejected', 'duplicate')
        and reviewed_by is not null and reviewed_at is not null)
  );

-- AN APPROVAL HAS A CATALOG ROW, AND NOTHING ELSE DOES. Without this, a
-- submission could read 'approved' with no published prompt behind it, or a
-- rejected one could carry a catalog id it has no claim to.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_approval_shape;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_approval_shape
  check (
    (status = 'approved' and approved_prompt_id is not null)
    or (status <> 'approved' and approved_prompt_id is null)
  );

-- A DUPLICATE POINTS AT WHAT IT DUPLICATES, and nothing else does. The target
-- is deliberately not constrained to be pending or approved: review may group
-- a submission against an earlier one in any state.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_duplicate_shape;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_duplicate_shape
  check (
    (status = 'duplicate' and duplicate_of_id is not null and duplicate_of_id <> id)
    or (status <> 'duplicate' and duplicate_of_id is null)
  );

-- 64 LOWERCASE HEX CHARACTERS, AND NOTHING ELSE. The function is the only
-- writer today; this is what keeps the column meaning "a SHA-256 of the
-- normalised wording" if that ever stops being true.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_fingerprint_shape;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_fingerprint_shape
  check (text_fingerprint ~ '^[0-9a-f]{64}$');

-- ============================================================
-- 3. INDEXES
-- ============================================================
-- The review queue's query: pending first, newest first.
create index if not exists statement_prompt_submissions_status_created_idx
  on public.statement_prompt_submissions (status, created_at desc);

-- "What have I submitted", the applicant's own list.
create index if not exists statement_prompt_submissions_submitter_idx
  on public.statement_prompt_submissions (submitted_by, created_at desc);

-- Duplicate grouping, which is always within one school.
create index if not exists statement_prompt_submissions_school_fingerprint_idx
  on public.statement_prompt_submissions (school_id, text_fingerprint);

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================
-- OWN ROWS ONLY, AND NO WAY TO DECIDE THEM. The shape follows
-- statement_drafts: a select policy and an insert policy keyed on auth.uid(),
-- with `with check` on every write so a row cannot be handed to somebody else.
--
-- THERE IS NO UPDATE POLICY AND NO DELETE POLICY FOR APPLICANTS, which is the
-- load-bearing absence in this file. With RLS enabled and no policy for a
-- command, that command is DENIED -- a missing policy is a denial, not a gap.
-- So an applicant cannot move their own row to 'approved', cannot write
-- reviewed_by, cannot attach an approved_prompt_id, and cannot delete the
-- record of something they submitted. Section 5 then declines to grant those
-- privileges either, so the command is refused before a policy is consulted.
--
-- WITHDRAWAL IS THEREFORE NOT A DIRECT UPDATE. It runs through a definer
-- function in 20261002_003 that re-checks ownership and that the row is still
-- pending. Giving applicants a general UPDATE and constraining it with a
-- policy predicate would have been the alternative, and it is strictly worse:
-- a policy that must enumerate which columns may change is a policy that fails
-- open the day a column is added.
alter table public.statement_prompt_submissions enable row level security;

drop policy if exists "own prompt submission select" on public.statement_prompt_submissions;
create policy "own prompt submission select" on public.statement_prompt_submissions
  for select to authenticated using (submitted_by = (select auth.uid()));

-- INSERT IS PINNED TO 'pending' AND TO AN EMPTY REVIEW. Every field a decision
-- would write is required to be null, so the one statement an applicant may
-- issue against this table cannot create an already-approved submission.
drop policy if exists "own prompt submission insert" on public.statement_prompt_submissions;
create policy "own prompt submission insert" on public.statement_prompt_submissions
  for insert to authenticated with check (
    submitted_by = (select auth.uid())
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and review_note is null
    and approved_prompt_id is null
    and duplicate_of_id is null
  );

-- ============================================================
-- 5. GRANTS -- revoke first, because GRANT is additive
-- ============================================================
revoke all on public.statement_prompt_submissions from public;
revoke all on public.statement_prompt_submissions from anon, authenticated, service_role;

-- SELECT IS COLUMN-SCOPED, AND review_note IS NOT IN THE LIST. RLS filters
-- ROWS, never columns, so the select policy above would otherwise let a
-- submitter read an administrator's private note about them straight from
-- PostgREST. A column that is not granted cannot be selected, aliased,
-- ordered by, or filtered on, by any route or any direct query.
grant select (
  id, submitted_by, school_id, prompt_text, stated_max_words, application_cycle,
  source_url, status, reviewed_at, approved_prompt_id, duplicate_of_id,
  text_fingerprint, created_at, updated_at
) on public.statement_prompt_submissions to authenticated;

-- NO INSERT GRANT. NOT EVEN A COLUMN-SCOPED ONE.
--
-- AN EARLIER DRAFT OF THIS FILE GRANTED INSERT on six columns, with the policy
-- above pinning submitted_by to auth.uid() and status to 'pending'. That was a
-- real hole, and it is worth recording exactly what it let through rather than
-- quietly deleting the line:
--
--   * THE RATE LIMIT. Three an hour and ten a day live inside the creation
--     function. A direct POST to /rest/v1/statement_prompt_submissions never
--     entered that function, so the limits counted nothing.
--   * SCHOOL LEGITIMACY. The directory check lived in the Next.js route. A
--     direct insert could name any uuid at all as a school.
--   * ATOMICITY. The whole point of the creation function is that a draft and
--     its submission exist together or not at all. A direct insert produced a
--     submission with no draft -- an orphan in the review queue that no
--     applicant was writing against.
--
-- Identity and status were NOT bypassable even then, because the policy pinned
-- both. But three of the five guarantees were, so the grant is gone: with no
-- INSERT privilege, the command is refused before any policy is consulted, and
-- the SECURITY DEFINER function in 20261002_003 becomes the only way a row can
-- enter this table.
--
-- THE INSERT POLICY ABOVE IS KEPT ANYWAY. It is unreachable while no grant
-- exists, and that is the point: if a future migration ever restores an INSERT
-- privilege by accident, the policy is still standing behind it and still
-- refuses a row that names somebody else or arrives pre-approved.
--
-- NO UPDATE, NO DELETE EITHER, FOR ANY BROWSER ROLE. Deciding a submission and
-- withdrawing one both run through definer functions whose EXECUTE is
-- restricted; see 20261002_003.
--
-- anon GETS NOTHING AT ALL. A submission is not public reference data.
-- service_role gets nothing either, following statement_drafts and
-- statement_prompts: the privileged path is a function, not a table grant.

commit;
