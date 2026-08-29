-- ============================================================================
-- Step 17B — EMERGENCY: close the anonymous read of public.user_profiles.
--
-- Confirmed root cause (from production inspection):
--   RLS is ENABLED, but the policy "Anyone can read profiles"
--     cmd: SELECT, role: public, using: true
--   matches every row for every role, including anon. The anon role also holds
--   broad table grants (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
--   TRIGGER), so it can reach the table in the first place.
--
-- Result: GET /rest/v1/user_profiles?select=* returned all 505 rows —
-- including email and stripe_customer_id — to anyone holding the public anon
-- key, which ships in the browser bundle by design.
--
-- Scope: anonymous containment ONLY.
--   * The `authenticated` role is not touched.
--   * The tier-escalation problem (users can UPDATE their own
--     subscription_tier / interview_count) is NOT addressed here — next step.
--   * The own-row least-privilege rework is NOT applied here; messaging and
--     admin analytics still read other users' profiles from the browser.
--
-- Supersedes the earlier part1 migration, which used a DO block that dropped
-- every policy whose roles included `public`. That was wrong: the legitimate
-- own-profile policies also use the `public` role and would have been
-- destroyed. This migration names the single offending policy explicitly.
-- ============================================================================
begin;

-- A. RLS is already enabled; asserted here so the migration is self-contained
--    and safe to re-run.
alter table public.user_profiles enable row level security;

-- B. Drop ONLY the permissive read-everything policy. Named explicitly — no
--    pattern matching, no role-based sweep.
drop policy if exists "Anyone can read profiles" on public.user_profiles;

-- C. Remove the anon role's table-level privileges. This is the change that
--    actually closes the leak: the surviving own-profile policies are written
--    for the `public` role (which includes anon), but with no table privilege
--    anon cannot reach the table for those policies to be evaluated at all.
revoke all privileges on table public.user_profiles from anon;

-- D. Column-level privileges are tracked separately from table-level ones in
--    PostgreSQL, so a table-level REVOKE is not guaranteed to clear them.
--    information_schema.column_privileges lists both the expansion of
--    table-level grants and any explicit per-column grants; after step C, any
--    row still present for anon is a genuine column-level grant. Revoke each
--    one by name rather than assuming none exist.
do $$
declare g record;
begin
  for g in
    select distinct column_name, privilege_type
    from   information_schema.column_privileges
    where  table_schema = 'public'
      and  table_name   = 'user_profiles'
      and  grantee      = 'anon'
  loop
    execute format(
      'revoke %s (%I) on table public.user_profiles from anon',
      g.privilege_type, g.column_name
    );
    raise notice 'revoked column privilege % on %', g.privilege_type, g.column_name;
  end loop;
end $$;

commit;

-- ============================================================================
-- VERIFICATION — run after the COMMIT above. Read-only.
-- ============================================================================

-- 1. Expect: "Anyone can read profiles" absent; the own-profile and admin
--    policies still present.
select policyname, cmd, roles
from   pg_policies
where  schemaname = 'public' and tablename = 'user_profiles'
order  by policyname;

-- 2. Expect: zero rows for anon. Rows for authenticated are expected and
--    intentionally untouched in this step.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'user_profiles'
  and  grantee in ('anon','authenticated')
order  by grantee, privilege_type;

-- 3. Expect: zero rows. Any row here means a column grant survived.
select grantee, column_name, privilege_type
from   information_schema.column_privileges
where  table_schema = 'public' and table_name = 'user_profiles'
  and  grantee = 'anon';

-- 4. Separate escape hatch to rule out: privileges granted to PUBLIC (the
--    pseudo-role) apply to anon too, and the earlier inspection filtered to
--    the named roles so would not have shown them. Expect zero rows.
--    NOT revoked automatically here: a REVOKE ... FROM PUBLIC would also
--    strip the authenticated role, which this step must leave alone.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'user_profiles'
  and  grantee = 'PUBLIC';
