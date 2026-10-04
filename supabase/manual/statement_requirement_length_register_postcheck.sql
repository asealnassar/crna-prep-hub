-- Statement requirement LENGTH REGISTER -- POST-MIGRATION VERIFICATION. READ-ONLY.
-- Run immediately after
-- supabase/migrations/20261002_006_statement_requirement_length_register.sql.
--
-- ONE STATEMENT, deliberately: the Supabase SQL editor shows only the LAST
-- result of a multi-statement script, so every check below is unioned into a
-- single query and the whole matrix is visible at once.
--
-- PASS CONDITION: every row reads PASS, except the rows marked INFO, which are
-- context rather than assertions. A single FAIL means the migration did not land
-- as designed -- do not set STATEMENT_REQUIREMENTS.
--
-- WHAT 006 IS FOR, in one paragraph, because the checks below only make sense
-- with it: a number is not a rule until the school says so. Verifying all 83
-- programmes showed schools publishing the same figure in five different
-- registers -- an enforced cap, a cap they enforce by not reading past it, a
-- stated length that is never called a maximum, an explicit suggestion, and a
-- figure whose standing cannot be determined. These columns record which, and
-- `unenforced_length` holds the school's own sentence for the case where no
-- bound may be stored at all. The constraints below are what stop those cases
-- collapsing back into one.
--
-- READ-ONLY, and therefore unable to prove the constraints FIRE. Every row below
-- establishes that a column or a CHECK exists with the definition written. That
-- a row carrying both a sentence and a bound is actually refused is behavioural:
-- see supabase/tests/statement_requirements_behaviour_test.sql.
--
-- Mutates nothing.

with
  reqs_t as (select to_regclass('public.statement_requirements') as oid),

new_cols(ord, col, typ, nullable) as (
  values
    (1, 'words_enforcement',          'text',    'YES'),
    (2, 'words_stated_as',            'text',    'YES'),
    (3, 'characters_enforcement',     'text',    'YES'),
    (4, 'characters_stated_as',       'text',    'YES'),
    (5, 'pages_enforcement',          'text',    'YES'),
    (6, 'pages_stated_as',            'text',    'YES'),
    (7, 'unenforced_length',          'text',    'YES'),
    (8, 'unenforced_length_verbatim', 'boolean', 'YES')
),

registers(ord, val) as (
  values (1, 'truncated'), (2, 'enforced'), (3, 'target'), (4, 'suggested'), (5, 'unknown')
),

checks as (

  -- ============================================ 1. THE EIGHT COLUMNS
  select 100 as step,
         'public.statement_requirements exists' as check_name,
         coalesce((select oid::text from reqs_t), 'absent') as actual,
         'present' as expected,
         case when (select oid from reqs_t) is null
              then 'FAIL -- 005 is missing, so 006 cannot have landed' else 'PASS' end as verdict

  union all
  select 100 + e.ord,
         format('column %s', e.col),
         coalesce(c.data_type, 'absent') || coalesce(' / nullable=' || c.is_nullable, ''),
         format('%s / nullable=%s', e.typ, e.nullable),
         case
           when c.column_name is null then 'FAIL -- column missing'
           when c.data_type <> e.typ then 'FAIL -- wrong type'
           when c.is_nullable <> e.nullable
             then 'FAIL -- NOT NULL would reject every row that does not record a register'
           else 'PASS'
         end
    from new_cols e
    left join information_schema.columns c
           on c.table_schema = 'public' and c.table_name = 'statement_requirements'
          and c.column_name = e.col

  -- NO DEFAULT ON ANY OF THEM. `default 'enforced'` would write the strict
  -- register onto every future row that forgot to state one, making "not
  -- recorded" indistinguishable from "checked, and it really is a cap". NULL
  -- keeps the two apart in the database; the strict reading is applied in one
  -- place in TypeScript (parseEnforcement), shared by both readers.
  union all
  select 200 + e.ord,
         format('%s has NO default', e.col),
         coalesce((select coalesce(column_default, 'null')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and column_name = e.col), 'absent'),
         'null',
         case when (select column_default from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements'
                       and column_name = e.col) is not null
              then 'FAIL -- a default erases the difference between "not recorded" and '
                   || '"recorded as this"'
              else 'PASS' end
    from new_cols e

  -- ============================================ 2. THE REGISTER VALUES
  --
  -- Five values and no others. An unrecognised register reaching the database
  -- would be read as the STRICT one by parseEnforcement -- safe, but not what
  -- whoever wrote it meant, so the database refuses it instead.
  union all
  select 300 + x.ord,
         format('constraint: %s is restricted to the five registers', x.col),
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from reqs_t) and c.conname = x.conname),
                  'absent'),
         'a CHECK listing truncated, enforced, target, suggested, unknown',
         case
           when not exists (select 1 from pg_constraint c
                             where c.conrelid = (select oid from reqs_t)
                               and c.conname = x.conname)
             then 'FAIL -- constraint missing; an arbitrary register could be stored'
           when (select bool_and(
                   (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from reqs_t) and c.conname = x.conname)
                   like '%''' || r.val || '''%')
                   from registers r)
             then 'PASS'
           else 'FAIL -- the constraint exists but omits one of the five registers'
         end
    from (values (1, 'words_enforcement',      'statement_requirements_words_enforcement_known'),
                 (2, 'characters_enforcement', 'statement_requirements_characters_enforcement_known'),
                 (3, 'pages_enforcement',      'statement_requirements_pages_enforcement_known'))
         as x(ord, col, conname)

  -- EVERY REGISTER CHECK MUST ALLOW NULL EXPLICITLY. A CHECK passes on TRUE
  -- **or NULL**, which has bitten this schema before; each condition is written
  -- so the NULL case is the one it intends to allow.
  union all
  select 310 + x.ord,
         format('%s CHECK allows NULL explicitly', x.col),
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from reqs_t) and c.conname = x.conname)
                   like '%' || x.col || ' IS NULL%'
              then 'present' else 'absent' end,
         format('%s IS NULL OR ...', x.col),
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from reqs_t) and c.conname = x.conname)
                   like '%' || x.col || ' IS NULL%'
              then 'PASS' else 'FAIL -- the NULL case is not explicitly allowed' end
    from (values (1, 'words_enforcement',      'statement_requirements_words_enforcement_known'),
                 (2, 'characters_enforcement', 'statement_requirements_characters_enforcement_known'),
                 (3, 'pages_enforcement',      'statement_requirements_pages_enforcement_known'))
         as x(ord, col, conname)

  -- ============================================ 3. A REGISTER NEEDS A LIMIT
  union all
  select 400 + x.ord,
         format('constraint %s', x.conname),
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from reqs_t)
                              and c.conname = x.conname) then 'present' else 'absent' end,
         'present',
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from reqs_t)
                              and c.conname = x.conname)
              then 'PASS' else format('FAIL -- %s', x.why) end
    from (values
      (1, 'statement_requirements_words_register_needs_limit',
          'a word register or quotation with no word bound describes nothing'),
      (2, 'statement_requirements_characters_register_needs_limit',
          'a character register with no character bound describes nothing'),
      (3, 'statement_requirements_pages_register_needs_limit',
          'a page register with no page bound and no spacing describes nothing'),
      (4, 'statement_requirements_truncation_needs_maximum',
          '"we read only the first N" is meaningless without N')
    ) as x(ord, conname, why)

  -- TRUNCATION REQUIRES A MAXIMUM IN THE SAME UNIT, not merely any bound. A
  -- minimum cannot be truncated at.
  union all
  select 410,
         'truncation CHECK names max_words, max_characters and max_pages',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from reqs_t)
                      and c.conname = 'statement_requirements_truncation_needs_maximum'),
                  'absent'),
         'all three maxima',
         case when (select bool_and(
                      (select pg_get_constraintdef(c.oid) from pg_constraint c
                        where c.conrelid = (select oid from reqs_t)
                          and c.conname = 'statement_requirements_truncation_needs_maximum')
                      like '%' || m.col || '%')
                      from (values ('max_words'), ('max_characters'), ('max_pages')) m(col))
              then 'PASS'
              else 'FAIL -- one unit could claim truncation with no maximum' end

  -- ============================================ 4. THE UNENFORCED LENGTH
  --
  -- THE OWNER-APPROVED ANSWER FOR AN UNCONFIRMED LIMIT (Option A): nine
  -- verified programmes publish a figure with no wording saying whether it is a
  -- maximum, a minimum or a suggestion. The decision is to show the school's
  -- sentence and enforce nothing -- so the sentence is stored and the typed
  -- bounds beside it stay NULL.
  union all
  select 500,
         'constraint: unenforced_length is bounded in length and refuses a blank',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from reqs_t)
                      and c.conname = 'statement_requirements_unenforced_length_text'), 'absent'),
         'unenforced_length IS NULL OR char_length(btrim(...)) BETWEEN 1 AND 2000',
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from reqs_t)
                       and c.conname = 'statement_requirements_unenforced_length_text')
                   like '%btrim%'
              then 'PASS' else 'FAIL -- an empty quotation could be stored and rendered' end

  -- THE CONTRADICTION THE DATABASE REFUSES. "We do not know whether this is a
  -- limit" and "the maximum is 1,000" cannot both be true of one document.
  union all
  select 501,
         'constraint: a row may NOT both show a length and bound it',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from reqs_t)
                      and c.conname = 'statement_requirements_unenforced_length_has_no_bound'),
                  'absent'),
         'unenforced_length IS NULL OR (every min_/max_ column IS NULL)',
         case
           when not exists (select 1 from pg_constraint c
                             where c.conrelid = (select oid from reqs_t)
                               and c.conname =
                                   'statement_requirements_unenforced_length_has_no_bound')
             then 'FAIL -- an ambiguous range could be published as a hard maximum'
           when (select bool_and(
                   (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from reqs_t)
                       and c.conname =
                           'statement_requirements_unenforced_length_has_no_bound')
                   like '%' || b.col || ' IS NULL%')
                   from (values ('min_words'), ('max_words'), ('min_characters'),
                                ('max_characters'), ('min_pages'), ('max_pages')) b(col))
             then 'PASS -- but the behavioural test must show it actually refuses'
           else 'FAIL -- the constraint exists but omits one of the six bound columns'
         end

  -- THE VERBATIM FLAG DECIDES WHETHER QUOTATION MARKS APPEAR, which makes it
  -- the whole meaning of the column beside it. A flag with no sentence claims
  -- "verbatim" about text the row does not carry.
  union all
  select 502,
         'constraint: the verbatim flag requires a sentence',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from reqs_t)
                      and c.conname =
                          'statement_requirements_unenforced_verbatim_needs_text'), 'absent'),
         'unenforced_length_verbatim IS NULL OR unenforced_length IS NOT NULL',
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from reqs_t)
                              and c.conname =
                                  'statement_requirements_unenforced_verbatim_needs_text')
              then 'PASS'
              else 'FAIL -- a row could claim verbatim about nothing' end

  union all
  select 503,
         'unenforced_length_verbatim has NO default (NULL reads as "not verbatim")',
         coalesce((select coalesce(column_default, 'null') from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and column_name = 'unenforced_length_verbatim'), 'absent'),
         'null',
         case when (select column_default from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements'
                       and column_name = 'unenforced_length_verbatim') is not null
              then 'FAIL -- defaulting this to true would present summaries as quotations'
              else 'PASS' end

  -- ============================================ 5. NOTHING ELSE MOVED
  union all
  select 600,
         'statement_requirements grants (COMPARE WITH THE PREFLIGHT)',
         coalesce((select string_agg(distinct grantee || '.' || privilege_type, ', '
                                     order by grantee || '.' || privilege_type)
                     from information_schema.role_table_grants
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and grantee not in ('postgres', 'supabase_admin')), 'none'),
         'identical to the preflight -- anon.SELECT, authenticated.SELECT',
         'INFO -- 006 issues no GRANT or REVOKE; any difference is a finding'

  union all
  select 601,
         'row level security still enabled',
         coalesce((select relrowsecurity::text from pg_class
                    where oid = (select oid from reqs_t)), 'unknown'),
         'true',
         case when (select relrowsecurity from pg_class
                     where oid = (select oid from reqs_t)) is true
              then 'PASS' else 'FAIL -- RLS was disabled' end

  union all
  select 602,
         'still exactly one policy, and it is SELECT',
         coalesce((select count(*)::text || ' / ' || coalesce(string_agg(cmd, ','), '')
                     from pg_policies
                    where schemaname = 'public' and tablename = 'statement_requirements'),
                  '0 / none'),
         '1 / SELECT',
         case when (select count(*) from pg_policies
                     where schemaname = 'public' and tablename = 'statement_requirements') = 1
               and (select cmd from pg_policies
                     where schemaname = 'public' and tablename = 'statement_requirements'
                     limit 1) = 'SELECT'
              then 'PASS' else 'FAIL -- the policy set changed' end

  union all
  select 603,
         'public.statement_drafts was not touched by 006',
         coalesce((select count(*)::text from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_drafts'), '?'),
         'identical to after 005',
         'INFO -- 006 alters only statement_requirements; compare the column count'

  union all
  select 604,
         'public.statement_prompts was not touched by 006',
         case when to_regclass('public.statement_prompts') is null then 'absent'
              else coalesce((select count(*)::text from public.statement_prompts), 'unreadable')
         end,
         'identical to before',
         'INFO -- 006 names this table in no statement'

  -- ============================================ 6. NO UNIT DERIVED FROM ANOTHER
  union all
  select 700,
         'no estimated/derived length column was added',
         coalesce((select string_agg(column_name, ', ') from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and (column_name like '%estimate%' or column_name like '%per_page%'
                           or column_name like '%equivalent%')), 'none'),
         'none',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'statement_requirements'
                              and (column_name like '%estimate%' or column_name like '%per_page%'
                                   or column_name like '%equivalent%'))
              then 'FAIL -- the register became a back door for the conversion'
              else 'PASS' end

  -- ============================================ 7. EMPTINESS AND WHAT IS NOT PROVEN
  union all
  select 800,
         'the table is still empty (INFO -- expected right after the migration)',
         coalesce((select count(*)::text from public.statement_requirements), 'unreadable'),
         '0',
         case when (select count(*) from public.statement_requirements) = 0
              then 'INFO -- as expected; 006 contains no INSERT and no backfill'
              else 'INFO -- rows present; this is not a fresh apply' end

  union all
  select 900,
         'the constraints FIRING (INFO -- NOT CHECKED HERE)',
         'not checked',
         'see supabase/tests/statement_requirements_behaviour_test.sql',
         'INFO -- every row above reads a constraint DEFINITION. That a row carrying '
         || 'both a sentence and a bound is actually refused, that an unverified set '
         || 'cannot be activated, and that an unknown register is rejected are '
         || 'behavioural and need the writing test.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;
