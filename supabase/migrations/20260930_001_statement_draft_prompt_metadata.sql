-- Personal Statement Studio V2 -- draft prompt metadata.
--
-- ADDITIVE ONLY, AND METADATA-ONLY. This migration adds FOUR nullable columns to
-- public.statement_drafts and two CHECK constraints over them. It does not
-- touch, rewrite, backfill or delete any existing row, column, index, policy,
-- grant, function or trigger, and it does not edit the migration that created
-- the table.
--
-- NO TABLE REWRITE, SO NO ROW IS MODIFIED. All four columns are nullable with NO
-- DEFAULT. From Postgres 11 an ADD COLUMN in that shape is a catalog change
-- only: existing rows are not visited, not rewritten, and their updated_at is
-- untouched. That is what makes "existing drafts remain valid with all four
-- fields NULL" true by construction rather than by a backfill that sets them.
--
-- WHY THESE COLUMNS. V2 analysis scores Prompt Alignment, which needs the
-- question the essay answers. Two of the four are canonical references and two
-- are a SNAPSHOT:
--
--   school_id, prompt_id    which prompt did the applicant select?
--   prompt_text,            what exact wording and stated limit did THIS draft
--   stated_max_words        use at the time?
--
-- The snapshot is the point. A school editing its prompt, or an admin
-- deactivating one and adding a replacement, must never retroactively change
-- the question an existing essay was written to answer -- nor silently move an
-- eligibility threshold that has already been evaluated. A reference alone
-- cannot promise that; a stored copy can.
--
-- NO FOREIGN KEYS, DELIBERATELY -- NEITHER ONE:
--
--   * school_id -> public.schools(id). public.schools has NO migration in this
--     repository; it predates the migrations directory and exists only in
--     production. A clean database built from supabase/migrations/ alone has no
--     schools table, so a REFERENCES clause would abort on exactly the
--     environments a migration must be safe in.
--   * prompt_id -> public.statement_prompts(id). That table IS now under
--     migration control (20260930_000), so this FK is technically available.
--     It is still omitted, for two reasons. The approved scope for this
--     checkpoint is four nullable columns and two CHECKs, and adding one FK
--     while the sibling column cannot have one would produce a half-referential
--     row: prompt_id guaranteed to resolve, school_id not. Both arrive together
--     in the FK checkpoint, after the legacy school schema is captured.
--
-- No stub schools table is created here to make a constraint resolve.
--
-- NO CROSS-COLUMN CONSTRAINT IN THIS CHECKPOINT. Nothing requires the four to
-- appear together, so a row carrying prompt_text with no prompt_id, or a
-- prompt_id with no snapshot, is accepted by the database. That is deliberate:
-- the application has not been written yet, and a constraint guessing at its
-- eventual invariant would have to be dropped to accommodate the real one. The
-- rule "analysis needs a prompt" is an application rule for now.
--
-- WHAT IS DELIBERATELY ABSENT:
--
--   * Any uniqueness. Multiple drafts per prompt remains the approved model.
--   * Any trigger. Nothing here writes updated_at.
--   * Any change to revision, its default or its CHECK. The compare-and-swap
--     behaviour is untouched.
--   * Any RLS or grant change. See section 3 for why none is needed.
--   * Any backfill, and any seed row.
--   * A word-count or character-count cache. Derivable from the essay.
--
-- RUN THE PREFLIGHT FIRST. Both are read-only:
--   supabase/manual/statement_draft_prompt_metadata_preflight.sql
--   supabase/manual/statement_draft_prompt_metadata_postcheck.sql

begin;

-- ============================================================
-- 1. THE COLUMNS
-- ============================================================
-- `if not exists` on each, so this file is re-runnable against a table that
-- already has some of them from a partial application.
--
-- NULLABLE AND UNDEFAULTED, all four. NULL is the honest value for a draft that
-- has no prompt selected: it is a different fact from "prompt zero" or "empty
-- wording", and it must stay distinguishable. Every draft that exists today
-- takes NULL and stays valid.

-- The canonical school. Same uuid as public.schools.id (confirmed uuid, primary
-- key). No FK yet -- see the header.
alter table public.statement_drafts
  add column if not exists school_id uuid;

-- The canonical prompt. Same uuid as public.statement_prompts.id. No FK yet.
alter table public.statement_drafts
  add column if not exists prompt_id uuid;

-- The prompt wording AS IT WAS when this draft adopted it. Not a reference, a
-- copy -- that is the whole reason this column exists rather than a join.
alter table public.statement_drafts
  add column if not exists prompt_text text;

-- The school's stated word maximum as it was at the same moment. NULL means the
-- school stated none, which is a different fact from zero.
alter table public.statement_drafts
  add column if not exists stated_max_words integer;

-- ============================================================
-- 2. CONSTRAINTS
-- ============================================================
-- drop-then-add, so this file is re-runnable.
--
-- BOTH START WITH `IS NULL OR`, FOR CLARITY RATHER THAN FOR CORRECTNESS.
--
-- A PostgreSQL CHECK constraint is satisfied when its expression evaluates to
-- TRUE *or* to NULL; only FALSE rejects the row. So a bare range over a
-- nullable column -- `check (stated_max_words between 1 and 5000)` -- would
-- already permit NULL, because the comparison yields NULL for a NULL input.
-- The explicit branch is NOT what makes these columns nullable.
--
-- It is written out anyway for two reasons: it states the intended nullable
-- semantics where a reader will see them, instead of leaving them to be
-- inferred from three-valued logic, and it mirrors the canonical form used by
-- the statement_prompts constraints, so the snapshot and the catalog it
-- snapshots read identically.

-- NULL, or wording with something in it and no more than 5,000 characters.
--
-- TWO CLAUSES, EACH DOING A DIFFERENT JOB, matching statement_prompts:
--
--   btrim(...) >= 1          rejects a snapshot that is empty or only
--                            whitespace. A blank question is not a question.
--   char_length(...) <= 5000 caps what is STORED, measured on the text as
--                            given. Measuring the trimmed length for the
--                            ceiling would let trailing whitespace push a row
--                            past 5,000 characters while passing the check.
--
-- NOTHING IS TRIMMED OR MUTATED. The stored value is exactly what was supplied:
-- indentation, blank lines and internal spacing inside a multi-paragraph prompt
-- all survive, because a school's own formatting is part of the question.
--
-- UNIT NOTE. Postgres char_length() counts code POINTS; JavaScript's
-- String.prototype.length counts UTF-16 code UNITS, so wording containing
-- astral characters measures shorter here than in a browser. This constraint is
-- the outer bound; whatever writes a snapshot remains the authority on what an
-- editor is told.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_prompt_text_length;
alter table public.statement_drafts
  add constraint statement_drafts_prompt_text_length
  check (prompt_text is null
         or (char_length(btrim(prompt_text)) >= 1 and char_length(prompt_text) <= 5000));

-- NULL, or a real count in the same range statement_prompts allows. The two
-- ranges are kept identical on purpose: a snapshot that the catalog itself
-- could not have produced would be a snapshot of nothing.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_stated_max_words_range;
alter table public.statement_drafts
  add constraint statement_drafts_stated_max_words_range
  check (stated_max_words is null or stated_max_words between 1 and 5000);

-- ============================================================
-- 3. RLS, GRANTS AND INDEXES -- ALL UNCHANGED, AND WHY NONE IS NEEDED
-- ============================================================
-- NO POLICY CHANGE. The four policies on this table key on user_id alone
-- ("own statement draft select/insert/update/delete", each
-- `user_id = (select auth.uid())`). Which ROWS a caller may touch is unaffected
-- by which COLUMNS the row has, so adding columns cannot widen access. The new
-- columns are covered by the existing policies the moment they exist.
--
-- NO GRANT CHANGE. The existing grant is TABLE-level --
-- `grant select, insert, update, delete on public.statement_drafts to
-- authenticated` -- not column-level, so it extends to new columns
-- automatically. A column-level grant regime would have needed a line here; a
-- table-level one does not, and adding a redundant GRANT would only risk
-- widening what the original migration deliberately narrowed.
--
-- NO NEW INDEX. Nothing queries drafts by school or prompt yet. The existing
-- (user_id, updated_at desc) index still serves the library's only query shape.
-- An index on prompt_id belongs in the checkpoint that first filters by it, so
-- its shape can be chosen against a real query rather than guessed.
--
-- Nothing in this section executes. It is here so that a reader asking "why did
-- this migration not touch security?" finds the answer beside the change.

commit;

-- ============================================================
-- VERIFY (read-only, after this file has been applied)
-- ============================================================
-- Run supabase/manual/statement_draft_prompt_metadata_postcheck.sql. It is a
-- single query, so the Supabase SQL editor shows the whole result rather than
-- only the last statement's output.
