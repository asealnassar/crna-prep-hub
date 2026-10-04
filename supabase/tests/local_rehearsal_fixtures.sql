-- ============================================================================
-- SYNTHETIC FIXTURES for the isolated local rehearsal.
--
-- Run AFTER supabase/tests/local_rehearsal_scaffold.sql and AFTER the six
-- statement migrations: this file writes to their tables.
--
-- COMMITTED, not rolled back -- deliberately. The role-session test connects as
-- a different role and the concurrency harness opens two more connections, and
-- an uncommitted row is invisible to all of them. That is precisely why those
-- tests need a disposable database rather than a transaction.
--
-- Every id below is a fixed, obviously-synthetic literal (aaaa..., dddd...)
-- chosen so a stray row is recognisable at a glance. No real applicant content.
--
-- THIS FILE IS FOR A DISPOSABLE LOCAL CLUSTER ONLY, and writes to auth.users.
-- Section 0 refuses to let it run anywhere else by accident.
-- ============================================================================

-- One transaction ON PURPOSE: psql without ON_ERROR_STOP prints an error and
-- carries on, which would let section 0's refusal be ignored.
begin;

-- ---- 0. REFUSE TO RUN ON A MANAGED SUPABASE DATABASE ---------------------
do $guard$
declare
  v_signals text[] := '{}';
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
      using hint = 'This file writes synthetic rows to auth.users and commits '
                || 'them. It is for a disposable local cluster only.';
  end if;

  if current_setting('crna.rehearsal_confirm', true)
       is distinct from 'disposable-local-cluster' then
    raise exception 'REFUSING TO RUN: the disposable-cluster opt-in is not set.'
      using hint = 'set crna.rehearsal_confirm = ''disposable-local-cluster''; '
                || 'or export PGOPTIONS="-c crna.rehearsal_confirm=disposable-local-cluster"';
  end if;

  raise notice 'guard passed: installing synthetic fixtures';
end
$guard$;

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'a@example.invalid'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'b@example.invalid');

insert into public.statement_drafts (id, user_id, title, essay) values
  ('dddddddd-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001',
   'A draft', 'synthetic essay text for applicant A'),
  ('dddddddd-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002',
   'B draft', 'synthetic essay text for applicant B');

-- One COMPLETED analysis per applicant. Two rows, not one, so that a
-- cross-user read test fails against a row that genuinely exists rather than
-- passing because the table happens to be empty.
insert into public.statement_analyses
  (id, user_id, draft_id, fingerprint, status, revision, prompt_attached, words,
   over_limit, overall, review, rubric_version, schema_version)
values
  ('eeeeeeee-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001',
   'dddddddd-0000-4000-8000-00000000000a', repeat('a', 64), 'complete', 1, false, 150,
   false, 70, '{"synthetic": true}'::jsonb, 'rehearsal-rubric', 'rehearsal-schema'),
  ('eeeeeeee-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002',
   'dddddddd-0000-4000-8000-00000000000b', repeat('b', 64), 'complete', 1, false, 160,
   false, 80, '{"synthetic": true}'::jsonb, 'rehearsal-rubric', 'rehearsal-schema');

-- One ACTIVE verified set and one INACTIVE one, each with a document, so the
-- visibility tests can prove a document disappears WITH ITS SET rather than
-- only when its own is_active is false.
insert into public.statement_requirement_sets
  (id, school_id, verification_status, source_url, verified_on, original_text, is_active)
values
  ('11111111-0000-4000-8000-000000000001', gen_random_uuid(), 'verified',
   'https://example.invalid/synthetic', current_date, 'synthetic active set', true),
  ('22222222-0000-4000-8000-000000000002', gen_random_uuid(), 'verified',
   'https://example.invalid/synthetic', current_date, 'synthetic inactive set', false);

insert into public.statement_requirements
  (id, set_id, school_id, document_type, label, prompt_text)
values
  ('33333333-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001',
   gen_random_uuid(), 'personal-statement', 'Visible Doc', 'synthetic prompt'),
  ('44444444-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000002',
   gen_random_uuid(), 'personal-statement', 'Hidden Doc', 'synthetic prompt');

commit;

select 'fixtures installed' as status,
       (select count(*) from auth.users)                    as users,
       (select count(*) from public.statement_drafts)        as drafts,
       (select count(*) from public.statement_analyses)      as analyses,
       (select count(*) from public.statement_requirement_sets) as sets,
       (select count(*) from public.statement_requirements)  as documents;
