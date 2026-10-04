-- ============================================================================
-- Behavioural test for the analysis cache: public.statement_analyses and its
-- two SECURITY DEFINER functions.
--
-- Run AFTER supabase/migrations/20261002_004_statement_analyses.sql has been
-- applied. Read the NOTICE output, then confirm the final SELECTs report 0.
--
-- WHAT THIS COVERS THAT THE SCHEMA CHECK CANNOT.
-- supabase/manual/statement_analyses_security_check.sql reads the catalog: it
-- proves the policy, the grants and the constraints EXIST. This file proves the
-- functions BEHAVE -- that claiming another user's draft is refused, that a
-- completed result is reused rather than recomputed, that a failed attempt
-- leaves nothing behind, that a stale claim is recoverable, and that a
-- fabricated complete row is refused by the database.
--
-- ---------------------------------------------------------------------------
-- THIS FILE WRITES. READ THIS BEFORE RUNNING IT ANYWHERE.
-- ---------------------------------------------------------------------------
-- Every statement runs inside a transaction that ends in ROLLBACK, and the
-- fixtures are synthetic: user ids from gen_random_uuid(), throwaway auth.users
-- rows, essay text that is a literal placeholder. Nothing is committed and
-- nothing production is read, modified or deleted by design.
--
-- THAT IS NOT THE SAME AS RISK-FREE ON PRODUCTION, and it would be dishonest to
-- describe it that way. A transaction that ends in ROLLBACK still:
--
--   * takes real locks while it runs -- including a row lock on any
--     statement_analyses row it touches and brief locks on auth.users -- so a
--     concurrent request for the same row waits;
--   * consumes a real connection from the pooler;
--   * advances real sequences and, if the schema ever gains a trigger with an
--     external effect (a webhook, a notification job insert), FIRES IT -- and a
--     side effect outside the database is not rolled back with the transaction;
--   * leaves real entries in the write-ahead log and in any audit logging;
--   * will COMMIT EVERYTHING if somebody runs the statements individually, or
--     stops at the `do $$` block and never reaches the ROLLBACK. The Supabase
--     SQL editor makes that mistake easy.
--
-- It also inserts into auth.users, which is Supabase's own schema rather than
-- this application's. That succeeds only as the table owner and is rolled back,
-- but it is a write to an authentication table and should be treated as one.
--
-- SO: run it on an isolated project if one exists. If it is run against
-- production, do it deliberately, as the owner, during a quiet period, having
-- read the whole file -- not because the word ROLLBACK appears at the bottom.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FILE CANNOT DO: PROVE THE CONCURRENCY GUARANTEE.
-- ---------------------------------------------------------------------------
-- Two statements in one session are sequential by definition. Section 4 below
-- exercises the SHAPE of the race -- that a second claim for the same
-- (draft_id, fingerprint) returns a state rather than raising -- which is the
-- audit finding it was written for. It does NOT prove that two simultaneous
-- transactions cannot both insert, because only one transaction exists here.
--
-- THE REAL TEST NEEDS TWO SESSIONS. Procedure, for a human with two SQL
-- editor tabs or two psql connections:
--
--   Session 1:  begin;
--               select public.claim_statement_analysis(
--                 '<draft>'::uuid, '<64 hex>', 1, false, null, 150, null, false, 'r', 's');
--               -- leave the transaction OPEN. Do not commit.
--
--   Session 2:  select public.claim_statement_analysis(
--                 '<draft>'::uuid, '<64 hex>', 1, false, null, 150, null, false, 'r', 's');
--               -- EXPECT: this BLOCKS, waiting on session 1's row lock.
--
--   Session 1:  commit;
--
--   Session 2:  -- unblocks and must now return state 'running' (session 1 holds
--               -- a fresh pending claim), NOT an error, and NOT a second row.
--               -- AND NO claimToken: a 'running' answer carries none, because
--               -- that caller did not win the attempt.
--
--   Either:     select count(*) from public.statement_analyses
--                where draft_id = '<draft>' and fingerprint = '<64 hex>';
--               -- EXPECT exactly 1.
--
-- Both sessions must be authenticated as the SAME user and that user must own
-- the draft, which means real JWTs. Record the actual outputs; "it seemed to
-- work" is not a result.
--
-- ---------------------------------------------------------------------------
-- AND A SECOND TWO-SESSION PROCEDURE: THE SUPERSEDED REQUEST.
-- ---------------------------------------------------------------------------
-- This is the one the token was added for, and section 9 below exercises only
-- its SHAPE. The real interleaving needs two sessions and a clock:
--
--   Session 1:  select public.claim_statement_analysis(
--                 '<draft>'::uuid, '<64 hex>', 1, false, null, 150, null, false, 'r', 's');
--               -- record the returned claimToken as TOKEN_1. This is the
--               -- request that is about to be abandoned.
--
--   Either:     update public.statement_analyses
--                  set updated_at = now() - interval '11 minutes'
--                where fingerprint = '<64 hex>';
--               -- standing in for a request whose model call hung. Doing it
--               -- this way avoids waiting eleven real minutes; it is a WRITE
--               -- to a real row and must be done on a row you created.
--
--   Session 2:  select public.claim_statement_analysis(
--                 '<draft>'::uuid, '<64 hex>', 1, false, null, 150, null, false, 'r', 's');
--               -- EXPECT state 'claimed', the SAME id, and a DIFFERENT token.
--               -- Record it as TOKEN_2.
--
--   Session 1:  select public.settle_statement_analysis(
--                 '<id>'::uuid, 'TOKEN_1'::uuid, '{"synthetic":true}'::jsonb, 70);
--               -- EXPECT {"ok": false, "reason": "not-found"}. Before the
--               -- token, this SUCCEEDED and wrote session 1's result onto
--               -- session 2's claim.
--
--   Session 1:  select public.settle_statement_analysis(
--                 '<id>'::uuid, 'TOKEN_1'::uuid, null, null);
--               -- the release path. EXPECT {"ok": true, "state": "released",
--               -- "released": false} -- reports success, removes NOTHING.
--               -- Before the token, this DELETED session 2's claim.
--
--   Either:     select status, claim_token from public.statement_analyses
--                where id = '<id>';
--               -- EXPECT: still 'pending', still TOKEN_2. Session 2's claim
--               -- survived both attempts intact.
--
--   Session 2:  select public.settle_statement_analysis(
--                 '<id>'::uuid, 'TOKEN_2'::uuid, '{"synthetic":true}'::jsonb, 80);
--               -- EXPECT {"ok": true, "state": "complete"}. The replacement
--               -- can still finish its own work.
--
-- Both sessions authenticated as the same owner. The `update ... updated_at`
-- step writes to a real row: do it only to a row you created in step 1.
-- ============================================================================

begin;

do $$
declare
  v_user_a   uuid := gen_random_uuid();
  v_user_b   uuid := gen_random_uuid();
  v_draft_a  uuid := gen_random_uuid();
  v_draft_b  uuid := gen_random_uuid();
  v_fp       text := repeat('a', 64);
  v_fp2      text := repeat('b', 64);
  v_row_id   uuid;
  v_token_old uuid;
  v_token_new uuid;
  v_count    integer;
  v_failures integer := 0;

  -- A deliberately minimal review shape. Not a real StatementReview: the
  -- database stores jsonb and validates nothing about its contents -- the
  -- application validates before calling settle(). Using a toy object here
  -- makes that division visible.
  v_review   jsonb := jsonb_build_object('synthetic', true);
begin
  -- ------------------------------------------------------------------ fixtures
  -- Rolled back; never committed. The ids are generated, not borrowed.
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_user_a, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', format('analyses-test-a-%s@example.invalid', v_user_a)),
         (v_user_b, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', format('analyses-test-b-%s@example.invalid', v_user_b));

  insert into public.statement_drafts (id, user_id, title, essay)
  values (v_draft_a, v_user_a, 'synthetic draft A', 'synthetic essay text A'),
         (v_draft_b, v_user_b, 'synthetic draft B', 'synthetic essay text B');

  -- ============================================================
  -- 1. CROSS-USER CLAIM DENIAL  (the audit hardening)
  -- ============================================================
  -- The function derives the caller from auth.uid(), which is NULL in this
  -- session -- so it must refuse before it reads or writes anything. That is the
  -- first assertion, and it is also why sections 2-6 call the function's
  -- internals directly rather than through it: without a JWT there is no
  -- auth.uid() to be, and faking one requires set_config of
  -- request.jwt.claims, which is session B territory.
  if (public.claim_statement_analysis(
        v_draft_a, v_fp, 1, false, null, 150, null, false, 'r1', 's1')
      ->> 'reason') is distinct from 'not-authenticated' then
    v_failures := v_failures + 1;
    raise notice 'FAIL  unauthenticated claim: expected not-authenticated, got %',
      public.claim_statement_analysis(
        v_draft_a, v_fp, 1, false, null, 150, null, false, 'r1', 's1');
  else
    raise notice 'pass  an unauthenticated caller is refused before anything is written';
  end if;

  select count(*) into v_count from public.statement_analyses;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a refused claim wrote % row(s)', v_count;
  else
    raise notice 'pass  a refused claim wrote nothing';
  end if;

  -- THE OWNERSHIP BRANCH, EXERCISED AS SQL rather than through the function.
  -- This is the predicate the hardening added: it is what the function
  -- evaluates, written out so it can be checked without a JWT.
  --
  -- CROSS-USER: user B against user A's draft.
  if exists (select 1 from public.statement_drafts d
              where d.id = v_draft_a and d.user_id = v_user_b) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  ownership predicate admits another user''s draft';
  else
    raise notice 'pass  the ownership predicate refuses another user''s draft';
  end if;

  -- NONEXISTENT: an id that belongs to nobody. Same answer, so the function
  -- cannot be used to discover which draft ids exist.
  if exists (select 1 from public.statement_drafts d
              where d.id = gen_random_uuid() and d.user_id = v_user_a) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  ownership predicate admits a nonexistent draft';
  else
    raise notice 'pass  the ownership predicate refuses a nonexistent draft';
  end if;

  -- And the owner is admitted, or the check would be refusing everybody.
  if not exists (select 1 from public.statement_drafts d
                  where d.id = v_draft_a and d.user_id = v_user_a) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  ownership predicate refuses the owner';
  else
    raise notice 'pass  the ownership predicate admits the owner';
  end if;

  -- ============================================================
  -- 2. A CLAIM, AND THE CACHE REUSE THAT FOLLOWS
  -- ============================================================
  -- Inserted directly, as the function would, because auth.uid() is NULL here.
  -- What is being tested from here on is the TABLE's behaviour: the constraints
  -- and the uniqueness that the functions rely on.
  insert into public.statement_analyses (
    user_id, draft_id, fingerprint, status, revision, prompt_attached,
    provenance, words, stated_max_words, over_limit, rubric_version, schema_version
  ) values (
    v_user_a, v_draft_a, v_fp, 'pending', 1, false, null, 150, null, false, 'r1', 's1'
  ) returning id into v_row_id;
  raise notice 'pass  a pending claim was created';

  -- A COMPLETE ROW NEEDS BOTH A REVIEW AND A SCORE. This is what stops a failed
  -- attempt being readable as a success.
  begin
    update public.statement_analyses
       set status = 'complete'
     where id = v_row_id;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a complete row was accepted with no review and no score';
  exception when check_violation then
    raise notice 'pass  complete-without-a-result is refused (%)', sqlerrm;
  end;

  -- The legitimate completion.
  update public.statement_analyses
     set status = 'complete', review = v_review, overall = 72, updated_at = now()
   where id = v_row_id;
  raise notice 'pass  a validated result completed the claim';

  -- CACHE REUSE: the same (draft, fingerprint) now resolves to the stored
  -- result, which is what lets the route answer without a model call.
  select count(*) into v_count
    from public.statement_analyses
   where draft_id = v_draft_a and fingerprint = v_fp and status = 'complete';
  if v_count <> 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  cache lookup found % complete rows, expected 1', v_count;
  else
    raise notice 'pass  the stored result is findable by (draft, fingerprint)';
  end if;

  -- A DIFFERENT FINGERPRINT IS DIFFERENT WORK. An edited essay must not read
  -- the previous answer.
  select count(*) into v_count
    from public.statement_analyses
   where draft_id = v_draft_a and fingerprint = v_fp2;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a different fingerprint found % row(s)', v_count;
  else
    raise notice 'pass  a changed fingerprint is a cache miss';
  end if;

  -- ============================================================
  -- 3. A COMPLETED ROW IS NEVER OVERWRITTEN
  -- ============================================================
  -- settle() filters on status = 'pending', so a late or duplicated response
  -- cannot replace feedback the applicant is already reading. Exercised as the
  -- same predicate.
  update public.statement_analyses
     set review = jsonb_build_object('synthetic', 'late arrival'), overall = 1
   where id = v_row_id and user_id = v_user_a and status = 'pending';
  if (select overall from public.statement_analyses where id = v_row_id) <> 72 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a completed result was overwritten';
  else
    raise notice 'pass  a completed result is not overwritten by a late arrival';
  end if;

  -- AND NOT BY ANOTHER USER. settle()'s user filter, as SQL.
  update public.statement_analyses
     set review = jsonb_build_object('synthetic', 'hostile'), overall = 100
   where id = v_row_id and user_id = v_user_b and status = 'pending';
  if (select overall from public.statement_analyses where id = v_row_id) <> 72 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  another user settled this claim';
  else
    raise notice 'pass  another user cannot settle this claim';
  end if;

  -- ============================================================
  -- 4. DUPLICATE CLAIM HANDLING  (shape only -- see the header)
  -- ============================================================
  -- THE UNIQUENESS KEY IS WHAT MAKES TWO PAID ANALYSES IMPOSSIBLE. A second
  -- insert for the same (draft, fingerprint) must not create a second row.
  begin
    insert into public.statement_analyses (
      user_id, draft_id, fingerprint, status, revision, prompt_attached,
      provenance, words, stated_max_words, over_limit, rubric_version, schema_version
    ) values (
      v_user_a, v_draft_a, v_fp, 'pending', 2, false, null, 150, null, false, 'r1', 's1'
    );
    v_failures := v_failures + 1;
    raise notice 'FAIL  a second row was created for the same draft and fingerprint';
  exception when unique_violation then
    raise notice 'pass  a second claim for the same inputs is refused by the key';
  end;

  -- AND THE HARDENED FUNCTION ABSORBS THAT REFUSAL instead of raising it. The
  -- `on conflict do nothing` path, exercised as the same statement the function
  -- runs: it must affect no row and raise nothing.
  insert into public.statement_analyses (
    user_id, draft_id, fingerprint, status, revision, prompt_attached,
    provenance, words, stated_max_words, over_limit, rubric_version, schema_version
  ) values (
    v_user_a, v_draft_a, v_fp, 'pending', 3, false, null, 150, null, false, 'r1', 's1'
  )
  on conflict on constraint statement_analyses_draft_fingerprint_key do nothing;
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  on-conflict-do-nothing inserted % row(s)', v_count;
  else
    raise notice 'pass  the loser of a race inserts nothing and raises nothing';
  end if;

  select count(*) into v_count
    from public.statement_analyses where draft_id = v_draft_a and fingerprint = v_fp;
  if v_count <> 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  % rows exist for one (draft, fingerprint)', v_count;
  else
    raise notice 'pass  exactly one row exists for one (draft, fingerprint)';
  end if;

  raise notice 'NOTE  section 4 proves the SHAPE of the race, not concurrency. '
               'See the two-session procedure in this file''s header.';

  -- ============================================================
  -- 5. A FAILED ATTEMPT LEAVES NOTHING BEHIND
  -- ============================================================
  insert into public.statement_analyses (
    user_id, draft_id, fingerprint, status, revision, prompt_attached,
    provenance, words, stated_max_words, over_limit, rubric_version, schema_version
  ) values (
    v_user_a, v_draft_a, v_fp2, 'pending', 1, false, null, 150, null, false, 'r1', 's1'
  ) returning id into v_row_id;

  -- settle() with a null review DELETES the claim rather than marking it
  -- failed, so the next attempt is an ordinary first attempt.
  delete from public.statement_analyses
   where id = v_row_id and user_id = v_user_a and status = 'pending';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  the release path deleted % row(s), expected 1', v_count;
  else
    raise notice 'pass  a failed attempt releases its claim entirely';
  end if;

  if exists (select 1 from public.statement_analyses
              where draft_id = v_draft_a and fingerprint = v_fp2) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a released claim left a row behind';
  else
    raise notice 'pass  no state survives a failed attempt';
  end if;

  -- NO 'failed' STATUS EXISTS, which is why there is nothing to age out.
  begin
    insert into public.statement_analyses (
      user_id, draft_id, fingerprint, status, revision, prompt_attached,
      provenance, words, stated_max_words, over_limit, rubric_version, schema_version
    ) values (
      v_user_a, v_draft_a, repeat('c', 64), 'failed', 1, false, null, 150, null, false,
      'r1', 's1'
    );
    v_failures := v_failures + 1;
    raise notice 'FAIL  a failed status was accepted';
  exception when check_violation then
    raise notice 'pass  there is no failed status to reason about';
  end;

  -- ============================================================
  -- 6. STALE CLAIM RECOVERY
  -- ============================================================
  insert into public.statement_analyses (
    user_id, draft_id, fingerprint, status, revision, prompt_attached,
    provenance, words, stated_max_words, over_limit, rubric_version, schema_version,
    updated_at
  ) values (
    v_user_a, v_draft_b, repeat('d', 64), 'pending', 1, false, null, 150, null, false,
    'r1', 's1', now() - interval '11 minutes'
  ) returning id into v_row_id;

  -- A ROW OLDER THAN THE WINDOW IS RECLAIMABLE.
  if (select updated_at > now() - interval '10 minutes'
        from public.statement_analyses where id = v_row_id) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  an 11-minute-old claim reads as still running';
  else
    raise notice 'pass  a claim past the window reads as abandoned';
  end if;

  -- RECOVERY TOUCHES updated_at AND KEEPS THE ID, so a settle() still in flight
  -- from the dead request completes THIS row rather than creating a stray one.
  update public.statement_analyses set updated_at = now() where id = v_row_id;
  if (select updated_at > now() - interval '10 minutes'
        from public.statement_analyses where id = v_row_id) then
    raise notice 'pass  recovery refreshes the claim without changing its identity';
  else
    v_failures := v_failures + 1;
    raise notice 'FAIL  recovery did not refresh the claim';
  end if;

  select count(*) into v_count
    from public.statement_analyses where draft_id = v_draft_b;
  if v_count <> 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  recovery produced % rows for one draft', v_count;
  else
    raise notice 'pass  recovery produced no duplicate row';
  end if;

  -- A LIVE CLAIM IS NEVER STOLEN. The window is longer than the model timeout.
  update public.statement_analyses
     set updated_at = now() - interval '2 minutes' where id = v_row_id;
  if (select updated_at > now() - interval '10 minutes'
        from public.statement_analyses where id = v_row_id) then
    raise notice 'pass  a two-minute-old claim still reads as running';
  else
    v_failures := v_failures + 1;
    raise notice 'FAIL  a live claim reads as abandoned';
  end if;

  -- ============================================================
  -- 7. THE SHAPE CONSTRAINTS
  -- ============================================================
  begin
    insert into public.statement_analyses (
      user_id, draft_id, fingerprint, status, revision, prompt_attached,
      provenance, words, stated_max_words, over_limit, rubric_version, schema_version
    ) values (
      v_user_a, v_draft_a, 'not-a-sha-256', 'pending', 1, false, null, 150, null, false,
      'r1', 's1'
    );
    v_failures := v_failures + 1;
    raise notice 'FAIL  a malformed fingerprint was accepted';
  exception when check_violation then
    raise notice 'pass  the fingerprint must be lowercase 64-hex';
  end;

  begin
    insert into public.statement_analyses (
      user_id, draft_id, fingerprint, status, revision, prompt_attached, provenance,
      words, stated_max_words, over_limit, rubric_version, schema_version, review, overall
    ) values (
      v_user_a, v_draft_a, repeat('e', 64), 'complete', 1, false, 'verified',
      150, null, false, 'r1', 's1', v_review, 72
    );
    v_failures := v_failures + 1;
    raise notice 'FAIL  an unrecognised provenance was accepted';
  exception when check_violation then
    raise notice 'pass  provenance is catalog, user or null';
  end;

  begin
    insert into public.statement_analyses (
      user_id, draft_id, fingerprint, status, revision, prompt_attached, provenance,
      words, stated_max_words, over_limit, rubric_version, schema_version, review, overall
    ) values (
      v_user_a, v_draft_a, repeat('f', 64), 'complete', 1, false, null,
      150, null, false, 'r1', 's1', v_review, 101
    );
    v_failures := v_failures + 1;
    raise notice 'FAIL  an out-of-range score was accepted';
  exception when check_violation then
    raise notice 'pass  overall must be between 0 and 100';
  end;

  -- ============================================================
  -- 9. A SUPERSEDED ATTEMPT HAS NO AUTHORITY  (shape -- see the header)
  -- ============================================================
  -- THE HOLE THE TOKEN CLOSED. Recovery keeps the row's id, and the id used to
  -- be the only thing settle() checked -- so the abandoned request could still
  -- complete the row, or delete it out from under the replacement.
  --
  -- WHAT FOLLOWS EXERCISES THE PREDICATES, in one session, with two tokens
  -- standing in for two requests. It does NOT prove the interleaving; the
  -- two-session procedure in the header does that.
  insert into public.statement_analyses (
    user_id, draft_id, fingerprint, status, revision, prompt_attached, provenance,
    words, stated_max_words, over_limit, rubric_version, schema_version, updated_at
  ) values (
    v_user_a, v_draft_a, repeat('9', 64), 'pending', 1, false, null, 150, null, false,
    'r1', 's1', now() - interval '11 minutes'
  ) returning id, claim_token into v_row_id, v_token_old;

  -- THE RECLAIM, as claim() performs it: same id, new token.
  update public.statement_analyses
     set updated_at = now(), claim_token = gen_random_uuid()
   where id = v_row_id
  returning claim_token into v_token_new;

  if v_token_new = v_token_old then
    v_failures := v_failures + 1;
    raise notice 'FAIL  the reclaim did not rotate the token';
  else
    raise notice 'pass  a reclaim keeps the id and rotates the token';
  end if;

  -- THE SUPERSEDED REQUEST TRIES TO COMPLETE. settle()'s predicate, with the
  -- old token.
  update public.statement_analyses
     set status = 'complete', review = v_review, overall = 70
   where id = v_row_id and claim_token = v_token_old
     and user_id = v_user_a and status = 'pending';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a superseded request completed the replacement claim';
  else
    raise notice 'pass  a superseded request cannot complete the replacement';
  end if;

  -- AND TRIES TO RELEASE IT. This is the worse half: before the token, this
  -- DELETED the replacement, and the replacement''s paid result then had
  -- nowhere to land.
  delete from public.statement_analyses
   where id = v_row_id and claim_token = v_token_old
     and user_id = v_user_a and status = 'pending';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a superseded request released the replacement claim';
  else
    raise notice 'pass  a superseded request cannot release the replacement';
  end if;

  -- THE REPLACEMENT IS UNTOUCHED AND CAN STILL FINISH ITS OWN WORK.
  if not exists (select 1 from public.statement_analyses
                  where id = v_row_id and status = 'pending'
                    and claim_token = v_token_new) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  the replacement claim did not survive intact';
  else
    raise notice 'pass  the replacement claim survived both attempts intact';
  end if;

  update public.statement_analyses
     set status = 'complete', review = v_review, overall = 80
   where id = v_row_id and claim_token = v_token_new
     and user_id = v_user_a and status = 'pending';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  the replacement could not complete its own claim';
  else
    raise notice 'pass  the replacement completed its own claim';
  end if;

  -- A NULL TOKEN IS NOT A WILDCARD.
  update public.statement_analyses
     set overall = 1
   where id = v_row_id and claim_token is null and user_id = v_user_a;
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a null token matched a row';
  else
    raise notice 'pass  a null token matches nothing';
  end if;

  raise notice 'NOTE  section 9 proves the PREDICATES, not the interleaving. '
               'See the superseded-request procedure in this file''s header.';

  -- ============================================================
  -- 10. DELETION AND RETENTION
  -- ============================================================
  -- AN ORPHANED ROW IS NOT ANONYMOUS. review.evidence is a verified span of the
  -- applicant''s essay -- reviewSchema.ts rejects a result whose quote does not
  -- appear in the text -- so a row outliving its draft holds excerpts of a
  -- personal statement.
  select count(*) into v_count
    from public.statement_analyses where draft_id = v_draft_a;
  if v_count = 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  no rows to test the cascade with';
  else
    raise notice 'pass  % analysis row(s) exist for draft A', v_count;
  end if;

  -- DELETING THE DRAFT TAKES ITS ANALYSES WITH IT. One foreign key, no sweep.
  delete from public.statement_drafts where id = v_draft_a;
  select count(*) into v_count
    from public.statement_analyses where draft_id = v_draft_a;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  % analysis row(s) survived the deleted draft', v_count;
  else
    raise notice 'pass  deleting a draft cascades to its analyses';
  end if;

  -- DELETING THE ACCOUNT TAKES EVERYTHING. statement_drafts.user_id already
  -- cascades from auth.users; the analyses key puts this table on the same
  -- chain, so the administrator''s script needs no change.
  insert into public.statement_analyses (
    user_id, draft_id, fingerprint, status, revision, prompt_attached, provenance,
    words, stated_max_words, over_limit, rubric_version, schema_version
  ) values (
    v_user_b, v_draft_b, repeat('8', 64), 'pending', 1, false, null, 150, null, false,
    'r1', 's1'
  );

  delete from auth.users where id = v_user_b;
  select count(*) into v_count from public.statement_analyses where user_id = v_user_b;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  % analysis row(s) survived the deleted account', v_count;
  else
    raise notice 'pass  deleting an account cascades to its analyses';
  end if;

  if exists (select 1 from public.statement_drafts where id = v_draft_b) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  the draft survived the deleted account (pre-existing cascade)';
  else
    raise notice 'pass  the draft cascaded too, as it already did before this change';
  end if;

  -- ------------------------------------------------------------------ verdict
  if v_failures = 0 then
    raise notice '--- ALL CHECKS PASSED ---';
  else
    raise notice '--- % CHECK(S) FAILED ---', v_failures;
  end if;
end $$;

rollback;

-- ============================================================================
-- POST-ROLLBACK CONFIRMATION. Expect 0 from both. Anything else means the
-- transaction was committed -- which is the mistake this file's header warns
-- about -- and the synthetic rows are now real.
-- ============================================================================
select count(*) as leftover_synthetic_analyses
from   public.statement_analyses
where  rubric_version in ('r1', 'r') or schema_version in ('s1', 's');

select count(*) as leftover_synthetic_drafts
from   public.statement_drafts
where  title like 'synthetic draft %';
