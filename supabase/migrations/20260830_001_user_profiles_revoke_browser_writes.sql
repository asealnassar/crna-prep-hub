-- ============================================================================
-- Step 20 (revised) — remove all browser write access to public.user_profiles.
--
-- Supersedes 20260830_000, which was written before the production functions
-- were inspected and mis-stated the risk. Corrected picture:
--
--   * handle_new_user() — SECURITY DEFINER, AFTER INSERT on auth.users —
--     already creates the profile row with subscription_tier='free' and
--     interview_count=0. Signup never needed client INSERT.
--   * guard_user_profile_privileges() — BEFORE INSERT/UPDATE — already forces
--     subscription_tier and stripe_customer_id back to their old values for
--     every non-service-role request. Tier self-upgrade was therefore NOT
--     possible via PostgREST, contrary to the earlier report.
--   * What the guard does NOT cover: interview_count and
--     has_used_free_interview. Those remain freely writable by any
--     authenticated user against their own row, which is enough to reset the
--     free-interview allowance to zero and practise indefinitely.
--
-- RUN ONLY AFTER the deploy that removed the browser's writes. Both are live:
--   * app/interview/page.tsx no longer updates interview_count (Step 20)
--   * app/signup/page.tsx no longer inserts the profile row (this revision)
--
-- Not touched: the Step 17B anonymous lockdown, the SELECT policies, the
-- auth.users trigger, guard_user_profile_privileges(), and service_role.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-FLIGHT (read-only). Expect zero rows: a privilege granted to PUBLIC
-- would survive a revoke aimed at `authenticated` and must be handled
-- separately, since revoking from PUBLIC affects every role at once.
-- ---------------------------------------------------------------------------
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'user_profiles'
  and  grantee = 'PUBLIC';

-- ---------------------------------------------------------------------------
-- MIGRATION
-- ---------------------------------------------------------------------------
begin;

-- RLS stays on; asserted so this file is self-contained and re-runnable.
alter table public.user_profiles enable row level security;

-- 1. Atomic usage increment for the server's service-role client.
--    Locked down deliberately:
--      * one uuid parameter, no column or value is caller-controlled
--      * a single UPDATE statement, so concurrent starts cannot both read the
--        same value and write the same +1
--      * empty search_path with fully schema-qualified names, so a hostile
--        temp schema cannot shadow the target table
--      * EXECUTE held only by service_role
--    guard_user_profile_privileges() still fires on this UPDATE and simply
--    re-asserts the unchanged tier and Stripe id, which is the desired result.
create or replace function public.increment_interview_count(p_user_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.user_profiles
     set interview_count = coalesce(public.user_profiles.interview_count, 0) + 1
   where public.user_profiles.id = p_user_id
  returning public.user_profiles.interview_count;
$$;

revoke all on function public.increment_interview_count(uuid) from public;
revoke all on function public.increment_interview_count(uuid) from anon;
revoke all on function public.increment_interview_count(uuid) from authenticated;
grant execute on function public.increment_interview_count(uuid) to service_role;

-- 2. The browser needs to read profiles and nothing else. Revoking everything
--    and re-granting only SELECT is stricter and clearer than column-level
--    grants, and leaves no user-writable column behind.
--    This covers INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER.
revoke all privileges on table public.user_profiles from authenticated;
grant select on table public.user_profiles to authenticated;

-- 3. Drop the policies that now describe a privilege the role does not hold.
--    Leaving them would misstate the security model to the next reader.
drop policy if exists "Users can update own profile" on public.user_profiles;
drop policy if exists "Users can update own interview_count" on public.user_profiles;

-- SELECT policies are deliberately untouched:
--   "Users can view own profile"   — own-row read, required by the app
--   "admins can view all profiles" — admin analytics and the messaging picker
-- anon remains fully revoked from Step 17B. "Anyone can read profiles" is NOT
-- recreated. service_role table access is not modified anywhere in this file.

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect exactly one row: authenticated / SELECT. No anon rows at all.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'user_profiles'
  and  grantee in ('anon','authenticated')
order  by grantee, privilege_type;

-- Expect: "Users can view own profile" and "admins can view all profiles"
-- only. No update policies, no "Anyone can read profiles".
select policyname, cmd, roles
from   pg_policies
where  schemaname = 'public' and tablename = 'user_profiles'
order  by policyname;

-- Expect: service_role / EXECUTE, and nothing else.
select grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public' and routine_name = 'increment_interview_count';

-- Expect: on_auth_user_created still present and untouched.
select tgname, pg_get_triggerdef(oid) as definition
from   pg_trigger
where  tgrelid = 'auth.users'::regclass and not tgisinternal;
