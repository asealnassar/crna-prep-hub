-- Statement Studio V2 -- migration 007 PREFLIGHT.
-- READ-ONLY. Run BEFORE the migration. Mutates nothing: every reference below
-- is a catalog read or a count.
--
-- Migration: supabase/migrations/20261005_007_statement_requirement_document_types_and_pages.sql
--
-- ONE STATEMENT, deliberately. The Supabase SQL editor displays only the LAST
-- result of a multi-statement script, so a preflight split into several SELECTs
-- shows one answer and hides the rest.
--
-- WHAT 007 DOES, AND THEREFORE WHAT THIS HAS TO ESTABLISH FIRST.
--
--   * It REPLACES statement_requirements_document_type_known, widening it from
--     six values to nine. So the six must be exactly what is there now: if the
--     constraint has already been widened, 007 has run and re-running it is a
--     no-op that would make the postcheck's "it changed" reading meaningless.
--   * It REWRITES min_pages and max_pages from integer to numeric(4,1). An
--     ALTER COLUMN TYPE takes ACCESS EXCLUSIVE and rewrites the table, so the
--     row count is the cost, and every dependent CHECK is re-validated -- which
--     means a row that violates one TODAY will abort the migration rather than
--     the ALTER.
--
-- READ THE VERDICT COLUMN. Any FAIL means do not apply 007 yet. INFO rows are
-- state to RECORD so the postcheck has something to compare against -- grants,
-- RLS, policies and row counts are asserted "unchanged" after the migration,
-- and unchanged is meaningless without a before.

with
  reqs as (select to_regclass('public.statement_requirements') as oid),
  sets_t as (select to_regclass('public.statement_requirement_sets') as oid),
  dtc as (select pg_get_constraintdef(oid) as def
            from pg_constraint
           where conname = 'statement_requirements_document_type_known'
             and conrelid = (select oid from reqs)),
  checks as (

  -- ---- 1. WHO AND WHERE ---------------------------------------------------
  select 100 as step,
         'target database and executing role (INFO)' as check_name,
         'db=' || current_database() || ', current_user=' || current_user as actual,
         'the production project, as the role that will apply 007' as expected,
         'INFO -- 007 only ALTERs public.statement_requirements, so the role must '
         || 'own that table. It needs no privilege on auth.users.' as verdict

  -- ---- 2. 005 AND 006 MUST BE APPLIED ------------------------------------
  union all
  select 200, '005 applied: both catalog tables exist',
         coalesce((select oid::text from reqs), 'absent') || ' / '
           || coalesce((select oid::text from sets_t), 'absent'),
         'both present',
         case when (select oid from reqs) is not null
               and (select oid from sets_t) is not null
              then 'PASS' else 'FAIL -- apply 005 first' end

  union all
  select 201, '006 applied: all eight register columns present',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'statement_requirements'
             and column_name in ('words_enforcement', 'words_stated_as',
                  'characters_enforcement', 'characters_stated_as',
                  'pages_enforcement', 'pages_stated_as',
                  'unenforced_length', 'unenforced_length_verbatim')) || ' of 8',
         '8 of 8',
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements'
                       and column_name in ('words_enforcement', 'words_stated_as',
                            'characters_enforcement', 'characters_stated_as',
                            'pages_enforcement', 'pages_stated_as',
                            'unenforced_length', 'unenforced_length_verbatim')) = 8
              then 'PASS' else 'FAIL -- apply 006 first; 007''s audit block checks for '
                   || 'pages_enforcement and will refuse' end

  -- ---- 3. 007 MUST NOT ALREADY BE APPLIED --------------------------------
  union all
  select 300, 'document_type constraint still has ONLY the original six',
         case when (select def from dtc) is null then 'constraint absent'
              when (select def from dtc) like '%statement-of-purpose%'
                then 'already widened'
              else 'the original six' end,
         'the original six',
         case
           when (select def from dtc) is null
             then 'FAIL -- statement_requirements_document_type_known is missing; '
                  || 'investigate before altering anything'
           when (select def from dtc) like '%statement-of-purpose%'
             then 'FAIL -- 007 HAS ALREADY BEEN APPLIED (the constraint names '
                  || 'statement-of-purpose). Do not re-apply; run the postcheck instead.'
           else 'PASS -- 007 has not run' end

  union all
  select 301, 'all six original document types are present in the constraint',
         (select (case when def like '%''personal-statement''%' then 1 else 0 end
                + case when def like '%''goal-statement''%' then 1 else 0 end
                + case when def like '%''diversity-statement''%' then 1 else 0 end
                + case when def like '%''writing-sample''%' then 1 else 0 end
                + case when def like '%''additional-response''%' then 1 else 0 end
                + case when def like '%''other''%' then 1 else 0 end)::text
            from dtc) || ' of 6',
         '6 of 6',
         case when (select (case when def like '%''personal-statement''%' then 1 else 0 end
                          + case when def like '%''goal-statement''%' then 1 else 0 end
                          + case when def like '%''diversity-statement''%' then 1 else 0 end
                          + case when def like '%''writing-sample''%' then 1 else 0 end
                          + case when def like '%''additional-response''%' then 1 else 0 end
                          + case when def like '%''other''%' then 1 else 0 end) from dtc) = 6
              then 'PASS -- 007 must not remove any of these'
              else 'FAIL -- the constraint is not the one 005 created; read it before '
                   || 'replacing it' end

  -- ---- 4. THE PAGE COLUMNS' CURRENT TYPE ---------------------------------
  union all
  select 310, 'min_pages is integer before 007',
         coalesce((select data_type from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and column_name = 'min_pages'), 'absent'),
         'integer',
         case when (select data_type from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements'
                       and column_name = 'min_pages') = 'integer'
              then 'PASS'
              else 'FAIL -- not the pre-007 type; 007 may already have run, or the '
                   || 'column is not what 005 created' end

  union all
  select 311, 'max_pages is integer before 007',
         coalesce((select data_type from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and column_name = 'max_pages'), 'absent'),
         'integer',
         case when (select data_type from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements'
                       and column_name = 'max_pages') = 'integer'
              then 'PASS' else 'FAIL -- not the pre-007 type' end

  union all
  select 312, 'page columns are nullable with no default (RECORD THIS)',
         (select string_agg(column_name || ': nullable=' || is_nullable
                            || ' default=' || coalesce(column_default, 'none'), '; '
                            order by column_name)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'statement_requirements'
             and column_name in ('min_pages', 'max_pages')),
         'both nullable, neither defaulted',
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements'
                       and column_name in ('min_pages', 'max_pages')
                       and is_nullable = 'YES' and column_default is null) = 2
              then 'PASS -- the postcheck asserts this is still true after 007'
              else 'FAIL -- a default or NOT NULL is present that 005 did not create' end

  -- ---- 5. EVERY CONSTRAINT THE TYPE CHANGE TOUCHES -----------------------
  union all
  select 320, 'all five page-related CHECK constraints exist',
         (select count(*)::text from pg_constraint
           where conrelid = (select oid from reqs) and contype = 'c'
             and conname in ('statement_requirements_page_bounds',
                  'statement_requirements_page_spacing_known',
                  'statement_requirements_pages_register_needs_limit',
                  'statement_requirements_truncation_needs_maximum',
                  'statement_requirements_unenforced_length_has_no_bound')) || ' of 5',
         '5 of 5',
         case when (select count(*) from pg_constraint
                     where conrelid = (select oid from reqs) and contype = 'c'
                       and conname in ('statement_requirements_page_bounds',
                            'statement_requirements_page_spacing_known',
                            'statement_requirements_pages_register_needs_limit',
                            'statement_requirements_truncation_needs_maximum',
                            'statement_requirements_unenforced_length_has_no_bound')) = 5
              then 'PASS -- 007''s audit block refuses to commit if any is lost'
              else 'FAIL -- a constraint 007 expects to carry across is already missing' end

  union all
  select 321, 'CHECK constraint count on statement_requirements (RECORD THIS)',
         (select count(*)::text from pg_constraint
           where conrelid = (select oid from reqs) and contype = 'c'),
         '25 as 005+006 leave it',
         'INFO -- 007 replaces one constraint IN PLACE and adds none, so the '
         || 'postcheck asserts this number is UNCHANGED'

  union all
  select 322, 'column count on statement_requirements (RECORD THIS)',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'statement_requirements'),
         '37 as 005+006 leave it',
         'INFO -- 007 adds, drops and renames nothing, so this must be unchanged after'

  -- ---- 6. DATA THAT COULD ABORT THE REWRITE ------------------------------
  union all
  select 400, 'rows in statement_requirements (RECORD THIS)',
         (select count(*)::text from public.statement_requirements),
         'record it',
         'INFO -- ALTER COLUMN TYPE rewrites the table and takes ACCESS EXCLUSIVE '
         || 'on it for the duration, so this count is the cost. Zero makes the '
         || 'rewrite instant. The postcheck asserts the same number afterwards.'

  union all
  select 401, 'rows in statement_requirement_sets (RECORD THIS)',
         (select count(*)::text from public.statement_requirement_sets),
         'record it',
         'INFO -- 007 does not touch this table at all; recorded so the postcheck '
         || 'can prove it'

  union all
  select 402, 'any page value outside 1..200 that would fail re-validation',
         (select count(*)::text from public.statement_requirements
           where (min_pages is not null and (min_pages < 1 or min_pages > 200))
              or (max_pages is not null and (max_pages < 1 or max_pages > 200))),
         '0',
         case when (select count(*) from public.statement_requirements
                     where (min_pages is not null and (min_pages < 1 or min_pages > 200))
                        or (max_pages is not null and (max_pages < 1 or max_pages > 200))) = 0
              then 'PASS -- statement_requirements_page_bounds will re-validate cleanly'
              else 'FAIL -- a row violates the page bound TODAY. The type change '
                   || 're-validates every CHECK, so the migration would abort. Fix the '
                   || 'row first; do not weaken the constraint to get past it.' end

  union all
  select 403, 'any min_pages > max_pages that would fail re-validation',
         (select count(*)::text from public.statement_requirements
           where min_pages is not null and max_pages is not null and min_pages > max_pages),
         '0',
         case when (select count(*) from public.statement_requirements
                     where min_pages is not null and max_pages is not null
                       and min_pages > max_pages) = 0
              then 'PASS' else 'FAIL -- the ordering CHECK would abort the migration' end

  union all
  select 404, 'fractional-value risk before the change (INFO)',
         'not possible while the column is integer',
         'n/a',
         'INFO -- no existing value can be fractional, so the rewrite cannot lose '
         || 'precision on data already stored. The precision risk runs the other '
         || 'way and AFTER the change: numeric(4,1) ROUNDS on insert, so 1.25 pages '
         || 'would be stored as 1.3 silently. That is defended in the importer, '
         || 'which maps page prose from a reviewed whitelist, not in the column.'

  -- ---- 7. STATE THE POSTCHECK WILL ASSERT IS UNCHANGED -------------------
  union all
  select 500, 'grants on the two catalog tables (RECORD THIS)',
         coalesce((select string_agg(table_name || '/' || grantee || '/' || privilege_type,
                                     '; ' order by table_name, grantee, privilege_type)
                     from information_schema.role_table_grants
                    where table_schema = 'public'
                      and table_name in ('statement_requirements',
                                         'statement_requirement_sets')
                      and grantee in ('anon', 'authenticated', 'service_role')),
                  'none'),
         'SELECT only, to anon and authenticated, on both tables',
         case when (select count(*) from information_schema.role_table_grants
                     where table_schema = 'public'
                       and table_name in ('statement_requirements',
                                          'statement_requirement_sets')
                       and grantee in ('anon', 'authenticated', 'service_role')
                       and privilege_type <> 'SELECT') = 0
              then 'PASS -- no write grant to any browser role. 007 touches no grant.'
              else 'FAIL -- a write grant exists that 005 did not create' end

  union all
  select 501, 'RLS enabled on both catalog tables (RECORD THIS)',
         (select string_agg(relname || '=' || relrowsecurity::text, '; ' order by relname)
            from pg_class
           where oid in ((select oid from reqs), (select oid from sets_t))),
         'both true',
         case when (select count(*) from pg_class
                     where oid in ((select oid from reqs), (select oid from sets_t))
                       and relrowsecurity) = 2
              then 'PASS -- 007 touches no RLS setting'
              else 'FAIL -- RLS is not enabled on both' end

  union all
  select 502, 'policies on the two catalog tables (RECORD THIS)',
         coalesce((select string_agg(tablename || '/' || policyname || '/' || cmd,
                                     '; ' order by tablename, policyname)
                     from pg_policies
                    where schemaname = 'public'
                      and tablename in ('statement_requirements',
                                        'statement_requirement_sets')), 'none'),
         'exactly two SELECT policies',
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and tablename in ('statement_requirements',
                                         'statement_requirement_sets')) = 2
              then 'PASS -- 007 touches no policy'
              else 'FAIL -- the policy set is not what 005 created' end

  -- ---- 8. NOT VISIBLE FROM SQL ------------------------------------------
  union all
  select 600, 'rollout flags (NOT VISIBLE FROM SQL)',
         'check the deployment environment',
         'STATEMENT_REQUIREMENTS unset, or anything but the exact string on',
         'INFO -- 007 is a schema widening and enables nothing. No flag should '
         || 'change as part of applying it. Confirm in Vercel, not here.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;
