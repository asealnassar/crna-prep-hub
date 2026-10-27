-- Statement Studio V2 -- migration 008 PREFLIGHT.
-- READ-ONLY. Run BEFORE the migration. Mutates nothing: every reference below
-- is a catalog read or a count.
--
-- Migration: supabase/migrations/20261006_008_statement_prompt_submission_requirement_fields.sql
--
-- ONE STATEMENT, deliberately. The Supabase SQL editor displays only the LAST
-- result of a multi-statement script, so a preflight split into several SELECTs
-- shows one answer and hides the rest.
--
-- WHAT 008 DOES, AND THEREFORE WHAT THIS HAS TO ESTABLISH FIRST.
--
--   * It ADDS TEN NULLABLE COLUMNS. `add column ... if not exists` with no
--     default and no NOT NULL takes ACCESS EXCLUSIVE only briefly and does not
--     rewrite the table, so the row count below is informational rather than a
--     cost -- but it is recorded so the postcheck can assert no row moved.
--   * It ADDS THREE CHECK CONSTRAINTS on those new columns. Every existing row
--     has NULL in all of them, so validation cannot fail -- unless 008 has
--     already run and rows carry values, which the column check below detects.
--   * It REPLACES statement_prompt_submissions_approval_shape. The old
--     constraint requires an approved row to carry approved_prompt_id; the new
--     one requires only that a catalog link imply approval. VALIDATION RUNS
--     AGAINST EVERY EXISTING ROW, and the new predicate is strictly weaker than
--     the old one, so any row that satisfies the current constraint satisfies
--     the replacement. The count below proves there is nothing that could fail.
--   * It WIDENS a column-level SELECT grant for `authenticated`. GRANT is
--     additive, so the current grant list is recorded to be compared after.
--
-- WHAT IT MUST NOT HAVE DONE, and what this checks is still true:
--   * no INSERT, UPDATE or DELETE privilege for anon, authenticated or
--     service_role on this table;
--   * RLS still enabled, with exactly the two policies 20261002_000 created;
--   * review_note and reviewed_by still ungranted.
--
-- READ THE VERDICT COLUMN. Any FAIL means do not apply 008 yet. INFO rows are
-- state to RECORD so the postcheck has a before to compare against.

with
  t as (select to_regclass('public.statement_prompt_submissions') as oid),
  cols as (
    select column_name, data_type, is_nullable, numeric_precision, numeric_scale
    from information_schema.columns
    where table_schema = 'public' and table_name = 'statement_prompt_submissions'
  ),
  new_cols as (
    select count(*) as n from cols where column_name in (
      'document_label', 'document_type_hint', 'stated_min_words',
      'stated_max_characters', 'stated_max_pages', 'stated_pages_text',
      'formatting_instructions', 'other_instructions', 'submitter_note',
      'approved_requirement_id')
  ),
  checks as (
    select conname from pg_constraint
    where conrelid = (select oid from t) and contype = 'c'
  ),
  pol as (select policyname, cmd from pg_policies
          where schemaname = 'public' and tablename = 'statement_prompt_submissions'),
  priv as (
    select grantee, privilege_type, count(*) filter (where column_name is not null) as cols
    from (
      select grantee, privilege_type, column_name
      from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'statement_prompt_submissions'
      union all
      select grantee, privilege_type, null
      from information_schema.table_privileges
      where table_schema = 'public' and table_name = 'statement_prompt_submissions'
    ) p
    where grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    group by grantee, privilege_type
  ),
  granted_cols as (
    select column_name from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'statement_prompt_submissions'
      and grantee = 'authenticated' and privilege_type = 'SELECT'
  )
select * from (
  -- ---- the table has to exist, or 008 is not the next thing to run ----
  select 1 as ord,
    case when (select oid from t) is null then 'FAIL' else 'PASS' end as verdict,
    'table public.statement_prompt_submissions exists' as check_name,
    coalesce((select oid from t)::text, 'MISSING') as detail

  -- ---- 008 must not already be applied ----
  union all select 2,
    case when (select n from new_cols) = 0 then 'PASS'
         when (select n from new_cols) = 10 then 'FAIL'
         else 'FAIL' end,
    'none of the 10 new columns exists yet',
    (select n from new_cols)::text || ' of 10 present'
      || case when (select n from new_cols) between 1 and 9
              then ' -- PARTIALLY APPLIED: inspect before re-running' else '' end

  -- ---- the constraint 008 replaces must be the one it expects ----
  union all select 3,
    case when exists (select 1 from checks
                      where conname = 'statement_prompt_submissions_approval_shape')
         then 'PASS' else 'FAIL' end,
    'statement_prompt_submissions_approval_shape is present to be replaced',
    coalesce((select pg_get_constraintdef(oid) from pg_constraint
              where conrelid = (select oid from t)
                and conname = 'statement_prompt_submissions_approval_shape'), 'MISSING')

  -- ---- nothing can fail the weaker replacement ----
  union all select 4,
    case when (select count(*) from public.statement_prompt_submissions
               where approved_prompt_id is not null and status <> 'approved') = 0
         then 'PASS' else 'FAIL' end,
    'no row carries a catalog link without being approved',
    (select count(*)::text from public.statement_prompt_submissions
     where approved_prompt_id is not null and status <> 'approved') || ' offending rows'

  -- ---- RLS and its two policies, unchanged by 008 ----
  union all select 5,
    case when (select relrowsecurity from pg_class where oid = (select oid from t))
         then 'PASS' else 'FAIL' end,
    'row level security is enabled',
    (select relrowsecurity::text from pg_class where oid = (select oid from t))

  union all select 6,
    case when (select count(*) from pol) = 2 then 'PASS' else 'FAIL' end,
    'exactly the two policies 20261002_000 created',
    (select coalesce(string_agg(policyname || ' [' || cmd || ']', '; ' order by policyname),
                     'NONE') from pol)

  -- ---- no write privilege exists, and 008 adds none ----
  union all select 7,
    case when (select count(*) from priv
               where privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) = 0
         then 'PASS' else 'FAIL' end,
    'no INSERT/UPDATE/DELETE privilege for any browser role',
    (select coalesce(string_agg(grantee || ':' || privilege_type, ', '), 'none') from priv
     where privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))

  -- ---- the private columns are private BEFORE, so "still" means something ----
  union all select 8,
    case when not exists (select 1 from granted_cols
                          where column_name in ('review_note', 'reviewed_by'))
         then 'PASS' else 'FAIL' end,
    'review_note and reviewed_by are NOT granted to authenticated',
    (select coalesce(string_agg(column_name, ', '), 'neither is granted')
     from granted_cols where column_name in ('review_note', 'reviewed_by'))

  -- ---- state to record, for the postcheck to compare ----
  union all select 9, 'INFO',
    'authenticated SELECT column count (record this)',
    (select count(*)::text from granted_cols)

  union all select 10, 'INFO',
    'authenticated SELECT columns (record this)',
    (select coalesce(string_agg(column_name, ', ' order by column_name), 'NONE')
     from granted_cols)

  union all select 11, 'INFO',
    'row count (record this; 008 must not change it)',
    (select count(*)::text from public.statement_prompt_submissions)

  union all select 12, 'INFO',
    'CHECK constraint count (record this; 008 adds 3 and replaces 1)',
    (select count(*)::text from checks)

  union all select 13, 'INFO',
    'submissions by status (record this; 008 must not change it)',
    coalesce((select string_agg(status || '=' || n::text, ', ' order by status)
              from (select status, count(*) as n
                    from public.statement_prompt_submissions group by status) s), 'no rows')
) rows
order by ord;
