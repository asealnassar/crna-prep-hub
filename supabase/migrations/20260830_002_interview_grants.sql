-- ============================================================================
-- Step 21 — server-owned authorization for in-progress interviews.
--
-- The engine state travels with each request, so a continuation could be
-- fabricated: a free user who had spent their allowance could hand-craft
-- `state` and keep consuming model calls. New interviews were gated; continued
-- ones were not, because re-checking the allowance on every turn would cut off
-- an interview the user had legitimately started.
--
-- A grant row is created by the server when an interview is legitimately
-- started, and every later turn must present its id.
--
-- Why not reuse interview_sessions: the browser inserts into that table
-- directly (conversation, engine_state, scores). A table the client can write
-- cannot authorize the client — a user could insert a row and "continue" it.
-- This table is written only with the service role, holds no conversation
-- content, and is unreadable from the browser.
--
-- Safe to run at any time. The application already treats a missing table as
-- "checks inactive" and keeps working, so there is no ordering requirement in
-- either direction.
--
-- PRE-FLIGHT (read-only). Expect zero rows: the table should not exist yet.
--   select tablename from pg_tables
--   where schemaname = 'public' and tablename = 'interview_grants';
-- ============================================================================
begin;

create table if not exists public.interview_grants (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  mode           text,
  interview_type text,
  turns_used     integer not null default 0,
  completed      boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists interview_grants_user_id_idx
  on public.interview_grants (user_id);

-- RLS on with no policies at all: the browser has no read or write path, and
-- the service role bypasses RLS. Nothing here is needed client-side.
alter table public.interview_grants enable row level security;

revoke all privileges on table public.interview_grants from anon;
revoke all privileges on table public.interview_grants from authenticated;

-- Supabase's default privileges usually grant ALL on new public tables to
-- postgres, anon, authenticated and service_role -- which is why the revokes
-- above are needed. Do not rely on that for service_role: bypassing RLS is not
-- the same as holding SQL table privileges, and a project whose default
-- privileges have been altered would leave the server unable to read or write
-- this table. Granted explicitly, and only what the server actually uses:
--   INSERT  createGrant()   -- issuing a grant when an interview starts
--   SELECT  checkGrant()    -- ownership, completion and cap checks
--   UPDATE  completeGrant() -- marking an interview finished
-- No DELETE: nothing in the application removes grants.
grant select, insert, update on table public.interview_grants to service_role;

-- Atomic turn RESERVATION, not merely an atomic increment.
--
-- The cap lives in the WHERE clause rather than in the application. Checking
-- turns_used in TypeScript and then incrementing is a time-of-check /
-- time-of-use race: two continuations arriving at turns_used = 23 could both
-- pass the check and drive the counter to 25, buying an extra model call. A
-- conditional UPDATE takes a row lock, so the second statement re-evaluates
-- against the committed value and matches no row.
--
-- No row returned means: grant missing, already completed, or at the cap. The
-- API treats a null result as a refusal and returns 403 BEFORE calling OpenAI,
-- so a refused turn costs nothing.
--
-- COUPLING: 24 is duplicated from MAX_TURNS_PER_INTERVIEW in
-- lib/interviewSession.ts (MAX_PRIMARY_QUESTIONS 10 + FOLLOW_UP_BUDGET 8 + 6
-- margin). It is a literal here on purpose -- SQL cannot import the TypeScript
-- constant, and accepting a maximum as a parameter would hand the caller the
-- one value worth attacking. The database is the authority; the TypeScript
-- constant only mirrors it. Changing either REQUIRES changing both.
--
-- Same hardening as increment_interview_count: one uuid parameter, single
-- statement, empty search_path, table schema-qualified, execute restricted to
-- service_role.
create or replace function public.consume_interview_turn(p_grant_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.interview_grants
     set turns_used = coalesce(turns_used, 0) + 1
   where id = p_grant_id
     and completed = false
     and coalesce(turns_used, 0) < 24
  returning turns_used;
$$;

revoke all on function public.consume_interview_turn(uuid) from public;
revoke all on function public.consume_interview_turn(uuid) from anon;
revoke all on function public.consume_interview_turn(uuid) from authenticated;
grant execute on function public.consume_interview_turn(uuid) to service_role;

-- SECURITY DEFINER runs as the function's owner. create-or-replace assigns
-- ownership to whoever executes this file (postgres in the Supabase SQL
-- Editor); pinned explicitly so it cannot drift if replaced by another role.
alter function public.consume_interview_turn(uuid) owner to postgres;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect: rowsecurity = true.
select relname, relrowsecurity
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relname = 'interview_grants';

-- Expect: zero rows. The browser has no access at all.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'interview_grants'
  and  grantee in ('anon','authenticated');

-- Expect: exactly INSERT, SELECT, UPDATE for service_role. If DELETE also
-- appears it came from default privileges; harmless, but not required.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'interview_grants'
  and  grantee = 'service_role'
order  by privilege_type;

-- Expect: zero rows. No policies is intentional, not an oversight.
select policyname from pg_policies
where  schemaname = 'public' and tablename = 'interview_grants';

-- Expect: service_role / EXECUTE only.
select grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public' and routine_name = 'consume_interview_turn';

-- Expect: prosecdef = true and proconfig containing search_path=.
select proname, prosecdef, proconfig, pg_get_userbyid(proowner) as owner
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and p.proname = 'consume_interview_turn';

-- Cap behaviour is NOT exercised here. A schema migration should not insert,
-- mutate and delete a production row to prove a function works. Run
-- supabase/tests/consume_interview_turn_test.sql separately; it is wrapped in
-- an explicit rollback and commits nothing.
