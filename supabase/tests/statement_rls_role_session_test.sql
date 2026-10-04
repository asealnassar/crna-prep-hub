-- ============================================================================
-- RLS AND GRANTS, EXERCISED FROM A GENUINE NON-PRIVILEGED SESSION.
--
-- Run this file TWICE, connecting as a different role each time:
--
--   export PGOPTIONS="-c crna.rehearsal_confirm=disposable-local-cluster"
--   psql -U authenticated -f supabase/tests/statement_rls_role_session_test.sql
--   psql -U anon          -f supabase/tests/statement_rls_role_session_test.sql
--
-- It detects which role is connected and runs the matching battery. Expect
-- 18 passes as authenticated and 8 as anon.
--
-- WHY A SEPARATE FILE FROM THE BEHAVIOURAL TESTS.
-- supabase/manual/statement_analyses_security_check.sql proves the policy and
-- the grants EXIST. The behavioural tests prove the functions BEHAVE -- but they
-- run as the table owner, and AN OWNER SESSION BYPASSES RLS ENTIRELY. A policy
-- can be present, correct in the catalog, and still never consulted. Only a
-- session that is neither the owner nor a superuser can show that it bites.
--
-- That is why section 0 REFUSES TO RUN as the owner or as a superuser. A green
-- result obtained from a privileged session would be worse than no result,
-- because it would look like evidence.
--
-- THIS FILE REQUIRES THE SCAFFOLD. It reads the fixed synthetic ids created by
-- supabase/tests/local_rehearsal_fixtures.sql and will not work without them.
-- It is therefore a LOCAL-CLUSTER test and nothing else: on Supabase the anon
-- and authenticated roles are NOLOGIN, so you cannot connect as them at all.
--
-- WHAT IT WRITES. It calls claim_statement_analysis, which inserts. Everything
-- runs inside one transaction that ends in ROLLBACK, so the file is repeatable
-- and leaves nothing behind. See the long note in
-- statement_analyses_behaviour_test.sql on why ROLLBACK is not the same as
-- risk-free; here it matters less, because this file cannot run on Supabase.
-- ============================================================================

-- One transaction ON PURPOSE: psql without ON_ERROR_STOP prints an error and
-- carries on, which would let section 0's refusal be ignored.
begin;

-- ---- 0. REFUSE A PRIVILEGED OR PRODUCTION SESSION ------------------------
do $guard$
declare
  v_signals text[] := '{}';
  v_super   boolean := (select usesuper from pg_user where usename = current_user);
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
      using hint = 'This file depends on synthetic scaffold fixtures and on '
                || 'connecting AS anon / authenticated, which Supabase does not '
                || 'permit. It has no meaning on a managed project.';
  end if;

  if current_setting('crna.rehearsal_confirm', true)
       is distinct from 'disposable-local-cluster' then
    raise exception 'REFUSING TO RUN: the disposable-cluster opt-in is not set.'
      using hint = 'set crna.rehearsal_confirm = ''disposable-local-cluster'';';
  end if;

  -- THE POINT OF THE FILE. An owner or superuser session proves nothing here.
  if coalesce(v_super, false) then
    raise exception 'REFUSING TO RUN as a SUPERUSER (%).', current_user
      using hint = 'A superuser bypasses RLS, so every assertion below would '
                || 'pass without the policies existing. Connect as anon or '
                || 'authenticated instead.';
  end if;

  if current_user not in ('anon', 'authenticated') then
    raise exception 'REFUSING TO RUN as %. Connect as anon or authenticated.',
      current_user
      using hint = 'If this role owns the statement tables it also bypasses '
                || 'RLS, which would make a green result meaningless.';
  end if;

  raise notice 'guard passed: role=% superuser=%', current_user, coalesce(v_super, false);
end
$guard$;

do $t$
declare
  A   uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  B   uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  DA  uuid := 'dddddddd-0000-4000-8000-00000000000a';  -- A's draft
  DB_ uuid := 'dddddddd-0000-4000-8000-00000000000b';  -- B's draft
  EA  uuid := 'eeeeeeee-0000-4000-8000-00000000000a';  -- A's analysis
  EB  uuid := 'eeeeeeee-0000-4000-8000-00000000000b';  -- B's analysis
  SETA uuid := '11111111-0000-4000-8000-000000000001'; -- the ACTIVE set
  v_pass int := 0;
  v_fail int := 0;
  v_n int;
  v_j jsonb;
  v_t uuid;
  v_own_id uuid;
begin
  -- fixtures must be present, or every count below would be a vacuous zero
  if not exists (select 1 from pg_class where relname = 'statement_analyses') then
    raise exception 'migrations not applied: public.statement_analyses is missing';
  end if;

  -- ======================================================================
  if current_user = 'authenticated' then
  -- ======================================================================
    -- sign in as applicant A, exactly as PostgREST does
    perform set_config('request.jwt.claims', json_build_object('sub', A)::text, true);
    if auth.uid() is distinct from A then
      raise exception 'request.jwt.claims did not take effect; auth.uid() = %', auth.uid();
    end if;

    ---- analyses: reads -------------------------------------------------
    select count(*) into v_n from public.statement_analyses;
    if v_n = 1 then v_pass := v_pass + 1;
      raise notice 'pass  A sees exactly 1 analysis (the owner session sees 2)';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  A sees % analyses, expected 1', v_n; end if;

    select count(*) into v_n from public.statement_analyses where user_id = B;
    if v_n = 0 then v_pass := v_pass + 1;
      raise notice 'pass  B''s analysis is invisible to A (the row exists; RLS hides it)';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  A can see % of B''s analyses', v_n; end if;

    select count(*) into v_n from public.statement_analyses where id = EB;
    if v_n = 0 then v_pass := v_pass + 1;
      raise notice 'pass  addressing B''s analysis by primary key still returns nothing';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  A read B''s analysis by id'; end if;

    ---- analyses: writes ------------------------------------------------
    -- There is NO insert/update/delete grant on this table for anybody. The
    -- only writer is the SECURITY DEFINER function.
    begin
      insert into public.statement_analyses (user_id, draft_id, fingerprint, status,
        revision, prompt_attached, words, over_limit, rubric_version, schema_version)
      values (A, DA, repeat('c', 64), 'complete', 1, false, 10, false, 'rehearsal-rubric', 'rehearsal-schema');
      v_fail := v_fail + 1; raise warning 'FAIL  the applicant INSERTED an analysis directly';
    exception when insufficient_privilege then
      v_pass := v_pass + 1; raise notice 'pass  direct INSERT refused (no INSERT grant)';
    end;

    begin
      update public.statement_analyses set overall = 100;
      v_fail := v_fail + 1; raise warning 'FAIL  the applicant UPDATED an analysis directly';
    exception when insufficient_privilege then
      v_pass := v_pass + 1; raise notice 'pass  direct UPDATE refused -- scores cannot be self-awarded';
    end;

    begin
      delete from public.statement_analyses;
      v_fail := v_fail + 1; raise warning 'FAIL  the applicant DELETED analyses directly';
    exception when insufficient_privilege then
      v_pass := v_pass + 1; raise notice 'pass  direct DELETE refused';
    end;

    ---- the RPC boundary ------------------------------------------------
    -- p_provenance's vocabulary is catalog|user. Sending anything else is
    -- answered with 'invalid' rather than raising -- which is itself the
    -- parameter-validation guarantee, and is easy to trip over when writing
    -- a test: an 'invalid' reply looks like a refusal but is not the one
    -- being tested.
    v_j := public.claim_statement_analysis(DB_, repeat('d', 64), 1, false, 'catalog',
                                           100, null, false, 'rehearsal-rubric', 'rehearsal-schema');
    if (v_j->>'ok')::boolean is false and v_j->>'reason' = 'not-found' then
      v_pass := v_pass + 1;
      raise notice 'pass  A cannot claim B''s draft through the RPC (reason=not-found)';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  cross-user claim returned %', v_j; end if;

    select count(*) into v_n from public.statement_analyses
     where draft_id = DB_ and fingerprint = repeat('d', 64);
    if v_n > 0 then v_fail := v_fail + 1;
      raise warning 'FAIL  % row(s) landed on B''s draft', v_n;
    else
      raise notice 'note  nothing visible on B''s draft -- but RLS alone would hide it,'
        ' so this is NOT proof of absence. Count it from the owner session.';
    end if;

    -- the definer writes what the applicant cannot
    v_j := public.claim_statement_analysis(DA, repeat('e', 64), 1, false, 'catalog',
                                           100, null, false, 'rehearsal-rubric', 'rehearsal-schema');
    if (v_j->>'ok')::boolean and v_j->>'state' = 'claimed'
       and (v_j->>'claimToken') is not null then
      v_pass := v_pass + 1;
      raise notice 'pass  A claims its own draft and receives a claim token';
      v_t := (v_j->>'claimToken')::uuid;
      v_own_id := (v_j->>'id')::uuid;
    else v_fail := v_fail + 1;
      raise warning 'FAIL  own-draft claim returned %', v_j; end if;

    v_j := public.settle_statement_analysis(EB, v_t, '{"synthetic": true}'::jsonb, 99);
    if (v_j->>'ok')::boolean is false then
      v_pass := v_pass + 1; raise notice 'pass  A cannot settle B''s analysis (ok=false)';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  A settled B''s analysis: %', v_j; end if;

    -- Guard the next assertion against its own vacuity: a NULL id would make
    -- settle miss for the wrong reason and the test would pass having proved
    -- nothing about the token.
    if v_own_id is null then
      raise exception 'v_own_id was never captured -- the token test would be vacuous';
    end if;
    v_j := public.settle_statement_analysis(v_own_id, gen_random_uuid(),
                                            '{"synthetic": true}'::jsonb, 50);
    if (v_j->>'ok')::boolean is false then
      v_pass := v_pass + 1; raise notice 'pass  a forged claim token is refused on A''s own row';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  forged token accepted: %', v_j; end if;

    ---- the school catalog ----------------------------------------------
    select count(*) into v_n from public.statement_requirement_sets;
    if v_n = 1 then v_pass := v_pass + 1;
      raise notice 'pass  only the ACTIVE requirement set is visible (1 of 2)';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  % sets visible, expected 1', v_n; end if;

    select count(*) into v_n from public.statement_requirements;
    if v_n = 1 then v_pass := v_pass + 1;
      raise notice 'pass  only the document in the active set is visible (1 of 2)';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  % documents visible, expected 1', v_n; end if;

    select count(*) into v_n from public.statement_requirements where label = 'Hidden Doc';
    if v_n = 0 then v_pass := v_pass + 1;
      raise notice 'pass  a document disappears WITH ITS SET, not only on its own flag';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  the hidden document is visible'; end if;

    begin
      insert into public.statement_requirements
        (set_id, school_id, document_type, label, prompt_text)
      values (SETA, gen_random_uuid(), 'personal-statement', 'Forged', 'x');
      v_fail := v_fail + 1; raise warning 'FAIL  the applicant INSERTED a catalog document';
    exception when insufficient_privilege then
      v_pass := v_pass + 1;
      raise notice 'pass  catalog INSERT refused -- school requirements are not applicant-writable';
    end;

    begin
      update public.statement_requirements set prompt_text = 'tampered';
      v_fail := v_fail + 1; raise warning 'FAIL  the applicant UPDATED a catalog document';
    exception when insufficient_privilege then
      v_pass := v_pass + 1;
      raise notice 'pass  catalog UPDATE refused -- the prompt text cannot be tampered with';
    end;

    begin
      update public.statement_requirement_sets set is_active = true;
      v_fail := v_fail + 1; raise warning 'FAIL  the applicant ACTIVATED a requirement set';
    exception when insufficient_privilege then
      v_pass := v_pass + 1; raise notice 'pass  an applicant cannot activate an unverified set';
    end;

    ---- drafts ----------------------------------------------------------
    select count(*) into v_n from public.statement_drafts;
    if v_n = 1 then v_pass := v_pass + 1;
      raise notice 'pass  A sees only its own draft';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  % drafts visible, expected 1', v_n; end if;

    begin
      insert into public.statement_drafts (user_id, title, essay) values (B, 'forged', 'x');
      v_fail := v_fail + 1; raise warning 'FAIL  A inserted a draft owned by B';
    exception when insufficient_privilege or check_violation then
      v_pass := v_pass + 1; raise notice 'pass  A cannot insert a draft owned by B';
    end;

    raise notice '--- authenticated session: % passed, % failed (expected 18 / 0) ---',
      v_pass, v_fail;

  -- ======================================================================
  elsif current_user = 'anon' then
  -- ======================================================================
    if auth.uid() is not null then
      raise exception 'anon carries a subject (%) -- the scaffold is wrong', auth.uid();
    end if;
    v_pass := v_pass + 1; raise notice 'pass  auth.uid() is NULL -- no JWT, no identity';

    begin
      select count(*) into v_n from public.statement_analyses;
      v_fail := v_fail + 1; raise warning 'FAIL  anon READ % analyses', v_n;
    exception when insufficient_privilege then
      v_pass := v_pass + 1;
      raise notice 'pass  anon cannot read statement_analyses AT ALL -- no SELECT grant, '
        'so RLS is never even consulted';
    end;

    begin
      select count(*) into v_n from public.statement_drafts;
      v_fail := v_fail + 1; raise warning 'FAIL  anon READ % drafts', v_n;
    exception when insufficient_privilege then
      v_pass := v_pass + 1; raise notice 'pass  anon cannot read statement_drafts -- essays are not public';
    end;

    -- Two independent defences: no EXECUTE grant, and 'not-authenticated' if
    -- one were ever granted. Either outcome is a pass; both are recorded so
    -- the reader can tell WHICH defence answered.
    begin
      v_j := public.claim_statement_analysis(DA, repeat('a', 64), 1, false, 'catalog',
                                             100, null, false, 'rehearsal-rubric', 'rehearsal-schema');
      if v_j->>'reason' = 'not-authenticated' then
        v_pass := v_pass + 1;
        raise notice 'pass  the claim RPC refuses anon with not-authenticated '
          '(EXECUTE is open; the predicate held)';
      else v_fail := v_fail + 1;
        raise warning 'FAIL  anon claim returned %', v_j; end if;
    exception when insufficient_privilege then
      v_pass := v_pass + 1;
      raise notice 'pass  anon cannot even EXECUTE claim_statement_analysis -- '
        'refused at the grant, before any code runs';
    end;

    begin
      v_j := public.settle_statement_analysis(EA, gen_random_uuid(),
                                              '{"synthetic": true}'::jsonb, 100);
      if (v_j->>'ok')::boolean is false then
        v_pass := v_pass + 1; raise notice 'pass  the settle RPC refuses anon (ok=false)';
      else v_fail := v_fail + 1;
        raise warning 'FAIL  anon settled an analysis: %', v_j; end if;
    exception when insufficient_privilege then
      v_pass := v_pass + 1; raise notice 'pass  anon cannot EXECUTE settle_statement_analysis';
    end;

    -- the catalog IS deliberately public, but only where active
    select count(*) into v_n from public.statement_requirement_sets;
    if v_n = 1 then v_pass := v_pass + 1;
      raise notice 'pass  anon sees the active requirement set (the catalog is public by design)';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  anon sees % sets, expected 1', v_n; end if;

    select count(*) into v_n from public.statement_requirements where label = 'Hidden Doc';
    if v_n = 0 then v_pass := v_pass + 1;
      raise notice 'pass  anon cannot see a document whose set is inactive';
    else v_fail := v_fail + 1;
      raise warning 'FAIL  anon sees the hidden document'; end if;

    begin
      insert into public.statement_requirements
        (set_id, school_id, document_type, label, prompt_text)
      values (SETA, gen_random_uuid(), 'personal-statement', 'Forged', 'x');
      v_fail := v_fail + 1; raise warning 'FAIL  anon INSERTED a catalog document';
    exception when insufficient_privilege then
      v_pass := v_pass + 1; raise notice 'pass  anon cannot write the catalog';
    end;

    raise notice '--- anon session: % passed, % failed (expected 8 / 0) ---', v_pass, v_fail;
  end if;

  if v_fail > 0 then
    raise exception '% assertion(s) failed in a genuine % session', v_fail, current_user;
  end if;
  raise notice '--- ALL CHECKS PASSED ---';
end
$t$;

rollback;
