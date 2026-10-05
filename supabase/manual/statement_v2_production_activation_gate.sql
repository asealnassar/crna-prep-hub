-- Statement Studio V2 — PRODUCTION ACTIVATION GATE.
-- READ-ONLY. Run BEFORE migration 004. Mutates nothing.
--
-- WHAT THIS ADDS TO THE THREE APPROVED PREFLIGHTS.
-- The preflights ask whether each migration CAN be applied. This file asks
-- three questions none of them do, and that matter more on production than on
-- an isolated project:
--
--   1. Has any of 004 / 005 / 006 ALREADY been applied -- in whole or IN PART?
--      A partial application is the dangerous state. Every one of these
--      migrations is `create ... if not exists` / `drop ... if exists`, which
--      means re-running a half-applied migration SKIPS the objects that exist
--      and silently leaves the rest in whatever shape they were in. Counting
--      signature objects distinguishes "not applied" from "fully applied" from
--      "partially applied", which a single to_regclass check cannot.
--
--   2. Is there a migration history to read at all? Supabase records one only
--      when migrations are applied through its CLI. This project applies them
--      by pasting into the SQL editor, so the history may be absent or stale
--      and MUST NOT be trusted over the schema itself. Section 3 reports what
--      is there without treating it as authoritative.
--
--   3. Is the database busy RIGHT NOW in a way that makes 005 dangerous?
--      Migration 005 takes ACCESS EXCLUSIVE on public.statement_drafts, a table
--      with live applicant essays. An ACCESS EXCLUSIVE request that has to wait
--      QUEUES -- and every reader arriving after it queues behind it. Measured
--      in the local rehearsal: a plain SELECT that arrived after a queued
--      ALTER was itself blocked and timed out. So a long-running or
--      idle-in-transaction session is not a nuisance here, it is the
--      difference between a schema change and an outage.
--
-- ASSUMES public.statement_drafts and public.statement_prompts EXIST, because
-- sections 4 and 5 read them by name and a missing relation would abort the whole
-- gate at parse time rather than report. Both are long applied in production, and
-- steps 203/204 confirm the ones the migrations actually require. If you ever run
-- this against a database without them, expect "relation does not exist" and read
-- that as the answer.
--
-- READ THE VERDICT COLUMN. Any FAIL means do not proceed.

with
  anal   as (select to_regclass('public.statement_analyses')         as oid),
  sets_t as (select to_regclass('public.statement_requirement_sets') as oid),
  reqs   as (select to_regclass('public.statement_requirements')     as oid),
  drafts as (select to_regclass('public.statement_drafts')           as oid),
  au     as (select to_regclass('auth.users')                        as oid),
  hist   as (select to_regclass('supabase_migrations.schema_migrations') as oid),

  -- signature-object counts, one per migration
  n004 as (select
      (case when (select oid from anal) is not null then 1 else 0 end)
    + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('claim_statement_analysis', 'settle_statement_analysis'))
    + (select count(*) from pg_policies where schemaname = 'public'
        and tablename = 'statement_analyses'
        and policyname = 'own statement analysis select')
    + (select count(*) from pg_constraint where conrelid = (select oid from anal)
        and conname in ('statement_analyses_draft_fk', 'statement_analyses_user_fk',
                        'statement_analyses_draft_fingerprint_key'))
    + (select count(*) from pg_indexes where schemaname = 'public'
        and tablename = 'statement_analyses'
        and indexname in ('statement_analyses_draft_idx', 'statement_analyses_owner_idx',
                          'statement_analyses_pending_idx'))
    as present),

  n005 as (select
      (case when (select oid from sets_t) is not null then 1 else 0 end)
    + (case when (select oid from reqs) is not null then 1 else 0 end)
    + (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'statement_drafts'
          and column_name in ('requirement_id', 'requirement_snapshot'))
    + (select count(*) from pg_constraint where conrelid = (select oid from drafts)
        and contype = 'c'
        and conname in ('statement_drafts_requirement_pair',
                        'statement_drafts_requirement_needs_prompt_text',
                        'statement_drafts_requirement_snapshot_object'))
    as present),

  n006 as (select count(*) as present from information_schema.columns
            where table_schema = 'public' and table_name = 'statement_requirements'
              and column_name in ('words_enforcement', 'words_stated_as',
                   'characters_enforcement', 'characters_stated_as',
                   'pages_enforcement', 'pages_stated_as',
                   'unenforced_length', 'unenforced_length_verbatim')),

  checks as (

  -- ---- 1. WHERE AM I, AND AS WHOM ----------------------------------------
  select 100 as step,
         'target database and executing role (INFO)' as check_name,
         'db=' || current_database() || ', current_user=' || current_user
           || ', session_user=' || session_user as actual,
         'the production project, as the role that will apply the migrations' as expected,
         'INFO -- confirm the project ref in the dashboard URL matches the one in '
         || 'NEXT_PUBLIC_SUPABASE_URL. This query cannot see the project ref.' as verdict

  union all
  select 101, 'server version (INFO)',
         (select setting from pg_settings where name = 'server_version'),
         '15 or 16', 'INFO'

  union all
  select 102, 'is the executing role a superuser? (INFO)',
         (select coalesce(usesuper::text, 'unknown') from pg_user where usename = current_user),
         'f on Supabase',
         'INFO -- recorded because a privilege confirmed for a superuser does not '
         || 'predict a non-superuser result'

  -- ---- 2. HAS ANY MIGRATION ALREADY BEEN APPLIED? ------------------------
  -- 0 = not applied (proceed). full = already applied (skip it). anything in
  -- between = PARTIAL, which is the state to stop on.
  union all
  select 200, '004 signature objects present  <<< must be 0 of 10',
         (select present::text from n004) || ' of 10',
         '0 of 10',
         case (select present from n004)
           when 0  then 'PASS -- 004 has not been applied'
           when 10 then 'FAIL -- 004 is ALREADY APPLIED. Do not re-apply; skip to step 4 '
                        || 'of the runbook and verify instead.'
           else 'FAIL -- 004 is PARTIALLY APPLIED. STOP. Re-running will skip the '
                || 'objects that exist and leave the rest unchanged, because every '
                || 'statement is `if not exists`. Identify which objects are present '
                || 'before doing anything else.'
         end

  union all
  select 201, '005 signature objects present  <<< must be 0 of 7',
         (select present::text from n005) || ' of 7',
         '0 of 7',
         case (select present from n005)
           when 0 then 'PASS -- 005 has not been applied'
           when 7 then 'FAIL -- 005 is ALREADY APPLIED. Do not re-apply.'
           else 'FAIL -- 005 is PARTIALLY APPLIED. STOP. Note that its CHECK '
                || 'constraints on statement_drafts are not NOT VALID, so a partial '
                || 'state may mean a constraint was added without its columns.'
         end

  union all
  select 202, '006 signature columns present  <<< must be 0 of 8',
         (select present::text from n006) || ' of 8',
         '0 of 8',
         case (select present from n006)
           when 0 then 'PASS -- 006 has not been applied'
           when 8 then 'FAIL -- 006 is ALREADY APPLIED. Do not re-apply.'
           else 'FAIL -- 006 is PARTIALLY APPLIED. STOP.'
         end

  union all
  select 203, 'prerequisite: public.statement_drafts exists',
         coalesce((select oid::text from drafts), 'absent'), 'present',
         case when (select oid from drafts) is not null then 'PASS'
              else 'FAIL -- both 004 and 005 require it' end

  union all
  select 204, 'prerequisite: auth.users exists',
         coalesce((select oid::text from au), 'absent'), 'present',
         case when (select oid from au) is not null then 'PASS'
              else 'FAIL -- 004''s retention FK requires it' end

  -- ---- 3. MIGRATION HISTORY, REPORTED BUT NOT TRUSTED --------------------
  union all
  select 300, 'supabase_migrations.schema_migrations exists (INFO)',
         coalesce((select oid::text from hist), 'absent'),
         'may be absent',
         'INFO -- absent is EXPECTED here: these migrations are applied by pasting '
         || 'into the SQL editor, which records nothing. Section 2 above reads the '
         || 'SCHEMA, which is authoritative. Do not conclude from an empty history '
         || 'that nothing was applied.'

  union all
  select 301, 'how to read that history, if step 300 found it (INFO)',
         'see the verdict',
         'informational only',
         'INFO -- this query deliberately does NOT read that table. A relation named '
         || 'in a SELECT is resolved when the statement is PARSED, so naming it here '
         || 'would make this whole gate fail with "relation does not exist" in the '
         || 'very case that is expected -- an absent history. If step 300 reports it '
         || 'present, run this separately:  select version from '
         || 'supabase_migrations.schema_migrations where version like ''20261002%'' '
         || 'order by version;  and compare against section 2, which reads the schema '
         || 'and is authoritative.'

  -- ---- 4. IS THE DATABASE BUSY RIGHT NOW? --------------------------------
  -- This is the section that decides whether to apply 005 in this minute.
  union all
  select 400, 'longest open transaction (INFO)',
         coalesce((select max(now() - xact_start)::text from pg_stat_activity
                    where xact_start is not null and pid <> pg_backend_pid()), 'none'),
         'seconds, not minutes',
         'INFO -- 005 waits behind every one of these, and new readers wait behind 005'

  union all
  select 401, 'sessions IDLE IN TRANSACTION  <<< these block 005 indefinitely',
         (select count(*)::text from pg_stat_activity
           where state = 'idle in transaction' and pid <> pg_backend_pid()),
         '0',
         case when (select count(*) from pg_stat_activity
                     where state = 'idle in transaction' and pid <> pg_backend_pid()) = 0
              then 'PASS -- nothing is holding a transaction open'
              else 'FAIL -- an idle-in-transaction session holds its locks until it '
                   || 'ends. 005 will wait for it, and every applicant draft read '
                   || 'arriving afterwards will wait behind 005. Wait for these to '
                   || 'clear, or apply 005 with a short lock_timeout and expect it to '
                   || 'be cancelled.'
         end

  union all
  select 402, 'locks currently held on public.statement_drafts (INFO)',
         (select count(*)::text from pg_locks
           where relation = (select oid from drafts) and pid <> pg_backend_pid()),
         'low',
         'INFO -- 005 needs ACCESS EXCLUSIVE, which conflicts with ALL of these'

  union all
  select 403, 'active queries other than this one (INFO)',
         (select count(*)::text from pg_stat_activity
           where state = 'active' and pid <> pg_backend_pid() and backend_type = 'client backend'),
         'low',
         'INFO -- a proxy for how quiet the period is'

  -- ---- 5. BASELINES TO RECORD VERBATIM -----------------------------------
  union all
  select 500, 'statement_drafts row count (RECORD THIS)',
         (select count(*)::text from public.statement_drafts),
         'record it', 'INFO -- every postcheck compares against this number'

  union all
  select 501, 'statement_prompts row count / active (RECORD THIS)',
         coalesce((select count(*)::text || ' / ' || count(*) filter (where is_active)::text
                     from public.statement_prompts), 'table absent'),
         'record it', 'INFO -- proves the live Arkansas State prompt was untouched'

  -- ---- 6. WHAT SQL CANNOT SEE --------------------------------------------
  union all
  select 600, 'backup / recovery capability (NOT VISIBLE FROM SQL)',
         'check the dashboard',
         'a known-good restore point',
         'INFO -- Supabase Settings > Database > Backups. Record whether this '
         || 'project has Point-in-Time Recovery or only daily backups, and the '
         || 'timestamp of the most recent one. Daily-only means the recovery '
         || 'granularity is up to 24 hours of applicant work. These migrations are '
         || 'additive and create no destructive statement, but confirm the restore '
         || 'point BEFORE applying, not after.'

  union all
  select 601, 'rollout flags (NOT VISIBLE FROM SQL)',
         'check the deployment environment',
         'all three unset, or any value other than the exact string on',
         'INFO -- STATEMENT_ANALYSIS_CACHE, STATEMENT_REQUIREMENTS and '
         || 'STATEMENT_PROMPT_SUBMISSIONS are read with === ''on'' and fail closed on '
         || 'anything else. Confirm in Vercel, not here.'

  union all
  select 602, 'studio gate (NOT VISIBLE FROM SQL)',
         'check the deployment environment',
         'STATEMENT_STUDIO_MODE unset or internal',
         'INFO -- the gate defaults to internal unless the value is exactly '
         || '''general''. While it is internal, Statement Studio is admin-only, which '
         || 'is a second containment layer independent of the three flags.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;
