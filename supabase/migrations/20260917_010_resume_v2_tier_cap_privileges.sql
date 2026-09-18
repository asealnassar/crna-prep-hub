-- ============================================================================
-- 010  RESUME V2: THE CAP HELPER IS PRIVATE, ENFORCED
--
-- WHAT THIS FIXES. public.resume_v2_tier_cap(text) is meant to be callable by
-- nobody. It is the private helper the write-boundary triggers read, 007 says
-- so in its own comments, and lib/resume/writeBoundary.test.ts asserts it is
-- granted to no one. A read of the live catalog during the 007 verification
-- step returned something else:
--
--   authenticated  EXECUTE = true      <-- wrong
--   anon           EXECUTE = false
--   service_role   EXECUTE = true
--
-- WHY 007'S REVOKES DID NOT CLOSE IT. 007 revokes the function from `public`
-- and from `anon`, and stops there:
--
--   revoke all on function public.resume_v2_tier_cap(text) from public;
--   revoke all on function public.resume_v2_tier_cap(text) from anon;
--
-- A Supabase project ships ALTER DEFAULT PRIVILEGES granting EXECUTE on new
-- functions in `public` to anon, authenticated and service_role. Those are
-- EXPLICIT grants to named roles. `revoke ... from public` removes only the
-- PUBLIC pseudo-role's implicit EXECUTE and leaves every named grant standing,
-- so the revoke has to name each role it means. anon was named and removed.
-- authenticated was not named, so it survived. The two trigger functions later
-- in the same migration each carry the third line; this one was missed.
--
-- 009 DID NOT CLOSE IT EITHER. CREATE OR REPLACE preserves a function's ACL, so
-- replacing the body changed the cap's VALUE and nothing about who may read it.
-- Applying 009 therefore leaves this exposure exactly where it was, and 009's
-- own verification query -- "expect ZERO rows" from routine_privileges -- is
-- what surfaces it.
--
-- WHAT IT ACTUALLY EXPOSED, not inflated. The function is `immutable`, takes a
-- tier as text and returns an integer. It reads no table, writes nothing, and
-- holds no session state. Any signed-in user could reach it at
-- /rest/v1/rpc/resume_v2_tier_cap and learn the cap numbers. That is disclosure
-- of a product rule, not privilege escalation: the cap that governs a write is
-- applied inside enforce_resume_v2_write_boundary(), which is SECURITY DEFINER
-- and evaluates this helper as its owner, so what a caller may execute here
-- changes no stored value and lifts no limit.
--
-- It is still wrong, and wrong in the direction where the next reader assumes a
-- control exists that does not.
--
-- 007 AND 009 ARE NOT MODIFIED. Both are applied and stay byte-stable. This
-- file changes privileges only: it does not replace the function, so the body
-- 009 installed is the body that remains.
--
-- SERVICE_ROLE KEEPS EXECUTE, deliberately. Nothing requires it -- the trigger
-- reads the helper as a DEFINER, so a backend write never consults the caller's
-- privileges -- but service_role is the trusted server key that already
-- bypasses RLS on every table in this schema. Removing one function from it
-- buys no security and gives the offline V1 -> V2 migration writer a new way to
-- fail. The role that must not hold this is the one the browser carries.
--
-- NO TABLE IS TOUCHED. No column, no constraint, no index, no policy, no
-- trigger, no row.
--
-- ORDERING. This file depends only on the function existing, which 007 created.
-- It is numbered after 009 because that is where it was written, but it may be
-- applied at any point after 007 if the exposure should be closed sooner.
--
-- PRE-FLIGHT (read-only). Expect true / false / true -- the state this fixes.
--   select has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
--          has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role
--   from   pg_proc p
--   where  p.pronamespace = 'public'::regnamespace
--     and  p.proname = 'resume_v2_tier_cap';
-- ============================================================================
begin;

-- The line 007 and 009 are missing. `revoke all` rather than `revoke execute`
-- to match the idiom every other revoke in this series uses; EXECUTE is the
-- only privilege a function carries, so the two are the same instruction.
revoke all on function public.resume_v2_tier_cap(text) from authenticated;

-- Re-asserted rather than assumed. Revoking a privilege that is not held is a
-- no-op and never an error, so these two cost nothing and leave the helper
-- correct whatever order this database had things applied in -- including one
-- where a later replay re-granted what 007 removed.
revoke all on function public.resume_v2_tier_cap(text) from public;
revoke all on function public.resume_v2_tier_cap(text) from anon;

-- service_role is deliberately not modified. See the header.
--
-- The other three private helpers in this series -- enforce_resume_v2_write_
-- boundary(), enforce_resume_section_v2_boundary() and guard_resume_entitlement_
-- fields() -- already carry an explicit `from authenticated` revoke in 007 and
-- 008 respectively, so none of them is re-asserted here. They are checked in
-- the verification below rather than taken on trust.

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only; run after the migration)
-- ---------------------------------------------------------------------------

-- 1. The three roles the finding named. Expect false / false / true.
select has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_expect_false,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_expect_false,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role_expect_true,
       coalesce(p.proacl::text, '(NULL -- PUBLIC can execute, which is a FAIL)') as acl
from   pg_proc p
where  p.pronamespace = 'public'::regnamespace
  and  p.proname = 'resume_v2_tier_cap';

-- 2. Every private helper in the V2 series, side by side. Expect four rows,
--    false in both columns on all of them. The absence of this check is what
--    let 007 ship a helper `authenticated` could call.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_expect_false,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_expect_false
from   pg_proc p
where  p.pronamespace = 'public'::regnamespace
  and  p.proname in ('resume_v2_tier_cap',
                     'enforce_resume_v2_write_boundary',
                     'enforce_resume_section_v2_boundary',
                     'guard_resume_entitlement_fields')
order  by p.proname;

-- 3. The seven public RPCs are untouched by this migration: expect every row
--    true. A revoke that caught a grant it was not aimed at would show here.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_expect_true
from   pg_proc p
where  p.pronamespace = 'public'::regnamespace
  and  p.proname in ('create_resume_v2','save_resume_v2','save_resume_strength_v2',
                     'record_ai_usage','settle_ai_usage','record_resume_import',
                     'settle_resume_import')
order  by p.proname;

-- 4. Every role that can still execute the helper. Expect true for the owner
--    and service_role only; anything else in this list is a finding.
select r.rolname,
       has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
from   pg_proc p
       cross join pg_roles r
where  p.pronamespace = 'public'::regnamespace
  and  p.proname = 'resume_v2_tier_cap'
  and  r.rolname in ('anon','authenticated','authenticator','service_role','postgres')
order  by r.rolname;

-- 5. The cap still returns the locked numbers: 010 changes privileges only.
--    Expect 1 / 1 / null / 1.
select public.resume_v2_tier_cap('free')     as free,
       public.resume_v2_tier_cap('premium')  as premium,
       public.resume_v2_tier_cap('ultimate') as ultimate,
       public.resume_v2_tier_cap('nonsense') as unknown_tier_is_free;

-- 6. Expect the row counts to be UNCHANGED. This migration writes no data.
select (select count(*) from public.resumes)         as resumes,
       (select count(*) from public.resume_sections) as sections,
       (select count(*) from public.resume_scores)   as scores;
