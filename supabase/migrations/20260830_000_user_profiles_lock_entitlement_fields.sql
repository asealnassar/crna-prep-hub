-- ============================================================================
-- Step 20 — take entitlement and usage fields out of the browser's reach.
--
-- RLS proved the caller owned the ROW but said nothing about which COLUMNS
-- they could change, so an authenticated user could run
--   PATCH /rest/v1/user_profiles?id=eq.<self>  {"subscription_tier":"ultimate"}
-- and self-grant the paid plan, or reset interview_count to 0 for unlimited
-- free interviews.
--
-- RUN THIS ONLY AFTER the application deploy that removed the browser's write
-- (app/interview/page.tsx no longer updates interview_count; the server does).
-- That deploy is live, so this is safe to run now.
--
-- Not touched here: the anonymous lockdown from Step 17B, "Users can view own
-- profile", "admins can view all profiles", and the INSERT path used by
-- signup — see the pre-flight check below before assuming anything about it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-FLIGHT (read-only). Run this first and read the output.
-- Signup is currently healthy: the newest auth user has a profile row. How the
-- row is created could not be determined from outside the database, so confirm
-- here whether an INSERT policy exists or a trigger on auth.users does it.
-- If an INSERT policy exists, this migration leaves it alone.
-- ---------------------------------------------------------------------------
select policyname, cmd, roles, qual, with_check
from   pg_policies
where  schemaname = 'public' and tablename = 'user_profiles'
order  by cmd, policyname;

select tgname, pg_get_triggerdef(oid) as definition
from   pg_trigger
where  tgrelid = 'auth.users'::regclass and not tgisinternal;

-- ---------------------------------------------------------------------------
-- MIGRATION
-- ---------------------------------------------------------------------------
begin;

-- 1. Atomic increment, so two concurrent interview starts cannot both read the
--    same value and write the same +1. SECURITY DEFINER because the caller
--    (the API's service-role client) is trusted, but the function is locked to
--    service_role only so no browser session can reach it.
create or replace function public.increment_interview_count(p_user_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.user_profiles
     set interview_count = coalesce(interview_count, 0) + 1
   where id = p_user_id
  returning interview_count;
$$;

revoke all on function public.increment_interview_count(uuid) from public, anon, authenticated;
grant execute on function public.increment_interview_count(uuid) to service_role;

-- 2. No application code updates user_profiles from the browser any more:
--    signup INSERTs, the Stripe webhook UPDATEs with the service role (which
--    bypasses RLS and is unaffected), and interview usage is now incremented
--    server-side. So the authenticated role needs no UPDATE at all — this is
--    stricter and simpler than column-level grants, and there is no
--    user-editable column left to preserve.
revoke update on public.user_profiles from authenticated;

-- 3. No code deletes profiles from the browser either.
revoke delete on public.user_profiles from authenticated;

-- 4. Remove the policies that now imply a permission the role no longer holds.
--    Leaving them would misrepresent the security model to the next reader.
drop policy if exists "Users can update own profile" on public.user_profiles;
drop policy if exists "Users can update own interview_count" on public.user_profiles;

-- SELECT is untouched: "Users can view own profile" and "admins can view all
-- profiles" both remain, and anon remains fully revoked from Step 17B.

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect: no UPDATE or DELETE row for authenticated; no rows at all for anon.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'user_profiles'
  and  grantee in ('anon','authenticated')
order  by grantee, privilege_type;

-- Expect: the two update policies gone; view-own and admin-view still present.
select policyname, cmd, roles
from   pg_policies
where  schemaname = 'public' and tablename = 'user_profiles'
order  by policyname;

-- Expect: service_role only.
select grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public' and routine_name = 'increment_interview_count';
