-- Personal Statement Studio V2 -- publishing a reviewed submission into the
-- catalog, with the evidence that justifies it.
--
-- ---------------------------------------------------------------------------
-- THIS FILE REPLACES THE WITHDRAWN 20261006_009, WHICH WAS NEVER APPLIED
-- ---------------------------------------------------------------------------
-- 009 created this same function, and was correct against the schema that
-- existed when it was written. 20261008_011 then added evidence_kind (NOT NULL
-- DEFAULT 'official-source') and evidence_submission_id to
-- statement_requirement_sets, and 009's INSERT names neither -- so a set
-- created by promoting an applicant's submission would be recorded as an
-- OFFICIAL SOURCE. Three things follow, in order:
--
--   1. the provenance is false: nobody checked the school's own page;
--   2. activation then fails, because 011's active_needs_evidence check
--      demands a source_url for official-source evidence and a
--      submission-backed set has none to give honestly;
--   3. if it were activated anyway, the Studio would tell the applicant
--      "Confirmed against the school's published materials" -- the exact
--      defect QA-001 was raised for.
--
-- WHY A NEW FILE RATHER THAN AN EDIT IN PLACE. The function must be created
-- AFTER 011, because it writes 011's columns. Keeping the number 009 would
-- mean a file whose name says "before" and whose content requires "after",
-- and the filename is the only ordering an operator sees. 009 was never
-- applied to production, so withdrawing it rewrites no history: see
-- supabase/manual/MIGRATION_STATUS.md.
--
-- WHY NOT CREATE THE EVIDENCE-AWARE VERSION AT 009 AND LET IT RESOLVE LATER.
-- Because PostgreSQL would let it. CREATE OR REPLACE FUNCTION checks a
-- PL/pgSQL body for SYNTAX only -- it does not resolve table or column
-- references -- so the migration would apply cleanly and then fail at the
-- first promotion with 'column "evidence_kind" of relation
-- "statement_requirement_sets" does not exist'. Verified on PostgreSQL 16.15
-- against a throwaway cluster. A landmine that applies cleanly is worse than
-- the bug it replaces, which is why the guard below refuses instead.
--
-- EVERYTHING ELSE IS 009 UNCHANGED: the same signature, the same guards, the
-- same two modes, the same is_active = false, the same grants.
begin;

-- ===========================================================================
-- PRECONDITION: 20261008_011 MUST ALREADY BE APPLIED
-- ===========================================================================
-- This function writes evidence_kind and evidence_submission_id. PostgreSQL
-- does NOT resolve column references in a PL/pgSQL body at CREATE time -- it
-- checks syntax only -- so creating this before 011 would SUCCEED and then
-- fail at the first promotion with "column evidence_kind does not exist".
-- Verified on PostgreSQL 16.15 against a throwaway cluster.
--
-- A silent landmine is worse than the bug it replaces, so the order is
-- enforced here rather than documented. The whole file is one transaction, so
-- a refusal leaves nothing behind.
do $guard$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'statement_requirement_sets'
       and column_name  = 'evidence_kind'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'statement_requirement_sets'
       and column_name  = 'evidence_submission_id'
  ) then
    raise exception
      'REFUSED: 20261008_011 (evidence columns) must be applied before this migration';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'statement_prompt_submissions'
       and column_name  = 'approved_requirement_id'
  ) then
    raise exception
      'REFUSED: 20261006_008 (submission requirement fields) must be applied first';
  end if;
end
$guard$;

create or replace function public.promote_statement_submission_to_requirement(
  p_submission_id uuid,
  p_reviewer      uuid,
  p_mode          text,
  p_requirement   jsonb,
  p_set           jsonb default '{}'::jsonb,
  p_set_id        uuid  default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_submission public.statement_prompt_submissions%rowtype;
  v_set_id     uuid;
  v_req_id     uuid;
  v_created    text;
  v_label      text;
  v_prompt     text;
  v_doctype    text;
begin
  -- ---- guards that write nothing -------------------------------------
  --
  -- EVERY ONE OF THESE RETURNS A WORD RATHER THAN RAISING. The route turns the
  -- word into a message beside the field that caused it; an exception would
  -- arrive as a 500 with nothing to show the administrator.
  if p_submission_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid-submission');
  end if;
  if p_reviewer is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid-reviewer');
  end if;
  if p_mode is null or p_mode not in ('new-set', 'existing-set') then
    return jsonb_build_object('ok', false, 'reason', 'invalid-mode');
  end if;

  -- ---- the submission, locked for the duration -----------------------
  --
  -- FOR UPDATE, so two administrators pressing Save on the same submission
  -- cannot both promote it. The second waits, re-reads, and finds
  -- approved_requirement_id already set.
  select * into v_submission
  from public.statement_prompt_submissions
  where id = p_submission_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  if v_submission.approved_requirement_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already-promoted',
                              'requirementId', v_submission.approved_requirement_id);
  end if;
  if v_submission.status in ('rejected', 'withdrawn') then
    return jsonb_build_object('ok', false, 'reason', 'not-promotable',
                              'status', v_submission.status);
  end if;

  -- ---- the three canonical fields that cannot be absent ---------------
  v_label   := nullif(btrim(coalesce(p_requirement->>'label', '')), '');
  v_prompt  := nullif(btrim(coalesce(p_requirement->>'prompt_text', '')), '');
  v_doctype := nullif(btrim(coalesce(p_requirement->>'document_type', '')), '');
  if v_label is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid-label');
  end if;
  if v_prompt is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid-prompt-text');
  end if;
  -- THE NINE REVIEWED VALUES, checked here as well as by the table's CHECK, so
  -- the administrator gets a word rather than a constraint violation.
  if v_doctype is null or v_doctype not in (
    'personal-statement', 'goal-statement', 'diversity-statement',
    'writing-sample', 'additional-response', 'other',
    'statement-of-purpose', 'autobiographical-essay', 'supplemental-essay'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid-document-type');
  end if;

  -- ============================================================
  -- 3. THE SET -- CREATED OR CHOSEN, NEVER GUESSED
  -- ============================================================
  if p_mode = 'existing-set' then
    if p_set_id is null then
      return jsonb_build_object('ok', false, 'reason', 'set-required');
    end if;
    -- IT MUST BE THIS SCHOOL'S. A set id from another school would file the
    -- document under a school nobody chose, and the requirement carries its own
    -- school_id, so the two would disagree for ever.
    perform 1 from public.statement_requirement_sets
      where id = p_set_id and school_id = v_submission.school_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'set-not-found');
    end if;
    v_set_id  := p_set_id;
    v_created := 'requirement';
  else
    insert into public.statement_requirement_sets (
      school_id, application_cycle, verification_status, source_url, verified_on,
      is_verbatim, original_text, notes,
      -- 20261008_011'S TWO COLUMNS, WRITTEN BECAUSE THIS IS THE ONE WRITER
      -- THAT KNOWS THE ANSWER. See the header: omitting them let the column
      -- default record an applicant's approved submission as an official
      -- source, which is a false provenance claim AND a row that 011's
      -- active_needs_evidence check then refuses to activate.
      evidence_kind, evidence_submission_id,
      -- SEE THE HEADER. Written explicitly, not left to the column default,
      -- and the payload cannot override it.
      is_active,
      display_order
    ) values (
      v_submission.school_id,
      nullif(btrim(coalesce(p_set->>'application_cycle', '')), ''),
      coalesce(nullif(btrim(coalesce(p_set->>'verification_status', '')), ''), 'unverified'),
      nullif(btrim(coalesce(p_set->>'source_url', '')), ''),
      (nullif(btrim(coalesce(p_set->>'verified_on', '')), ''))::date,
      coalesce((p_set->>'is_verbatim')::boolean, false),
      coalesce(p_set->>'original_text', ''),
      coalesce(p_set->'notes', '[]'::jsonb),
      /*
        THE EVIDENCE, FROM THE PAYLOAD, DEFAULTING TO THE WEAKER CLAIM.

        The admin route sends 'admin-approved-submission' plus this
        submission's id when it publishes. A payload that says nothing falls
        to 'official-source' with a null id -- the same pair 011's default
        produces -- so an unpublished promotion is unchanged by this.

        THE ID IS THIS SUBMISSION'S, NOT THE PAYLOAD'S. p_submission_id is
        what the caller asked to promote and is the only id this row may
        claim as its evidence; taking it from p_set would let a caller
        attribute a set to a submission it is not about.
      */
      coalesce(nullif(btrim(coalesce(p_set->>'evidence_kind', '')), ''), 'official-source'),
      case
        when coalesce(nullif(btrim(coalesce(p_set->>'evidence_kind', '')), ''), 'official-source')
             = 'admin-approved-submission'
        then p_submission_id
        else null
      end,
      false,
      coalesce((p_set->>'display_order')::integer, 0)
    )
    returning id into v_set_id;
    v_created := 'set';
  end if;

  -- ============================================================
  -- 4. THE WRITING REQUIREMENT
  -- ============================================================
  -- EVERY VALUE FROM p_requirement, NOT FROM THE SUBMISSION. The administrator
  -- has read the applicant's report and decided; this writes their decision.
  insert into public.statement_requirements (
    set_id, school_id, document_type, label, prompt_text, components,
    min_words, max_words, min_characters, max_characters,
    characters_include_spaces, min_pages, max_pages,
    words_enforcement, words_stated_as,
    characters_enforcement, characters_stated_as,
    pages_enforcement, pages_stated_as,
    unenforced_length, unenforced_length_verbatim,
    page_spacing, font_size_pt, font_family, margins_inches,
    citation_style, citation_family, min_references,
    other_instructions, choice_group, is_optional, notes,
    -- SEE THE HEADER. A requirement added to an ALREADY-ACTIVE set would
    -- otherwise be visible to every applicant the moment it was saved.
    is_active,
    display_order
  ) values (
    v_set_id, v_submission.school_id, v_doctype, v_label, v_prompt,
    coalesce(p_requirement->'components', '[]'::jsonb),
    (p_requirement->>'min_words')::integer,
    (p_requirement->>'max_words')::integer,
    (p_requirement->>'min_characters')::integer,
    (p_requirement->>'max_characters')::integer,
    (p_requirement->>'characters_include_spaces')::boolean,
    -- numeric, NOT integer: 20261005_007 exists because an integer column read
    -- a page and a half as nothing.
    (p_requirement->>'min_pages')::numeric(4,1),
    (p_requirement->>'max_pages')::numeric(4,1),
    nullif(btrim(coalesce(p_requirement->>'words_enforcement', '')), ''),
    nullif(btrim(coalesce(p_requirement->>'words_stated_as', '')), ''),
    nullif(btrim(coalesce(p_requirement->>'characters_enforcement', '')), ''),
    nullif(btrim(coalesce(p_requirement->>'characters_stated_as', '')), ''),
    nullif(btrim(coalesce(p_requirement->>'pages_enforcement', '')), ''),
    nullif(btrim(coalesce(p_requirement->>'pages_stated_as', '')), ''),
    nullif(btrim(coalesce(p_requirement->>'unenforced_length', '')), ''),
    (p_requirement->>'unenforced_length_verbatim')::boolean,
    nullif(btrim(coalesce(p_requirement->>'page_spacing', '')), ''),
    (p_requirement->>'font_size_pt')::integer,
    nullif(btrim(coalesce(p_requirement->>'font_family', '')), ''),
    (p_requirement->>'margins_inches')::numeric(4,2),
    nullif(btrim(coalesce(p_requirement->>'citation_style', '')), ''),
    nullif(btrim(coalesce(p_requirement->>'citation_family', '')), ''),
    (p_requirement->>'min_references')::integer,
    coalesce(p_requirement->'other_instructions', '[]'::jsonb),
    nullif(btrim(coalesce(p_requirement->>'choice_group', '')), ''),
    coalesce((p_requirement->>'is_optional')::boolean, false),
    coalesce(p_requirement->'notes', '[]'::jsonb),
    false,
    coalesce((p_requirement->>'display_order')::integer, 0)
  )
  returning id into v_req_id;

  -- ============================================================
  -- 5. THE LINK BACK
  -- ============================================================
  -- THE SUBMISSION BECOMES approved IF IT WAS STILL PENDING, because promoting
  -- one is an endorsement of it -- there is no state in which an administrator
  -- publishes a submission they have not accepted. A submission already
  -- approved keeps its earlier reviewed_at; only the link is new.
  --
  -- 20261006_008 RELAXED approval_shape TO ALLOW THIS. Its predicate now says a
  -- catalog link implies approval, and no longer that approval implies a
  -- published statement_prompts row.
  update public.statement_prompt_submissions
  set status                  = 'approved',
      reviewed_by             = coalesce(reviewed_by, p_reviewer),
      reviewed_at             = coalesce(reviewed_at, now()),
      approved_requirement_id = v_req_id,
      updated_at              = now()
  where id = p_submission_id;

  return jsonb_build_object(
    'ok', true,
    'setId', v_set_id,
    'requirementId', v_req_id,
    'created', v_created,
    -- SAID PLAINLY, so no caller has to assume. Nothing this function writes is
    -- applicant-visible.
    'isActive', false
  );
end;
$fn$;

-- ============================================================
-- 6. PRIVILEGES -- revoke first, because GRANT is additive
-- ============================================================
-- THE WHOLE POINT OF THE DESIGN IS THIS BLOCK. anon and authenticated cannot
-- call this function at all, so no browser session -- applicant or
-- administrator -- can reach the catalog's write path. The admin route's
-- service-role client can, and only after the route has checked the allowlist.
revoke all on function public.promote_statement_submission_to_requirement(
  uuid, uuid, text, jsonb, jsonb, uuid) from public;
revoke all on function public.promote_statement_submission_to_requirement(
  uuid, uuid, text, jsonb, jsonb, uuid) from anon;
revoke all on function public.promote_statement_submission_to_requirement(
  uuid, uuid, text, jsonb, jsonb, uuid) from authenticated;
grant execute on function public.promote_statement_submission_to_requirement(
  uuid, uuid, text, jsonb, jsonb, uuid) to service_role;

comment on function public.promote_statement_submission_to_requirement(
  uuid, uuid, text, jsonb, jsonb, uuid) is
  'Creates reviewed catalog data from an applicant submission, in one '
  'transaction. Every canonical value comes from the administrator''s payload, '
  'never from the submission. Both rows are written is_active = false: this '
  'creates catalog data, it does not release it. EXECUTE is service_role only.';

commit;
