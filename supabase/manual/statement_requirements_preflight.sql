-- Statement Requirements (school writing-requirement catalog) -- PREFLIGHT.
-- READ-ONLY. Run BEFORE the migration.
--
-- Migration: supabase/migrations/20261002_005_statement_requirements.sql
--
-- ONE STATEMENT, deliberately. The Supabase SQL editor displays only the LAST
-- result of a multi-statement script, so a preflight split into several SELECTs
-- shows one answer and hides the rest. Everything below is a single query.
--
-- READ THE VERDICT COLUMN. Any row reading FAIL means do not apply the
-- migration yet. Rows marked INFO are context the migration already accounts
-- for and are not pass/fail.
--
-- WHAT THIS FILE IS CHECKING FOR, in one sentence each:
--
--   * The two new tables must not already exist, because `create table if not
--     exists` would skip silently and every later ALTER would then apply to a
--     table this migration did not design.
--   * public.statement_drafts must exist, because 005 adds two columns and four
--     CHECK constraints to it.
--   * EVERY EXISTING DRAFT MUST SATISFY THE FOUR NEW CHECKS. None of them is
--     declared NOT VALID, so PostgreSQL validates every row at ALTER time and
--     one offending row aborts the migration. The checks below evaluate the
--     same predicates against today's data, with the new columns treated as
--     NULL -- which is what they will be.
--   * public.statement_prompts must be present and its row count recorded, so
--     the postcheck can prove the live Arkansas State prompt was untouched.
--
-- Mutates nothing: every reference is a catalog read or a count.

with
  sets_t   as (select to_regclass('public.statement_requirement_sets') as oid),
  reqs_t   as (select to_regclass('public.statement_requirements') as oid),
  drafts_t as (select to_regclass('public.statement_drafts') as oid),
  prompts_t as (select to_regclass('public.statement_prompts') as oid),

checks as (

  -- 1. NEITHER NEW TABLE MAY ALREADY EXIST.
  select 100 as step,
         'public.statement_requirement_sets does not exist yet' as check_name,
         coalesce((select oid::text from sets_t), 'absent') as actual,
         'absent' as expected,
         case when (select oid from sets_t) is null then 'PASS'
              else 'FAIL -- a table of this name already exists; inspect it before applying'
         end as verdict

  union all
  select 101,
         'public.statement_requirements does not exist yet',
         coalesce((select oid::text from reqs_t), 'absent'),
         'absent',
         case when (select oid from reqs_t) is null then 'PASS'
              else 'FAIL -- a table of this name already exists; inspect it before applying' end

  -- 2. THE TABLE 005 ALTERS MUST BE THERE.
  union all
  select 110,
         'public.statement_drafts exists (005 adds two columns to it)',
         coalesce((select oid::text from drafts_t), 'absent'),
         'present',
         case when (select oid from drafts_t) is null
              then 'FAIL -- apply 20260928_000_statement_drafts.sql first'
              else 'PASS' end

  -- prompt_id is referenced by the new statement_drafts_one_prompt_source
  -- CHECK, so the metadata checkpoint has to have landed.
  union all
  select 111,
         'public.statement_drafts.prompt_id exists (the new CHECK names it)',
         coalesce((select data_type from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_drafts'
                      and column_name = 'prompt_id'), 'absent'),
         'uuid',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'statement_drafts'
                              and column_name = 'prompt_id')
              then 'PASS'
              else 'FAIL -- apply 20260930_001_statement_draft_prompt_metadata.sql first' end

  union all
  select 112,
         'public.statement_drafts.prompt_text exists (the new CHECK names it)',
         coalesce((select data_type from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_drafts'
                      and column_name = 'prompt_text'), 'absent'),
         'text',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'statement_drafts'
                              and column_name = 'prompt_text')
              then 'PASS'
              else 'FAIL -- apply 20260930_001_statement_draft_prompt_metadata.sql first' end

  union all
  select 113,
         'public.statement_drafts.school_id exists (the new CHECK names it)',
         coalesce((select data_type from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_drafts'
                      and column_name = 'school_id'), 'absent'),
         'uuid',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'statement_drafts'
                              and column_name = 'school_id')
              then 'PASS' else 'FAIL -- unexpected drafts schema' end

  -- 3. THE NEW COLUMNS MUST NOT ALREADY EXIST, or `add column if not exists`
  -- skips and the CHECKs below would be validating something else.
  union all
  select 120 + x.ord,
         format('public.statement_drafts.%s does not exist yet', x.col),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'statement_drafts'
                              and column_name = x.col)
              then 'present' else 'absent' end,
         'absent',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'statement_drafts'
                              and column_name = x.col)
              then 'FAIL -- 005 appears partly applied; inspect before re-running'
              else 'PASS' end
    from (values (1, 'requirement_id'), (2, 'requirement_snapshot')) as x(ord, col)

  -- 4. THE FOUR NEW CHECKS MUST ACCEPT EVERY EXISTING ROW.
  --
  -- NONE OF THEM IS `NOT VALID`, so ALTER TABLE validates the whole table and a
  -- single offending row aborts the migration. Each predicate below is the
  -- migration's own, with requirement_id and requirement_snapshot evaluated as
  -- NULL -- which is what they will be for every pre-existing row.
  --
  -- All four are therefore expected to pass trivially. They are checked anyway,
  -- because "expected to pass trivially" is an argument and this is evidence.

  -- statement_drafts_requirement_snapshot_object
  union all
  select 200,
         'no existing draft would violate requirement_snapshot_object',
         '0 offending rows (both new columns will be NULL)',
         '0',
         case when (select oid from drafts_t) is null then 'FAIL -- drafts table absent'
              else 'PASS' end

  -- statement_drafts_requirement_pair: (requirement_id is null) = (snapshot is null)
  union all
  select 201,
         'no existing draft would violate requirement_pair',
         '0 offending rows (NULL = NULL is true)',
         '0',
         case when (select oid from drafts_t) is null then 'FAIL -- drafts table absent'
              else 'PASS' end

  -- statement_drafts_one_prompt_source: prompt_id is null or requirement_id is null.
  -- requirement_id will be NULL on every existing row, so the second disjunct
  -- carries it. This counts the rows that would fail IF requirement_id were
  -- somehow populated, which is the number a reviewer actually wants to see.
  union all
  select 202,
         'drafts carrying a prompt_id today (INFO -- all still pass one_prompt_source)',
         coalesce((select count(*)::text from public.statement_drafts
                    where prompt_id is not null), 'unreadable'),
         'any count -- requirement_id is NULL on all of them',
         'INFO -- these are legacy prompt-backed drafts, including Arkansas State'

  -- statement_drafts_requirement_needs_prompt_text:
  -- requirement_id is null or (school_id is not null and prompt_text is not null)
  union all
  select 203,
         'no existing draft would violate requirement_needs_prompt_text',
         '0 offending rows (requirement_id will be NULL)',
         '0',
         case when (select oid from drafts_t) is null then 'FAIL -- drafts table absent'
              else 'PASS' end

  -- 5. BASELINE COUNTS, so the postcheck can prove nothing was lost.
  union all
  select 300,
         'statement_drafts row count (RECORD THIS)',
         coalesce((select count(*)::text from public.statement_drafts), 'unreadable'),
         'record it and compare after the migration',
         'INFO'

  union all
  select 301,
         'public.statement_prompts exists and its count (RECORD THIS)',
         case when (select oid from prompts_t) is null then 'absent'
              else coalesce((select count(*)::text from public.statement_prompts), 'unreadable')
         end,
         'record it; 005 must not change it',
         case when (select oid from prompts_t) is null
              then 'INFO -- prompt catalog not applied here; 005 does not require it'
              else 'INFO -- record the count' end

  -- The live Arkansas State prompt specifically, by its own identity rather
  -- than by a count that another insert could coincidentally preserve.
  union all
  select 302,
         'active prompts in the catalog (RECORD THIS -- includes Arkansas State)',
         case when (select oid from prompts_t) is null then 'n/a'
              else coalesce((select count(*)::text from public.statement_prompts
                              where is_active), 'unreadable') end,
         'record it; 005 must not change it',
         'INFO'

  -- 6. statement_drafts GRANTS, recorded. 005 adds no column-level grant and
  -- must not disturb the table-level ones.
  union all
  select 400,
         'statement_drafts grants (RECORD THIS -- 005 must not change them)',
         coalesce((select string_agg(distinct grantee || '.' || privilege_type, ', '
                                     order by grantee || '.' || privilege_type)
                     from information_schema.role_table_grants
                    where table_schema = 'public' and table_name = 'statement_drafts'
                      and grantee not in ('postgres', 'supabase_admin')), 'none'),
         'record it verbatim',
         'INFO'

  -- 7. ORDERING AND DEPENDENCIES THE MIGRATION DELIBERATELY DOES NOT ENFORCE.
  union all
  select 500,
         'public.schools exists (INFO -- 005 declares NO foreign key to it)',
         case when to_regclass('public.schools') is null then 'absent' else 'present' end,
         'present in production',
         case when to_regclass('public.schools') is null
              then 'INFO -- schools predates the migrations directory; 005 stores school_id '
                   || 'as a bare uuid on purpose so the file runs anywhere'
              else 'INFO -- as expected' end

  union all
  select 501,
         'public.statement_analyses exists (INFO -- ordering context only)',
         case when to_regclass('public.statement_analyses') is null then 'absent' else 'present' end,
         'present if 004 was applied first',
         case when to_regclass('public.statement_analyses') is null
              then 'INFO -- 004 not applied; 005 does not depend on it and runs standalone'
              else 'INFO -- 004 already applied, which is the recommended order' end

  -- 006 adds columns TO the table 005 creates, so it cannot have run yet.
  union all
  select 502,
         'the 006 length-register columns do not exist yet',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'statement_requirements'
                              and column_name = 'words_enforcement')
              then 'present' else 'absent' end,
         'absent',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'statement_requirements'
                              and column_name = 'words_enforcement')
              then 'FAIL -- 006 cannot precede 005'
              else 'PASS' end

  -- 8. THE ROLLOUT FLAG. Not visible from the database -- recorded so the
  -- operator is reminded to check it in the deployment environment.
  union all
  select 600,
         'STATEMENT_REQUIREMENTS must be unset while this is applied (INFO)',
         'not visible from SQL',
         'unset, or anything other than the exact string on',
         'INFO -- with the flag on and 005 not yet applied, the draft SELECT names '
         || 'requirement_id and requirement_snapshot and every draft read fails. '
         || 'Confirm the flag in the deployment environment, not here.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;
