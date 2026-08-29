-- ============================================================================
-- Step 17, Part 2 — per-row least privilege for authenticated users.
--
-- DO NOT RUN THIS YET. Step 17B closes the anonymous leak on its own;
-- this file remains a draft for a later step and has NOT been reviewed against
-- the production policy set that the inspection revealed. It restricts SELECT to the caller's own row, which
-- breaks two features that currently read other users' profiles from the
-- browser:
--
--   1. components/MessagesModal.tsx:150 and :245 read the counterpart's and
--      sender's `email` for every conversation. NOT admin-gated -- this runs
--      for every ordinary user. After this migration those names render as
--      "Unknown" until the lookup moves to a server route.
--   2. app/admin/analytics/page.tsx:28 selects every profile from the browser.
--      The admin user table empties out until it reads through a server route
--      using the service role (the pattern /api/admin/users already uses).
--
-- Apply this only after those two reads have server-side replacements.
--
-- Grants below assume the app keeps creating profiles from the client at
-- signup. If signup moves to an auth.users trigger, drop the INSERT policy
-- and the INSERT grant.
-- ============================================================================
begin;

alter table public.user_profiles enable row level security;

-- SELECT: own row only. `(select auth.uid())` is wrapped so the planner
-- evaluates it once per query rather than once per row.
drop policy if exists "user_profiles_select_own" on public.user_profiles;
create policy "user_profiles_select_own"
  on public.user_profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

-- INSERT: required by app/signup/page.tsx:33, which creates the profile row
-- client-side straight after signUp(). WITH CHECK prevents a user creating a
-- row under someone else's id.
drop policy if exists "user_profiles_insert_own" on public.user_profiles;
create policy "user_profiles_insert_own"
  on public.user_profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = id);

-- UPDATE: required by app/interview/page.tsx:456, which increments
-- interview_count client-side. USING controls which rows are visible to the
-- update; WITH CHECK stops the row being reassigned to another user's id.
drop policy if exists "user_profiles_update_own" on public.user_profiles;
create policy "user_profiles_update_own"
  on public.user_profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- DELETE: no application code deletes a profile, so no policy and no grant.
-- The service role still deletes if backend code ever needs to.

revoke all on public.user_profiles from anon, authenticated;
grant select, insert, update on public.user_profiles to authenticated;

commit;

-- ----------------------------------------------------------------------------
-- KNOWN GAP, deliberately not addressed here: interview_count and
-- subscription_tier live on a row the user may update. A user can still set
-- their own interview_count back to 0, or set subscription_tier to 'ultimate',
-- because column-level restriction is not expressible in an RLS policy.
-- Closing that needs either column grants plus a trigger, or moving those
-- writes server-side. Flagged, not fixed.
-- ----------------------------------------------------------------------------
