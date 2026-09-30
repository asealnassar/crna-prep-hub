-- Statement Prompts (prompt catalog) -- PREFLIGHT. READ-ONLY. Run BEFORE the migration.
--
-- Migration: supabase/migrations/20260930_000_statement_prompts.sql
--
-- ONE STATEMENT, deliberately. The Supabase SQL editor displays only the LAST
-- result of a multi-statement script, so a preflight split into several SELECTs
-- shows one answer and hides the rest. Everything below is a single query.
--
-- READ THE VERDICT COLUMN. Any row reading FAIL means do not apply the
-- migration yet. Rows marked INFO are context the migration already accounts
-- for and are not pass/fail.
--
-- Mutates nothing: every reference is a catalog read.

with
  target as (select to_regclass('public.statement_prompts') as oid),
  schools as (select to_regclass('public.schools') as oid),

checks as (
  -- 1. The table must not already exist. `create table if not exists` would
  -- skip silently and every later ALTER would then apply to a table this file
  -- did not design.
  select 100 as step,
         'public.statement_prompts does not exist yet' as check_name,
         coalesce((select oid::text from target), 'absent') as actual,
         'absent' as expected,
         case when (select oid from target) is null then 'PASS'
              else 'FAIL -- a table of this name already exists; inspect it before applying' end as verdict

  -- 2. gen_random_uuid() must resolve, or the DEFAULT clause aborts the file.
  union all
  select 200, 'gen_random_uuid() resolves',
         coalesce((select p.proname || '() in ' || n.nspname
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where p.proname = 'gen_random_uuid' limit 1), 'NOT FOUND'),
         'gen_random_uuid() resolvable',
         case when exists (select 1 from pg_proc where proname = 'gen_random_uuid')
              then 'PASS'
              else 'FAIL -- STOP, the id DEFAULT would abort and nothing would apply' end

  -- 3. btrim() and char_length() are core builtins; named so a reader can see
  -- the CHECK constraints have no extension dependency.
  union all
  select 300, 'btrim() and char_length() resolve (CHECK dependencies)',
         (select string_agg(distinct p.proname, ', ' order by p.proname)
            from pg_proc p where p.proname in ('btrim', 'char_length')),
         'btrim, char_length',
         case when (select count(distinct proname) from pg_proc
                     where proname in ('btrim', 'char_length')) = 2
              then 'PASS' else 'FAIL -- a CHECK constraint would not compile' end

  -- 4. CONTEXT, NOT A GATE. This migration is designed to run whether or not
  -- public.schools exists, because it declares no foreign key. Both answers
  -- are acceptable; the row exists so the reader knows which environment they
  -- are looking at.
  union all
  select 400, 'public.schools present (INFO -- not required)',
         case when (select oid from schools) is null
              then 'absent -- this is a migration-only environment'
              else 'present -- this looks like production' end,
         'either is fine; no FK is declared',
         'INFO'

  -- 5. If schools IS present, confirm its id is uuid -- the type this table's
  -- school_id is chosen to match. Still not a gate: a mismatch would not stop
  -- this migration, but it would stop the FK follow-up.
  union all
  select 410, 'schools.id is uuid, if schools exists (INFO)',
         coalesce((select format_type(a.atttypid, a.atttypmod)
                     from pg_attribute a
                    where a.attrelid = (select oid from schools)
                      and a.attname = 'id' and a.attnum > 0 and not a.attisdropped),
                  'n/a -- schools absent'),
         'uuid, or n/a',
         case when (select oid from schools) is null then 'INFO -- schools absent'
              when (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
                     where a.attrelid = (select oid from schools) and a.attname = 'id') = 'uuid'
              then 'INFO -- uuid, so the later FK will be valid'
              else 'INFO -- NOT uuid; the later FK checkpoint must reconcile this' end

  -- 6. No name collisions on the objects this file creates.
  union all
  select 500, 'no existing index or constraint of the names this file creates',
         coalesce((select string_agg(c.relname, ', ' order by c.relname)
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public'
                      and c.relname in ('statement_prompts_school_active_order_idx',
                                        'statement_prompts_pkey')), 'none'),
         'none',
         case when exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public'
                              and c.relname in ('statement_prompts_school_active_order_idx',
                                                'statement_prompts_pkey'))
              then 'FAIL -- a name this file creates is already taken'
              else 'PASS' end

  -- 7. No policy of this file's name exists anywhere in public.
  union all
  select 510, 'no existing policy named "active statement prompt select"',
         coalesce((select string_agg(p.tablename, ', ' order by p.tablename)
                     from pg_policies p
                    where p.schemaname = 'public'
                      and p.policyname = 'active statement prompt select'), 'none'),
         'none',
         case when exists (select 1 from pg_policies p
                            where p.schemaname = 'public'
                              and p.policyname = 'active statement prompt select')
              then 'FAIL -- that policy name is already in use'
              else 'PASS' end

  -- 8. The three browser/service roles must exist, or the GRANT/REVOKE aborts.
  union all
  select 600, 'roles anon, authenticated, service_role all exist',
         (select string_agg(rolname, ', ' order by rolname) from pg_roles
           where rolname in ('anon', 'authenticated', 'service_role')),
         'anon, authenticated, service_role',
         case when (select count(*) from pg_roles
                     where rolname in ('anon', 'authenticated', 'service_role')) = 3
              then 'PASS' else 'FAIL -- STOP, the GRANT/REVOKE block would abort' end

  -- 9. THE SUPABASE DEFAULT-PRIVILEGES TRAP, the same one the drafts migration
  -- documents. Default privileges in this schema mean a newly created table
  -- arrives with grants already attached, so the migration REVOKEs before it
  -- GRANTs. This row shows what is configured, so a reader can see why.
  union all
  select 700, 'default privileges configured for public schema (INFO)',
         coalesce((select string_agg(distinct d.defaclobjtype::text || ':' ||
                                     coalesce(r.rolname, 'PUBLIC'), ', ')
                     from pg_default_acl d
                     left join pg_namespace n on n.oid = d.defaclnamespace
                     left join pg_roles r on r.oid = d.defaclrole
                    where n.nspname = 'public'), 'none'),
         'whatever is configured -- the migration revokes first regardless',
         'INFO'

  -- 10. statement_drafts should already be in place. Not a hard dependency --
  -- this table references nothing of it -- but the two are one subsystem and a
  -- missing drafts table means the checkpoints are being applied out of order.
  union all
  select 800, 'public.statement_drafts already applied (INFO -- ordering check)',
         case when to_regclass('public.statement_drafts') is null
              then 'absent' else 'present' end,
         'present -- the prompt catalog is the checkpoint after it',
         case when to_regclass('public.statement_drafts') is null
              then 'INFO -- drafts not applied here; this file still runs standalone'
              else 'INFO -- as expected' end
)
select step, check_name, actual, expected, verdict
from checks
order by step;
