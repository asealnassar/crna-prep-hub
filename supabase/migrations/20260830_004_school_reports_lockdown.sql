-- ============================================================================
-- Step 22 — close public.school_reports.
--
-- Confirmed against production with only the public anon key and no session:
--   SELECT  -> returned rows including reporter_email
--   INSERT  -> reached the uuid type cast, so permission was granted
--   UPDATE  -> 204, permission granted
--   DELETE  -> 204, permission granted
--
-- Root cause, from the production policy inspection:
--   "Only admin can view reports"  SELECT  roles {public}  USING true
-- The name says admin; the predicate says everyone. Combined with default
-- table grants to anon and authenticated, every report -- and every reporter's
-- email address -- was world-readable, and the table was world-writable.
--
-- RUN ONLY AFTER the application deploy that moves /admin/reports onto
-- /api/admin/reports. Before that deploy the admin page reads and writes this
-- table directly from the browser and this migration would break it.
--
-- After this migration the browser can do exactly one thing: a signed-in user
-- may insert a report under their own email address. Everything else --
-- reading, resolving, deleting -- happens server-side with the service role.
-- ============================================================================
begin;

alter table public.school_reports enable row level security;

-- ---------------------------------------------------------------------------
-- 1. Privileges. Revoke before granting: GRANT is additive, so granting the
--    wanted privileges on top of Supabase's default ALL would leave DELETE,
--    TRUNCATE, REFERENCES and TRIGGER in place.
-- ---------------------------------------------------------------------------

-- PUBLIC is the pseudo-role every other role inherits from. A privilege left
-- here would survive the role-specific revokes below.
revoke all privileges on table public.school_reports from public;

revoke all privileges on table public.school_reports from anon;
revoke all privileges on table public.school_reports from authenticated;
revoke all privileges on table public.school_reports from service_role;

-- Signed-in users may submit a report and nothing else. Column-level INSERT
-- rather than table-level: without a privilege on id, status or created_at the
-- browser cannot supply them at all, so they can only come from the column
-- defaults (uuid_generate_v4(), 'pending', now()). A table-wide INSERT grant
-- would let a client post status='resolved' or backdate created_at.
grant insert (school_id, school_name, field_with_error, description, reporter_email)
  on table public.school_reports
  to authenticated;

-- The server reads the queue, flips status, and deletes. It never inserts:
-- reports originate from users, not from the admin API.
grant select, update, delete on table public.school_reports to service_role;

-- ---------------------------------------------------------------------------
-- 2. Policies. All three existing ones are replaced.
--    * "Only admin can view reports" is USING true -- the actual leak.
--    * "Anyone can insert reports" is WITH CHECK true on role public, so an
--      anonymous caller could file reports in anyone's name.
--    * "Admin can delete report" is no longer needed: deletion moved to the
--      server, and the service role bypasses RLS.
-- ---------------------------------------------------------------------------
drop policy if exists "Only admin can view reports" on public.school_reports;
drop policy if exists "Anyone can insert reports"   on public.school_reports;
drop policy if exists "Admin can delete report"     on public.school_reports;

-- The one surviving policy. Role `authenticated`, not `public`, so anon is
-- excluded at the policy level as well as by privileges. The email must match
-- the verified JWT, so a report cannot be filed under someone else's address;
-- the NOT NULL guard rejects a session with no email rather than letting
-- NULL = NULL semantics decide.
create policy "school_reports_insert_own"
  on public.school_reports
  for insert
  to authenticated
  with check (
    (select auth.email()) is not null
    and reporter_email = (select auth.email())
  );

-- No SELECT, UPDATE or DELETE policy is created. With no privileges and no
-- policy, the browser has no read or write path of any kind. service_role
-- bypasses RLS, so the admin API is unaffected. postgres is untouched.

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect: rls_enabled = true.
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relname = 'school_reports';

-- Expect exactly one row: school_reports_insert_own / INSERT / {authenticated}.
select policyname, cmd, roles, qual, with_check
from   pg_policies
where  schemaname = 'public' and tablename = 'school_reports'
order  by policyname;

-- Expect: no rows for PUBLIC, anon or authenticated. service_role should show
-- exactly DELETE, SELECT, UPDATE.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'school_reports'
  and  grantee in ('PUBLIC','anon','authenticated','service_role')
order  by grantee, privilege_type;

-- Expect: authenticated with INSERT on exactly five columns -- school_id,
-- school_name, field_with_error, description, reporter_email. No id, no
-- status, no created_at. No rows at all for anon or PUBLIC.
select grantee, column_name, privilege_type
from   information_schema.column_privileges
where  table_schema = 'public' and table_name = 'school_reports'
  and  grantee in ('PUBLIC','anon','authenticated')
order  by grantee, column_name;
