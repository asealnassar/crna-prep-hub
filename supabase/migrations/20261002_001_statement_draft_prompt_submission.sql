-- Personal Statement Studio V2 -- a draft may answer a user-provided prompt.
--
-- ADDITIVE ONLY. This migration adds ONE nullable column to
-- public.statement_drafts and TWO CHECK constraints over the prompt columns. It
-- does not touch, rewrite, backfill or delete any existing row, column, index,
-- policy, grant, function or trigger, and it edits no earlier migration.
--
-- ONE COLUMN, NOT TWO. An earlier sketch of this work carried a `prompt_origin`
-- text column beside the id. It is not here, for two reasons:
--
--   1. IT WOULD BE DERIVABLE AND THEREFORE ABLE TO DISAGREE. A draft answers a
--      catalog prompt when prompt_id is set and a user-provided one when
--      prompt_submission_id is set; the two are mutually exclusive by the
--      constraint below, so the origin is already a fact about which column is
--      populated. A stored copy is a second source of truth that can drift from
--      the first, and the drift would be invisible.
--   2. EVERY EXISTING ROW WOULD VIOLATE IT. Drafts created before this file
--      carry a prompt_id and no origin, so any constraint requiring the two to
--      agree would fail on live data unless this migration backfilled -- and
--      rewriting rows that hold somebody's statement metadata is exactly what
--      these migrations do not do.
--
-- THE SNAPSHOT IS STILL THE SNAPSHOT. prompt_text, school_id and
-- stated_max_words keep their existing meaning and their existing constraints:
-- an immutable copy of the question this essay was written to answer, taken
-- when it was chosen. The new column records WHERE that copy came from. It is
-- provenance, and it is never read to render the question -- so a submission
-- that is later rejected, withdrawn, edited by an administrator or approved
-- with corrected wording changes nothing an applicant can see in their draft.
--
-- NO FOREIGN KEY, matching prompt_id beside it. 20260930_001 omitted the FK to
-- statement_prompts so that a half-referential row -- one id guaranteed to
-- resolve and its sibling not -- could not exist, and the same argument applies
-- here: both FKs arrive together once public.schools is under migration
-- control. A dangling prompt_submission_id is harmless by construction,
-- because nothing resolves it to display anything.
--
-- WHAT IS DELIBERATELY ABSENT:
--
--   * Any backfill. No existing draft is touched.
--   * Any change to revision, its default, its CHECK, or the compare-and-swap.
--   * Any RLS change. The own-rows policies already cover every column.
--   * Any grant change. The existing grant is TABLE-level, so a new column is
--     covered automatically -- see section 3.
--   * Any index. No query filters on this column; it is read with the row.

begin;

-- ============================================================
-- 1. THE COLUMN
-- ============================================================
alter table public.statement_drafts
  add column if not exists prompt_submission_id uuid;

comment on column public.statement_drafts.prompt_submission_id is
  'Provenance only: the statement_prompt_submissions row this draft''s prompt '
  'snapshot was pasted from. Never resolved to render the prompt -- the draft '
  'renders its own prompt_text. Mutually exclusive with prompt_id.';

-- ============================================================
-- 2. CONSTRAINTS
-- ============================================================

-- THE MUTUAL EXCLUSION, AND IT IS THE POINT OF THIS FILE.
--
-- prompt_id means "a row in the approved catalog". prompt_submission_id means
-- "somebody's paste, which may or may not ever be approved". A row carrying
-- both would be claiming catalog provenance for wording that was never
-- reviewed -- the precise misrepresentation this feature has to make
-- impossible -- and it would be claiming it in a way no application check could
-- be trusted to prevent, because statement_drafts is a table the applicant's
-- own role may UPDATE.
--
-- So it is a CHECK. Whoever writes the row, through whatever client, with
-- whatever token, the two columns cannot both be populated.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_prompt_source_exclusive;
alter table public.statement_drafts
  add constraint statement_drafts_prompt_source_exclusive
  check (prompt_id is null or prompt_submission_id is null);

-- A USER-PROVIDED PROMPT HAS WORDING. The snapshot is what the draft renders,
-- so a submission reference with no prompt_text would leave the editor pointing
-- at a question it cannot show -- and tempt a future reader to resolve the
-- submission to recover it, which is the one thing provenance must never be
-- used for.
--
-- The converse is NOT constrained: prompt_text with neither id is permitted,
-- because 20260930_001 deliberately left the four prompt columns free of
-- cross-column rules and a draft may legitimately hold a snapshot whose source
-- has been forgotten. This file narrows only what it introduces.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_submission_has_text;
alter table public.statement_drafts
  add constraint statement_drafts_submission_has_text
  check (prompt_submission_id is null or prompt_text is not null);

-- ============================================================
-- 3. NO GRANT OR POLICY CHANGE, AND WHY
-- ============================================================
-- The existing grant is TABLE-level --
--   grant select, insert, update, delete on public.statement_drafts to authenticated
-- -- so a new column is covered by it automatically and nothing is added here.
--
-- STATED PLAINLY, BECAUSE IT IS A REAL LIMIT: that grant means an applicant can
-- write every column of their OWN draft row directly through PostgREST,
-- including prompt_id and prompt_text. That is true today, before this file,
-- for the four columns 20260930_001 added. This migration does not widen it and
-- cannot narrow it -- the application's own PATCH path runs as the same
-- `authenticated` role with the same JWT, so a column-level revoke would break
-- prompt selection for the feature as surely as for an attacker.
--
-- WHAT THAT DOES AND DOES NOT ALLOW. An applicant can make their own draft
-- claim anything. They CANNOT make the catalog agree: public.statement_prompts
-- grants no insert or update to any browser role, and approval runs inside a
-- definer function restricted to service_role. So "is this really an approved
-- school prompt" is answered by resolving prompt_id against the catalog and
-- comparing the wording -- see provenanceOf() in
-- lib/statement/draft/promptSubmission.ts -- and never by trusting a column on
-- the draft. The blast radius of a forged draft column is that one applicant's
-- own draft, and the analyser safeguards are built on the catalog comparison
-- rather than on the claim.

commit;
