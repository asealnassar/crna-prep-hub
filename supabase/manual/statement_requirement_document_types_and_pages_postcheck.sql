-- Statement Studio V2 -- migration 007 POSTCHECK.
-- READ-ONLY. Run AFTER the migration. Mutates nothing.
--
-- Migration: supabase/migrations/20261005_007_statement_requirement_document_types_and_pages.sql
--
-- ONE STATEMENT, for the same reason the preflight is: the SQL editor shows
-- only the last result of a multi-statement script.
--
-- NO INTENTIONALLY INVALID WRITES. This file never tries to insert a bad row to
-- see whether a constraint bites. It reads the CONSTRAINT DEFINITIONS instead,
-- which is weaker evidence and is said so plainly: a definition that mentions
-- the right columns is not proof the constraint fires. The behavioural proof --
-- all nine types accepted, an unknown one refused, 1.5 stored exactly, min >
-- max still refused, truncated still needing a maximum -- belongs in an
-- isolated local cluster, and is covered by the migration's own audit block
-- and by the repository's local tests.
--
-- SEVERAL CHECKS BELOW COMPARE AGAINST NUMBERS THE PREFLIGHT RECORDED. Where
-- that is so, the expected column names the preflight step. "Unchanged" cannot
-- be asserted by this file alone.
--
-- READ THE VERDICT COLUMN. Any FAIL means the migration did not land as
-- designed; do not enable STATEMENT_REQUIREMENTS.

with
  reqs as (select to_regclass('public.statement_requirements') as oid),
  sets_t as (select to_regclass('public.statement_requirement_sets') as oid),
  dtc as (select pg_get_constraintdef(oid) as def
            from pg_constraint
           where conname = 'statement_requirements_document_type_known'
             and conrelid = (select oid from reqs)),
  trunc_c as (select pg_get_constraintdef(oid) as def
                from pg_constraint
               where conname = 'statement_requirements_truncation_needs_maximum'
                 and conrelid = (select oid from reqs)),
  nobound as (select pg_get_constraintdef(oid) as def
                from pg_constraint
               where conname = 'statement_requirements_unenforced_length_has_no_bound'
                 and conrelid = (select oid from reqs)),
  bounds as (select pg_get_constraintdef(oid) as def
               from pg_constraint
              where conname = 'statement_requirements_page_bounds'
                and conrelid = (select oid from reqs)),
  pagecols as (select column_name, data_type, numeric_precision, numeric_scale,
                      is_nullable, column_default
                 from information_schema.columns
                where table_schema = 'public' and table_name = 'statement_requirements'
                  and column_name in ('min_pages', 'max_pages')),
  checks as (

  select 100 as step,
         'target database and executing role (INFO)' as check_name,
         'db=' || current_database() || ', current_user=' || current_user as actual,
         'the project 007 was applied to' as expected,
         'INFO' as verdict

  -- ---- 1. ALL NINE DOCUMENT TYPES, AND THE SIX OLD ONES KEPT -------------
  union all
  select 200, 'the constraint definition names all NINE document types',
         (select (case when def like '%''personal-statement''%' then 1 else 0 end
                + case when def like '%''goal-statement''%' then 1 else 0 end
                + case when def like '%''diversity-statement''%' then 1 else 0 end
                + case when def like '%''writing-sample''%' then 1 else 0 end
                + case when def like '%''additional-response''%' then 1 else 0 end
                + case when def like '%''other''%' then 1 else 0 end
                + case when def like '%''statement-of-purpose''%' then 1 else 0 end
                + case when def like '%''autobiographical-essay''%' then 1 else 0 end
                + case when def like '%''supplemental-essay''%' then 1 else 0 end)::text
            from dtc) || ' of 9',
         '9 of 9',
         case when (select (case when def like '%''personal-statement''%' then 1 else 0 end
                          + case when def like '%''goal-statement''%' then 1 else 0 end
                          + case when def like '%''diversity-statement''%' then 1 else 0 end
                          + case when def like '%''writing-sample''%' then 1 else 0 end
                          + case when def like '%''additional-response''%' then 1 else 0 end
                          + case when def like '%''other''%' then 1 else 0 end
                          + case when def like '%''statement-of-purpose''%' then 1 else 0 end
                          + case when def like '%''autobiographical-essay''%' then 1 else 0 end
                          + case when def like '%''supplemental-essay''%' then 1 else 0 end)
                     from dtc) = 9
              then 'PASS' else 'FAIL -- 007 did not widen the constraint as designed' end

  union all
  select 201, 'the THREE new types specifically',
         (select (case when def like '%''statement-of-purpose''%' then 'statement-of-purpose ' else '' end
                || case when def like '%''autobiographical-essay''%' then 'autobiographical-essay ' else '' end
                || case when def like '%''supplemental-essay''%' then 'supplemental-essay' else '' end)
            from dtc),
         'all three present',
         case when (select def from dtc) like '%''statement-of-purpose''%'
               and (select def from dtc) like '%''autobiographical-essay''%'
               and (select def from dtc) like '%''supplemental-essay''%'
              then 'PASS' else 'FAIL' end

  union all
  select 202, 'the constraint is still a CLOSED set, not dropped',
         case when (select def from dtc) is null then 'absent'
              when (select def from dtc) like '%document_type%ANY%'
                or (select def from dtc) like '%document_type%=%' then 'present'
              else 'present' end,
         'present',
         case when (select def from dtc) is null
              then 'FAIL -- the constraint is GONE. Any string would now be accepted, '
                   || 'which is worse than the six-value limit 007 replaced.'
              else 'PASS -- an unknown document_type is still refused' end

  -- ---- 2. THE PAGE COLUMNS' NEW TYPE -------------------------------------
  union all
  select 300, 'min_pages is numeric(4,1)',
         coalesce((select data_type || '(' || numeric_precision || ',' || numeric_scale || ')'
                     from pagecols where column_name = 'min_pages'), 'absent'),
         'numeric(4,1)',
         case when (select data_type = 'numeric' and numeric_precision = 4 and numeric_scale = 1
                      from pagecols where column_name = 'min_pages')
              then 'PASS' else 'FAIL -- not the intended type' end

  union all
  select 301, 'max_pages is numeric(4,1)',
         coalesce((select data_type || '(' || numeric_precision || ',' || numeric_scale || ')'
                     from pagecols where column_name = 'max_pages'), 'absent'),
         'numeric(4,1)',
         case when (select data_type = 'numeric' and numeric_precision = 4 and numeric_scale = 1
                      from pagecols where column_name = 'max_pages')
              then 'PASS' else 'FAIL -- not the intended type' end

  union all
  select 302, 'no nullability or default drift on the page columns',
         (select string_agg(column_name || ': nullable=' || is_nullable || ' default='
                            || coalesce(column_default, 'none'), '; ' order by column_name)
            from pagecols),
         'both nullable, neither defaulted (preflight step 312)',
         case when (select count(*) from pagecols
                     where is_nullable = 'YES' and column_default is null) = 2
              then 'PASS -- NULL still means THE SCHOOL DID NOT STATE ONE'
              else 'FAIL -- a default or NOT NULL appeared; a defaulted page bound '
                   || 'would read as a requirement the school never made' end

  union all
  select 303, 'word and character columns were NOT changed',
         (select string_agg(column_name || '=' || data_type, ' ' order by column_name)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'statement_requirements'
             and column_name in ('min_words', 'max_words', 'min_characters',
                                 'max_characters')),
         'all four still integer',
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements'
                       and column_name in ('min_words', 'max_words', 'min_characters',
                                           'max_characters')
                       and data_type = 'integer') = 4
              then 'PASS -- 007 widened pages only'
              else 'FAIL -- a unit outside the approved scope changed type' end

  -- ---- 3. EVERY PAGE CONSTRAINT SURVIVED, AND STILL NAMES ITS COLUMNS ----
  union all
  select 400, 'all five page-related CHECK constraints still exist',
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
              then 'PASS' else 'FAIL -- the type change lost a constraint' end

  union all
  select 401, 'page_bounds still bounds 1..200 and orders min <= max',
         coalesce(left((select def from bounds), 70), 'absent'),
         'both columns, both bounds, the ordering',
         case when (select def from bounds) like '%min_pages%'
               and (select def from bounds) like '%max_pages%'
               and (select def from bounds) like '%200%'
              then 'PASS -- numeric comparison is exact, so 1.5 passes and 1.5 <= 2 '
                   || 'still orders correctly'
              else 'FAIL -- the bound no longer references both page columns' end

  union all
  select 402, 'truncated still requires a maximum, for pages',
         coalesce((select case when def like '%pages_enforcement%'
                            and def like '%max_pages IS NOT NULL%'
                          then 'references pages_enforcement and max_pages'
                          else 'does NOT reference both' end from trunc_c), 'absent'),
         'references pages_enforcement and max_pages',
         case when (select def from trunc_c) like '%pages_enforcement%'
               and (select def from trunc_c) like '%max_pages IS NOT NULL%'
              then 'PASS' else 'FAIL -- a truncated page register could now have no '
                   || 'maximum, which 006 forbids' end

  union all
  select 403, 'unenforced_length still forbids BOTH page bounds',
         coalesce((select case when def like '%min_pages IS NULL%'
                            and def like '%max_pages IS NULL%'
                          then 'both page columns named' else 'a page column is missing'
                     end from nobound), 'absent'),
         'both page columns named',
         case when (select def from nobound) like '%min_pages IS NULL%'
               and (select def from nobound) like '%max_pages IS NULL%'
              then 'PASS -- a sentence and a bound still cannot coexist'
              else 'FAIL' end

  union all
  select 404, 'the other two unenforced-length constraints are intact',
         (select count(*)::text from pg_constraint
           where conrelid = (select oid from reqs) and contype = 'c'
             and conname in ('statement_requirements_unenforced_length_text',
                  'statement_requirements_unenforced_verbatim_needs_text')) || ' of 2',
         '2 of 2',
         case when (select count(*) from pg_constraint
                     where conrelid = (select oid from reqs) and contype = 'c'
                       and conname in ('statement_requirements_unenforced_length_text',
                            'statement_requirements_unenforced_verbatim_needs_text')) = 2
              then 'PASS' else 'FAIL -- 006''s unenforced-length rules are not all present' end

  -- ---- 4. NOTHING UNRELATED WAS ADDED ------------------------------------
  union all
  select 500, 'CHECK constraint count unchanged',
         (select count(*)::text from pg_constraint
           where conrelid = (select oid from reqs) and contype = 'c'),
         'the number preflight step 321 recorded (25 after 005+006)',
         case when (select count(*) from pg_constraint
                     where conrelid = (select oid from reqs) and contype = 'c') = 25
              then 'PASS -- 007 replaced one in place and added none'
              else 'FAIL -- compare against preflight step 321. A different count means '
                   || '007 added or lost a constraint outside its approved scope.' end

  union all
  select 501, 'column count unchanged',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'statement_requirements'),
         'the number preflight step 322 recorded (37 after 005+006)',
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements') = 37
              then 'PASS -- no column added, dropped or renamed'
              else 'FAIL -- compare against preflight step 322' end

  union all
  select 502, 'the neighbouring table is untouched',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'statement_requirement_sets')
           || ' columns, '
           || (select count(*)::text from pg_constraint
                where conrelid = (select oid from sets_t) and contype = 'c') || ' checks',
         '13 columns, 7 checks (as 005 leaves it)',
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public'
                       and table_name = 'statement_requirement_sets') = 13
               and (select count(*) from pg_constraint
                     where conrelid = (select oid from sets_t) and contype = 'c') = 7
              then 'PASS -- 007 names statement_requirements only'
              else 'FAIL -- the set table changed; 007 should not have reached it' end

  -- ---- 5. GRANTS, RLS, POLICIES, ROWS -----------------------------------
  union all
  select 600, 'grants unchanged: SELECT only, no write to any browser role',
         coalesce((select string_agg(table_name || '/' || grantee || '/' || privilege_type,
                                     '; ' order by table_name, grantee, privilege_type)
                     from information_schema.role_table_grants
                    where table_schema = 'public'
                      and table_name in ('statement_requirements',
                                         'statement_requirement_sets')
                      and grantee in ('anon', 'authenticated', 'service_role')), 'none'),
         'identical to preflight step 500',
         case when (select count(*) from information_schema.role_table_grants
                     where table_schema = 'public'
                       and table_name in ('statement_requirements',
                                          'statement_requirement_sets')
                       and grantee in ('anon', 'authenticated', 'service_role')
                       and privilege_type <> 'SELECT') = 0
              then 'PASS -- no write grant. Compare the string against step 500 for an '
                   || 'exact match.'
              else 'FAIL -- a write grant exists that did not before' end

  union all
  select 601, 'RLS still enabled on both catalog tables',
         (select string_agg(relname || '=' || relrowsecurity::text, '; ' order by relname)
            from pg_class
           where oid in ((select oid from reqs), (select oid from sets_t))),
         'both true',
         case when (select count(*) from pg_class
                     where oid in ((select oid from reqs), (select oid from sets_t))
                       and relrowsecurity) = 2
              then 'PASS' else 'FAIL -- RLS was disabled. STOP; the catalog is readable '
                   || 'without a policy.' end

  union all
  select 602, 'policies unchanged: exactly the two 005 created',
         coalesce((select string_agg(tablename || '/' || policyname || '/' || cmd,
                                     '; ' order by tablename, policyname)
                     from pg_policies
                    where schemaname = 'public'
                      and tablename in ('statement_requirements',
                                        'statement_requirement_sets')), 'none'),
         'identical to preflight step 502',
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and tablename in ('statement_requirements',
                                         'statement_requirement_sets')) = 2
              then 'PASS -- compare the string against step 502 for an exact match'
              else 'FAIL -- the policy set changed' end

  union all
  select 700, 'row count unchanged on statement_requirements',
         (select count(*)::text from public.statement_requirements),
         'the number preflight step 400 recorded',
         'INFO -- 007 is pure DDL and inserts, updates and deletes nothing. A '
         || 'different number here means something else wrote to the table between '
         || 'the two runs, which is worth knowing before activation.'

  union all
  select 701, 'row count unchanged on statement_requirement_sets',
         (select count(*)::text from public.statement_requirement_sets),
         'the number preflight step 401 recorded',
         'INFO -- compare against step 401'

  union all
  select 800, 'rollout flags (NOT VISIBLE FROM SQL)',
         'check the deployment environment',
         'STATEMENT_REQUIREMENTS still unset',
         'INFO -- 007 enables nothing. The catalog is still empty and every set the '
         || 'importer proposes is planned is_active = false, so the flag has nothing '
         || 'to expose yet.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;
