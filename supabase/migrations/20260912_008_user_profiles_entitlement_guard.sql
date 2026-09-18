-- ============================================================================
-- Entitlement source integrity for public.user_profiles.
--
-- WHY THIS EXISTS. Migration 007 enforces the resume creation cap and the
-- finalization rule from user_profiles.subscription_tier. That makes the tier
-- column load-bearing: if a user can write it, they can write themselves an
-- Ultimate plan and every rule 007 added evaporates. A control is only as
-- strong as the value it reads.
--
-- WHAT THE AUDIT FOUND, and why this is defensive rather than a fix for a known
-- hole. The repository's history says the column is already protected twice
-- over -- 20260830_001 revoked every browser write privilege on the table, and
-- a production trigger named guard_user_profile_privileges() forces
-- subscription_tier and stripe_customer_id back to their previous values for
-- non-service-role writes. Both are almost certainly live: the application code
-- they were waiting on has shipped (signup no longer inserts the profile row,
-- and the interview page no longer writes interview_count).
--
-- Two things are nonetheless true and worth closing:
--
--   1. guard_user_profile_privileges() EXISTS ONLY AS A COMMENT IN THIS REPO.
--      It was created directly against the database and never captured in a
--      migration, so nobody reviewing this codebase can see what it does, and a
--      project built from these migrations -- the staging project, for
--      instance -- would not have it at all.
--
--   2. 20260829_001 is a draft that says DO NOT RUN and nevertheless sits in
--      the migrations directory GRANTing insert and update on this table. A
--      replay applies it before 20260830_001 revokes it again, so the end state
--      is correct by ordering alone. That is a thin thing to rely on.
--
-- So this migration makes the invariant self-asserting: after it runs, the tier
-- is system-controlled whatever the prior state of the database was.
--
-- IT DOES NOT REPLACE THE PRODUCTION GUARD. A deliberately different name, so
-- CREATE OR REPLACE cannot clobber a function this repository has never seen
-- and quietly drop the stripe_customer_id protection along with it. Where both
-- exist they agree, and re-asserting a value that is already correct changes
-- nothing.
--
-- THE LEGITIMATE PATH IS UNAFFECTED. The only writer of subscription_tier in
-- the application is app/api/webhook/route.ts, the Stripe webhook, which uses
-- the service-role key. The guard reads request.jwt.claims and exempts only a
-- request whose JWT role is service_role. Direct database work with no request
-- JWT (SQL editor, migrations and admin scripts) is also left unrestricted.
-- handle_new_user() and the server-side interview counter remain on trusted
-- server-side paths.
--
-- PRE-FLIGHT (read-only). Expect authenticated / SELECT only, and no rows for
-- anon. Anything else means a browser write privilege is live.
--   select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'user_profiles'
--     and grantee in ('anon', 'authenticated') order by grantee, privilege_type;
-- ============================================================================
begin;

alter table public.user_profiles enable row level security;

-- ---------------------------------------------------------------------------
-- 1. The guard
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER with an empty search_path and qualified references, matching
-- every other guard in this schema. It is a trigger function -- no arguments,
-- returns `trigger` -- so PostgREST does not expose it and it cannot be called.
--
-- It FORCES rather than raises, which is what the production guard does: a
-- self-promotion attempt succeeds as a no-op instead of returning an error that
-- tells the caller what to try next. The stored value is the assertion, which
-- is what the adversarial test checks.

create or replace function public.guard_resume_entitlement_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  claims text := current_setting('request.jwt.claims', true);
  jwt_role text;
begin
  -- Direct database work (SQL editor, migrations, admin scripts) has no
  -- request JWT and remains unrestricted.
  if claims is null then
    return new;
  end if;

  jwt_role := claims::json ->> 'role';

  -- The Stripe webhook and other trusted backend writes use service_role.
  if jwt_role = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A profile a user creates for themselves starts on the free plan with no
    -- billing identity, whatever the payload said.
    new.subscription_tier := 'free';
    new.stripe_customer_id := null;
    return new;
  end if;

  -- An ordinary profile update may change anything except what it is billed
  -- for. Both fields are put back to what they were, so an update that touches
  -- neither is unaffected and an update that tries to is a no-op on those two
  -- columns alone.
  new.subscription_tier := old.subscription_tier;
  new.stripe_customer_id := old.stripe_customer_id;
  return new;
end
$fn$;

revoke all on function public.guard_resume_entitlement_fields() from public;
revoke all on function public.guard_resume_entitlement_fields() from anon;
revoke all on function public.guard_resume_entitlement_fields() from authenticated;

drop trigger if exists user_profiles_entitlement_guard on public.user_profiles;
create trigger user_profiles_entitlement_guard
  before insert or update on public.user_profiles
  for each row execute function public.guard_resume_entitlement_fields();

-- ---------------------------------------------------------------------------
-- 2. The grants, re-asserted
-- ---------------------------------------------------------------------------
--
-- The browser reads profiles and writes nothing. Verified against the code
-- rather than assumed: every `from('user_profiles')` in app/, components/ and
-- lib/ that is not a `.select()` runs server-side under the service role
-- (the Stripe webhook and lib/interviewUsage.ts). No client component writes
-- this table.
--
-- GRANT is additive, so the revoke has to come first. This is a re-assertion of
-- what 20260830_001 already did, written to be safe to run whatever state the
-- database is in -- including one where the DO-NOT-RUN draft was applied last.

revoke all privileges on table public.user_profiles from anon;
revoke all privileges on table public.user_profiles from authenticated;
grant select on table public.user_profiles to authenticated;

-- service_role is deliberately not modified anywhere in this file.

-- ---------------------------------------------------------------------------
-- 3. Policies that would describe privileges the role no longer holds
-- ---------------------------------------------------------------------------
--
-- Dropped by every name they have been given across the two earlier migrations.
-- Leaving them behind would misstate the security model to the next reader, and
-- would silently become live again if anyone re-granted the table.
--
-- The SELECT policies are untouched, deliberately: own-row read is required by
-- the application, and the admin policy backs analytics and the messaging
-- picker.

drop policy if exists "user_profiles_insert_own"              on public.user_profiles;
drop policy if exists "user_profiles_update_own"              on public.user_profiles;
drop policy if exists "Users can update own profile"          on public.user_profiles;
drop policy if exists "Users can update own interview_count"  on public.user_profiles;
drop policy if exists "Users can insert own profile"          on public.user_profiles;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect exactly one row: authenticated / SELECT. No anon rows at all, and no
-- INSERT, UPDATE, DELETE or TRUNCATE for either.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'user_profiles'
  and  grantee in ('anon', 'authenticated')
order  by grantee, privilege_type;

-- Expect SELECT policies only. No cmd of INSERT, UPDATE, DELETE or ALL.
select policyname, cmd, roles
from   pg_policies
where  schemaname = 'public' and tablename = 'user_profiles'
order  by policyname;

-- Expect the new guard, and -- if it is present in this database -- the
-- pre-existing production one alongside it. Both may coexist; they agree.
select tgname, pg_get_triggerdef(oid) as definition
from   pg_trigger
where  tgrelid = 'public.user_profiles'::regclass and not tgisinternal
order  by tgname;

-- Expect prosecdef = true and proconfig {search_path=}.
select p.proname, p.prosecdef as security_definer, p.proconfig
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and p.proname = 'guard_resume_entitlement_fields';

-- Expect no anon or authenticated rows. postgres (the owner) and service_role
-- may retain EXECUTE; neither is a browser-carried role.
select grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public'
  and  routine_name = 'guard_resume_entitlement_fields'
  and  grantee in ('anon', 'authenticated', 'service_role', 'postgres')
order  by grantee, privilege_type;

-- Expect the tier distribution to be UNCHANGED. This migration writes no data.
select coalesce(subscription_tier, 'null') as tier, count(*)
from   public.user_profiles group by 1 order by 1;
