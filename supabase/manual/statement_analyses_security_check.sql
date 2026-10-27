-- Statement analyses (analysis cache) -- SECURITY CHECK.
-- Run immediately after supabase/migrations/20261002_004_statement_analyses.sql.
--
-- THIS FILE WAS REFERENCED BY THAT MIGRATION BEFORE IT EXISTED. The activation
-- sequence at the foot of 004 says "run this and read every row's ok column";
-- an audit found the file missing. This is it.
--
-- THREE SECTIONS, AND THEY PROVE DIFFERENT THINGS. Read this before running
-- anything, because the difference is the whole point of splitting them:
--
--   SECTION A  READ-ONLY SCHEMA INSPECTION. One statement, mutates nothing,
--              safe on production at any time. It proves that the objects,
--              constraints, indexes, policies and GRANTS EXIST AS WRITTEN.
--
--              IT DOES NOT PROVE THAT ACCESS IS ACTUALLY RESTRICTED AT
--              RUNTIME. has_table_privilege() reports a grant; it does not
--              execute a query as `anon` with no JWT, and it says nothing at
--              all about whether an RLS policy's predicate evaluates the way it
--              reads. A catalog row saying "RLS enabled, one select policy" is
--              consistent with a policy that returns every row. Section A is
--              necessary and it is not sufficient, and no row it emits should
--              ever be quoted as evidence that cross-user access is denied.
--
--   SECTION B  TESTS NEEDING AUTHENTICATED SESSIONS. Cannot run in the
--              Supabase SQL editor at all: the editor connects as the table
--              owner, for whom RLS is not enforced and every grant is moot.
--              These need two real signed-in sessions, which means two JWTs,
--              which means credentials. Written out as a procedure, not as
--              runnable SQL, so nobody mistakes an owner-session result for a
--              browser-session result.
--
--   SECTION C  TESTS THAT TEMPORARILY WRITE SYNTHETIC ROWS. Real behavioural
--              coverage of the two definer functions, in
--              supabase/tests/statement_analyses_behaviour_test.sql. Separate
--              file because it WRITES, and because its risk profile is
--              different from both sections above. Read its header before
--              running it anywhere.
--
-- PASS CONDITION FOR SECTION A: every row reads PASS, except rows marked INFO,
-- which are context rather than assertions. A single FAIL means 004 did not
-- land as designed -- do not set STATEMENT_ANALYSIS_CACHE.
--
-- to_regclass() is used rather than a ::regclass cast so that a missing table
-- reports as one clean FAIL instead of aborting the whole query. For the same
-- reason has_table_privilege() is called with the table OID rather than its
-- name: given a NULL oid it returns NULL, whereas the name form raises
-- 'relation does not exist' and would abort every other check with it.
--
-- Section A mutates nothing.

-- ============================================================================
-- SECTION A -- READ-ONLY SCHEMA INSPECTION
-- ============================================================================

with
tbl as (select to_regclass('public.statement_analyses') as oid),

claim_fn as (
  select p.oid, p.prosecdef, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_statement_analysis'
),
settle_fn as (
  select p.oid, p.prosecdef, p.proconfig, p.pronargs
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'settle_statement_analysis'
),

expected_cols(ord, col, typ, nullable) as (
  values
    (1,  'id',               'uuid',                     'NO'),
    (2,  'user_id',          'uuid',                     'NO'),
    (3,  'draft_id',         'uuid',                     'NO'),
    (4,  'fingerprint',      'text',                     'NO'),
    (5,  'claim_token',      'uuid',                     'NO'),
    (6,  'status',           'text',                     'NO'),
    (7,  'revision',         'bigint',                   'NO'),
    (8,  'prompt_attached',  'boolean',                  'NO'),
    (9,  'provenance',       'text',                     'YES'),
    (10, 'words',            'integer',                  'NO'),
    (11, 'stated_max_words', 'integer',                  'YES'),
    (12, 'over_limit',       'boolean',                  'NO'),
    (13, 'overall',          'integer',                  'YES'),
    (14, 'review',           'jsonb',                    'YES'),
    (15, 'rubric_version',   'text',                     'NO'),
    (16, 'schema_version',   'text',                     'NO'),
    (17, 'created_at',       'timestamp with time zone', 'NO'),
    (18, 'updated_at',       'timestamp with time zone', 'NO')
),

expected_constraints(ord, conname, kind) as (
  values
    (1, 'statement_analyses_draft_fingerprint_key', 'u'),
    (2, 'statement_analyses_status',                'c'),
    (3, 'statement_analyses_fingerprint_shape',     'c'),
    (4, 'statement_analyses_complete_shape',        'c'),
    (5, 'statement_analyses_overall_range',         'c'),
    (6, 'statement_analyses_provenance',            'c')
),

expected_indexes(ord, idxname) as (
  values
    (1, 'statement_analyses_draft_idx'),
    (2, 'statement_analyses_owner_idx'),
    (3, 'statement_analyses_pending_idx')
),

checks as (

  -- ---------------------------------------------------------------- the table
  select 100 as step,
         'public.statement_analyses exists' as check_name,
         coalesce((select oid::text from tbl), 'absent') as actual,
         'present' as expected,
         case when (select oid from tbl) is null
              then 'FAIL -- 004 has not been applied'
              else 'PASS' end as verdict

  -- ---------------------------------------------------------------- columns
  union all
  select 200 + e.ord,
         format('column %s', e.col),
         coalesce(c.data_type, 'absent')
           || coalesce(' / nullable=' || c.is_nullable, ''),
         format('%s / nullable=%s', e.typ, e.nullable),
         case
           when c.column_name is null then 'FAIL -- column missing'
           when c.data_type <> e.typ then 'FAIL -- wrong type'
           when c.is_nullable <> e.nullable then 'FAIL -- wrong nullability'
           else 'PASS'
         end
    from expected_cols e
    left join information_schema.columns c
           on c.table_schema = 'public'
          and c.table_name = 'statement_analyses'
          and c.column_name = e.col

  -- THE ESSAY IS NOT HERE, and that is a security property rather than a
  -- schema detail: a second copy of somebody's personal statement is a second
  -- place for it to leak from.
  union all
  select 290,
         'no essay or draft text column exists',
         coalesce((select string_agg(column_name, ', ')
                     from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'statement_analyses'
                      and column_name in ('essay', 'prompt_text', 'text', 'body',
                                          'content', 'draft_text')), 'none'),
         'none',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'statement_analyses'
                              and column_name in ('essay', 'prompt_text', 'text', 'body',
                                                  'content', 'draft_text'))
              then 'FAIL -- applicant text is stored here'
              else 'PASS' end

  -- ------------------------------------------------------------- constraints
  union all
  select 300 + e.ord,
         format('constraint %s', e.conname),
         coalesce(con.contype::text, 'absent'),
         e.kind,
         case
           when con.conname is null then 'FAIL -- constraint missing'
           when con.contype::text <> e.kind then 'FAIL -- wrong constraint kind'
           else 'PASS'
         end
    from expected_constraints e
    left join pg_constraint con
           on con.conrelid = (select oid from tbl)
          and con.conname = e.conname

  -- The uniqueness key is what makes two concurrent paid analyses impossible.
  -- Its COLUMNS matter, not just its existence.
  union all
  select 390,
         'uniqueness is on (draft_id, fingerprint)',
         coalesce((select pg_get_constraintdef(con.oid)
                     from pg_constraint con
                    where con.conrelid = (select oid from tbl)
                      and con.conname = 'statement_analyses_draft_fingerprint_key'),
                  'absent'),
         'UNIQUE (draft_id, fingerprint)',
         case when (select pg_get_constraintdef(con.oid)
                      from pg_constraint con
                     where con.conrelid = (select oid from tbl)
                       and con.conname = 'statement_analyses_draft_fingerprint_key')
                   = 'UNIQUE (draft_id, fingerprint)'
              then 'PASS'
              else 'FAIL -- the concurrency guarantee rests on this key' end

  -- ----------------------------------------------------- referential integrity
  -- RETENTION IS ENFORCED BY THESE TWO KEYS AND BY NOTHING ELSE. There is no
  -- sweep, no trigger and no scheduled job -- so if a key is missing, analyses
  -- outlive the drafts they quote and nothing will ever notice.
  union all
  select 392 + x.ord,
         format('foreign key on %s cascades', x.col),
         coalesce((select pg_get_constraintdef(con.oid) from pg_constraint con
                    where con.conrelid = (select oid from tbl) and con.conname = x.conname),
                  'absent'),
         x.want,
         case
           when not exists (select 1 from pg_constraint con
                             where con.conrelid = (select oid from tbl)
                               and con.conname = x.conname)
             then format('FAIL -- %s', x.why)
           when (select pg_get_constraintdef(con.oid) from pg_constraint con
                  where con.conrelid = (select oid from tbl) and con.conname = x.conname)
                not like '%ON DELETE CASCADE'
             then 'FAIL -- the key exists but does not cascade'
           else 'PASS'
         end
    from (values
      (1, 'draft_id', 'statement_analyses_draft_fk',
          'FOREIGN KEY (draft_id) REFERENCES statement_drafts(id) ON DELETE CASCADE',
          'a deleted draft would leave analyses quoting it -- review.evidence is a '
          || 'verified span of the applicant''s essay'),
      (2, 'user_id', 'statement_analyses_user_fk',
          'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
          'a deleted account would leave analyses behind')
    ) as x(ord, col, conname, want, why)

  -- THE PER-ATTEMPT TOKEN. Authority to settle, rotated on every claim.
  union all
  select 395,
         'claim_token is NOT NULL with a per-row default',
         coalesce((select coalesce(column_default, 'null') || ' / nullable=' || is_nullable
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_analyses'
                      and column_name = 'claim_token'), 'absent'),
         'gen_random_uuid() / nullable=NO',
         case
           when not exists (select 1 from information_schema.columns
                             where table_schema = 'public'
                               and table_name = 'statement_analyses'
                               and column_name = 'claim_token')
             then 'FAIL -- the deployed table predates the superseded-claim fix'
           when (select is_nullable from information_schema.columns
                  where table_schema = 'public' and table_name = 'statement_analyses'
                    and column_name = 'claim_token') <> 'NO'
             then 'FAIL -- a nullable token is a token that can be omitted'
           else 'PASS' end

  union all
  select 396,
         'settle_statement_analysis takes FOUR arguments (id, token, review, overall)',
         coalesce((select pg_get_function_identity_arguments(oid) from settle_fn), 'absent'),
         'p_id uuid, p_token uuid, p_review jsonb, p_overall integer',
         -- pg_get_function_identity_arguments RETURNS NAMES AS WELL AS TYPES.
         -- A first version compared against 'uuid, uuid, jsonb, integer' and
         -- reported FAIL against a correct function -- found by running it. The
         -- ARGUMENT COUNT is what matters, so that is what is asserted, with
         -- the token named explicitly.
         case
           when (select oid from settle_fn) is null then 'FAIL -- function missing'
           when (select pronargs from settle_fn) <> 4
             then 'FAIL -- the three-argument version settles without a token'
           when (select pg_get_function_identity_arguments(oid) from settle_fn)
                not like '%p_token uuid%'
             then 'FAIL -- the second argument is not the claim token'
           else 'PASS'
         end

  union all
  select 397,
         'the three-argument settle overload is GONE',
         coalesce((select count(*)::text from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname = 'settle_statement_analysis'), '0'),
         '1',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname = 'settle_statement_analysis') = 1
              then 'PASS'
              else 'FAIL -- two overloads exist; the unprotected one is still callable' end

  -- ---------------------------------------------------------------- indexes
  union all
  select 400 + e.ord,
         format('index %s', e.idxname),
         case when i.indexname is null then 'absent' else 'present' end,
         'present',
         case when i.indexname is null then 'FAIL -- index missing' else 'PASS' end
    from expected_indexes e
    left join pg_indexes i
           on i.schemaname = 'public'
          and i.tablename = 'statement_analyses'
          and i.indexname = e.idxname

  -- --------------------------------------------------------------------- RLS
  union all
  select 500,
         'row level security is enabled',
         coalesce((select relrowsecurity::text from pg_class
                    where oid = (select oid from tbl)), 'unknown'),
         'true',
         case when (select relrowsecurity from pg_class
                     where oid = (select oid from tbl)) is true
              then 'PASS' else 'FAIL -- RLS is off; every grant is table-wide' end

  union all
  select 501,
         'exactly one policy exists',
         coalesce((select count(*)::text from pg_policies
                    where schemaname = 'public' and tablename = 'statement_analyses'), '0'),
         '1',
         case when (select count(*) from pg_policies
                     where schemaname = 'public' and tablename = 'statement_analyses') = 1
              then 'PASS' else 'FAIL -- an extra policy is an extra way in' end

  union all
  select 502,
         'the only policy is SELECT for authenticated',
         coalesce((select cmd || ' / ' || coalesce(array_to_string(roles, ','), '')
                     from pg_policies
                    where schemaname = 'public' and tablename = 'statement_analyses'
                    limit 1), 'absent'),
         'SELECT / authenticated',
         case when (select cmd from pg_policies
                     where schemaname = 'public' and tablename = 'statement_analyses'
                     limit 1) = 'SELECT'
              then 'PASS' else 'FAIL -- a write policy exists' end

  -- THE LOAD-BEARING ABSENCE. No insert/update/delete policy, so those commands
  -- are denied even before a grant is consulted.
  union all
  select 503,
         'NO insert, update or delete policy exists',
         coalesce((select string_agg(cmd, ', ') from pg_policies
                    where schemaname = 'public' and tablename = 'statement_analyses'
                      and cmd <> 'SELECT'), 'none'),
         'none',
         case when exists (select 1 from pg_policies
                            where schemaname = 'public' and tablename = 'statement_analyses'
                              and cmd <> 'SELECT')
              then 'FAIL -- an applicant could fabricate a completed analysis'
              else 'PASS' end

  -- The predicate is recorded for a human to read. NOT an assertion: a
  -- predicate that LOOKS right is not a predicate that was EXERCISED, which is
  -- what section B and section C are for.
  union all
  select 504,
         'policy predicate (INFO -- read it, do not trust it)',
         coalesce((select coalesce(qual, '(none)') from pg_policies
                    where schemaname = 'public' and tablename = 'statement_analyses'
                    limit 1), 'absent'),
         'user_id = ( SELECT auth.uid() AS uid)',
         'INFO -- section B must exercise this with two real sessions'

  -- ------------------------------------------------------------------ grants
  -- has_table_privilege REPORTS A GRANT. It does not run a query as that role.
  union all
  select 600,
         'authenticated has SELECT',
         coalesce(has_table_privilege('authenticated', (select oid from tbl), 'SELECT')::text,
                  'unknown'),
         'true',
         case when has_table_privilege('authenticated', (select oid from tbl), 'SELECT') is true
              then 'PASS' else 'FAIL -- an applicant cannot read their own feedback' end

  union all
  select 601 + x.ord,
         format('authenticated has NO %s', x.priv),
         coalesce(has_table_privilege('authenticated', (select oid from tbl), x.priv)::text,
                  'unknown'),
         'false',
         case when has_table_privilege('authenticated', (select oid from tbl), x.priv) is true
              then format('FAIL -- %s would let an applicant forge a result', x.priv)
              else 'PASS' end
    from (values (1, 'INSERT'), (2, 'UPDATE'), (3, 'DELETE')) as x(ord, priv)

  union all
  select 610 + x.ord,
         format('anon has NO %s', x.priv),
         coalesce(has_table_privilege('anon', (select oid from tbl), x.priv)::text, 'unknown'),
         'false',
         case when has_table_privilege('anon', (select oid from tbl), x.priv) is true
              then 'FAIL -- an analysis is not public reference data'
              else 'PASS' end
    from (values (1, 'SELECT'), (2, 'INSERT'), (3, 'UPDATE'), (4, 'DELETE')) as x(ord, priv)

  -- service_role BYPASSES RLS. A grant here is a standing privilege against a
  -- table nothing writes, so there must not be one.
  union all
  select 620 + x.ord,
         format('service_role has NO %s', x.priv),
         coalesce(has_table_privilege('service_role', (select oid from tbl), x.priv)::text,
                  'unknown'),
         'false',
         case when has_table_privilege('service_role', (select oid from tbl), x.priv) is true
              then 'FAIL -- service_role bypasses RLS; revoke it'
              else 'PASS' end
    from (values (1, 'SELECT'), (2, 'INSERT'), (3, 'UPDATE'), (4, 'DELETE')) as x(ord, priv)

  -- PUBLIC is held by every role, anon included. Supabase's schema default
  -- privileges are why 004 revokes it explicitly rather than trusting defaults.
  union all
  select 630,
         'PUBLIC holds nothing',
         coalesce((select string_agg(distinct privilege_type, ', ')
                     from information_schema.role_table_grants
                    where table_schema = 'public'
                      and table_name = 'statement_analyses'
                      and grantee = 'PUBLIC'), 'none'),
         'none',
         case when exists (select 1 from information_schema.role_table_grants
                            where table_schema = 'public'
                              and table_name = 'statement_analyses'
                              and grantee = 'PUBLIC')
              then 'FAIL -- PUBLIC is held by every role including anon'
              else 'PASS' end

  -- Anything granted that this migration did not grant. Catches a default
  -- privilege that survived the revoke.
  union all
  select 640,
         'no grant exists beyond authenticated.SELECT',
         coalesce((select string_agg(grantee || '.' || privilege_type, ', ' order by grantee)
                     from information_schema.role_table_grants
                    where table_schema = 'public'
                      and table_name = 'statement_analyses'
                      and not (grantee = 'authenticated' and privilege_type = 'SELECT')
                      -- THE OWNER IS DERIVED, NOT NAMED. A first version listed
                      -- 'postgres' and 'supabase_admin' and so reported FAIL on
                      -- any cluster whose owner is called something else --
                      -- found by running it. The owner always holds every
                      -- privilege on its own table and is not a finding.
                      and grantee <> pg_get_userbyid(
                        (select relowner from pg_class
                          where oid = (select oid from tbl)))
                      and grantee not in ('postgres', 'supabase_admin')), 'none'),
         'none (beyond the table owner)',
         case when exists (select 1 from information_schema.role_table_grants
                            where table_schema = 'public'
                              and table_name = 'statement_analyses'
                              and not (grantee = 'authenticated'
                                       and privilege_type = 'SELECT')
                              and grantee <> pg_get_userbyid(
                                (select relowner from pg_class
                                  where oid = (select oid from tbl)))
                              and grantee not in ('postgres', 'supabase_admin'))
              then 'FAIL -- read the actual column and revoke what is listed'
              else 'PASS' end

  -- --------------------------------------------------------------- functions
  union all
  select 700,
         'claim_statement_analysis exists',
         case when (select oid from claim_fn) is null then 'absent' else 'present' end,
         'present',
         case when (select oid from claim_fn) is null then 'FAIL -- function missing' else 'PASS' end

  union all
  select 701,
         'claim_statement_analysis is SECURITY DEFINER',
         coalesce((select prosecdef::text from claim_fn), 'unknown'),
         'true',
         case when (select prosecdef from claim_fn) is true
              then 'PASS' else 'FAIL -- applicants hold no INSERT; definer is the only path' end

  -- AN EMPTY search_path IS STORED AS search_path="" , WITH THE QUOTES. A first
  -- version of this check compared against the bare string `search_path=` and
  -- reported FAIL against a migration that was correct -- found by running it.
  -- Both spellings are accepted so the check does not depend on how a given
  -- server renders an empty GUC.
  union all
  select 702,
         'claim_statement_analysis pins an EMPTY search_path',
         coalesce((select array_to_string(proconfig, ', ') from claim_fn), 'none'),
         'search_path="" (empty)',
         case
           when (select proconfig from claim_fn) is null
             then 'FAIL -- no search_path; a definer function without one is hijackable'
           when (select proconfig from claim_fn)
                && array['search_path=', 'search_path=""'] then 'PASS'
           else 'FAIL -- search_path is set to something other than empty'
         end

  union all
  select 710,
         'settle_statement_analysis exists',
         case when (select oid from settle_fn) is null then 'absent' else 'present' end,
         'present',
         case when (select oid from settle_fn) is null then 'FAIL -- function missing' else 'PASS' end

  union all
  select 711,
         'settle_statement_analysis is SECURITY DEFINER',
         coalesce((select prosecdef::text from settle_fn), 'unknown'),
         'true',
         case when (select prosecdef from settle_fn) is true then 'PASS' else 'FAIL' end

  union all
  select 712,
         'settle_statement_analysis pins an EMPTY search_path',
         coalesce((select array_to_string(proconfig, ', ') from settle_fn), 'none'),
         'search_path="" (empty)',
         case
           when (select proconfig from settle_fn) is null
             then 'FAIL -- no search_path; a definer function without one is hijackable'
           when (select proconfig from settle_fn)
                && array['search_path=', 'search_path=""'] then 'PASS'
           else 'FAIL -- a definer function without an empty search_path is hijackable'
         end

  -- EXECUTE goes to `authenticated` only. anon and PUBLIC must hold none.
  union all
  select 720 + x.ord,
         format('%s may EXECUTE claim_statement_analysis', x.role),
         coalesce(has_function_privilege(x.role, (select oid from claim_fn), 'EXECUTE')::text,
                  'unknown'),
         x.want,
         case
           when (select oid from claim_fn) is null then 'FAIL -- function missing'
           when has_function_privilege(x.role, (select oid from claim_fn), 'EXECUTE')::text = x.want
             then 'PASS'
           else format('FAIL -- expected %s', x.want)
         end
    from (values (1, 'authenticated', 'true'), (2, 'anon', 'false')) as x(ord, role, want)

  union all
  select 730 + x.ord,
         format('%s may EXECUTE settle_statement_analysis', x.role),
         coalesce(has_function_privilege(x.role, (select oid from settle_fn), 'EXECUTE')::text,
                  'unknown'),
         x.want,
         case
           when (select oid from settle_fn) is null then 'FAIL -- function missing'
           when has_function_privilege(x.role, (select oid from settle_fn), 'EXECUTE')::text = x.want
             then 'PASS'
           else format('FAIL -- expected %s', x.want)
         end
    from (values (1, 'authenticated', 'true'), (2, 'anon', 'false')) as x(ord, role, want)

  -- THE OWNERSHIP READ THE AUDIT ADDED. Proven here only by its presence in the
  -- function source; whether it refuses another user's draft is section C.
  union all
  select 740,
         'claim() reads statement_drafts to check ownership',
         case when (select pg_get_functiondef(oid) from claim_fn)
                   like '%public.statement_drafts%' then 'present' else 'absent' end,
         'present',
         case when (select pg_get_functiondef(oid) from claim_fn)
                   like '%d.id = p_draft_id and d.user_id = v_user%'
              then 'PASS'
              else 'FAIL -- the deployed function predates the audit hardening' end

  union all
  select 741,
         'claim() handles the insert race without raising',
         case when (select pg_get_functiondef(oid) from claim_fn)
                   like '%on conflict on constraint statement_analyses_draft_fingerprint_key%'
              then 'present' else 'absent' end,
         'present',
         case when (select pg_get_functiondef(oid) from claim_fn)
                   like '%on conflict on constraint statement_analyses_draft_fingerprint_key%'
              then 'PASS'
              else 'FAIL -- the deployed function predates the audit hardening' end

  -- --------------------------------------------------------------- row count
  union all
  select 800,
         'the table is empty (INFO -- expected right after the migration)',
         coalesce((select count(*)::text from public.statement_analyses), 'unreadable'),
         '0',
         case when (select count(*) from public.statement_analyses) = 0
              then 'INFO -- as expected'
              else 'INFO -- rows already present; this is not a fresh apply' end

  -- ------------------------------------------------- what this cannot prove
  union all
  select 900,
         'runtime access restriction (INFO -- NOT CHECKED HERE)',
         'not checked',
         'see sections B and C',
         'INFO -- every row above reads the catalog. None of it ran a query as '
         || 'anon or as another applicant, and none of it evaluated an RLS '
         || 'predicate. Do not quote section A as evidence that cross-user '
         || 'access is denied.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;


-- ============================================================================
-- SECTION B -- TESTS THAT NEED AUTHENTICATED DATABASE SESSIONS
-- ============================================================================
--
-- NOT RUNNABLE IN THE SQL EDITOR, AND THAT IS NOT A LIMITATION OF THIS FILE.
-- The editor connects as the table owner. An owner is not subject to RLS and
-- holds every privilege, so a query that returns rows there tells you nothing
-- about what `authenticated` or `anon` can see. Running section A's checks and
-- then adding "and I also selected some rows and it worked" is the single
-- easiest way to convince yourself of a guarantee you have not tested.
--
-- WHAT THESE NEED: two signed-in accounts and their access tokens (JWTs), and a
-- client that sends them -- PostgREST over HTTPS, or psql with
-- `set local role authenticated` plus a `request.jwt.claims` setting. Both
-- involve credentials, so both are OUTSIDE this file and require explicit
-- authorization. Nothing here was executed.
--
-- B1. anon cannot read the table at all.
--     GET /rest/v1/statement_analyses with the anon key and no Authorization
--     header.  EXPECT: 401 or an empty result with a permission error -- NOT a
--     row. If rows come back, stop and revoke.
--
-- B2. An applicant reads only their own analyses.
--     Sign in as A, create a draft, analyse it. Then GET
--     /rest/v1/statement_analyses as B.  EXPECT: zero rows, not a 403 -- RLS
--     filters rather than refuses, so an empty array is the correct answer.
--
-- B3. An applicant cannot read another applicant's analysis by id.
--     As B: GET /rest/v1/statement_analyses?id=eq.<A's analysis id>.
--     EXPECT: zero rows. Indistinguishable from a row that does not exist.
--
-- B4. An applicant cannot write the table directly.
--     As A: POST /rest/v1/statement_analyses with a hand-built body whose
--     status is 'complete' and whose review is any JSON.
--     EXPECT: refused -- `authenticated` holds no INSERT. Then PATCH an
--     existing own row's `overall`, and DELETE it.  EXPECT: both refused.
--     THIS IS THE ONE THAT MATTERS MOST: it is the difference between feedback
--     that was generated and paid for, and feedback an applicant typed.
--
-- B5. An applicant cannot claim work for a draft they do not own.
--     As B: POST /rest/v1/rpc/claim_statement_analysis with A's draft id and
--     any 64-hex fingerprint.  EXPECT: {"ok": false, "reason": "not-found"},
--     and `select count(*) from public.statement_analyses` unchanged.
--     This is the audit hardening. Before it, B received a claim id.
--
-- B6. An applicant cannot settle another applicant's claim.
--     As A, start an analysis and capture the claim id AND its claimToken. As
--     B: POST /rest/v1/rpc/settle_statement_analysis with that id, that token
--     and any review.
--     EXPECT: {"ok": false, "reason": "not-found"} and A's row untouched --
--     the user filter refuses it even with the right token.
--
-- B8. A superseded request cannot complete or release the replacement.
--     The two-session procedure is in
--     supabase/tests/statement_analyses_behaviour_test.sql's header. It needs
--     one authenticated session and one write to force staleness, and it is the
--     only end-to-end check of the token.
--
-- B7. Free and Premium cannot reach the analyser at all.
--     POST the application's analyse endpoint as a Free account and then a
--     Premium account.  EXPECT: 403 with code `analysis-requires-ultimate`,
--     and no new row in statement_analyses, and no new usage ledger entry.
--     This is an APPLICATION gate (app/api/statement/drafts/[id]/analyze),
--     not a database one -- the database has no concept of a tier -- so it has
--     to be tested through the route.
--
-- RECORD THE ACTUAL RESPONSES. A note saying "B4 refused" is worth less than
-- the status code and body, because the failure mode to look for is a 2xx with
-- an empty body that reads like a refusal and was in fact a write.


-- ============================================================================
-- SECTION C -- TESTS THAT TEMPORARILY WRITE SYNTHETIC ROWS
-- ============================================================================
--
-- IN A SEPARATE FILE: supabase/tests/statement_analyses_behaviour_test.sql
--
-- It covers what neither section above can: that the definer functions BEHAVE
-- as written -- the ownership refusal, the claim/complete/reuse cycle, the
-- release of a failed attempt, the recovery of a stale claim, and the CHECK
-- constraints refusing a fabricated complete row.
--
-- IT WRITES. Read its header before running it anywhere. It is not risk-free on
-- production merely because it ends in ROLLBACK.
--
-- AND ONE THING IT CANNOT DO: prove the concurrency guarantee. Two statements
-- in one session are sequential by definition. The two-session procedure is
-- documented in that file.
