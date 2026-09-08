-- D33 POST-MIGRATION VERIFICATION — READ-ONLY. Run immediately after.
-- Compare every value against the preflight output.

-- 1. The migrated draft. Every field must match preflight except id/name.
select
  left(id::text, 8) || '…'                 as analysis_id,
  name,
  left(user_id::text, 8) || '…'            as user_abbrev,
  revision,
  engine_version,
  policies::text                           as policies,
  jsonb_array_length(courses)              as course_count,
  md5(courses::text)                       as courses_md5,
  encode(digest(courses::text, 'sha256'), 'hex') as courses_sha256,
  created_at,
  updated_at
from public.gpa_drafts
order by created_at;
-- EXPECT: same revision, engine_version, policies, course_count, courses_md5,
--         courses_sha256, created_at and updated_at as preflight.
--         name = 'My Analysis'; analysis_id populated.
-- If courses_md5 differs, STOP — the JSON was rewritten.

select count(*) as analyses,
       count(distinct user_id) as users,
       count(*) filter (where name = 'My Analysis') as migrated_default,
       count(*) filter (where id is null)          as missing_id
from public.gpa_drafts;
-- EXPECT: analyses = 1, users = 1, migrated_default = 1, missing_id = 0.

-- 2. New primary key is id; user_id is NO LONGER unique.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid = 'public.gpa_drafts'::regclass
order by contype, conname;
-- EXPECT: PRIMARY KEY (id); FOREIGN KEY (user_id) REFERENCES auth.users(id)
--         ON DELETE CASCADE; checks: courses_is_array, courses_size,
--         engine_version, name_len, policies_shape.
-- EXPECT: NO unique constraint on user_id alone.

select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='gpa_drafts' order by indexname;
-- EXPECT 4: gpa_drafts_pkey, gpa_drafts_user_id_idx,
--           gpa_drafts_user_name_uniq (UNIQUE, lower(btrim(name))),
--           gpa_drafts_user_updated_idx.

select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
where c.relname = 'gpa_drafts' and not t.tgisinternal order by tgname;
-- EXPECT 3: gpa_drafts_limit, gpa_drafts_revision_guard, gpa_drafts_touch.

-- 3. Function ACLs must remain hardened (all three roles false).
select p.proname,
       case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security,
       coalesce(array_to_string(p.proconfig, ','), '(none)')     as search_path,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role,
       coalesce(array_to_string(p.proacl, ' | '), '(default)')   as acl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'gpa%'
order by p.proname;
-- EXPECT: all INVOKER, search_path pinned, anon/authenticated/service_role all
--         false, acl = postgres=X/postgres.

-- 4. Table grants unchanged.
select grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema='public' and table_name='gpa_drafts'
group by grantee order by grantee;
-- EXPECT: authenticated = DELETE,INSERT,SELECT,UPDATE and postgres only.
--         No anon, no service_role, no PUBLIC.

-- 5. gpa_calculations untouched by this migration.
select count(*) as total_rows,
       count(*) filter (where engine_version = 2) as v2_snapshots
from public.gpa_calculations;
-- EXPECT: total_rows = 21, v2_snapshots = 1. This migration never writes here.
