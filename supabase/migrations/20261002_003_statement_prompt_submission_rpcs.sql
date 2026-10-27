-- Personal Statement Studio V2 -- the three privileged prompt-submission paths.
--
-- FUNCTIONS ONLY. This migration creates three functions and sets their EXECUTE
-- privileges. It creates no table, adds no column, and changes no policy or
-- table grant.
--
-- WHY FUNCTIONS AT ALL. Three operations cannot be expressed as a single
-- statement a browser may issue:
--
--   1. CREATE. A draft and its submission must both exist or neither must. Two
--      round trips from a route can fail between them and leave a pending
--      submission nobody is writing against, or -- worse -- a draft whose
--      provenance points at a row that was never created.
--   2. WITHDRAW. Applicants hold no UPDATE on the submissions table, by design,
--      so the one state change that is legitimately theirs needs a path that
--      re-checks ownership itself.
--   3. DECIDE. Approval must insert into a catalog no role may write.
--
-- THE THREE HAVE DELIBERATELY DIFFERENT SECURITY MODES, and the differences are
-- the whole design:
--
--   create    SECURITY DEFINER, EXECUTE to authenticated. It was INVOKER, and
--             that was wrong: INVOKER needs the caller to hold INSERT, and a
--             caller who holds INSERT can skip the function entirely. See the
--             audit above the function itself.
--   withdraw  SECURITY DEFINER, EXECUTE to authenticated. It must write a
--             column applicants hold no UPDATE on, so it runs as owner -- and
--             therefore re-establishes ownership itself, in the UPDATE's own
--             WHERE clause rather than in a separate read.
--   decide    SECURITY DEFINER, EXECUTE to service_role ONLY. It writes the
--             catalog. No browser role may run it at all.
--
-- EVERY FUNCTION SETS search_path = '' AND FULLY QUALIFIES EVERY NAME. Without
-- it, a definer function resolves unqualified names through the CALLER's
-- search_path, and a caller who can create a schema can shadow a table the
-- function writes.
--
-- NOTHING HERE TRUSTS AN ARGUMENT FOR IDENTITY. The caller is auth.uid(),
-- always; no function takes a user id, so none can be told to act as somebody
-- else.

begin;

-- ============================================================
-- 1. CREATE: a draft and its pending submission, or neither
-- ============================================================
-- SECURITY DEFINER, AND THE REASON IS THAT INVOKER COULD NOT WORK.
--
-- An INVOKER function runs with the caller's privileges, so for it to insert a
-- submission the caller must hold INSERT on the table -- and a caller who holds
-- INSERT can issue that statement directly and never call the function at all.
-- Every guarantee that lives in the function body is then optional. The earlier
-- version of this file granted exactly that privilege, and three guarantees
-- were skippable through PostgREST: the rate limit, the school check, and the
-- atomic pairing of a draft with its submission.
--
-- So the privilege is withdrawn (20261002_000, section 5) and the function
-- runs as its owner instead. There is now no INSERT privilege to abuse,
-- because there is no INSERT privilege.
--
-- WHAT RLS STOPS DOING, AND WHAT REPLACES IT. A definer function bypasses row
-- level security, so every guarantee the policies were providing has to be
-- re-established here, explicitly:
--
--   OWNERSHIP. The insert policy pinned submitted_by to auth.uid(). Now the
--     function does: v_user is read from auth.uid() and is the ONLY source of
--     both submitted_by and user_id. No parameter carries an identity, so
--     there is no argument that could name somebody else -- which is why this
--     function's signature is worth reading as a security property.
--   THE RATE WINDOW. Under RLS the counts were scoped to the caller's rows by
--     the select policy. That is gone, so `where submitted_by = v_user` on both
--     counts is now load-bearing rather than belt-and-braces. Without it the
--     function would count every applicant's submissions and lock everybody out.
--   STATUS. The policy required 'pending' on insert. The column default
--     supplies it and no parameter can override it, because status is not
--     named in the INSERT at all.
--
-- auth.uid() STILL WORKS UNDER DEFINER. It reads the request's JWT claim from a
-- session setting that PostgREST populates per request; it does not depend on
-- which role the function body executes as. A null means no verified session,
-- and the first guard refuses that.
--
-- NO DYNAMIC SQL ANYWHERE IN THIS FUNCTION. Every statement is static with
-- bound parameters, so running as the owner introduces no injection surface.
--
-- THE ABUSE LIMIT IS INSIDE THIS BOUNDARY, which is now the only boundary there
-- is: this is the sole path by which a row can enter the table, so a limit here
-- is a limit, full stop.
--
-- THE LIMITS, AND WHY THESE NUMBERS. Three an hour and ten a day. A submission
-- creates review work for a person, so the ceiling is far below the AI rate
-- limits in lib/statement/entitlement.ts (5/min, 20/hr, 60/day) -- those bound
-- machine cost, this bounds somebody's attention. An applicant legitimately
-- pasting questions for several programmes in one sitting fits comfortably;
-- scripted submission does not.
--
-- GENERAL DRAFT CREATION IS NOT AFFECTED. This function is the only path that
-- counts against these limits, and it is reached only when a prompt is pasted.
create or replace function public.create_statement_draft_with_prompt_submission(
  p_title             text,
  p_essay             text,
  p_school_id         uuid,
  p_prompt_text       text,
  p_stated_max_words  integer default null,
  p_application_cycle text    default null,
  p_source_url        text    default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user          uuid := auth.uid();
  v_hour_count    integer;
  v_day_count     integer;
  v_submission_id uuid;
  v_fingerprint   text;
  v_draft         public.statement_drafts%rowtype;
begin
  -- ---- guards that write nothing -------------------------------------
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;

  -- Shape only. The route has already applied the full validators; these
  -- repeat the cheapest of them so a DIRECT caller cannot skip them entirely.
  if p_school_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid-school');
  end if;
  if p_prompt_text is null or btrim(p_prompt_text) = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid-prompt-text');
  end if;
  if char_length(p_prompt_text) > 5000 then
    return jsonb_build_object('ok', false, 'reason', 'prompt-text-too-long');
  end if;
  if p_title is null or btrim(p_title) = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid-title');
  end if;
  if char_length(btrim(p_title)) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'title-too-long');
  end if;
  -- A blank word limit must arrive as NULL. Zero is somebody's mistake, not a
  -- school stating nothing, and it is refused rather than normalised away.
  if p_stated_max_words is not null
     and (p_stated_max_words < 1 or p_stated_max_words > 5000) then
    return jsonb_build_object('ok', false, 'reason', 'invalid-max-words');
  end if;

  -- ---- the school must be one this product lists -----------------------
  -- CHECKED HERE AS WELL AS IN THE ROUTE, and here is the one that counts: the
  -- route's check protected a path that could be skipped, and this one cannot
  -- be. A well-formed uuid naming no school would otherwise put a submission
  -- into the review queue attached to nothing a reviewer could identify.
  --
  -- public.schools HAS NO MIGRATION IN THIS REPOSITORY, which is why neither
  -- this table nor the catalog can declare a foreign key to it. This read is
  -- the enforcement until that schema is captured, and it is why a clean
  -- database built from supabase/migrations/ alone cannot run this path.
  if not exists (select 1 from public.schools where id = p_school_id) then
    return jsonb_build_object('ok', false, 'reason', 'school-not-listed');
  end if;

  -- ---- one applicant at a time ------------------------------------------
  -- THE RATE LIMIT IS COUNT-THEN-INSERT, which is a check and a write with a
  -- gap between them. Two requests arriving together would both count three,
  -- both decide they were under the limit, and both insert -- so the ceiling
  -- would be "three, or more if you are quick". This serialises a single
  -- applicant's own submissions for the rest of the transaction.
  --
  -- PER USER, NOT GLOBAL. The lock key is derived from the caller's own id, so
  -- two different applicants never wait for each other; hashtext of a uuid is
  -- stable within a database, which is all a lock key has to be.
  --
  -- TRANSACTION-SCOPED, so it is released when this function returns whether it
  -- succeeds or raises. There is no path that leaves a lock held.
  perform pg_advisory_xact_lock(hashtext(v_user::text));

  -- ---- the limit, still writing nothing --------------------------------
  select count(*) into v_hour_count
  from public.statement_prompt_submissions
  where submitted_by = v_user
    and created_at > now() - interval '1 hour';

  if v_hour_count >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'rate-limited', 'window', 'hour');
  end if;

  select count(*) into v_day_count
  from public.statement_prompt_submissions
  where submitted_by = v_user
    and created_at > now() - interval '1 day';

  if v_day_count >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'rate-limited', 'window', 'day');
  end if;

  -- ---- the two writes, in one transaction ------------------------------
  -- A function body IS a transaction: if the second insert raises -- a CHECK,
  -- an RLS refusal, anything -- the first is rolled back with it. There is no
  -- state in which the submission exists and the draft does not.
  --
  -- STATUS AND REVIEW FIELDS ARE NOT NAMED, so the column defaults supply
  -- 'pending' and NULLs, and the insert policy's predicate on them holds.
  -- THE GROUPING KEY, COMPUTED FROM THE TEXT BEING STORED. sha256 and encode
  -- are Postgres core; convert_to names the encoding explicitly so the digest
  -- is the same bytes on any database. The normalisation -- collapse whitespace
  -- runs, trim, case fold -- mirrors normalizedPromptText() in
  -- lib/statement/draft/promptSubmission.ts, and a test asserts the two agree
  -- on what counts as the same question.
  v_fingerprint := encode(
    sha256(convert_to(lower(btrim(regexp_replace(p_prompt_text, '\s+', ' ', 'g'))), 'UTF8')),
    'hex'
  );

  insert into public.statement_prompt_submissions (
    submitted_by, school_id, prompt_text, stated_max_words, application_cycle,
    source_url, text_fingerprint
  ) values (
    v_user, p_school_id, p_prompt_text, p_stated_max_words,
    nullif(btrim(coalesce(p_application_cycle, '')), ''),
    nullif(btrim(coalesce(p_source_url, '')), ''),
    v_fingerprint
  )
  returning id into v_submission_id;

  -- THE SNAPSHOT IS TAKEN HERE, from the same values that were just stored, so
  -- the draft's copy and the submission's original are identical at birth and
  -- independent for ever after. prompt_id is deliberately not set: this draft
  -- answers a question nobody has reviewed, and the exclusion constraint
  -- enforces that it cannot claim otherwise.
  insert into public.statement_drafts (
    user_id, title, essay, school_id, prompt_text, stated_max_words, prompt_submission_id
  ) values (
    v_user, btrim(p_title), coalesce(p_essay, ''), p_school_id, p_prompt_text,
    p_stated_max_words, v_submission_id
  )
  returning * into v_draft;

  return jsonb_build_object(
    'ok', true,
    -- THE ROW'S OWN SHAPE, snake_case, so the application parses this with the
    -- same strict reader it applies to a row read straight from the table.
    -- A second, camel-cased shape here would be a second thing that could
    -- disagree with rows.ts about what a coherent draft is.
    'draft', jsonb_build_object(
      'id', v_draft.id,
      'user_id', v_draft.user_id,
      'title', v_draft.title,
      'essay', v_draft.essay,
      'revision', v_draft.revision,
      'created_at', v_draft.created_at,
      'updated_at', v_draft.updated_at,
      'school_id', v_draft.school_id,
      'prompt_id', v_draft.prompt_id,
      'prompt_text', v_draft.prompt_text,
      'stated_max_words', v_draft.stated_max_words,
      'prompt_submission_id', v_draft.prompt_submission_id
    ),
    'submissionId', v_submission_id
  );
end;
$fn$;

-- EXECUTE IS THE WHOLE PERIMETER NOW, so it is set explicitly rather than left
-- to defaults: PostgreSQL grants EXECUTE to PUBLIC on a new function, and
-- PUBLIC includes anon. Revoked from both, then granted to the one role that
-- can have a verified session. An anonymous caller reaching this function would
-- find auth.uid() null and be refused by the first guard anyway -- but it
-- should not be reachable, and now it is not.
revoke all on function public.create_statement_draft_with_prompt_submission(
  text, text, uuid, text, integer, text, text) from public;
revoke all on function public.create_statement_draft_with_prompt_submission(
  text, text, uuid, text, integer, text, text) from anon, service_role;
grant execute on function public.create_statement_draft_with_prompt_submission(
  text, text, uuid, text, integer, text, text) to authenticated;

-- ============================================================
-- 2. WITHDRAW: the applicant's own pending submission
-- ============================================================
-- SECURITY DEFINER, because applicants hold no UPDATE on the submissions table
-- and must not be given one: a general UPDATE constrained by a policy predicate
-- fails open the day a column is added, and the column it would fail open on is
-- `status`.
--
-- OWNERSHIP IS RE-ESTABLISHED IN THE UPDATE ITSELF. A definer function bypasses
-- RLS, so the WHERE clause is the only thing standing between a caller and
-- somebody else's row -- and it is written as part of the write rather than as
-- a read followed by a write, so two concurrent calls cannot both pass a check
-- and then both act.
--
-- ONLY 'pending' MOVES. An approved submission has already produced a catalog
-- row that other applicants may be using, and withdrawing published content is
-- not what this action is for. A rejected or duplicate one is already decided.
-- A second withdraw of an already-withdrawn row reports 'already-decided'
-- rather than failing, so a retried request is safe.
--
-- THE DRAFT IS NOT TOUCHED. Not its snapshot, not its revision, not its
-- updated_at, and not its prompt_submission_id -- the provenance of a withdrawn
-- submission is still the truth about where that wording came from.
create or replace function public.withdraw_statement_prompt_submission(
  p_submission_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user    uuid := auth.uid();
  v_updated uuid;
  v_status  text;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;
  if p_submission_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  update public.statement_prompt_submissions
     set status = 'withdrawn',
         updated_at = now()
   where id = p_submission_id
     and submitted_by = v_user
     and status = 'pending'
  returning id into v_updated;

  if v_updated is not null then
    return jsonb_build_object('ok', true, 'status', 'withdrawn');
  end if;

  -- Nothing moved. Distinguish "not yours / absent" from "already decided",
  -- but only for a row that IS the caller's: an id that is not theirs must
  -- read exactly as an id that does not exist.
  select status into v_status
  from public.statement_prompt_submissions
  where id = p_submission_id and submitted_by = v_user;

  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  return jsonb_build_object('ok', false, 'reason', 'already-decided', 'status', v_status);
end;
$fn$;

revoke all on function public.withdraw_statement_prompt_submission(uuid) from public;
revoke all on function public.withdraw_statement_prompt_submission(uuid) from anon, service_role;
grant execute on function public.withdraw_statement_prompt_submission(uuid) to authenticated;

-- ============================================================
-- 3. DECIDE: approve, reject or mark duplicate
-- ============================================================
-- SECURITY DEFINER, EXECUTE TO service_role ONLY. This is the function that
-- writes public.statement_prompts, a table no role holds INSERT on. The
-- privilege granted is "may run this one reviewed procedure", never "may write
-- the catalog" -- so the statements that can reach that table are fixed, and
-- they are all in this file.
--
-- AUTHORIZATION IS DOUBLE. EXECUTE is restricted to service_role, which no
-- browser ever holds; and the route that builds a service-role client does so
-- only after authenticateRequest() and isAdminEmail(), following
-- app/api/admin/reports/route.ts. Neither alone is relied on.
--
-- THE REVIEWER IS AN ARGUMENT HERE, UNLIKE EVERYWHERE ELSE, because
-- service_role has no auth.uid(): the admin's identity is established by the
-- route and passed in for the audit trail. That is safe precisely because only
-- service_role can call this at all.
--
-- CONCURRENCY. The submission row is locked FOR UPDATE before its status is
-- read, so two administrators clicking Approve at the same moment serialise:
-- the first publishes, the second finds a non-pending row and is told so. A
-- retried request after a timeout behaves identically. No catalog row is ever
-- published twice for one submission.
--
-- PARTIAL FAILURE IS IMPOSSIBLE BY CONSTRUCTION. The catalog insert and the
-- status transition are in one function body and therefore one transaction: a
-- prompt cannot be published while the submission stays pending, and a
-- submission cannot read 'approved' with no catalog row behind it -- which the
-- approval-shape CHECK would refuse anyway.
--
-- THE ORIGINAL TEXT IS NEVER OVERWRITTEN. p_label and p_prompt_text set what is
-- PUBLISHED; the submission keeps the wording as it was pasted, so the audit
-- trail survives an administrator correcting a typo before publication.
create or replace function public.decide_statement_prompt_submission(
  p_submission_id  uuid,
  p_decision       text,
  p_reviewer_id    uuid,
  p_label          text    default null,
  p_prompt_text    text    default null,
  p_duplicate_of   uuid    default null,
  p_supersedes     uuid    default null,
  p_deactivate_old boolean default false,
  p_review_note    text    default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_sub       public.statement_prompt_submissions%rowtype;
  v_prompt_id uuid;
  v_text      text;
begin
  if p_reviewer_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;
  if p_decision not in ('approved', 'rejected', 'duplicate') then
    return jsonb_build_object('ok', false, 'reason', 'invalid-decision');
  end if;

  -- The lock, before the status is read. Everything after this point is
  -- serialised against another decision on the same submission.
  select * into v_sub
  from public.statement_prompt_submissions
  where id = p_submission_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  -- ALREADY DECIDED IS A SAFE ANSWER, NOT AN ERROR. A double click, a retry
  -- after a timeout, two administrators at once: all report the settled state
  -- and change nothing.
  if v_sub.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already-decided',
                              'status', v_sub.status);
  end if;

  if p_decision = 'duplicate' then
    if p_duplicate_of is null or p_duplicate_of = p_submission_id then
      return jsonb_build_object('ok', false, 'reason', 'invalid-duplicate');
    end if;
    update public.statement_prompt_submissions
       set status = 'duplicate',
           duplicate_of_id = p_duplicate_of,
           reviewed_by = p_reviewer_id,
           reviewed_at = now(),
           review_note = p_review_note,
           updated_at = now()
     where id = p_submission_id;
    return jsonb_build_object('ok', true, 'status', 'duplicate');
  end if;

  if p_decision = 'rejected' then
    update public.statement_prompt_submissions
       set status = 'rejected',
           reviewed_by = p_reviewer_id,
           reviewed_at = now(),
           review_note = p_review_note,
           updated_at = now()
     where id = p_submission_id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  -- ---- approval ---------------------------------------------------------
  -- The published wording is the administrator's corrected text when they
  -- supplied one, and the submission's otherwise. Either way the submission
  -- row keeps what was pasted.
  v_text := coalesce(nullif(btrim(coalesce(p_prompt_text, '')), ''), v_sub.prompt_text);

  if p_label is null or btrim(p_label) = '' then
    return jsonb_build_object('ok', false, 'reason', 'label-required');
  end if;

  -- A NEW ROW. Never an update of the superseded prompt: its wording is what
  -- somebody's draft was written against, and 20260930_000's model is that an
  -- obsolete prompt is deactivated rather than rewritten.
  insert into public.statement_prompts (
    school_id, label, prompt_text, stated_max_words, application_cycle,
    is_active, origin_submission_id, supersedes_prompt_id
  ) values (
    v_sub.school_id, btrim(p_label), v_text, v_sub.stated_max_words,
    v_sub.application_cycle, true, v_sub.id, p_supersedes
  )
  returning id into v_prompt_id;

  -- DEACTIVATION IS EXPLICIT AND SEPARATE. Approving a new cycle's wording does
  -- not retire the old one unless an administrator said so, and even then the
  -- row survives: drafts referencing it keep a resolvable identity, and no
  -- saved wording anywhere changes.
  if p_deactivate_old and p_supersedes is not null then
    update public.statement_prompts
       set is_active = false, updated_at = now()
     where id = p_supersedes;
  end if;

  update public.statement_prompt_submissions
     set status = 'approved',
         approved_prompt_id = v_prompt_id,
         reviewed_by = p_reviewer_id,
         reviewed_at = now(),
         review_note = p_review_note,
         updated_at = now()
   where id = p_submission_id;

  return jsonb_build_object('ok', true, 'status', 'approved', 'promptId', v_prompt_id);
end;
$fn$;

revoke all on function public.decide_statement_prompt_submission(
  uuid, text, uuid, text, text, uuid, uuid, boolean, text) from public;
revoke all on function public.decide_statement_prompt_submission(
  uuid, text, uuid, text, text, uuid, uuid, boolean, text) from anon;
revoke all on function public.decide_statement_prompt_submission(
  uuid, text, uuid, text, text, uuid, uuid, boolean, text) from authenticated;
grant execute on function public.decide_statement_prompt_submission(
  uuid, text, uuid, text, text, uuid, uuid, boolean, text) to service_role;

commit;
