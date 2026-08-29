-- Step 17 — INSPECTION ONLY. Read-only; changes nothing.
-- Run in the Supabase dashboard: SQL Editor -> New query -> Run.
-- Paste the four result sets back before any migration is applied.

-- 1. Is RLS enabled, and is it forced?
select c.relname            as table_name,
       c.relrowsecurity     as rls_enabled,
       c.relforcerowsecurity as rls_forced
from   pg_class c
join   pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relname = 'user_profiles';

-- 2. Every existing policy on the table.
select policyname, cmd, permissive, roles, qual, with_check
from   pg_policies
where  schemaname = 'public' and tablename = 'user_profiles'
order  by policyname;

-- 3. Table-level grants held by anon / authenticated.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public'
  and  table_name   = 'user_profiles'
  and  grantee in ('anon', 'authenticated')
order  by grantee, privilege_type;

-- 4. Column-level grants (Supabase sometimes grants per column).
select grantee, column_name, privilege_type
from   information_schema.column_privileges
where  table_schema = 'public'
  and  table_name   = 'user_profiles'
  and  grantee in ('anon', 'authenticated')
order  by grantee, column_name;

-- 5. Schema, for reference.
select column_name, data_type, is_nullable, column_default
from   information_schema.columns
where  table_schema = 'public' and table_name = 'user_profiles'
order  by ordinal_position;
