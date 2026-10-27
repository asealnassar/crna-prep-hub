-- Statement Studio V2 -- migration 008 POSTCHECK.
-- READ-ONLY. Run AFTER the migration. Mutates nothing.
--
-- Migration: supabase/migrations/20261006_008_statement_prompt_submission_requirement_fields.sql
-- Preflight: supabase/manual/statement_prompt_submission_fields_preflight.sql
--
-- ONE STATEMENT, for the reason the preflight gives.
--
-- WHAT THIS ESTABLISHES.
--   * The ten columns exist, are NULLABLE, and stated_max_pages is
--     numeric(4,1) -- not integer, which is the bug 20261005_007 fixed in the
--     canonical table and which must not reappear here.
--   * The three new CHECK constraints exist and the approval shape is the NEW,
--     weaker one: a catalog link implies approval, and approval alone implies
--     nothing. That is what lets "reviewed" and "published" be two states.
--   * The widened SELECT grant includes the ten readable columns and STILL
--     EXCLUDES review_note and reviewed_by.
--   * NOTHING ELSE MOVED: no write privilege appeared, RLS is still on with its
--     two policies, the row count is unchanged, and every existing row still
--     has NULL in every new column -- the migration adds capacity, not data.
--
-- COMPARE ord 20-23 AGAINST THE PREFLIGHT'S INFO ROWS.

with
  t as (select to_regclass('public.statement_prompt_submissions') as oid),
  cols as (
    select column_name, data_type, is_nullable, numeric_precision, numeric_scale
    from information_schema.columns
    where table_schema = 'public' and table_name = 'statement_prompt_submissions'
  ),
  expected(column_name) as (values
    ('document_label'), ('document_type_hint'), ('stated_min_words'),
    ('stated_max_characters'), ('stated_max_pages'), ('stated_pages_text'),
    ('formatting_instructions'), ('other_instructions'), ('submitter_note'),
    ('approved_requirement_id')),
  checks as (
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = (select oid from t) and contype = 'c'
  ),
  pol as (select policyname, cmd from pg_policies
          where schemaname = 'public' and tablename = 'statement_prompt_submissions'),
  priv as (
    select grantee, privilege_type
    from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'statement_prompt_submissions'
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  ),
  granted_cols as (
    select column_name from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'statement_prompt_submissions'
      and grantee = 'authenticated' and privilege_type = 'SELECT'
  )
select * from (
  select 1 as ord,
    case when (select count(*) from expected e
               join cols c on c.column_name = e.column_name) = 10
         then 'PASS' else 'FAIL' end as verdict,
    'all 10 columns exist' as check_name,
    (select count(*)::text from expected e join cols c on c.column_name = e.column_name)
      || ' of 10' as detail

  union all select 2,
    case when not exists (select 1 from expected e join cols c on c.column_name = e.column_name
                          where c.is_nullable <> 'YES')
         then 'PASS' else 'FAIL' end,
    'every new column is nullable',
    coalesce((select string_agg(c.column_name, ', ')
              from expected e join cols c on c.column_name = e.column_name
              where c.is_nullable <> 'YES'), 'all nullable')

  -- THE FRACTIONAL-PAGE PROBLEM MUST NOT REAPPEAR.
  union all select 3,
    case when (select data_type from cols where column_name = 'stated_max_pages') = 'numeric'
          and (select numeric_precision from cols where column_name = 'stated_max_pages') = 4
          and (select numeric_scale from cols where column_name = 'stated_max_pages') = 1
         then 'PASS' else 'FAIL' end,
    'stated_max_pages is numeric(4,1), never integer',
    coalesce((select data_type || '(' || coalesce(numeric_precision::text, '?') || ','
                     || coalesce(numeric_scale::text, '?') || ')'
              from cols where column_name = 'stated_max_pages'), 'MISSING')

  -- AND THE APPLICANT'S WORDING IS KEPT BESIDE IT.
  union all select 4,
    case when (select data_type from cols where column_name = 'stated_pages_text') = 'text'
         then 'PASS' else 'FAIL' end,
    'stated_pages_text is text, so unparseable wording survives',
    coalesce((select data_type from cols where column_name = 'stated_pages_text'), 'MISSING')

  union all select 5,
    case when (select count(*) from checks where conname in (
                 'statement_prompt_submissions_text_fields_length',
                 'statement_prompt_submissions_stated_ranges',
                 'statement_prompt_submissions_word_bounds_ordered')) = 3
         then 'PASS' else 'FAIL' end,
    'the 3 new CHECK constraints exist',
    (select count(*)::text from checks where conname in (
       'statement_prompt_submissions_text_fields_length',
       'statement_prompt_submissions_stated_ranges',
       'statement_prompt_submissions_word_bounds_ordered')) || ' of 3'

  -- ---- the headline: approval no longer implies publication ----
  union all select 6,
    case when (select def from checks
               where conname = 'statement_prompt_submissions_approval_shape')
              like '%approved_requirement_id%'
         then 'PASS' else 'FAIL' end,
    'approval_shape is the NEW one and knows approved_requirement_id',
    coalesce((select def from checks
              where conname = 'statement_prompt_submissions_approval_shape'), 'MISSING')

  union all select 7,
    case when (select def from checks
               where conname = 'statement_prompt_submissions_approval_shape')
              not like '%status = ''approved''::text AND approved_prompt_id IS NOT NULL%'
         then 'PASS' else 'FAIL' end,
    'an approved submission is no longer REQUIRED to have published',
    'the old both-directions predicate is gone'

  -- ---- the grant widened, and only in the safe direction ----
  union all select 8,
    case when (select count(*) from expected e
               join granted_cols g on g.column_name = e.column_name) = 10
         then 'PASS' else 'FAIL' end,
    'authenticated may SELECT all 10 new columns',
    (select count(*)::text from expected e join granted_cols g on g.column_name = e.column_name)
      || ' of 10'

  union all select 9,
    case when not exists (select 1 from granted_cols
                          where column_name in ('review_note', 'reviewed_by'))
         then 'PASS' else 'FAIL' end,
    'review_note and reviewed_by are STILL not granted',
    (select coalesce(string_agg(column_name, ', '), 'neither is granted')
     from granted_cols where column_name in ('review_note', 'reviewed_by'))

  -- ---- nothing else moved ----
  union all select 10,
    case when (select count(*) from priv
               where privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) = 0
         then 'PASS' else 'FAIL' end,
    'still no INSERT/UPDATE/DELETE for any browser role',
    (select coalesce(string_agg(grantee || ':' || privilege_type, ', '), 'none') from priv
     where privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))

  union all select 11,
    case when (select relrowsecurity from pg_class where oid = (select oid from t))
          and (select count(*) from pol) = 2
         then 'PASS' else 'FAIL' end,
    'RLS still enabled with its two policies',
    (select coalesce(string_agg(policyname, '; ' order by policyname), 'NONE') from pol)

  -- THE MIGRATION ADDS CAPACITY, NOT DATA.
  union all select 12,
    case when (select count(*) from public.statement_prompt_submissions
               where document_label is not null or document_type_hint is not null
                  or stated_min_words is not null or stated_max_characters is not null
                  or stated_max_pages is not null or stated_pages_text is not null
                  or formatting_instructions is not null or other_instructions is not null
                  or submitter_note is not null or approved_requirement_id is not null) = 0
         then 'PASS' else 'INFO' end,
    'no existing row gained a value (expected right after the migration)',
    (select count(*)::text from public.statement_prompt_submissions
     where document_label is not null or document_type_hint is not null
        or stated_min_words is not null or stated_max_characters is not null
        or stated_max_pages is not null or stated_pages_text is not null
        or formatting_instructions is not null or other_instructions is not null
        or submitter_note is not null or approved_requirement_id is not null)
      || ' rows carry new values'

  -- ---- compare these against the preflight ----
  union all select 20, 'INFO', 'authenticated SELECT column count (was 14, expect 24)',
    (select count(*)::text from granted_cols)
  union all select 21, 'INFO', 'row count (must equal the preflight)',
    (select count(*)::text from public.statement_prompt_submissions)
  union all select 22, 'INFO', 'CHECK constraint count (preflight + 3)',
    (select count(*)::text from checks)
  union all select 23, 'INFO', 'submissions by status (must equal the preflight)',
    coalesce((select string_agg(status || '=' || n::text, ', ' order by status)
              from (select status, count(*) as n
                    from public.statement_prompt_submissions group by status) s), 'no rows')
) rows
order by ord;
