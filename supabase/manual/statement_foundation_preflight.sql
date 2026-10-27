-- ============================================================================
-- FOUNDATION PREFLIGHT — before 20261002_000..003 (prompt submissions)
-- ============================================================================
-- READ-ONLY. No INSERT, UPDATE, DELETE, ALTER, CREATE, DROP, GRANT or REVOKE
-- appears below. Run it in the SQL editor immediately before approving 000.
--
-- ANY 'FAIL' MEANS DO NOT PROCEED. 'INFO' rows are context, not verdicts.
--
-- ONE STATEMENT, because the SQL editor shows only the last result.
--
-- ----------------------------------------------------------------------------
-- WHY THIS FILE EXISTS
-- ----------------------------------------------------------------------------
-- statement_v2_rollout_preflight.sql is the gate for the V2 schema work
-- (008, 010-017). It requires statement_prompt_submissions to already exist,
-- because 008 and 012 add columns to it and 017 reads it -- so it is the gate
-- for the state AFTER this foundation is in place, and it cannot be the gate
-- for the state before it.
--
-- Production Stage A on 2026-10-22 found 20261002_000..003 had NEVER been
-- applied: no table, no columns, no constraints, no indexes, no RLS, no
-- policies, no grants, no 001/002 artifacts on the existing tables, and none
-- of 003's three RPCs. MIGRATION_STATUS.md had recorded 000 as applied in one
-- table cell; that claim was never substantiated and has been corrected.
--
-- This file proves the state the FOUNDATION expects: its prerequisites present,
-- and everything it is about to create still absent.
--
-- ----------------------------------------------------------------------------
-- WHAT IT ASSERTS
-- ----------------------------------------------------------------------------
--   1     identity -- which database and which role
--   10s   the parents exist, with the columns 001/002/003 depend upon
--   20s   the platform prerequisites exist (auth.users, auth.uid(), the roles)
--   30s   NOTHING 000 creates exists yet
--   40s   NOTHING 001/002 adds to the existing tables exists yet
--   50s   NONE of 003's RPC names is taken
--   60s   safety: no long transaction, no blocking lock
--   99    READY TO APPLY 000-003: YES / NO
-- ============================================================================
with
  subs as (select to_regclass('public.statement_prompt_submissions') as oid),
  drafts as (select to_regclass('public.statement_drafts') as oid),
  prompts as (select to_regclass('public.statement_prompts') as oid),
  hist as (select to_regclass('supabase_migrations.schema_migrations') as oid),

  -- what 001 and 002 depend on already being there
  parent_cols(tbl, col, typ) as (values
    ('statement_drafts',  'id',               'uuid'),
    ('statement_drafts',  'user_id',          'uuid'),
    ('statement_drafts',  'prompt_id',        'uuid'),
    ('statement_drafts',  'prompt_text',      'text'),
    ('statement_prompts', 'id',               'uuid')),

  -- everything the four migrations are about to create; all must be ABSENT
  new_cols(tbl, col) as (values
    ('statement_drafts',  'prompt_submission_id'),
    ('statement_prompts', 'origin_submission_id'),
    ('statement_prompts', 'supersedes_prompt_id')),
  new_cons(con) as (values
    ('statement_drafts_prompt_source_exclusive'),
    ('statement_drafts_submission_has_text'),
    ('statement_prompts_supersedes_not_self'),
    ('statement_prompt_submissions_text_length'),
    ('statement_prompt_submissions_max_words_range'),
    ('statement_prompt_submissions_cycle_format'),
    ('statement_prompt_submissions_source_url'),
    ('statement_prompt_submissions_status'),
    ('statement_prompt_submissions_review_shape'),
    ('statement_prompt_submissions_approval_shape'),
    ('statement_prompt_submissions_duplicate_shape'),
    ('statement_prompt_submissions_fingerprint_shape')),
  new_idx(idx) as (values
    ('statement_prompt_submissions_status_created_idx'),
    ('statement_prompt_submissions_submitter_idx'),
    ('statement_prompt_submissions_school_fingerprint_idx')),
  new_pol(pol) as (values
    ('own prompt submission select'),
    ('own prompt submission insert')),
  new_rpc(fn) as (values
    ('create_statement_draft_with_prompt_submission'),
    ('decide_statement_prompt_submission'),
    ('withdraw_statement_prompt_submission')),

  got as (
    select
      -- parents, by column AND declared type
      (select count(*) from parent_cols p
         join information_schema.columns c
           on c.table_schema = 'public' and c.table_name = p.tbl
          and c.column_name = p.col and c.data_type = p.typ)             as parents_ok,
      (select count(*) from parent_cols)                                 as parents_want,
      -- platform
      (select count(*) from information_schema.tables
        where table_schema = 'auth' and table_name = 'users')            as auth_users,
      (select count(*) from pg_proc f join pg_namespace n
         on n.oid = f.pronamespace
        where n.nspname = 'auth' and f.proname = 'uid')                  as auth_uid,
      (select count(*) from pg_roles
        where rolname in ('anon','authenticated','service_role'))        as roles,
      (select count(*) from pg_proc f join pg_namespace n
         on n.oid = f.pronamespace
        where f.proname = 'gen_random_uuid')                             as gen_uuid,
      -- conflicts: every one of these must be zero
      (select count(*) from new_cols w
         join information_schema.columns c
           on c.table_schema = 'public' and c.table_name = w.tbl
          and c.column_name = w.col)                                     as clash_cols,
      (select count(*) from new_cons w join pg_constraint k
         on k.conname = w.con)                                           as clash_cons,
      (select count(*) from new_idx w join pg_indexes i
         on i.schemaname = 'public' and i.indexname = w.idx)             as clash_idx,
      (select count(*) from new_pol w join pg_policies p
         on p.schemaname = 'public' and p.policyname = w.pol)            as clash_pol,
      (select count(*) from new_rpc w join pg_proc f on f.proname = w.fn
         join pg_namespace n on n.oid = f.pronamespace
          and n.nspname = 'public')                                      as clash_rpc,
      -- safety
      (select count(*) from pg_stat_activity
        where state <> 'idle' and xact_start < now() - interval '5 minutes') as long_tx,
      (select count(*) from pg_locks l join pg_class c on c.oid = l.relation
        where c.relname in ('statement_drafts','statement_prompts')
          and not l.granted)                                             as blocked
  ),
  clashes as (select (clash_cols + clash_cons + clash_idx + clash_pol + clash_rpc)
                     + case when (select oid from subs) is null then 0 else 1 end as n
                from got),

  checks as (
    select 1 as step, 'database and executing role' as check_name,
           'db=' || current_database() || ', user=' || current_user as actual,
           'the production project' as expected, 'INFO' as verdict

    -- ---- 10s: the parents 001/002/003 build on ------------------------------
    union all
    select 10, 'public.statement_drafts exists',
           case when (select oid from drafts) is null then 'ABSENT' else 'PRESENT' end,
           'PRESENT', case when (select oid from drafts) is null then 'FAIL' else 'PASS' end
    union all
    select 11, 'public.statement_prompts exists',
           case when (select oid from prompts) is null then 'ABSENT' else 'PRESENT' end,
           'PRESENT', case when (select oid from prompts) is null then 'FAIL' else 'PASS' end
    union all
    select 12, 'the 5 parent columns 001/002 depend on, with the right types',
           (select parents_ok::text from got) || ' of ' || (select parents_want::text from got),
           '5 of 5',
           case when (select parents_ok from got) = (select parents_want from got)
                then 'PASS' else 'FAIL' end

    -- ---- 20s: platform prerequisites ---------------------------------------
    union all
    select 20, 'auth.users exists (statement_drafts.user_id references it)',
           (select auth_users::text from got), '1',
           case when (select auth_users from got) = 1 then 'PASS' else 'FAIL' end
    union all
    select 21, 'auth.uid() exists (every RLS policy calls it)',
           (select auth_uid::text from got), '1',
           case when (select auth_uid from got) >= 1 then 'PASS' else 'FAIL' end
    union all
    select 22, 'the three Supabase roles exist',
           (select roles::text from got), '3',
           case when (select roles from got) = 3 then 'PASS' else 'FAIL' end
    union all
    select 23, 'gen_random_uuid() is available (every id defaults to it)',
           (select gen_uuid::text from got), '1 or more',
           case when (select gen_uuid from got) >= 1 then 'PASS' else 'FAIL' end

    -- ---- 30s/40s/50s: nothing being created may already exist --------------
    union all
    select 30, 'statement_prompt_submissions does NOT exist yet',
           case when (select oid from subs) is null then 'ABSENT' else 'PRESENT' end,
           'ABSENT', case when (select oid from subs) is null then 'PASS' else 'FAIL' end
    union all
    select 40, 'none of the 3 new columns exists yet',
           (select clash_cols::text from got), '0',
           case when (select clash_cols from got) = 0 then 'PASS' else 'FAIL' end
    union all
    select 41, 'none of the 12 constraint names is taken',
           (select clash_cons::text from got), '0',
           case when (select clash_cons from got) = 0 then 'PASS' else 'FAIL' end
    union all
    select 42, 'none of the 3 index names is taken',
           (select clash_idx::text from got), '0',
           case when (select clash_idx from got) = 0 then 'PASS' else 'FAIL' end
    union all
    select 43, 'neither policy name is taken',
           (select clash_pol::text from got), '0',
           case when (select clash_pol from got) = 0 then 'PASS' else 'FAIL' end
    union all
    select 50, 'none of 003''s 3 RPC names is taken',
           (select clash_rpc::text from got), '0',
           case when (select clash_rpc from got) = 0 then 'PASS' else 'FAIL' end

    -- ---- 60s: safety --------------------------------------------------------
    union all
    select 60, 'no transaction older than five minutes',
           (select long_tx::text from got), '0',
           case when (select long_tx from got) = 0 then 'PASS' else 'FAIL' end
    union all
    select 61, 'no blocking lock on statement_drafts or statement_prompts',
           (select blocked::text from got), '0',
           case when (select blocked from got) = 0 then 'PASS' else 'FAIL' end
    union all
    select 62, 'statement/lock timeouts for the session that will apply',
           'statement_timeout=' || current_setting('statement_timeout')
           || ', lock_timeout=' || current_setting('lock_timeout'),
           'set a lock_timeout before applying (e.g. 5s)', 'INFO'
    union all
    select 70, 'migration history, if any',
           case when (select oid from hist) is null
                then 'no history table (expected -- applied by SQL editor)'
                else coalesce((xpath('/row/v/text()', query_to_xml(
                       'select coalesce(string_agg(version, '', '' order by version), ''none'') as v '
                       || 'from supabase_migrations.schema_migrations '
                       || 'where version like ''20261002%%''',
                       false, true, '')))[1]::text, 'none')
           end,
           'context only', 'INFO'

    -- ---- the verdict --------------------------------------------------------
    union all
    select 99, 'READY TO APPLY 000-003',
           case
             when (select oid from drafts) is null or (select oid from prompts) is null
                  or (select parents_ok from got) <> (select parents_want from got)
               then 'NO -- a prerequisite is missing; read steps 10-12'
             when (select auth_users from got) <> 1 or (select auth_uid from got) < 1
                  or (select roles from got) <> 3 or (select gen_uuid from got) < 1
               then 'NO -- a platform prerequisite is missing; read steps 20-23'
             when (select n from clashes) > 0
               then 'NO -- ' || (select n::text from clashes)
                    || ' object(s) already exist; this is NOT a clean never-applied state'
             when (select long_tx from got) > 0 or (select blocked from got) > 0
               then 'NO -- a long transaction or a blocking lock is present; read steps 60-61'
             else 'YES -- prerequisites present, every new object absent, no locks'
           end,
           'YES', 
           case
             when (select oid from drafts) is null or (select oid from prompts) is null
                  or (select parents_ok from got) <> (select parents_want from got)
                  or (select auth_users from got) <> 1 or (select auth_uid from got) < 1
                  or (select roles from got) <> 3 or (select gen_uuid from got) < 1
                  or (select n from clashes) > 0
                  or (select long_tx from got) > 0 or (select blocked from got) > 0
               then 'FAIL' else 'PASS'
           end
  )
select step, check_name, actual, expected, verdict
  from checks
 order by step;
