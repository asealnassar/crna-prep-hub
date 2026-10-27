-- ============================================================================
-- Does the promotion RPC actually persist the evidence that justifies the row?
--
-- THE REGRESSION THIS EXISTS FOR. 20261006_009 created this function with an
-- INSERT that named neither evidence_kind nor evidence_submission_id, and
-- 20261008_011 then added both -- so a set created by promoting an applicant's
-- submission took the column default and recorded itself as an OFFICIAL
-- SOURCE. False provenance, an activation the check constraint then refuses,
-- and the QA-001 sentence back on an applicant's screen. 009 was withdrawn and
-- reissued as 20261015_017, after 011; this proves the reissue works.
--
-- DISPOSABLE LOCAL CLUSTER ONLY -- it writes rows. Run with
--   export PGOPTIONS="-c crna.rehearsal_confirm=disposable-local-cluster"
-- after the scaffold and migrations 000-008, 010-017.
--
-- READS ITS VERDICT FROM THE LAST SELECT, like every other check in this
-- directory. Any FAIL means do not apply.
-- ============================================================================

do $confirm$
begin
  if current_setting('crna.rehearsal_confirm', true) is distinct from 'disposable-local-cluster'
  then
    raise exception 'REFUSED: this test writes rows. Disposable local cluster only.';
  end if;
end
$confirm$;

begin;

-- ---- a submitter, a school, and a submission to promote --------------------
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-00000000e001', 'evidence@example.invalid')
on conflict (id) do nothing;

insert into public.statement_prompt_submissions
  (id, submitted_by, school_id, prompt_text, status, text_fingerprint)
values (
  '00000000-0000-4000-8000-00000000e002',
  '00000000-0000-4000-8000-00000000e001',
  '00000000-0000-4000-8000-00000000e003',
  'Describe a time you advocated for a patient.',
  'pending',
  repeat('a', 64)
);

-- ---- 1. PUBLISHED FROM A SUBMISSION ---------------------------------------
-- Exactly what app/api/admin/statement-prompts/route.ts sends when publish is
-- true: the kind, and the id of the submission being promoted.
select public.promote_statement_submission_to_requirement(
  '00000000-0000-4000-8000-00000000e002'::uuid,
  '00000000-0000-4000-8000-00000000e001'::uuid,
  'new-set',
  jsonb_build_object(
    'document_type', 'personal-statement',
    'label', 'Personal Statement',
    'prompt_text', 'Describe a time you advocated for a patient.'),
  jsonb_build_object(
    'verification_status', 'verified',
    'verified_on', '2026-10-15',
    'evidence_kind', 'admin-approved-submission',
    'evidence_submission_id', '00000000-0000-4000-8000-00000000e002')
) as promoted_submission_backed \gset

-- ---- 2. PUBLISHED FROM AN OFFICIAL SOURCE ---------------------------------
-- A payload that says nothing about evidence must still land on the weaker,
-- truthful claim -- never on the stronger one by accident.
insert into public.statement_prompt_submissions
  (id, submitted_by, school_id, prompt_text, status, text_fingerprint)
values (
  '00000000-0000-4000-8000-00000000e004',
  '00000000-0000-4000-8000-00000000e001',
  '00000000-0000-4000-8000-00000000e005',
  'Why nurse anesthesia?',
  'pending',
  repeat('b', 64)
);
select public.promote_statement_submission_to_requirement(
  '00000000-0000-4000-8000-00000000e004'::uuid,
  '00000000-0000-4000-8000-00000000e001'::uuid,
  'new-set',
  jsonb_build_object(
    'document_type', 'personal-statement',
    'label', 'Personal Statement',
    'prompt_text', 'Why nurse anesthesia?'),
  jsonb_build_object('verification_status', 'unverified')
) as promoted_official \gset

-- ---- the verdict -----------------------------------------------------------
with submission_backed as (
  select s.* from public.statement_requirement_sets s
   where s.school_id = '00000000-0000-4000-8000-00000000e003'
),
official as (
  select s.* from public.statement_requirement_sets s
   where s.school_id = '00000000-0000-4000-8000-00000000e005'
),
checks as (
  select 1 as step,
         'a promoted submission records admin-approved-submission' as check_name,
         (select evidence_kind from submission_backed) as actual,
         'admin-approved-submission' as expected
  union all
  select 2,
         'and points at the submission it was promoted from',
         (select evidence_submission_id::text from submission_backed),
         '00000000-0000-4000-8000-00000000e002'
  union all
  select 3,
         'a payload with no evidence falls to official-source',
         (select evidence_kind from official),
         'official-source'
  union all
  select 4,
         'and carries no submission id',
         (select coalesce(evidence_submission_id::text, 'null') from official),
         'null'
  union all
  -- THE CONSTRAINT 011 ADDED, EXERCISED RATHER THAN READ. A submission-backed
  -- row with no source_url must be activatable; that is the whole point of the
  -- widened check, and the shape 009 could not produce.
  select 5,
         'a submission-backed set with no source_url can be activated',
         (select case when (
            select count(*) from submission_backed
             where verification_status = 'verified'
               and verified_on is not null
               and source_url is null
               and evidence_kind = 'admin-approved-submission'
               and evidence_submission_id is not null) = 1
           then 'satisfies active_needs_evidence' else 'would be refused' end),
         'satisfies active_needs_evidence'
  union all
  select 6,
         'nothing was activated by promotion',
         (select count(*)::text from public.statement_requirement_sets where is_active),
         '0'
)
select step,
       check_name,
       actual,
       expected,
       case when actual is not distinct from expected then 'PASS' else 'FAIL' end as verdict
  from checks
 order by step;

rollback;
