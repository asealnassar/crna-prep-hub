-- Personal Statement Studio V2 -- the catalog's write boundary and provenance.
--
-- ADDITIVE ONLY. This migration adds TWO nullable columns to
-- public.statement_prompts. It does not touch, rewrite, backfill or delete any
-- existing row, policy or grant, and it does not change the catalog's RLS.
--
-- WHAT THIS FILE DOES NOT DO, AND THAT IS THE HEADLINE. It does not grant any
-- role the ability to write public.statement_prompts -- not anon, not
-- authenticated, and not service_role. 20260930_000 left the catalog with a
-- select-only policy and select-only grants on purpose, in its own words:
-- "this is the table whose contents feed the analysis prompt: a row a browser
-- could fabricate is a sentence a browser could put in front of the model."
-- That remains exactly true, so the answer to "approval has to insert a row"
-- is NOT a write grant.
--
-- The answer is a SECURITY DEFINER function, created in 20261002_003, whose
-- EXECUTE privilege is restricted to service_role. A definer function runs as
-- its owner and therefore writes the catalog without any role holding INSERT on
-- it. The privilege that exists is "may run this one reviewed procedure",
-- not "may write this table" -- which is narrower than a table grant in two
-- ways: the statements are fixed, and they are auditable in one place.
--
-- WHY THE TWO COLUMNS ARE HERE AND NOT IN 20261002_003. A function body can be
-- replaced; a column cannot be added by one. Keeping the shape change in its
-- own file means the function file is pure logic and can be re-run to amend
-- behaviour without touching the table.

begin;

-- ============================================================
-- 1. PROVENANCE
-- ============================================================
-- Which submission became this catalog row. NULL for a prompt an administrator
-- entered directly, which is the only kind that exists today.
--
-- THIS IS THE REVERSE OF statement_drafts.prompt_submission_id and serves a
-- different purpose: that one records where a DRAFT's wording came from, this
-- one records where a CATALOG ENTRY came from. Both are provenance, neither is
-- resolved to render anything.
alter table public.statement_prompts
  add column if not exists origin_submission_id uuid;

-- ============================================================
-- 2. VERSIONING
-- ============================================================
-- The prompt this one replaces, when an administrator approves a new cycle's
-- wording as a new version of an existing question.
--
-- A NEW ROW, NEVER AN EDIT. The catalog's model is already correct about this:
-- 20260930_000 states that "a materially different prompt, or a new application
-- cycle's wording, becomes a NEW row; an obsolete one is deactivated rather
-- than deleted". This column makes the chain explicit so a reviewer can see
-- which question a version belongs to, and so a picker could one day show only
-- the newest.
--
-- DEACTIVATING THE OLD ROW IS A SEPARATE, EXPLICIT DECISION. Setting this
-- column does not touch the superseded row's is_active, and the approval
-- function takes that as its own parameter, defaulting to false. An older
-- applicant's draft keeps resolving, and their saved wording is untouched
-- either way, because a draft renders its own snapshot.
alter table public.statement_prompts
  add column if not exists supersedes_prompt_id uuid;

-- NO SELF-REFERENCE. A prompt superseding itself would make the version chain
-- a cycle, and a reviewer walking it would not terminate.
alter table public.statement_prompts
  drop constraint if exists statement_prompts_supersedes_not_self;
alter table public.statement_prompts
  add constraint statement_prompts_supersedes_not_self
  check (supersedes_prompt_id is null or supersedes_prompt_id <> id);

-- ============================================================
-- 3. RLS AND GRANTS ARE UNCHANGED, DELIBERATELY
-- ============================================================
-- The existing policy is `for select to anon, authenticated using (is_active)`
-- and the existing grant is `select` for those two roles only. Both still
-- stand, and both now cover the two new columns automatically -- the grant is
-- table-level and the policy is column-blind.
--
-- No insert, update or delete policy is created. No write grant is issued. A
-- missing policy is a denial and a missing privilege is a refusal before the
-- policy is consulted, and this table keeps both.

commit;
