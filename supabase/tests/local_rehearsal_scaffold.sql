-- ============================================================================
-- SETUP for the isolated local rehearsal. Creates a synthetic Supabase-like
-- environment plus synthetic fixtures, so the statement migrations and the
-- role-session and two-session tests can run on a throwaway PostgreSQL cluster.
--
-- THIS FILE IS FOR A DISPOSABLE LOCAL CLUSTER ONLY. It creates login roles and
-- writes to auth.users. Running it anywhere else would be a security change.
-- Section 0 refuses to let that happen by accident; read it before overriding.
--
-- ORDER OF OPERATIONS:
--   1. createdb a throwaway database on a local cluster
--   2. this file                              (as the cluster's owner role)
--   3. the six statement migrations, in filename order
--   4. supabase/tests/local_rehearsal_fixtures.sql  (as the owner role)
--   5. supabase/tests/statement_rls_role_session_test.sql   (as authenticated,
--                                                            then as anon)
--   6. supabase/tests/statement_analyses_concurrency_two_session.sh
--
-- Every file in that list needs the disposable-cluster opt-in. The least
-- awkward way to supply it is on the connection:
--
--   export PGOPTIONS="-c crna.rehearsal_confirm=disposable-local-cluster"
--
-- WHERE THIS DIFFERS FROM SUPABASE -- read this before trusting any result:
--   * auth.users here has six columns; Supabase's has roughly thirty-five.
--     Nothing under test reads any of the others.
--   * the three roles are given LOGIN so each can be a genuine separate
--     session. Supabase's are NOLOGIN and PostgREST reaches them with SET ROLE.
--     Connecting directly is STRICTER: current_user is the role from the first
--     statement and no superuser is in the picture at all.
--   * Supabase's schema DEFAULT PRIVILEGES are not reproduced. That is the one
--     thing this rehearsal cannot test, and it is exactly what the migrations'
--     revoke-before-grant exists to defeat -- so a clean grant matrix here is
--     WEAKER evidence than a clean one on the real project.
--   * no PostgREST, no GoTrue. A signed-in applicant is simulated by setting
--     request.jwt.claims directly. Real JWT verification is not exercised.
-- ============================================================================

-- The whole file is one transaction ON PURPOSE. psql without ON_ERROR_STOP
-- prints an error and CARRIES ON, which would let section 0's refusal be
-- ignored and the roles get created anyway. Inside a transaction, a raise
-- aborts it and every statement below fails too.
begin;

-- ---- 0. REFUSE TO RUN ON A MANAGED SUPABASE DATABASE ----------------------
do $guard$
declare
  v_signals text[] := '{}';
  v_optin   text   := current_setting('crna.rehearsal_confirm', true);
begin
  if exists (select 1 from pg_roles where rolname in
       ('supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin',
        'supabase_read_only_user', 'authenticator', 'dashboard_user'))
  then v_signals := array_append(v_signals, 'Supabase-managed roles exist'); end if;

  if exists (select 1 from pg_extension where extname in
       ('pg_graphql', 'pgsodium', 'supabase_vault', 'pg_net'))
  then v_signals := array_append(v_signals, 'Supabase extensions installed'); end if;

  if exists (select 1 from pg_namespace where nspname in
       ('graphql', 'graphql_public', 'realtime', '_realtime', 'storage', 'vault'))
  then v_signals := array_append(v_signals, 'Supabase schemas present'); end if;

  if array_length(v_signals, 1) is not null then
    raise exception
      'REFUSING TO RUN: this looks like a managed Supabase database (%).',
      array_to_string(v_signals, '; ')
      using hint = 'This file creates LOGIN roles and writes to auth.users. It '
                || 'is for a disposable local cluster only. There is no '
                || 'override: if you genuinely need this on a managed project, '
                || 'do it by hand, statement by statement, having read each one.';
  end if;

  -- Fail closed. An unset opt-in is a refusal, not a default.
  if v_optin is distinct from 'disposable-local-cluster' then
    raise exception
      'REFUSING TO RUN: the disposable-cluster opt-in is not set.'
      using hint = 'If this really is a throwaway local database, run: '
                || 'set crna.rehearsal_confirm = ''disposable-local-cluster''; '
                || 'then re-run this file.';
  end if;

  raise notice 'guard passed: no Supabase-managed objects found, opt-in present';
end
$guard$;

-- ---- 1. THE ROLES POSTGREST WOULD SWITCH TO ------------------------------
create role anon          login;
create role authenticated login;
create role service_role  login;

-- ---- 2. THE auth SCHEMA AND ITS ONE TABLE --------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id          uuid primary key default gen_random_uuid(),
  instance_id uuid,
  aud         text,
  role        text,
  email       text,
  created_at  timestamptz not null default now()
);

-- Supabase's own definition: the subject claim of the request's JWT, or NULL.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

-- PostgREST needs USAGE on public to see anything; Supabase grants this.
grant usage on schema public to anon, authenticated, service_role;

commit;

select 'scaffold installed -- now apply the six migrations, then '
       || 'supabase/tests/local_rehearsal_fixtures.sql' as next_step;
