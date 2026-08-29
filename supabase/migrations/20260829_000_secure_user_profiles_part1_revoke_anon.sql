-- ============================================================================
-- Step 17, Part 1 — close the anonymous read of public.user_profiles.
--
-- Problem: an unauthenticated request carrying only the public anon key could
-- run GET /rest/v1/user_profiles?select=* and receive every row, including
-- email and stripe_customer_id. The anon key ships in the browser bundle by
-- design, so this was effectively public.
--
-- This part removes anonymous access and nothing else. It does NOT change what
-- authenticated users can see, so no existing feature changes behaviour.
-- Part 2 applies per-row least privilege and DOES have prerequisites — read
-- its header before running it.
--
-- Safe to run inside a transaction; roll back if any statement errors.
-- ============================================================================
begin;

-- Defence in depth: policies only take effect when RLS is on.
alter table public.user_profiles enable row level security;

-- The anon role has no legitimate need for this table. Signup currently
-- inserts a profile from the browser; if that insert runs before a session
-- exists (email confirmation enabled), it executes as anon and this revoke
-- WILL break signup. Confirm that before running -- see the report.
revoke all on public.user_profiles from anon;

-- Remove any policy that grants the anon role access. Named policies vary by
-- project, so drop by name using the inspection output; this block removes
-- every policy whose role list includes anon or public.
do $$
declare p record;
begin
  for p in
    select policyname
    from   pg_policies
    where  schemaname = 'public'
      and  tablename  = 'user_profiles'
      and  (roles::text[] && array['anon','public'])
  loop
    execute format('drop policy %I on public.user_profiles', p.policyname);
    raise notice 'dropped policy %', p.policyname;
  end loop;
end $$;

-- The service role bypasses RLS entirely; backend access is unaffected.

commit;
