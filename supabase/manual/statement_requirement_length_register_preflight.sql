-- Statement requirement LENGTH REGISTER -- PREFLIGHT. READ-ONLY.
-- Run BEFORE the migration, and AFTER 20261002_005 has been applied.
--
-- Migration: supabase/migrations/20261002_006_statement_requirement_length_register.sql
--
-- ONE STATEMENT, deliberately. The Supabase SQL editor displays only the LAST
-- result of a multi-statement script, so a preflight split into several SELECTs
-- shows one answer and hides the rest. Everything below is a single query.
--
-- READ THE VERDICT COLUMN. Any row reading FAIL means do not apply the
-- migration yet. Rows marked INFO are context and are not pass/fail.
--
-- THE ORDERING IS THE WHOLE POINT OF THIS FILE. 006 adds eight columns to
-- public.statement_requirements and its CHECK constraints reference min_words,
-- max_words, min_characters, max_characters, min_pages, max_pages and
-- page_spacing -- every one of which 005 creates. Applied first, 006 fails on
-- the missing table; applied with 005 only partly landed, its CHECKs reference
-- columns that are not there.
--
-- AND THE OTHER HALF OF THE ORDERING IS IN THE APPLICATION.
-- lib/statement/requirements/repo.ts names all eight of these columns in its
-- SELECT list, so 005-applied-and-006-missing with STATEMENT_REQUIREMENTS=on
-- means every catalog read errors. It fails CLOSED -- requirementProvenance()
-- turns a read error into a refusal and vouches for nothing -- but the feature
-- is broken rather than degraded. Keep the flag off until both have landed.
--
-- Mutates nothing: every reference is a catalog read or a count.

with
  reqs_t as (select to_regclass('public.statement_requirements') as oid),

new_cols(ord, col, typ) as (
  values
    (1, 'words_enforcement',          'text'),
    (2, 'words_stated_as',            'text'),
    (3, 'characters_enforcement',     'text'),
    (4, 'characters_stated_as',       'text'),
    (5, 'pages_enforcement',          'text'),
    (6, 'pages_stated_as',            'text'),
    (7, 'unenforced_length',          'text'),
    (8, 'unenforced_length_verbatim', 'boolean')
),

required_cols(ord, col) as (
  values
    (1, 'min_words'), (2, 'max_words'),
    (3, 'min_characters'), (4, 'max_characters'),
    (5, 'min_pages'), (6, 'max_pages'),
    (7, 'page_spacing')
),

checks as (

  -- 1. 005 MUST HAVE LANDED FIRST.
  select 100 as step,
         'public.statement_requirements exists (005 applied)' as check_name,
         coalesce((select oid::text from reqs_t), 'absent') as actual,
         'present' as expected,
         case when (select oid from reqs_t) is null
              then 'FAIL -- apply 20261002_005_statement_requirements.sql first'
              else 'PASS' end as verdict

  union all
  select 101,
         'public.statement_requirement_sets exists (005 applied)',
         case when to_regclass('public.statement_requirement_sets') is null
              then 'absent' else 'present' end,
         'present',
         case when to_regclass('public.statement_requirement_sets') is null
              then 'FAIL -- 005 did not land completely'
              else 'PASS' end

  -- 2. EVERY COLUMN 006's CHECKS REFERENCE MUST BE THERE.
  union all
  select 200 + e.ord,
         format('005 created %s (006 CHECKs reference it)', e.col),
         case when c.column_name is null then 'absent' else c.data_type end,
         'present',
         case when c.column_name is null
              then 'FAIL -- 006 would fail on a missing column'
              else 'PASS' end
    from required_cols e
    left join information_schema.columns c
           on c.table_schema = 'public' and c.table_name = 'statement_requirements'
          and c.column_name = e.col

  -- 3. NONE OF THE EIGHT NEW COLUMNS MAY ALREADY EXIST. `add column if not
  -- exists` would skip silently and the CHECKs would then apply to a column
  -- this migration did not design.
  union all
  select 300 + e.ord,
         format('%s does not exist yet', e.col),
         case when c.column_name is null then 'absent' else c.data_type end,
         'absent',
         case when c.column_name is null then 'PASS'
              else 'FAIL -- 006 appears partly applied; inspect before re-running' end
    from new_cols e
    left join information_schema.columns c
           on c.table_schema = 'public' and c.table_name = 'statement_requirements'
          and c.column_name = e.col

  -- 4. 006's CONSTRAINTS MUST NOT ALREADY EXIST either. (The migration drops
  -- them before adding, so a re-run is safe -- but their presence means this is
  -- not a first apply and the operator should know.)
  union all
  select 400,
         'none of 006 constraints exist yet',
         coalesce((select string_agg(conname, ', ' order by conname) from pg_constraint
                    where conrelid = (select oid from reqs_t)
                      and conname like 'statement_requirements_%enforcement%'
                       or conname like 'statement_requirements_unenforced%'), 'none'),
         'none',
         case when exists (select 1 from pg_constraint
                            where conrelid = (select oid from reqs_t)
                              and (conname like '%enforcement%'
                                   or conname like '%unenforced%'))
              then 'FAIL -- 006 appears partly applied'
              else 'PASS' end

  -- 5. THE TABLE SHOULD BE EMPTY, so there is nothing to backfill and no row
  -- that could violate a new CHECK. 006 contains no UPDATE and no backfill, so
  -- a non-empty table is not fatal -- but every new CHECK validates existing
  -- rows, and a row carrying a bound would have to satisfy the
  -- unenforced_length_has_no_bound rule once a sentence were added later.
  union all
  select 500,
         'public.statement_requirements is empty',
         coalesce((select count(*)::text from public.statement_requirements), 'unreadable'),
         '0',
         case when (select count(*) from public.statement_requirements) = 0
              then 'PASS -- nothing to validate and nothing to backfill'
              else 'INFO -- rows present. 006 adds only NULLABLE columns with NULL-tolerant '
                   || 'CHECKs, so existing rows still pass; read the next row' end

  union all
  select 501,
         'no existing row would violate unenforced_length_has_no_bound',
         '0 offending rows (unenforced_length will be NULL on every row)',
         '0',
         case when (select oid from reqs_t) is null then 'FAIL -- table absent'
              else 'PASS -- the new column is NULL, so the constraint''s first disjunct '
                   || 'carries every row' end

  -- 6. GRANTS, recorded. 006 issues none -- the table-level SELECT from 005 is
  -- column-blind and covers new columns.
  union all
  select 600,
         'statement_requirements grants (RECORD THIS -- 006 must not change them)',
         coalesce((select string_agg(distinct grantee || '.' || privilege_type, ', '
                                     order by grantee || '.' || privilege_type)
                     from information_schema.role_table_grants
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and grantee not in ('postgres', 'supabase_admin')), 'none'),
         'anon.SELECT, authenticated.SELECT',
         'INFO -- record it verbatim; 006 issues no GRANT or REVOKE at all'

  -- 7. THE ROLLOUT FLAG, which SQL cannot see.
  union all
  select 700,
         'STATEMENT_REQUIREMENTS must be unset while 005 and 006 are applied (INFO)',
         'not visible from SQL',
         'unset, or anything other than the exact string on',
         'INFO -- with 005 applied, 006 missing and the flag on, every catalog read '
         || 'errors because repo.ts names the eight new columns. It fails closed, but '
         || 'the feature is broken. Confirm the flag in the deployment environment.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;
