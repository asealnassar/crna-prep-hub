-- Step 17 — INSPECTION ONLY. Read-only; changes nothing.
-- Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Returns ONE row / ONE cell. Click it, copy, paste back.
select jsonb_pretty(jsonb_build_object(

  'rls', (
    select jsonb_build_object('enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_profiles'
  ),

  'policies', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', policyname, 'cmd', cmd, 'permissive', permissive,
      'roles', roles, 'using', qual, 'with_check', with_check) order by policyname)
    from pg_policies
    where schemaname = 'public' and tablename = 'user_profiles'
  ), '[]'::jsonb),

  'table_grants', coalesce((
    select jsonb_agg(jsonb_build_object('grantee', grantee, 'privilege', privilege_type)
                     order by grantee, privilege_type)
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'user_profiles'
      and grantee in ('anon','authenticated')
  ), '[]'::jsonb),

  'column_grants', coalesce((
    select jsonb_agg(distinct jsonb_build_object(
      'grantee', grantee, 'column', column_name, 'privilege', privilege_type))
    from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'user_profiles'
      and grantee in ('anon','authenticated')
  ), '[]'::jsonb),

  'columns', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', column_name, 'type', data_type,
      'nullable', is_nullable, 'default', column_default) order by ordinal_position)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles'
  ), '[]'::jsonb)

)) as user_profiles_config;
