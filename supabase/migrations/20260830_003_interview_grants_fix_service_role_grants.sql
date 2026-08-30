-- ============================================================================
-- Step 21 corrective — trim service_role privileges on interview_grants.
--
-- 20260830_002 granted SELECT, INSERT and UPDATE without first revoking. GRANT
-- is additive, so Supabase's default ALL survived and verification showed
-- service_role holding DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE
-- and UPDATE.
--
-- Nothing in the application deletes, truncates or references this table, so
-- removing the extras is safe: lib/interviewSession.ts uses INSERT
-- (createGrant), SELECT (checkGrant) and UPDATE (completeGrant) only.
--
-- Touches nothing else: no policies, no RLS setting, no function, no other
-- table, and no role besides service_role.
-- ============================================================================
begin;

revoke all privileges on table public.interview_grants from service_role;

grant select, insert, update
  on table public.interview_grants
  to service_role;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect exactly three rows: INSERT, SELECT, UPDATE.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'interview_grants'
  and  grantee = 'service_role'
order  by privilege_type;

-- Expect zero rows: anon and authenticated remain with no access.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'interview_grants'
  and  grantee in ('anon','authenticated');

-- Expect rowsecurity = true, unchanged.
select relname, relrowsecurity
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relname = 'interview_grants';

-- Expect service_role / EXECUTE only, unchanged.
select grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public' and routine_name = 'consume_interview_turn';
