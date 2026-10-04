-- ============================================================================
-- Behavioural test for the school requirement catalog:
-- public.statement_requirement_sets, public.statement_requirements, and the two
-- columns 005 adds to public.statement_drafts.
--
-- Run AFTER both of these have been applied:
--   supabase/migrations/20261002_005_statement_requirements.sql
--   supabase/migrations/20261002_006_statement_requirement_length_register.sql
--
-- Read the NOTICE output, then confirm the final SELECTs report 0.
--
-- WHAT THIS COVERS THAT THE POSTCHECKS CANNOT. The two postcheck files read the
-- catalog: they prove the policies, grants and constraints EXIST with the
-- definitions written. This file proves they FIRE -- that an unverified set
-- cannot be activated, that an unknown register is rejected, that a row cannot
-- both show a length and bound it, that the draft constraints hold, and that a
-- legacy prompt-backed draft still satisfies every new rule.
--
-- ---------------------------------------------------------------------------
-- THIS FILE WRITES. READ THIS BEFORE RUNNING IT ANYWHERE.
-- ---------------------------------------------------------------------------
-- Every statement runs inside a transaction that ends in ROLLBACK, and the
-- fixtures are synthetic: ids from gen_random_uuid(), a throwaway auth.users
-- row, school ids that belong to no school, and prompt text that is a literal
-- placeholder. Nothing is committed and nothing production is read, modified or
-- deleted by design.
--
-- THAT IS NOT THE SAME AS RISK-FREE ON PRODUCTION. A transaction that ends in
-- ROLLBACK still:
--
--   * takes real locks while it runs, including on public.statement_drafts --
--     the table holding every applicant's work -- so concurrent saves wait;
--   * consumes a real connection from the pooler;
--   * advances real sequences and fires any trigger with an effect outside the
--     database, which a ROLLBACK does not undo;
--   * leaves real write-ahead log and audit entries;
--   * will COMMIT EVERYTHING if somebody runs the statements individually, or
--     stops at the `do $$` block and never reaches the ROLLBACK. The Supabase
--     SQL editor makes that mistake easy, and this file inserts into
--     statement_drafts, so a committed run would leave a fake draft in a real
--     applicant table.
--
-- It also inserts into auth.users, which is Supabase's own authentication
-- schema rather than this application's.
--
-- SO: run it on an isolated project if one exists. If it is run against
-- production, do it deliberately, as the owner, during a quiet period, having
-- read the whole file -- not because the word ROLLBACK appears at the bottom.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FILE CANNOT DO: PROVE RLS VISIBILITY.
-- ---------------------------------------------------------------------------
-- This session is the table owner, for whom RLS is NOT ENFORCED. So the
-- inactive-versus-active visibility rule -- the one that keeps a withdrawn
-- requirement out of a picker -- cannot be tested here at all. Section 5 proves
-- the DATA shape the policy depends on; it does not prove the policy filters.
--
-- THE REAL TEST NEEDS A NON-OWNER SESSION. Procedure, for a human:
--
--   1. In this session, create an ACTIVE verified set with one document, and
--      COMMIT it (deliberately, knowing it is now a real catalog row).
--   2. From a browser or curl with the anon key and no Authorization header:
--        GET /rest/v1/statement_requirement_sets?select=id
--        GET /rest/v1/statement_requirements?select=id
--      EXPECT: the set and its document are both visible.
--   3. In SQL: update that set to is_active = false. Commit.
--   4. Repeat step 2.
--      EXPECT: ZERO rows from BOTH endpoints -- the document must disappear
--      with its set, not merely the set. That second part is the EXISTS clause
--      in the requirements policy, and it is the one that would leak.
--   5. As an authenticated applicant (any account), attempt:
--        POST   /rest/v1/statement_requirement_sets
--        PATCH  /rest/v1/statement_requirements?id=eq.<the document>
--        DELETE /rest/v1/statement_requirements?id=eq.<the document>
--      EXPECT: all three refused. A row a browser can write is a sentence a
--      browser can put in front of the analyser.
--   6. Delete the committed fixtures.
--
-- Steps 1 and 3 commit real rows and step 6 deletes them. That is a production
-- data change and needs explicit authorization; it is not part of this file.
-- ============================================================================

begin;

do $$
declare
  v_user     uuid := gen_random_uuid();
  v_school   uuid := gen_random_uuid();
  v_set      uuid;
  v_req      uuid;
  v_draft    uuid := gen_random_uuid();
  v_legacy   uuid := gen_random_uuid();
  v_prompt   uuid := gen_random_uuid();
  v_count    integer;
  v_failures integer := 0;
  v_snapshot jsonb := jsonb_build_object('synthetic', true, 'promptText', 'synthetic prompt');
begin
  -- ------------------------------------------------------------------ fixtures
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', format('requirements-test-%s@example.invalid', v_user));

  -- ============================================================
  -- 1. AN UNVERIFIED SET CANNOT BE ACTIVE
  -- ============================================================
  -- The editorial rule, in the database. This is the second, independent answer
  -- to "could somebody publish an unverified requirement" -- the first being
  -- that no browser role can write the table at all.

  -- An INACTIVE unverified set is fine: that is how research arrives.
  insert into public.statement_requirement_sets (
    school_id, verification_status, original_text, is_active
  ) values (
    v_school, 'unverified', 'synthetic research text', false
  ) returning id into v_set;
  raise notice 'pass  an INACTIVE unverified set is accepted (research arrives this way)';

  -- Activating it must be refused: no verified status, no source, no date.
  begin
    update public.statement_requirement_sets set is_active = true where id = v_set;
    v_failures := v_failures + 1;
    raise notice 'FAIL  an unverified set was activated';
  exception when check_violation then
    raise notice 'pass  activating an unverified set is refused (%)', sqlerrm;
  end;

  -- Verified but with no source URL: still refused. All three are required.
  begin
    update public.statement_requirement_sets
       set verification_status = 'verified', verified_on = current_date, is_active = true
     where id = v_set;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a verified set with no source_url was activated';
  exception when check_violation then
    raise notice 'pass  activation requires a source_url';
  end;

  -- Verified with a source but no date: still refused.
  begin
    update public.statement_requirement_sets
       set verification_status = 'verified', source_url = 'https://example.invalid/synthetic',
           verified_on = null, is_active = true
     where id = v_set;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a verified set with no verified_on was activated';
  exception when check_violation then
    raise notice 'pass  activation requires a verified_on date';
  end;

  -- CONFLICTING CAN NEVER BE ACTIVE, whatever evidence it carries: sources that
  -- disagree have no single correct value to publish.
  begin
    update public.statement_requirement_sets
       set verification_status = 'conflicting',
           source_url = 'https://example.invalid/synthetic',
           verified_on = current_date, is_active = true
     where id = v_set;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a conflicting set was activated';
  exception when check_violation then
    raise notice 'pass  a conflicting set can never be active';
  end;

  -- All three present: activation succeeds.
  update public.statement_requirement_sets
     set verification_status = 'verified',
         source_url = 'https://example.invalid/synthetic',
         verified_on = current_date,
         is_active = true
   where id = v_set;
  raise notice 'pass  a verified, sourced and dated set activates';

  -- AN UNRECOGNISED STATUS IS REFUSED.
  begin
    update public.statement_requirement_sets
       set verification_status = 'probably-fine' where id = v_set;
    v_failures := v_failures + 1;
    raise notice 'FAIL  an unrecognised verification status was accepted';
  exception when check_violation then
    raise notice 'pass  verification_status is restricted to the four known values';
  end;

  -- ============================================================
  -- 2. REQUIREMENT IDENTITY AND SCHOOL ASSOCIATION
  -- ============================================================
  insert into public.statement_requirements (
    set_id, school_id, document_type, label, prompt_text
  ) values (
    v_set, v_school, 'personal-statement', 'Synthetic Statement', 'synthetic prompt text'
  ) returning id into v_req;
  raise notice 'pass  a document was created under its set';

  -- A DOCUMENT CANNOT BELONG TO NO SET.
  begin
    insert into public.statement_requirements (
      set_id, school_id, document_type, label, prompt_text
    ) values (
      gen_random_uuid(), v_school, 'personal-statement', 'Orphan', 'synthetic'
    );
    v_failures := v_failures + 1;
    raise notice 'FAIL  a document was created under a nonexistent set';
  exception when foreign_key_violation then
    raise notice 'pass  a document must reference a real set';
  end;

  -- AN UNRECOGNISED DOCUMENT TYPE IS REFUSED.
  begin
    insert into public.statement_requirements (
      set_id, school_id, document_type, label, prompt_text
    ) values (v_set, v_school, 'thesis', 'Synthetic', 'synthetic');
    v_failures := v_failures + 1;
    raise notice 'FAIL  an unrecognised document type was accepted';
  exception when check_violation then
    raise notice 'pass  document_type is restricted to the known set';
  end;

  -- A DOCUMENT WITH NO WORDING IS REFUSED: a requirement with no question in it
  -- would be displayed as though it were vouched for.
  begin
    insert into public.statement_requirements (
      set_id, school_id, document_type, label, prompt_text
    ) values (v_set, v_school, 'personal-statement', 'Synthetic', '   ');
    v_failures := v_failures + 1;
    raise notice 'FAIL  a blank prompt was accepted';
  exception when check_violation then
    raise notice 'pass  a document must carry wording';
  end;

  -- ============================================================
  -- 3. THE LENGTH REGISTER (006)
  -- ============================================================
  -- AN UNKNOWN REGISTER IS REFUSED. parseEnforcement would read it as the
  -- STRICT register -- safe, but not what whoever wrote it meant.
  begin
    update public.statement_requirements
       set max_words = 500, words_enforcement = 'advisory-ish' where id = v_req;
    v_failures := v_failures + 1;
    raise notice 'FAIL  an unrecognised register was accepted';
  exception when check_violation then
    raise notice 'pass  the register is restricted to the five known values';
  end;

  -- EACH OF THE FIVE IS ACCEPTED, with a bound to describe.
  update public.statement_requirements set max_words = 500 where id = v_req;
  begin
    update public.statement_requirements set words_enforcement = 'enforced'  where id = v_req;
    update public.statement_requirements set words_enforcement = 'truncated' where id = v_req;
    update public.statement_requirements set words_enforcement = 'target'    where id = v_req;
    update public.statement_requirements set words_enforcement = 'suggested' where id = v_req;
    update public.statement_requirements set words_enforcement = 'unknown'   where id = v_req;
    raise notice 'pass  all five registers are accepted on a bounded unit';
  exception when others then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a legitimate register was refused: %', sqlerrm;
  end;

  -- A REGISTER WITH NO BOUND DESCRIBES NOTHING.
  begin
    update public.statement_requirements
       set max_words = null, min_words = null, words_enforcement = 'suggested'
     where id = v_req;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a word register was accepted with no word bound';
  exception when check_violation then
    raise notice 'pass  a register requires a bound in its own unit';
  end;

  -- TRUNCATION REQUIRES A MAXIMUM TO TRUNCATE AT. A minimum cannot be.
  update public.statement_requirements
     set min_words = 300, max_words = null, words_enforcement = null where id = v_req;
  begin
    update public.statement_requirements set words_enforcement = 'truncated' where id = v_req;
    v_failures := v_failures + 1;
    raise notice 'FAIL  truncation was accepted with only a minimum';
  exception when check_violation then
    raise notice 'pass  truncation requires a maximum';
  end;

  -- ============================================================
  -- 4. OPTION A: A LENGTH SHOWN AND NOT BOUNDED
  -- ============================================================
  -- The owner-approved answer for an unconfirmed limit. The sentence is stored
  -- and every typed bound stays NULL -- and the database refuses the
  -- contradiction rather than letting whichever code path runs first decide.
  update public.statement_requirements
     set min_words = null, max_words = null, words_enforcement = null,
         words_stated_as = null
   where id = v_req;

  update public.statement_requirements
     set unenforced_length = 'Submit a 1-2 page essay using APA formatting.',
         unenforced_length_verbatim = true
   where id = v_req;
  raise notice 'pass  a length sentence is accepted with no bound beside it';

  -- A BOUND ALONGSIDE THE SENTENCE IS REFUSED, in every unit.
  begin
    update public.statement_requirements set max_words = 1000 where id = v_req;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a word bound was accepted alongside an unenforced length';
  exception when check_violation then
    raise notice 'pass  a word bound is refused alongside an unenforced length';
  end;

  begin
    update public.statement_requirements set max_pages = 2 where id = v_req;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a page bound was accepted alongside an unenforced length';
  exception when check_violation then
    raise notice 'pass  a page bound is refused alongside an unenforced length';
  end;

  begin
    update public.statement_requirements set min_characters = 100 where id = v_req;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a character bound was accepted alongside an unenforced length';
  exception when check_violation then
    raise notice 'pass  a character bound is refused alongside an unenforced length';
  end;

  -- THE VERBATIM FLAG REQUIRES A SENTENCE. A flag with no text claims
  -- "verbatim" about nothing -- and the flag is what decides whether quotation
  -- marks appear.
  begin
    update public.statement_requirements
       set unenforced_length = null, unenforced_length_verbatim = true where id = v_req;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a verbatim flag was accepted with no sentence';
  exception when check_violation then
    raise notice 'pass  the verbatim flag requires a sentence';
  end;

  -- A BLANK SENTENCE IS NOT A SENTENCE: it would render as empty quote marks.
  begin
    update public.statement_requirements
       set unenforced_length = '   ', unenforced_length_verbatim = false where id = v_req;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a blank length sentence was accepted';
  exception when check_violation then
    raise notice 'pass  a blank length sentence is refused';
  end;

  -- ============================================================
  -- 5. CATALOG VISIBILITY -- DATA SHAPE ONLY (see the header)
  -- ============================================================
  -- THIS SESSION IS THE OWNER AND IS NOT SUBJECT TO RLS, so what follows proves
  -- the data the policy reads, not that the policy filters. The non-owner
  -- procedure is in this file's header and needs separate authorization.
  update public.statement_requirement_sets set is_active = false where id = v_set;

  select count(*) into v_count
    from public.statement_requirements r
    join public.statement_requirement_sets s on s.id = r.set_id
   where r.id = v_req and r.is_active and s.is_active;
  if v_count <> 0 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  the policy predicate still admits a document of an inactive set';
  else
    raise notice 'pass  the policy predicate excludes a document whose set is inactive';
  end if;

  update public.statement_requirement_sets
     set is_active = true where id = v_set;
  select count(*) into v_count
    from public.statement_requirements r
    join public.statement_requirement_sets s on s.id = r.set_id
   where r.id = v_req and r.is_active and s.is_active;
  if v_count <> 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  the policy predicate hides a document of an active set';
  else
    raise notice 'pass  the policy predicate admits a document of an active set';
  end if;

  raise notice 'NOTE  section 5 is the predicate, not the policy. An owner session '
               'bypasses RLS -- see the two-role procedure in the header.';

  -- ============================================================
  -- 6. REQUIREMENT-BACKED DRAFT CONSTRAINTS (005 on statement_drafts)
  -- ============================================================
  -- BOTH OR NEITHER. An id with no snapshot, or a snapshot with no id, is a
  -- draft that cannot say what it answers.
  begin
    insert into public.statement_drafts (id, user_id, title, essay, requirement_id)
    values (gen_random_uuid(), v_user, 'synthetic req draft', 'synthetic essay', v_req);
    v_failures := v_failures + 1;
    raise notice 'FAIL  a requirement_id was accepted with no snapshot';
  exception when check_violation then
    raise notice 'pass  a requirement_id without a snapshot is refused';
  end;

  begin
    insert into public.statement_drafts (id, user_id, title, essay, requirement_snapshot)
    values (gen_random_uuid(), v_user, 'synthetic req draft', 'synthetic essay', v_snapshot);
    v_failures := v_failures + 1;
    raise notice 'FAIL  a snapshot was accepted with no requirement_id';
  exception when check_violation then
    raise notice 'pass  a snapshot without a requirement_id is refused';
  end;

  -- THE SNAPSHOT MUST BE AN OBJECT.
  begin
    insert into public.statement_drafts (
      id, user_id, title, essay, school_id, prompt_text, requirement_id, requirement_snapshot
    ) values (
      gen_random_uuid(), v_user, 'synthetic req draft', 'synthetic essay', v_school,
      'synthetic prompt', v_req, '[1,2,3]'::jsonb
    );
    v_failures := v_failures + 1;
    raise notice 'FAIL  a json array was accepted as a snapshot';
  exception when check_violation then
    raise notice 'pass  the snapshot must be a json object';
  end;

  -- A REQUIREMENT-BACKED DRAFT NEEDS A SCHOOL AND WORDING.
  begin
    insert into public.statement_drafts (
      id, user_id, title, essay, requirement_id, requirement_snapshot
    ) values (
      gen_random_uuid(), v_user, 'synthetic req draft', 'synthetic essay', v_req, v_snapshot
    );
    v_failures := v_failures + 1;
    raise notice 'FAIL  a requirement-backed draft was accepted with no school or wording';
  exception when check_violation then
    raise notice 'pass  a requirement-backed draft needs a school and wording';
  end;

  -- THE LEGITIMATE SHAPE.
  insert into public.statement_drafts (
    id, user_id, title, essay, school_id, prompt_text, requirement_id, requirement_snapshot
  ) values (
    v_draft, v_user, 'synthetic req draft', 'synthetic essay', v_school,
    'synthetic prompt', v_req, v_snapshot
  );
  raise notice 'pass  a requirement-backed draft with school, wording, id and snapshot';

  -- ONE PROMPT SOURCE. A draft may not claim both a catalog prompt and a
  -- structured requirement: an id from a different table does not belong in
  -- prompt_id.
  begin
    update public.statement_drafts set prompt_id = v_prompt where id = v_draft;
    v_failures := v_failures + 1;
    raise notice 'FAIL  a draft carried both a prompt_id and a requirement_id';
  exception when check_violation then
    raise notice 'pass  a draft cannot claim two prompt sources';
  end;

  -- ============================================================
  -- 7. LEGACY DRAFT COMPATIBILITY
  -- ============================================================
  -- THE WHOLE POINT OF THE NULLABLE COLUMNS. A draft shaped exactly as every
  -- pre-005 row is shaped must still insert, update and read.
  insert into public.statement_drafts (id, user_id, title, essay)
  values (v_legacy, v_user, 'synthetic legacy draft', 'synthetic legacy essay');
  raise notice 'pass  a general draft with neither prompt nor requirement still inserts';

  update public.statement_drafts
     set essay = 'synthetic legacy essay, edited' where id = v_legacy;
  raise notice 'pass  a legacy draft still saves';

  -- A LEGACY PROMPT-BACKED DRAFT -- the Arkansas State shape: prompt_id set,
  -- requirement_id NULL. This is the one that must not have been broken.
  update public.statement_drafts
     set school_id = v_school, prompt_id = v_prompt, prompt_text = 'synthetic catalog prompt',
         stated_max_words = 500
   where id = v_legacy;
  raise notice 'pass  a legacy prompt-backed draft still saves (the Arkansas State shape)';

  select count(*) into v_count
    from public.statement_drafts
   where id = v_legacy and prompt_id is not null and requirement_id is null;
  if v_count <> 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  the legacy draft did not read back as prompt-backed';
  else
    raise notice 'pass  the legacy draft reads back as prompt-backed, requirement NULL';
  end if;

  -- AND THE NEW COLUMNS STAY NULL on it: nothing retroactively gave it a
  -- requirement.
  if exists (select 1 from public.statement_drafts
              where id = v_legacy
                and (requirement_id is not null or requirement_snapshot is not null)) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a legacy draft acquired requirement columns';
  else
    raise notice 'pass  a legacy draft carries NULL in both new columns';
  end if;

  -- ============================================================
  -- 8. CASCADE: DELETING A SET REMOVES ITS DOCUMENTS, NOT ANY DRAFT
  -- ============================================================
  delete from public.statement_requirement_sets where id = v_set;
  if exists (select 1 from public.statement_requirements where id = v_req) then
    v_failures := v_failures + 1;
    raise notice 'FAIL  a document outlived its deleted set';
  else
    raise notice 'pass  deleting a set cascades to its documents';
  end if;

  -- THE DRAFT SURVIVES WITH ITS SNAPSHOT INTACT. There is no foreign key from
  -- statement_drafts.requirement_id, deliberately: a REFERENCES clause would
  -- either block the delete or cascade away somebody's essay.
  select count(*) into v_count
    from public.statement_drafts where id = v_draft and requirement_snapshot is not null;
  if v_count <> 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  deleting the requirement destroyed or emptied the draft';
  else
    raise notice 'pass  the draft survives its requirement with the snapshot intact';
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
-- POST-ROLLBACK CONFIRMATION. Expect 0 from all three. Anything else means the
-- transaction was committed -- which is the mistake this file's header warns
-- about -- and synthetic rows are now in real tables, including a fake draft in
-- the table that holds applicants' work.
-- ============================================================================
select count(*) as leftover_synthetic_sets
from   public.statement_requirement_sets
where  original_text = 'synthetic research text';

select count(*) as leftover_synthetic_requirements
from   public.statement_requirements
where  label = 'Synthetic Statement' or label = 'Orphan' or label = 'Synthetic';

select count(*) as leftover_synthetic_drafts
from   public.statement_drafts
where  title in ('synthetic req draft', 'synthetic legacy draft');
