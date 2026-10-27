-- ===========================================================================
-- 011  Admin-approved submission as a second, named kind of evidence
-- ===========================================================================
--
-- NOT APPLIED. Drafted for review. Depends on 005 only, and on nothing
-- pending: public.statement_prompt_submissions, which the new column refers
-- to, is created by 20261002_000 and is APPLIED.
--
-- THIS FILE USED TO CLAIM A DEPENDENCY ON 009, and that claim was wrong twice
-- over. 009 created a FUNCTION, not the submission table; and the real
-- ordering runs the other way -- the promotion function writes the columns
-- added here, so it must come AFTER this file. Keeping the claim would have
-- told an operator to apply 009 first, which is the one thing that must never
-- happen: 009 is WITHDRAWN and deleted, replaced by 20261015_017, which
-- refuses to install unless this file is already applied.
--
-- ---------------------------------------------------------------------------
-- THE PROBLEM
-- ---------------------------------------------------------------------------
-- 005 says an active requirement set must carry evidence:
--
--     is_active = false
--     or (verification_status = 'verified'
--         and source_url is not null
--         and verified_on is not null)
--
-- That rule is right and must survive. But it recognises exactly ONE kind of
-- evidence -- a URL on the school's own site -- and a student submission never
-- has one. The prompt arrived in an email, or a portal the applicant was
-- logged into, or a PDF nobody else can fetch.
--
-- So an administrator could approve a submission, promote it to a canonical
-- row, and then find no way to publish it. Approve appeared to do nothing,
-- because everything applicant-facing is downstream of is_active.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES, AND WHAT IT REFUSES TO DO
-- ---------------------------------------------------------------------------
-- It adds a SECOND kind of evidence and names it. It does not weaken the rule:
-- an active set still needs a verified status, a date, and something a person
-- can point at. The something may now be an administrator's own decision on a
-- specific submission, recorded by id.
--
-- IT IS NOT THE SAME EVIDENCE, AND IS NOT STORED AS THOUGH IT WERE. The kind
-- is a column, not an inference, so every reader downstream can tell an entry
-- checked against a published page from one taken on an applicant's word --
-- and the interface says so rather than calling both "verified".
--
-- NO BACKFILL BEYOND A DEFAULT. Every existing row is official-source evidence,
-- which is what it already was.
-- ---------------------------------------------------------------------------

begin;

alter table public.statement_requirement_sets
  add column if not exists evidence_kind text not null default 'official-source',
  add column if not exists evidence_submission_id uuid;

comment on column public.statement_requirement_sets.evidence_kind is
  'What an active set is published on: ''official-source'' (a URL on the '
  'school''s own site) or ''admin-approved-submission'' (an administrator''s '
  'decision on a specific student submission). Never inferred; readers show it.';
comment on column public.statement_requirement_sets.evidence_submission_id is
  'The submission an ''admin-approved-submission'' set was published on. Null '
  'for official-source evidence.';

alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_evidence_kind_known;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_evidence_kind_known
  check (evidence_kind in ('official-source', 'admin-approved-submission'));

-- THE KIND AND ITS EVIDENCE TRAVEL TOGETHER. A submission id on an
-- official-source row, or a submission-backed row with no id, is a row whose
-- provenance cannot be reconstructed.
alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_evidence_shape;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_evidence_shape
  check (
    (evidence_kind = 'official-source' and evidence_submission_id is null)
    or (evidence_kind = 'admin-approved-submission' and evidence_submission_id is not null)
  );

-- THE RULE FROM 005, WIDENED BY EXACTLY ONE CASE.
--
-- Still: no active set without a verified status and a date. The third
-- requirement becomes "point at something" rather than "point at a URL".
alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_active_needs_evidence;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_active_needs_evidence
  check (
    is_active = false
    or (
      verification_status = 'verified'
      and verified_on is not null
      and (
        (evidence_kind = 'official-source' and source_url is not null)
        or (evidence_kind = 'admin-approved-submission'
            and evidence_submission_id is not null)
      )
    )
  );

commit;

-- ---------------------------------------------------------------------------
-- STILL TO DO WHEN THIS IS APPLIED, NOT DONE HERE
-- ---------------------------------------------------------------------------
-- * The foreign key to statement_prompt_submissions(id) is NOT added here,
--   and the reason originally given for that -- that 009 had yet to create
--   the table -- was false: 20261002_000 creates it and is applied, as the
--   rehearsal confirmed by finding the table present before this file ran.
--   So the FK is simply absent, and nothing enforces that
--   evidence_submission_id names a real submission.
--
--   WHAT HOLDS WITHOUT IT. The only writer is 20261015_017, which stores
--   p_submission_id -- the submission it has already loaded into a rowtype
--   and validated -- so it cannot store an id that does not exist. The FK
--   would be a second line of defence against a hand-written UPDATE, not the
--   first. Adding one takes a lock on statement_prompt_submissions, so it is
--   a deliberate separate change rather than an edit to this file at freeze
--   time; it is recorded as a pre-release item instead.
-- * repo.ts adds both columns to its select list in the same change that
--   applies this, for the reason given in that file: naming a column that does
--   not exist yet fails every catalog read.
