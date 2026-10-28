-- ===========================================================================
-- 012  "This prompt has changed" — a submission that challenges a catalog row
-- ===========================================================================
--
-- NOT APPLIED. Drafted for review. Depends on nothing pending: the two tables
-- it alters are created by applied 20261002_000 and applied 005, and it names
-- no column any other pending migration adds. Rehearsed alone on a 004-007
-- cluster; it applies.
--
-- IT IS NUMBERED AFTER 008 BECAUSE THAT IS WHEN IT WAS WRITTEN, not because
-- it needs it. 009 is WITHDRAWN and deleted (replaced by 20261015_017);
-- nothing here relates to either.
--
-- ---------------------------------------------------------------------------
-- WHY A KIND, AND NOT JUST ANOTHER SUBMISSION
-- ---------------------------------------------------------------------------
-- A submission today means "here is a prompt you do not have". An applicant
-- looking at a prompt that is simply WRONG -- the school changed it, and the
-- catalog still shows last year's -- has no way to say so. Sending it as a new
-- prompt loses the one fact that matters most: which existing row it
-- contradicts.
--
-- So the kind is recorded, and the challenged row is recorded with it. An
-- administrator then sees two prompts side by side and decides; nothing infers
-- a replacement from the fact that a report exists.
--
-- ---------------------------------------------------------------------------
-- THE CANONICAL ROW IS NOT TOUCHED BY A REPORT
-- ---------------------------------------------------------------------------
-- There is deliberately no write-back here. A report is evidence, and evidence
-- does not edit the thing it is about. The applicant may use their own wording
-- for their own draft immediately -- labelled as theirs, unverified -- while
-- the catalog keeps saying what it said until somebody decides otherwise.
-- ---------------------------------------------------------------------------

begin;

alter table public.statement_prompt_submissions
  add column if not exists submission_kind text not null default 'new-prompt',
  add column if not exists challenged_requirement_id uuid;

comment on column public.statement_prompt_submissions.submission_kind is
  '''new-prompt'' (a prompt the catalog does not have) or ''prompt-change'' (a '
  'report that an existing catalog row is out of date). Never inferred.';
comment on column public.statement_prompt_submissions.challenged_requirement_id is
  'The statement_requirements row a ''prompt-change'' report contradicts. Null '
  'for a new prompt. Preserved after any decision, so what was replaced stays '
  'answerable.';

alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_kind_known;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_kind_known
  check (submission_kind in ('new-prompt', 'prompt-change'));

-- THE KIND AND ITS TARGET TRAVEL TOGETHER. A report with nothing to compare
-- against cannot be reviewed; a new prompt pointing at an existing row would
-- be a report nobody labelled as one.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_challenge_shape;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_challenge_shape
  check (
    (submission_kind = 'new-prompt' and challenged_requirement_id is null)
    or (submission_kind = 'prompt-change' and challenged_requirement_id is not null)
  );

-- ---------------------------------------------------------------------------
-- THE COLUMN-LEVEL SELECT GRANT, WIDENED
-- ---------------------------------------------------------------------------
-- statement_prompt_submissions GRANTS SELECT BY COLUMN, NOT BY TABLE, so a new
-- column is NOT covered by the privilege authenticated already holds -- unlike
-- statement_requirements below, whose grant is table-level and covers its two
-- new columns automatically. 20261002_000 established the column-scoped grant
-- at 14 and 20261006_008 widened it to 24 by restating the whole list; this
-- restates it again at 26.
--
-- WITHOUT THIS, TURNING THE FLAG ON BREAKS THE READ. ownSubmissionColumns() and
-- reviewColumns() both name the two new columns behind
-- STATEMENT_PROMPT_CHANGE_REPORTS, and PostgREST answers a select that names an
-- ungranted column with `permission denied for table` for the WHOLE request --
-- so the applicant's own-submissions list would stop working rather than lose
-- one field.
--
-- GRANT IS ADDITIVE, so this adds the two new columns and changes nothing else.
-- The list is restated in full so the file reads as the whole truth rather than
-- a diff, which is the model 008 set.
--
-- review_note AND reviewed_by ARE STILL ABSENT, AND THAT IS STILL THE POINT.
-- RLS filters rows, never columns, so the own-row select policy would otherwise
-- let a submitter read an administrator's private note about them, and the
-- identity of the administrator who wrote it, straight from PostgREST.
--
-- NO INSERT, UPDATE OR DELETE GRANT, for any role, and nothing for anon or
-- service_role. Every write to this table still goes through the SECURITY
-- DEFINER functions in 20261002_003.
grant select (
  id, submitted_by, school_id, prompt_text, stated_max_words, application_cycle,
  source_url, status, reviewed_at, approved_prompt_id, duplicate_of_id,
  text_fingerprint, created_at, updated_at,
  document_label, document_type_hint, stated_min_words, stated_max_characters,
  stated_max_pages, stated_pages_text, formatting_instructions,
  other_instructions, submitter_note, approved_requirement_id,
  submission_kind, challenged_requirement_id
) on public.statement_prompt_submissions to authenticated;

-- ---------------------------------------------------------------------------
-- PROVENANCE SURVIVES A REPLACEMENT
-- ---------------------------------------------------------------------------
-- When an administrator decides a report REPLACES a catalog row, the old row
-- is deactivated rather than deleted, and the new row records which row it
-- superseded. Three questions stay answerable afterwards: what the catalog
-- used to say, what replaced it, and which submission caused the change.
alter table public.statement_requirements
  add column if not exists supersedes_requirement_id uuid,
  add column if not exists origin_submission_id uuid;

comment on column public.statement_requirements.supersedes_requirement_id is
  'The requirement this one replaced. The replaced row is deactivated, never '
  'deleted, so the catalog''s history stays readable.';
comment on column public.statement_requirements.origin_submission_id is
  'The submission this requirement was created from, when it came from one.';

alter table public.statement_requirements
  drop constraint if exists statement_requirements_supersedes_not_self;
alter table public.statement_requirements
  add constraint statement_requirements_supersedes_not_self
  check (supersedes_requirement_id is null or supersedes_requirement_id <> id);

commit;

-- ---------------------------------------------------------------------------
-- STILL TO DO WHEN THIS IS APPLIED, NOT DONE HERE
-- ---------------------------------------------------------------------------
-- * Foreign keys for challenged_requirement_id, supersedes_requirement_id and
--   origin_submission_id are left out. The reason once given -- that 008/009
--   had yet to create the tables -- does not hold: statement_requirements is
--   created by applied 005 and statement_prompt_submissions by applied
--   20261002_000, and 009 is WITHDRAWN and deleted (replaced by 20261015_017,
--   which this file does not depend on in either direction).
--
--   So these three columns are unconstrained references, and the writers are
--   what hold them: the admin route resolves each id before storing it.
--   Adding the FKs is a deliberate separate change -- each takes a lock on
--   the referenced table -- and is recorded as a pre-release item.
-- * repo.ts adds the new columns to its select list in the same change that
--   applies this.
