-- Analysis cache (migration 004) -- auth.users REFERENCE PREFLIGHT.
-- READ-ONLY. Run BEFORE the migration. Mutates nothing: every reference below
-- is a catalog read or a privilege function.
--
-- Migration: supabase/migrations/20261002_004_statement_analyses.sql
--
-- WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE FROM THE OTHER PREFLIGHTS.
--
-- Migration 004 ends by adding two foreign keys (section 2b):
--
--   statement_analyses_draft_fk -> public.statement_drafts(id)  on delete cascade
--   statement_analyses_user_fk  -> auth.users(id)               on delete cascade
--
-- The second one reaches OUT OF THIS APPLICATION'S SCHEMA into Supabase's. That
-- makes it the only statement in 004 whose success depends on a privilege this
-- project does not grant itself:
--
--   To create a foreign key, PostgreSQL requires REFERENCES privilege on the
--   REFERENCED table -- and on Supabase, auth.users is owned by
--   supabase_auth_admin, not by the role that runs the SQL editor.
--
-- `references auth.users(id)` is the standard, documented Supabase pattern and
-- is expected to succeed. But "expected to succeed" is not a check, and a
-- failure here aborts the whole migration -- in the SQL editor the entire script
-- is one transaction, so a refusal on line 249 rolls back the table, the policy
-- and both functions created above it. One read-only query beforehand is
-- cheaper than diagnosing that.
--
-- THE ISOLATED LOCAL REHEARSAL COULD NOT COVER THIS. In that cluster auth.users
-- was a synthetic stand-in owned by the same role that ran the migration, so
-- the privilege was present by construction and was never actually tested.
-- This file is the check that rehearsal could not be.
--
-- READ THE VERDICT COLUMN. Any FAIL means do not apply 004 yet. INFO rows are
-- context -- notably the executing role identity, which is recorded because
-- REFERENCES may be held directly or inherited through role membership, and
-- because a privilege confirmed for one role says nothing about another.

with
  au      as (select to_regclass('auth.users')               as oid),
  drafts  as (select to_regclass('public.statement_drafts')  as oid),
  anal    as (select to_regclass('public.statement_analyses') as oid),
  checks as (

  -- ---- 1. WHO IS ASKING ---------------------------------------------------
  -- Recorded first and deliberately: every privilege answer below is about
  -- THIS role. Re-run the file if the migration will be applied as another.
  select 100 as step,
         'executing role (INFO)' as check_name,
         'current_user=' || current_user
           || ', session_user=' || session_user
           || ', database=' || current_database() as actual,
         'the role that will apply migration 004' as expected,
         'INFO -- on Supabase the SQL editor normally reports postgres' as verdict

  union all
  select 101,
         'is the executing role a superuser? (INFO)',
         (select coalesce(usesuper::text, 'unknown') from pg_user where usename = current_user),
         'f on Supabase',
         'INFO -- a superuser bypasses the privilege checks below, so a PASS '
         || 'obtained as a superuser does not predict a non-superuser result'

  union all
  select 102,
         'roles the executing role belongs to (INFO)',
         coalesce((select string_agg(r.rolname, ', ' order by r.rolname)
                     from pg_auth_members m
                     join pg_roles r on r.oid = m.roleid
                    where m.member = (select oid from pg_roles where rolname = current_user)),
                  'none'),
         'recorded for diagnosis',
         'INFO -- REFERENCES may be inherited through any of these'

  -- ---- 2. THE REFERENCED TABLE EXISTS AND IS REACHABLE --------------------
  union all
  select 200,
         'schema auth exists',
         coalesce((select 'present' from pg_namespace where nspname = 'auth'), 'absent'),
         'present',
         case when exists (select 1 from pg_namespace where nspname = 'auth')
              then 'PASS'
              else 'FAIL -- no auth schema; this is not a Supabase database' end

  union all
  select 201,
         'USAGE on schema auth',
         coalesce(has_schema_privilege((select oid from pg_namespace
                                         where nspname = 'auth'), 'usage')::text, 'n/a'),
         'true',
         case when has_schema_privilege((select oid from pg_namespace
                                          where nspname = 'auth'), 'usage') then 'PASS'
              else 'FAIL -- the migration cannot even name auth.users' end

  union all
  select 202,
         'auth.users exists',
         coalesce((select oid::text from au), 'absent'),
         'present',
         case when (select oid from au) is not null then 'PASS'
              else 'FAIL -- the FK target is missing' end

  union all
  select 203,
         'auth.users owner (INFO)',
         coalesce((select pg_get_userbyid(c.relowner) from pg_class c
                    where c.oid = (select oid from au)), 'n/a'),
         'supabase_auth_admin on Supabase',
         'INFO -- if this is NOT the executing role, the REFERENCES check below '
         || 'is the one that matters; if it IS, the privilege is implicit and '
         || 'this preflight proves nothing about production'

  -- ---- 3. THE PRIVILEGE THAT CAN ABORT THE MIGRATION ---------------------
  -- has_table_privilege(NULL::oid, ...) yields NULL rather than raising, so a
  -- missing auth.users degrades to 'n/a' instead of breaking the preflight.
  union all
  select 300,
         'REFERENCES on auth.users  <<< THE DECIDING CHECK',
         coalesce(has_table_privilege((select oid from au), 'REFERENCES')::text, 'n/a'),
         'true',
         case
           when (select oid from au) is null then 'FAIL -- auth.users absent (see step 202)'
           when has_table_privilege((select oid from au), 'REFERENCES') then 'PASS'
           else 'FAIL -- DO NOT APPLY 004. statement_analyses_user_fk will be '
                || 'refused and the whole migration will roll back. Either grant '
                || 'REFERENCES on auth.users to this role, apply 004 as a role '
                || 'that holds it, or remove section 2b''s user FK and replace '
                || 'the retention guarantee with an explicit cleanup path.'
         end

  union all
  select 301,
         'REFERENCES on auth.users(id) specifically',
         coalesce(has_column_privilege((select oid from au), 'id', 'REFERENCES')::text, 'n/a'),
         'true',
         case
           when (select oid from au) is null then 'FAIL -- auth.users absent'
           when has_column_privilege((select oid from au), 'id', 'REFERENCES') then 'PASS'
           else 'FAIL -- column-level REFERENCES is missing even if table-level reads true'
         end

  union all
  select 302,
         'auth.users(id) is a unique/primary key',
         coalesce((select string_agg(con.conname, ', ')
                     from pg_constraint con
                    where con.conrelid = (select oid from au)
                      and con.contype in ('p', 'u')
                      and con.conkey = array[(select attnum from pg_attribute
                                               where attrelid = (select oid from au)
                                                 and attname = 'id')]::smallint[]),
                  'none found'),
         'a primary key on id',
         case when exists (select 1 from pg_constraint con
                            where con.conrelid = (select oid from au)
                              and con.contype in ('p', 'u'))
              then 'PASS' else 'FAIL -- an FK needs a unique constraint to point at' end

  -- ---- 4. THE OTHER FK TARGET, AND THE TABLE BEING CREATED ---------------
  union all
  select 400,
         'public.statement_drafts exists (the other FK target)',
         coalesce((select oid::text from drafts), 'absent'),
         'present',
         case when (select oid from drafts) is not null then 'PASS'
              else 'FAIL -- 004 is NO LONGER STANDALONE. Since the retention '
                || 'FKs were added it requires statement_drafts; apply '
                || '20260928_000_statement_drafts first.' end

  union all
  select 401,
         'REFERENCES on public.statement_drafts',
         coalesce(has_table_privilege((select oid from drafts), 'REFERENCES')::text, 'n/a'),
         'true',
         case
           when (select oid from drafts) is null then 'FAIL -- statement_drafts absent'
           when has_table_privilege((select oid from drafts), 'REFERENCES') then 'PASS'
           else 'FAIL -- statement_analyses_draft_fk will be refused'
         end

  union all
  select 402,
         'public.statement_analyses does not exist yet',
         coalesce((select oid::text from anal), 'absent'),
         'absent',
         case when (select oid from anal) is null then 'PASS'
              else 'FAIL -- a table of this name already exists. `create table if '
                || 'not exists` would skip silently and every later statement in '
                || '004 would apply to a table it did not design.' end

  union all
  select 403,
         'CREATE on schema public',
         has_schema_privilege('public', 'create')::text,
         'true',
         case when has_schema_privilege('public', 'create') then 'PASS'
              else 'FAIL -- the migration cannot create its table' end

  -- ---- 5. WHAT THIS PREFLIGHT CANNOT TELL YOU ----------------------------
  union all
  select 500,
         'the FK briefly locks auth.users (INFO)',
         'ShareRowExclusiveLock, measured locally',
         'apply during a quiet period',
         'INFO -- adding statement_analyses_user_fk takes ShareRowExclusiveLock '
         || 'on auth.users. Measured in the isolated rehearsal: this BLOCKS '
         || 'inserts into auth.users -- signups -- while permitting reads, so '
         || 'logins that only read are unaffected. In the SQL editor the whole '
         || 'script is one transaction, so the lock is held from the FK '
         || 'statement until the script commits. THE LOCAL DURATION (~20ms on an '
         || 'empty table) DOES NOT PREDICT PRODUCTION and must not be quoted as '
         || 'if it did.'

  union all
  select 501,
         'rollout flags must stay off (INFO)',
         'not visible from SQL',
         'STATEMENT_ANALYSIS_CACHE unset until 004 is applied and verified',
         'INFO -- confirm in the deployment environment, not here. All three '
         || 'statement flags fail closed on the exact string on.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;
