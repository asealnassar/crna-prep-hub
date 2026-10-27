-- Statement Studio V2 -- applicant-submitted prompts: SECURITY POSTCHECK.
--
-- READ-ONLY. Every statement below is a SELECT over system catalogs. It writes
-- nothing, locks nothing and changes nothing, so it is safe against any
-- database including production.
--
-- WHAT THIS IS FOR. The Node test suite asserts what the migration FILES say.
-- Only a database can say what is actually in force -- whether a GRANT landed,
-- whether a policy is enabled, whether a function really is definer. Run this
-- after applying 20261002_000..003, ideally first against an isolated database.
--
-- ONE QUERY, DELIBERATELY. The Supabase SQL editor shows only the last
-- statement's result, so every check is a row of one union and the whole report
-- arrives together. Read the `ok` column: every row must be true.

with checks as (

  -- ========================================================================
  -- 1. THE SUBMISSIONS TABLE IS WRITE-CLOSED TO BROWSERS
  -- ========================================================================
  -- The bypass this feature was hardened against: with any INSERT privilege,
  -- an applicant can POST straight to PostgREST and skip the rate limit, the
  -- school check and the atomic pairing with a draft.
  select 'no browser INSERT on submissions' as check,
         not exists (
           select 1 from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name = 'statement_prompt_submissions'
             and privilege_type = 'INSERT'
             and grantee in ('anon', 'authenticated', 'PUBLIC')
         ) as ok

  union all
  select 'no browser UPDATE on submissions',
         not exists (
           select 1 from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name = 'statement_prompt_submissions'
             and privilege_type = 'UPDATE'
             and grantee in ('anon', 'authenticated', 'PUBLIC')
         )

  union all
  select 'no browser DELETE on submissions',
         not exists (
           select 1 from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name = 'statement_prompt_submissions'
             and privilege_type = 'DELETE'
             and grantee in ('anon', 'authenticated', 'PUBLIC')
         )

  union all
  -- anon has no business reading somebody's pending submission at all.
  select 'anon cannot read submissions',
         not exists (
           select 1 from information_schema.role_column_grants
           where table_schema = 'public'
             and table_name = 'statement_prompt_submissions'
             and grantee = 'anon'
         )

  -- ========================================================================
  -- 2. PRIVATE REVIEW DATA IS PRIVATE AT THE COLUMN LEVEL
  -- ========================================================================
  -- RLS filters ROWS, never columns. Without a column-scoped grant a submitter
  -- could read an administrator's note about them straight from PostgREST.
  union all
  select 'review_note not readable by applicants',
         not exists (
           select 1 from information_schema.role_column_grants
           where table_schema = 'public'
             and table_name = 'statement_prompt_submissions'
             and column_name = 'review_note'
             and grantee in ('anon', 'authenticated', 'PUBLIC')
         )

  union all
  select 'reviewed_by not readable by applicants',
         not exists (
           select 1 from information_schema.role_column_grants
           where table_schema = 'public'
             and table_name = 'statement_prompt_submissions'
             and column_name = 'reviewed_by'
             and grantee in ('anon', 'authenticated', 'PUBLIC')
         )

  union all
  select 'submitters can still read their own wording',
         exists (
           select 1 from information_schema.role_column_grants
           where table_schema = 'public'
             and table_name = 'statement_prompt_submissions'
             and column_name = 'prompt_text'
             and grantee = 'authenticated'
             and privilege_type = 'SELECT'
         )

  -- ========================================================================
  -- 3. ROW LEVEL SECURITY IS ON AND SCOPED TO THE OWNER
  -- ========================================================================
  union all
  select 'RLS enabled on submissions',
         coalesce((select relrowsecurity from pg_class
                   where oid = 'public.statement_prompt_submissions'::regclass), false)

  union all
  select 'submissions select policy is owner-scoped',
         exists (
           select 1 from pg_policies
           where schemaname = 'public'
             and tablename = 'statement_prompt_submissions'
             and cmd = 'SELECT'
             and qual like '%auth.uid()%'
         )

  union all
  -- No policy for a command is a denial, and there must be none for these.
  select 'no UPDATE or DELETE policy for applicants',
         not exists (
           select 1 from pg_policies
           where schemaname = 'public'
             and tablename = 'statement_prompt_submissions'
             and cmd in ('UPDATE', 'DELETE')
             and 'authenticated' = any(roles)
         )

  -- ========================================================================
  -- 4. THE CATALOG IS STILL WRITE-CLOSED TO EVERYONE
  -- ========================================================================
  -- Including service_role. Approval writes through a definer function, not a
  -- table privilege, and that must still be true after this feature.
  union all
  select 'catalog has no write grant for ANY role',
         not exists (
           select 1 from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name = 'statement_prompts'
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
             and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
         )

  union all
  select 'catalog select policy still active-only',
         exists (
           select 1 from pg_policies
           where schemaname = 'public'
             and tablename = 'statement_prompts'
             and cmd = 'SELECT'
             and qual like '%is_active%'
         )

  -- ========================================================================
  -- 5. FUNCTION SECURITY MODES AND SEARCH PATHS
  -- ========================================================================
  union all
  select 'create RPC is SECURITY DEFINER',
         coalesce((select p.prosecdef from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname = 'create_statement_draft_with_prompt_submission'), false)

  union all
  select 'every new function pins search_path',
         (select count(*) = 3 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('create_statement_draft_with_prompt_submission',
                              'withdraw_statement_prompt_submission',
                              'decide_statement_prompt_submission')
            and p.proconfig::text like '%search_path=%')

  -- ========================================================================
  -- 6. EXECUTE PERIMETERS
  -- ========================================================================
  -- The catalog writer must be unreachable from any browser role.
  union all
  select 'decide RPC not executable by anon',
         not has_function_privilege('anon',
           'public.decide_statement_prompt_submission(uuid, text, uuid, text, text, uuid, uuid, boolean, text)',
           'EXECUTE')

  union all
  select 'decide RPC not executable by authenticated',
         not has_function_privilege('authenticated',
           'public.decide_statement_prompt_submission(uuid, text, uuid, text, text, uuid, uuid, boolean, text)',
           'EXECUTE')

  union all
  select 'decide RPC executable by service_role',
         has_function_privilege('service_role',
           'public.decide_statement_prompt_submission(uuid, text, uuid, text, text, uuid, uuid, boolean, text)',
           'EXECUTE')

  union all
  select 'create RPC not executable by anon',
         not has_function_privilege('anon',
           'public.create_statement_draft_with_prompt_submission(text, text, uuid, text, integer, text, text)',
           'EXECUTE')

  union all
  select 'create RPC executable by authenticated',
         has_function_privilege('authenticated',
           'public.create_statement_draft_with_prompt_submission(text, text, uuid, text, integer, text, text)',
           'EXECUTE')

  -- ========================================================================
  -- 7. THE PROVENANCE CONSTRAINT
  -- ========================================================================
  -- The one guarantee that holds whoever writes the row, through whatever
  -- client: a draft cannot claim a catalog prompt and a pasted one at once.
  union all
  select 'drafts cannot hold both prompt sources',
         exists (
           select 1 from pg_constraint
           where conrelid = 'public.statement_drafts'::regclass
             and conname = 'statement_drafts_prompt_source_exclusive'
         )

  union all
  select 'a user-provided prompt must carry its wording',
         exists (
           select 1 from pg_constraint
           where conrelid = 'public.statement_drafts'::regclass
             and conname = 'statement_drafts_submission_has_text'
         )

  union all
  select 'a submission fingerprint must be a sha256 digest',
         exists (
           select 1 from pg_constraint
           where conrelid = 'public.statement_prompt_submissions'::regclass
             and conname = 'statement_prompt_submissions_fingerprint_shape'
         )
)
select check,
       ok,
       case when ok then 'pass' else 'FAIL' end as result
from checks
order by ok, check;
