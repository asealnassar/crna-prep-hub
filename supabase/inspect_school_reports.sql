-- Step 22 — INSPECTION ONLY for public.school_reports. Read-only.
-- Run in the Supabase SQL Editor and send me the six result sets.

-- 1. Schema.
select column_name, data_type, is_nullable, column_default
from   information_schema.columns
where  table_schema = 'public' and table_name = 'school_reports'
order  by ordinal_position;

-- 2. RLS status: enabled, and forced?
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relname = 'school_reports';

-- 3. Every policy, with both expressions.
select policyname, cmd, permissive, roles, qual, with_check
from   pg_policies
where  schemaname = 'public' and tablename = 'school_reports'
order  by cmd, policyname;

-- 4. Table grants, including the PUBLIC pseudo-role.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'school_reports'
  and  grantee in ('PUBLIC','anon','authenticated','service_role')
order  by grantee, privilege_type;

-- 5. Column-level grants.
select grantee, column_name, privilege_type
from   information_schema.column_privileges
where  table_schema = 'public' and table_name = 'school_reports'
  and  grantee in ('PUBLIC','anon','authenticated','service_role')
order  by grantee, column_name;

-- 6. How the existing admin SELECT policy on user_profiles is written, so the
--    proposed admin policy below can match it rather than invent a new style.
select policyname, cmd, roles, qual
from   pg_policies
where  schemaname = 'public' and tablename = 'user_profiles'
  and  policyname ilike '%admin%';
