-- Personal Statement Studio V2 -- the school prompt catalog.
--
-- ADDITIVE ONLY. This migration creates ONE new table,
-- public.statement_prompts, and nothing else. It does not touch, rewrite,
-- backfill or delete any existing row, column, index, policy, grant, function
-- or trigger. In particular it does NOT touch public.schools, saved_schools or
-- school_reports, and it does not alter public.statement_drafts.
--
-- WHY THIS TABLE EXISTS. Statement Studio V2 analysis scores Prompt Alignment,
-- which is meaningless without the question the essay answers. No column
-- anywhere in this database holds essay-prompt wording today -- the audit that
-- preceded this file found zero hits for max_words, word_limit, prompt_id or
-- prompt text of any kind -- so the catalog is built from nothing.
--
-- CANONICAL ROWS, NOT MUTABLE ONES. A materially different prompt, or a new
-- application cycle's wording, becomes a NEW row; an obsolete one is
-- deactivated rather than deleted, so a draft that references it keeps a
-- resolvable identity for ever. That is what makes `is_active` a column rather
-- than a reason to DELETE.
--
-- NO FOREIGN KEY TO public.schools, DELIBERATELY. `school_id` is uuid NOT NULL
-- and carries the same value as schools.id (confirmed uuid, primary key,
-- default uuid_generate_v4()), but no REFERENCES clause is declared, because:
--
--   * public.schools has NO migration in this repository. It predates the
--     migrations directory and its DDL exists only in production. A clean
--     database built from supabase/migrations/ alone therefore has no schools
--     table at all.
--   * A REFERENCES clause would make this file abort on exactly the
--     environments a migration has to be safe in -- CI, a local Supabase, any
--     rebuilt staging -- while succeeding only against production.
--   * The fix is to bring the legacy school schema under migration control
--     first, in its own checkpoint, and add the FK after. That is a two-line
--     follow-up once schools exists everywhere.
--
-- No stub or fake schools table is created here to satisfy a constraint. A
-- table that exists only to make a foreign key resolve is worse than no foreign
-- key: it would shadow the real one on any environment that later gained it.
--
-- WHAT IS DELIBERATELY ABSENT:
--
--   * An updated_at trigger. Whatever writes a prompt sets updated_at, exactly
--     as the draft save route owns statement_drafts.updated_at.
--   * Any uniqueness beyond the primary key. Multiple prompts per school is the
--     approved model, and nothing yet says two prompts may not share a label, a
--     cycle or a display_order.
--   * Seed rows. No prompt is populated by this migration.
--   * Write policies and write grants for browser roles. See section 4.
--
-- RUN THE PREFLIGHT FIRST. Both are read-only:
--   supabase/manual/statement_prompts_preflight.sql
--   supabase/manual/statement_prompts_postcheck.sql

begin;

-- ============================================================
-- 1. THE TABLE
-- ============================================================
-- gen_random_uuid() is built in from Postgres 13 and is already the column
-- default in seven existing migrations in this project, including
-- statement_drafts, so no extension is created or required here. The preflight
-- proves it resolves before this file runs.
--
-- NOTE ON schools.id's DEFAULT. The production schools table defaults its id to
-- uuid_generate_v4(), which needs the uuid-ossp extension. This table does not
-- copy that: gen_random_uuid() is pgcrypto-free from PG13 and is what every
-- migration in this repository uses. The two functions produce the same type.
create table if not exists public.statement_prompts (
  id                uuid        primary key default gen_random_uuid(),

  -- The canonical school. Same uuid as public.schools.id, no FK yet -- see the
  -- header. NOT NULL because a prompt with no school is not a prompt.
  school_id         uuid        not null,

  -- What a picker shows: "Essay 1", "Why our program". Not the question itself.
  label             text        not null,

  -- The question, verbatim. A draft stores its own snapshot of this, so editing
  -- a row here can never retroactively change the question an essay was
  -- written to answer.
  prompt_text       text        not null,

  -- The school's stated word maximum, when it states one. NULL means "no
  -- stated limit", which is a different fact from zero and must stay
  -- distinguishable. Drives the V2 eligibility floor for short prompts.
  stated_max_words  integer,

  -- 'YYYY' or 'YYYY-YYYY'. NULL means the prompt is not cycle-specific.
  application_cycle text,

  -- Deactivated, never deleted. An inactive prompt stays resolvable for drafts
  -- that already reference it while disappearing from every picker.
  is_active         boolean     not null default true,

  -- Picker order within a school. Ties are the caller's to break; no
  -- uniqueness is implied or enforced.
  display_order     integer     not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================================================
-- 2. CONSTRAINTS
-- ============================================================
-- drop-then-add, so this file is re-runnable against a table that already
-- exists from a partial application.

-- Trimmed, so a label of spaces is not a label. Matches
-- statement_drafts_title_length exactly.
alter table public.statement_prompts
  drop constraint if exists statement_prompts_label_length;
alter table public.statement_prompts
  add constraint statement_prompts_label_length
  check (char_length(btrim(label)) between 1 and 200);

-- TWO CLAUSES, EACH DOING A DIFFERENT JOB.
--
--   btrim(...) >= 1   rejects empty and whitespace-only wording. A prompt of
--                     spaces is not a question.
--   char_length(...) <= 5000   caps what is STORED, measured on the text as
--                     given. Measuring the trimmed length for the ceiling would
--                     let trailing whitespace push a row past 5,000 bytes of
--                     storage while passing the check.
--
-- NOTHING IS TRIMMED OR MUTATED. The stored value is exactly what was supplied:
-- indentation, blank lines and internal spacing inside a multi-paragraph prompt
-- are all preserved, because a school's own formatting is part of the question.
--
-- UNIT NOTE. Postgres char_length() counts code POINTS; JavaScript's
-- String.prototype.length counts UTF-16 code UNITS, so wording containing
-- astral characters measures shorter here than in a browser. This constraint is
-- the outer bound; whatever writes a prompt remains the authority on what an
-- editor is told.
alter table public.statement_prompts
  drop constraint if exists statement_prompts_text_length;
alter table public.statement_prompts
  add constraint statement_prompts_text_length
  check (char_length(btrim(prompt_text)) >= 1 and char_length(prompt_text) <= 5000);

-- NULL or a real count. `is null or` rather than a bare range, because a bare
-- range on a nullable column evaluates to NULL for a NULL value, and a CHECK
-- that evaluates to NULL PASSES -- so the bare form would silently permit
-- nothing while appearing to constrain something.
alter table public.statement_prompts
  drop constraint if exists statement_prompts_max_words_range;
alter table public.statement_prompts
  add constraint statement_prompts_max_words_range
  check (stated_max_words is null or stated_max_words between 1 and 5000);

-- 'YYYY' or 'YYYY-YYYY', anchored at both ends so '2026x' and 'x2026' are
-- refused. Whether the second year must be the first plus one is NOT decided
-- here: '2026-2031' is accepted by this constraint, deliberately, because a
-- programme could legitimately publish a multi-year prompt and this checkpoint
-- has no mandate to rule on it.
alter table public.statement_prompts
  drop constraint if exists statement_prompts_cycle_format;
alter table public.statement_prompts
  add constraint statement_prompts_cycle_format
  check (application_cycle is null or application_cycle ~ '^[0-9]{4}(-[0-9]{4})?$');

-- Non-negative, and nothing more. No uniqueness: two prompts may share an
-- order, and the reader breaks the tie.
alter table public.statement_prompts
  drop constraint if exists statement_prompts_display_order_nonneg;
alter table public.statement_prompts
  add constraint statement_prompts_display_order_nonneg
  check (display_order >= 0);

-- ============================================================
-- 3. INDEX
-- ============================================================
-- The picker's only query shape: this school's active prompts, in order.
-- Leading school_id is the filter, is_active matches the RLS predicate, and
-- display_order serves the sort -- so one index covers all three. No other
-- index is created, because no other query shape exists yet.
create index if not exists statement_prompts_school_active_order_idx
  on public.statement_prompts (school_id, is_active, display_order);

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================
-- READ-ONLY FOR EVERY BROWSER ROLE. The catalog is reference data an applicant
-- reads; it is not theirs to write. The legacy schools table's permissive write
-- policies are deliberately NOT copied here.
--
-- WHAT MAKES THE WRITES IMPOSSIBLE, in two independent ways:
--
--   1. With RLS enabled and NO insert/update/delete policy, those commands are
--      denied for any role that does not bypass RLS -- a missing policy is a
--      denial, not a gap.
--   2. Section 5 grants no write privilege either, so the command is refused
--      before a policy is even consulted.
--
-- Either alone would be sufficient. Both are present because this is the table
-- whose contents feed the analysis prompt: a row a browser could fabricate is a
-- sentence a browser could put in front of the model.
alter table public.statement_prompts enable row level security;

drop policy if exists "active statement prompt select" on public.statement_prompts;

-- ONE POLICY, TWO ROLES. anon and authenticated get the same visibility -- the
-- catalog is public reference data -- so two identical policies would be two
-- places to forget to change. `using (is_active)` is the whole predicate:
-- inactive prompts are invisible to both roles, which is what keeps a
-- withdrawn question out of every picker without deleting the row a draft may
-- still reference.
create policy "active statement prompt select" on public.statement_prompts
  for select to anon, authenticated using (is_active);

-- ============================================================
-- 5. GRANTS -- revoke first, because GRANT is additive
-- ============================================================
-- PUBLIC is a real grantee in PostgreSQL and is easy to forget: a privilege
-- held by PUBLIC is held by every role, including anon. Revoke it explicitly
-- rather than trusting defaults. Supabase's own default privileges are already
-- in place on a newly created table in this schema, which is why a bare GRANT
-- would leave unwanted privileges behind.
revoke all on public.statement_prompts from public;
revoke all on public.statement_prompts from anon, authenticated, service_role;

-- SELECT ONLY, and only for the two browser roles. Rows they may see are still
-- filtered by the active-only policy above.
grant select on public.statement_prompts to anon, authenticated;

-- service_role GETS NOTHING, following statement_drafts. No application code
-- path writes prompts yet: the admin/server write path is a separate, later,
-- deliberately designed checkpoint, and it will grant exactly what it needs at
-- that point. Granting write privileges now, to a role that bypasses RLS,
-- against a table nothing writes, would be a standing privilege with no caller.

commit;

-- ============================================================
-- VERIFY (read-only, after this file has been applied)
-- ============================================================
-- Run supabase/manual/statement_prompts_postcheck.sql. It is a single query, so
-- the Supabase SQL editor shows the whole result rather than only the last
-- statement's output.
