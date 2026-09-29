-- Personal Statement Studio V2 -- Phase 3 draft storage.
--
-- ADDITIVE ONLY. This migration creates ONE new table, public.statement_drafts,
-- and nothing else. It does not touch, rewrite, backfill or delete any existing
-- row, column, index, policy, grant, function or trigger.
--
-- THERE IS NOTHING TO MIGRATE. Personal statements have never been persisted:
-- /personal-statement holds the essay in React state alone, the application
-- uses no localStorage key anywhere, and no previous migration creates a
-- statement table. The only statement rows in the database are usage-ledger
-- rows in resume_ai_usage namespaced `statement-`, which this table neither
-- reads nor touches. So there is no backfill, no dual-write window, and no
-- legacy shape to honour.
--
-- MULTIPLE INDEPENDENT DRAFTS, UNLIMITED FOR EVERY TIER. `id` is the key and
-- `user_id` is an ordinary column, so one user may hold any number of drafts.
-- That is deliberately unlike gpa_drafts, where user_id IS the primary key
-- because exactly one working draft is wanted there. No tier cap is expressed
-- here, in a constraint or anywhere else.
--
-- WHAT IS DELIBERATELY ABSENT, each because it would be speculative today:
--
--   * school_id / prompt_id / prompt_text. The school-prompt subsystem does not
--     exist -- no migration creates a prompts table and no column anywhere
--     holds essay-prompt wording. The intended future model is a canonical
--     prompt_id PLUS a stored snapshot of the prompt wording, so that a school
--     editing its prompt cannot silently rewrite the question an essay was
--     written to, and eventually one draft per user per prompt. None of that is
--     buildable against the schema as it stands.
--   * status. An essay has no draft/complete lifecycle the way a resume does.
--   * schema_version. `resumes` carries one only because V2 rows share a table
--     with V1 rows. This table has no V1 and never will, so a version column
--     would be a field that is always 1.
--   * word count / character-count cache. Derivable from `essay`.
--   * retention-warning or retention-state columns, soft-delete columns, and a
--     version-history table. See the two notes below.
--
-- RETENTION READINESS, WITHOUT RETENTION MACHINERY. The approved policy is that
-- a draft expires after 400 consecutive days with no successful persisted save,
-- measured from `updated_at`, and that merely opening a draft must not reset
-- that clock. This migration therefore provides `updated_at` and nothing more:
-- no pruning function, no cron entry, no warning column, no deletion job. Note
-- that the existing analytics-retention schedule prunes USAGE RECORDS via
-- analytics_prune(400); it does not reach user documents and must not be
-- extended to this table by accident.
--
-- VERSION HISTORY READINESS. `revision` is a monotonic integer per draft, which
-- is the natural key a future snapshot table can join on with no backfill and
-- no renumbering. No versions table is created here.
--
-- CONCURRENCY. `revision >= 1` is the only invariant this migration enforces.
-- The compare-and-swap that stops a stale tab overwriting newer work belongs to
-- the save route and is NOT implemented here. gpa_drafts goes further and
-- enforces "increments by exactly 1" with a trigger; that is deliberately not
-- copied, because it would constrain a save design not yet written.
--
-- updated_at IS NOT MAINTAINED BY A TRIGGER HERE. The two precedents differ:
-- save_resume_v2 sets `updated_at = v_now` explicitly inside the RPC, while
-- gpa_drafts uses a BEFORE UPDATE trigger. Neither was approved for this task,
-- so no trigger is created and the future save route is responsible for setting
-- the column. That responsibility matters more than usual because `updated_at`
-- is the retention clock -- see the postcheck note.
--
-- ACCOUNT DELETION. user_id references auth.users(id) ON DELETE CASCADE, so
-- removing the auth row removes that user's drafts. The manual deletion script
-- (supabase/manual/delete_fake_accounts.sql) deletes auth.users last and only
-- optionally, so it will also need an explicit `delete from statement_drafts`
-- line. That change is deliberately NOT made in this migration.
--
-- RUN THE PREFLIGHT FIRST. Both are read-only:
--   supabase/manual/statement_drafts_preflight.sql
--   supabase/manual/statement_drafts_postcheck.sql

begin;

-- ============================================================
-- 1. THE TABLE
-- ============================================================
-- gen_random_uuid() is built in from Postgres 13 and is already the column
-- default in six existing migrations (gpa_institutions, gpa_transcript_sources,
-- resume_ai_usage, resume_imports, email_broadcasts, interview_grants), so no
-- extension is created or required here. The preflight proves it resolves
-- before this file runs.
create table if not exists public.statement_drafts (
  id          uuid        primary key default gen_random_uuid(),

  -- ON DELETE CASCADE is the account-deletion story: no application code has to
  -- remember this table when an auth user is removed.
  user_id     uuid        not null references auth.users(id) on delete cascade,

  -- TITLE IS REQUIRED, with no default. A caller that omits it is refused here
  -- rather than producing a row the dashboard must render as "(untitled)".
  title       text        not null,

  -- EMPTY IS LEGAL. A draft is created before a word is written, so '' is a
  -- valid state -- distinct from NULL, which is not.
  essay       text        not null default '',

  revision    bigint      not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- 2. CONSTRAINTS
-- ============================================================
-- drop-then-add, so this file is re-runnable against a table that already
-- exists from a partial application.

alter table public.statement_drafts
  drop constraint if exists statement_drafts_revision_positive;
alter table public.statement_drafts
  add constraint statement_drafts_revision_positive check (revision >= 1);

-- THE APPROVED SAVED CEILING, AS A BACKSTOP. The route is still expected to
-- refuse an over-length essay with a typed 422 and a character count; this
-- exists so a bug in the route cannot store one anyway. It is a CEILING, never
-- a truncation: nothing here shortens an essay.
--
-- THE EXTRACTION CEILING IS UNCHANGED. Extraction may return up to 50,000
-- characters and Studio may display them; text over 20,000 simply cannot be
-- persisted until the applicant trims it themselves.
--
-- UNIT NOTE. Postgres char_length() counts code POINTS; JavaScript's
-- String.prototype.length counts UTF-16 code UNITS, so a string containing
-- astral characters (emoji) measures shorter here than in the browser. This
-- constraint is therefore the outer bound; the server-side check remains the
-- authority on what the applicant is told.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_essay_length;
alter table public.statement_drafts
  add constraint statement_drafts_essay_length check (char_length(essay) <= 20000);

-- Trimmed, so a title of spaces is not a title.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_title_length;
alter table public.statement_drafts
  add constraint statement_drafts_title_length
  check (char_length(btrim(title)) between 1 and 200);

-- ============================================================
-- 3. INDEX
-- ============================================================
-- The dashboard's only query shape: this user's drafts, most recently updated
-- first. Leading user_id matches the RLS predicate, so the index serves the
-- filter and the sort together.
create index if not exists statement_drafts_user_updated_idx
  on public.statement_drafts (user_id, updated_at desc);

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================
alter table public.statement_drafts enable row level security;

drop policy if exists "own statement draft select" on public.statement_drafts;
drop policy if exists "own statement draft insert" on public.statement_drafts;
drop policy if exists "own statement draft update" on public.statement_drafts;
drop policy if exists "own statement draft delete" on public.statement_drafts;

-- (select auth.uid()) rather than auth.uid(): the subselect is evaluated once
-- per statement instead of once per row, which is the form the existing tables
-- use.
create policy "own statement draft select" on public.statement_drafts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own statement draft insert" on public.statement_drafts
  for insert to authenticated with check (user_id = (select auth.uid()));
-- BOTH using AND with check. `using` decides which rows may be updated; without
-- `with check` a caller could update their own row and set user_id to someone
-- else's, handing the row away.
create policy "own statement draft update" on public.statement_drafts
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own statement draft delete" on public.statement_drafts
  for delete to authenticated using (user_id = (select auth.uid()));

-- ============================================================
-- 5. GRANTS -- revoke first, because GRANT is additive
-- ============================================================
-- PUBLIC is a real grantee in PostgreSQL and is easy to forget: a privilege
-- held by PUBLIC is held by every role, including anon. Revoke it explicitly
-- rather than trusting defaults. Supabase's own default privileges are already
-- in place on a newly created table in this schema, which is why a bare GRANT
-- would leave unwanted privileges behind.
revoke all on public.statement_drafts from public;
revoke all on public.statement_drafts from anon, authenticated, service_role;

-- The ONLY grantee is `authenticated`, and every statement it issues is still
-- filtered by the RLS policies above. anon, service_role and PUBLIC get
-- nothing: no application code path uses service_role on this table, and draft
-- CRUD is done with the caller's own JWT so RLS stays the authority.
grant select, insert, update, delete on public.statement_drafts to authenticated;

commit;

-- ============================================================
-- VERIFY (read-only, after this file has been applied)
-- ============================================================
-- Run supabase/manual/statement_drafts_postcheck.sql. It is a single query, so
-- the Supabase SQL editor shows the whole result rather than only the last
-- statement's output.
