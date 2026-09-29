-- Statement Drafts (Phase 3) -- PREFLIGHT. READ-ONLY. Run BEFORE the migration.
--
-- Migration: supabase/migrations/20260928_000_statement_drafts.sql
--
-- ONE STATEMENT, deliberately. The Supabase SQL editor displays only the LAST
-- result of a multi-statement script, so a preflight split into eight SELECTs
-- shows one answer and hides seven. Everything below is a single query.
--
-- READ THE VERDICT COLUMN. Any row reading FAIL means do not apply the
-- migration yet. Rows marked INFO are context the migration already accounts
-- for and are not pass/fail.
--
-- Mutates nothing: every reference is a catalog read.

with checks(step, check_name, actual, expected, verdict) as (

  -- 1. gen_random_uuid() is the id default and no extension is created for it.
  select 1, 'server version',
         current_setting('server_version'),
         '>= 13, where gen_random_uuid() is built in',
         case when current_setting('server_version_num')::int >= 130000
              then 'PASS' else 'FAIL -- gen_random_uuid() needs pgcrypto here' end

  union all
  select 2, 'gen_random_uuid() resolvable',
         coalesce((select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname)
                     from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where p.proname = 'gen_random_uuid'), '(not found)'),
         'at least one, normally pg_catalog.gen_random_uuid',
         case when exists (select 1 from pg_proc where proname = 'gen_random_uuid')
              then 'PASS' else 'FAIL -- STOP' end

  -- 2. The table itself must not already exist.
  union all
  select 3, 'table public.statement_drafts',
         case when exists (select 1 from pg_tables
                            where schemaname = 'public' and tablename = 'statement_drafts')
              then 'EXISTS' else 'absent' end,
         'absent',
         case when exists (select 1 from pg_tables
                            where schemaname = 'public' and tablename = 'statement_drafts')
              then 'FAIL -- STOP and inspect it before re-applying' else 'PASS' end

  -- 3. The FK target.
  union all
  select 4, 'FK target auth.users',
         case when exists (select 1 from pg_tables
                            where schemaname = 'auth' and tablename = 'users')
              then 'present' else 'MISSING' end,
         'present',
         case when exists (select 1 from pg_tables
                            where schemaname = 'auth' and tablename = 'users')
              then 'PASS' else 'FAIL -- STOP' end

  -- 4. Name collisions for every object the migration creates.
  union all
  select 5, 'index name statement_drafts_user_updated_idx',
         coalesce((select string_agg(schemaname || '.' || tablename, ', ')
                     from pg_indexes
                    where indexname = 'statement_drafts_user_updated_idx'), 'free'),
         'free',
         case when exists (select 1 from pg_indexes
                            where indexname = 'statement_drafts_user_updated_idx')
              then 'FAIL -- name taken' else 'PASS' end

  union all
  select 6, 'constraint names',
         coalesce((select string_agg(con.conname, ', ' order by con.conname)
                     from pg_constraint con
                    where con.conname in ('statement_drafts_revision_positive',
                                          'statement_drafts_essay_length',
                                          'statement_drafts_title_length')), 'all free'),
         'all free',
         case when exists (select 1 from pg_constraint
                            where conname in ('statement_drafts_revision_positive',
                                              'statement_drafts_essay_length',
                                              'statement_drafts_title_length'))
              then 'FAIL -- name taken' else 'PASS' end

  union all
  select 7, 'policy names',
         coalesce((select string_agg(policyname, ', ' order by policyname)
                     from pg_policies
                    where policyname in ('own statement draft select',
                                         'own statement draft insert',
                                         'own statement draft update',
                                         'own statement draft delete')), 'all free'),
         'all free (they are dropped-if-exists anyway)',
         case when exists (select 1 from pg_policies
                            where policyname in ('own statement draft select',
                                                 'own statement draft insert',
                                                 'own statement draft update',
                                                 'own statement draft delete'))
              then 'REVIEW -- migration drops them first' else 'PASS' end

  -- 5. The roles the migration revokes from and grants to must all exist, or a
  --    REVOKE/GRANT aborts the transaction and nothing is applied.
  union all
  select 8, 'roles anon / authenticated / service_role',
         coalesce((select string_agg(rolname, ', ' order by rolname) from pg_roles
                    where rolname in ('anon', 'authenticated', 'service_role')), '(none)'),
         'all three present',
         case when (select count(*) from pg_roles
                     where rolname in ('anon', 'authenticated', 'service_role')) = 3
              then 'PASS' else 'FAIL -- STOP, a REVOKE would abort' end

  -- 6. THE SUPABASE DEFAULT-PRIVILEGES TRAP, which is the whole reason the
  --    migration revokes before it grants. This shows what will be granted
  --    automatically on the new table. Informational: the migration handles it.
  union all
  select 9, 'default ACLs for new tables in public',
         coalesce((select string_agg(d.defaclrole::regrole::text || ' => ' || d.defaclacl::text, ' | ')
                     from pg_default_acl d
                     join pg_namespace n on n.oid = d.defaclnamespace
                    where n.nspname = 'public' and d.defaclobjtype = 'r'), '(none set)'),
         'whatever it says -- migration revokes all before granting',
         'INFO'

  -- 7. Who is applying it.
  union all
  select 10, 'current role / can create in public',
         current_user || ' / ' ||
         case when has_schema_privilege(current_user, 'public', 'CREATE')
              then 'CREATE ok' else 'NO CREATE' end,
         'a role with CREATE on schema public',
         case when has_schema_privilege(current_user, 'public', 'CREATE')
              then 'PASS' else 'FAIL -- STOP' end

  -- 8. Context, not a gate: there is nothing to migrate from. Any row here
  --    would mean an earlier statement store exists that this design missed.
  union all
  select 11, 'pre-existing statement-like tables',
         coalesce((select string_agg(tablename, ', ' order by tablename) from pg_tables
                    where schemaname = 'public'
                      and (tablename like '%statement%' or tablename like '%essay%')), 'none'),
         'none -- statements have never been persisted',
         case when exists (select 1 from pg_tables
                            where schemaname = 'public'
                              and (tablename like '%statement%' or tablename like '%essay%'))
              then 'REVIEW -- audit assumed none existed' else 'PASS' end

  -- 9. SCHEMA ACCESS. Table-level grants are useless without USAGE on the
  --    schema that contains the table: `authenticated` would hold
  --    select/insert/update/delete and still be unable to name
  --    public.statement_drafts. Supabase grants this by default and every other
  --    table in this project relies on it, so a FAIL here means something has
  --    been revoked and the migration would produce a table nobody can read.
  --
  --    The role OID form is used rather than the name form: given a NULL oid
  --    (role absent) has_schema_privilege returns NULL instead of raising
  --    'role does not exist', so one missing role cannot abort every other check.
  union all
  select 12, 'authenticated has USAGE on schema public',
         coalesce(
           case when has_schema_privilege(
                       (select oid from pg_roles where rolname = 'authenticated'),
                       (select oid from pg_namespace where nspname = 'public'),
                       'USAGE')
                then 'USAGE held' else 'NO USAGE' end,
           '(role or schema missing)'),
         'USAGE held',
         case when coalesce(has_schema_privilege(
                              (select oid from pg_roles where rolname = 'authenticated'),
                              (select oid from pg_namespace where nspname = 'public'),
                              'USAGE'), false)
              then 'PASS'
              else 'FAIL -- STOP, table grants alone would not make the table usable' end

  -- 10. FK CREATION PREREQUISITE. Creating
  --     `user_id references auth.users(id)` requires REFERENCES on auth.users.
  --     Without it the ALTER aborts, and because the whole migration is one
  --     transaction nothing at all would be applied.
  --
  --     has_table_privilege() is the right test precisely because it answers the
  --     real question: it returns true when the privilege is held directly, by
  --     ownership, or by superuser, so the Supabase editor role does not produce
  --     a false failure. Ownership and superuser status are printed alongside so
  --     a PASS can be attributed rather than merely trusted.
  --
  --     Table OID form again, so a missing auth.users reports FAIL here rather
  --     than raising and taking the rest of the preflight with it.
  union all
  select 13, 'privilege to create the FK to auth.users(id)',
         current_user
           || ' / superuser=' ||
           case when coalesce((select rolsuper from pg_roles where rolname = current_user), false)
                then 'yes' else 'no' end
           || ' / owns auth.users=' ||
           case when (select pg_get_userbyid(c.relowner) from pg_class c
                       where c.oid = to_regclass('auth.users')) = current_user
                then 'yes' else 'no' end
           || ' / REFERENCES=' ||
           coalesce(case when has_table_privilege(current_user,
                                                  to_regclass('auth.users')::oid,
                                                  'REFERENCES')
                         then 'yes' else 'no' end, '(auth.users not found)'),
         'REFERENCES=yes, held directly or via ownership or superuser',
         case when coalesce(has_table_privilege(current_user,
                                                to_regclass('auth.users')::oid,
                                                'REFERENCES'), false)
              then 'PASS'
              else 'FAIL -- STOP, the FK would abort and nothing would apply' end
)
select step, check_name, actual, expected, verdict
from checks
order by step;
