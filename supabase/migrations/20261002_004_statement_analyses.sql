-- Statement Studio V2 -- stored analysis results.
--
-- ADDITIVE ONLY. One new table and two functions. Nothing existing is touched:
-- not statement_drafts, not statement_prompts, not resume_ai_usage, and no
-- policy or grant belonging to any of them.
--
-- WHY THIS TABLE EXISTS. An analysis is a paid model call. Without somewhere to
-- put the result, reopening a draft re-runs it, a second browser tab re-runs
-- it, and a refresh re-runs it -- each one charging for work already done and
-- producing feedback that may differ from what the applicant was reading a
-- minute ago. Storing the validated result makes an analysis a thing that
-- happened rather than a thing that happens again whenever it is looked at.
--
-- THE ESSAY IS NOT STORED HERE. Only a SHA-256 of the inputs that produced the
-- result. The draft already holds the essay, and a second copy would be a
-- second place for somebody's personal statement to leak from. The fingerprint
-- is enough to answer the only question this table is asked: is the stored
-- feedback still about what is on screen?
--
-- CONTENT-ADDRESSED, NOT REVISION-ADDRESSED, and that is the point of the
-- fingerprint rather than a revision column. A revision moves when the TITLE is
-- saved, so keying on it would charge for a rename; and a revision says nothing
-- about whether the prompt changed. The fingerprint covers the essay, the saved
-- prompt snapshot, the school, the word limit, and the rubric and schema
-- versions -- and covers the title not at all.
--
-- NOT APPLIED. This file is written and reviewed; the feature that uses it is
-- gated OFF (STATEMENT_ANALYSIS_CACHE) and does not query anything here until
-- the migration runs and the flag is set. See the activation sequence at the
-- end of this file.

begin;

-- ============================================================
-- 1. THE TABLE
-- ============================================================
create table if not exists public.statement_analyses (
  id                uuid        primary key default gen_random_uuid(),

  -- The owner. NOT NULL: an analysis with no owner could not be read back by
  -- the person who paid for it, nor refused to anybody else.
  user_id           uuid        not null,

  -- The draft it is about. Same uuid as public.statement_drafts.id; no FK, for
  -- the reason every migration in this family gives -- the legacy schools
  -- capture has to land before this family declares any.
  draft_id          uuid        not null,

  -- SHA-256 of the analysed inputs. The identity of the work, and the one
  -- column that decides whether a stored result still applies.
  fingerprint       text        not null,

  -- 'pending' from the moment a caller claims the work, 'complete' when a
  -- validated result has been written. There is no 'failed': a failure deletes
  -- its claim, because a row that records a failure is a row that would have to
  -- be reasoned about before every retry.
  status            text        not null default 'pending',

  -- The revision that was read, kept for historical identification only. It is
  -- NOT part of the identity -- see the header -- and nothing compares it.
  revision          bigint      not null,

  -- Six categories or seven. Stored so a result can be rendered without
  -- re-deriving it from the draft, which may since have changed.
  prompt_attached   boolean     not null,

  -- 'catalog' or 'user', as the SERVER established it by resolving the prompt
  -- id against the catalog and comparing the wording. Never a browser's claim.
  -- NULL when the draft answers no prompt.
  provenance        text,

  words             integer     not null,
  stated_max_words  integer,
  over_limit        boolean     not null default false,

  -- 0-100, computed by the application from the category scores. NULL while
  -- pending, because there is nothing to report yet.
  overall           integer,

  -- The validated StatementReview. Written only after parseReview accepted it,
  -- so nothing malformed is ever stored as a success.
  review            jsonb,

  -- What this result means. A cached analysis produced under different weights
  -- or a different output shape is not interchangeable with a new one, and
  -- these columns are also inside the fingerprint so a change invalidates
  -- everything automatically.
  rubric_version    text        not null,
  schema_version    text        not null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================================================
-- 2. CONSTRAINTS
-- ============================================================

-- ONE ANALYSIS PER DRAFT PER SET OF INPUTS, and this is what makes two
-- simultaneous requests safe: both try to claim, the database admits one, and
-- the loser is told the work is already in progress. No transaction is held
-- open across the model call -- the claim commits immediately and the result is
-- written later by a second statement.
alter table public.statement_analyses
  drop constraint if exists statement_analyses_draft_fingerprint_key;
alter table public.statement_analyses
  add constraint statement_analyses_draft_fingerprint_key unique (draft_id, fingerprint);

alter table public.statement_analyses
  drop constraint if exists statement_analyses_status;
alter table public.statement_analyses
  add constraint statement_analyses_status check (status in ('pending', 'complete'));

-- SHA-256, lowercase hex. The column means one thing and this keeps it meaning
-- that whoever ever writes it.
alter table public.statement_analyses
  drop constraint if exists statement_analyses_fingerprint_shape;
alter table public.statement_analyses
  add constraint statement_analyses_fingerprint_shape
  check (fingerprint ~ '^[0-9a-f]{64}$');

-- A COMPLETE ROW CARRIES ITS RESULT, AND A PENDING ONE DOES NOT CLAIM ONE.
-- This is what stops a failed or malformed analysis being readable as a
-- success: without a validated review and a score there is no 'complete'.
alter table public.statement_analyses
  drop constraint if exists statement_analyses_complete_shape;
alter table public.statement_analyses
  add constraint statement_analyses_complete_shape
  check (
    (status = 'complete' and review is not null and overall is not null)
    or (status = 'pending' and review is null and overall is null)
  );

alter table public.statement_analyses
  drop constraint if exists statement_analyses_overall_range;
alter table public.statement_analyses
  add constraint statement_analyses_overall_range
  check (overall is null or overall between 0 and 100);

alter table public.statement_analyses
  drop constraint if exists statement_analyses_provenance;
alter table public.statement_analyses
  add constraint statement_analyses_provenance
  check (provenance is null or provenance in ('catalog', 'user'));

-- ============================================================
-- 3. INDEXES
-- ============================================================
-- "Is there a result for this draft?" -- newest first, because the editor shows
-- the most recent and older ones are history.
create index if not exists statement_analyses_draft_idx
  on public.statement_analyses (draft_id, created_at desc);

-- "Whose is this?" and the sweep for abandoned claims.
create index if not exists statement_analyses_owner_idx
  on public.statement_analyses (user_id, created_at desc);
create index if not exists statement_analyses_pending_idx
  on public.statement_analyses (status, updated_at) where status = 'pending';

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================
-- OWN ROWS, READ ONLY. An applicant may read their own feedback and nothing
-- else; the shape follows statement_drafts.
--
-- NO INSERT, UPDATE OR DELETE POLICY, which is the load-bearing absence. A
-- missing policy is a denial. If an applicant could write this table they could
-- fabricate a 'complete' row -- feedback nobody generated, attached to a
-- fingerprint of their choosing -- and read it back as though it had been paid
-- for and validated. Both writes run through the definer functions in section
-- 6, which derive the owner from auth.uid() and are the only path in.
alter table public.statement_analyses enable row level security;

drop policy if exists "own statement analysis select" on public.statement_analyses;
create policy "own statement analysis select" on public.statement_analyses
  for select to authenticated using (user_id = (select auth.uid()));

-- ============================================================
-- 5. GRANTS -- revoke first, because GRANT is additive
-- ============================================================
revoke all on public.statement_analyses from public;
revoke all on public.statement_analyses from anon, authenticated, service_role;

-- SELECT only, and only for a signed-in caller. RLS then limits it to their own
-- rows, so no applicant can read another's feedback or essay excerpts.
grant select on public.statement_analyses to authenticated;

-- anon gets nothing: an analysis is not public reference data.
-- service_role gets nothing either; the privileged path is a function.

-- ============================================================
-- 6. THE TWO WRITES
-- ============================================================

-- CLAIM. Returns the existing row when one exists, and inserts a pending claim
-- when none does -- in one statement, so two simultaneous callers cannot both
-- believe they won.
--
-- SECURITY DEFINER because applicants hold no INSERT, by design. Ownership is
-- established from auth.uid() and from nowhere else: there is no parameter that
-- could name another user.
--
-- STALE CLAIMS ARE TAKEN OVER. A caller whose request died -- a timeout, a
-- closed tab, a deploy -- leaves a pending row behind. After the staleness
-- window it is reclaimed rather than blocking the draft for ever. The window is
-- comfortably longer than the model timeout, so a slow-but-live request is
-- never stolen from.
create or replace function public.claim_statement_analysis(
  p_draft_id        uuid,
  p_fingerprint     text,
  p_revision        bigint,
  p_prompt_attached boolean,
  p_provenance      text,
  p_words           integer,
  p_stated_max      integer,
  p_over_limit      boolean,
  p_rubric_version  text,
  p_schema_version  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
  v_row  public.statement_analyses%rowtype;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- An existing row for exactly these inputs, if it is this caller's.
  select * into v_row
  from public.statement_analyses
  where draft_id = p_draft_id and fingerprint = p_fingerprint
  for update;

  if found then
    if v_row.user_id <> v_user then
      -- Somebody else's draft. Indistinguishable from one that does not exist.
      return jsonb_build_object('ok', false, 'reason', 'not-found');
    end if;
    if v_row.status = 'complete' then
      return jsonb_build_object('ok', true, 'state', 'complete',
                                'id', v_row.id, 'review', v_row.review,
                                'overall', v_row.overall, 'revision', v_row.revision,
                                'words', v_row.words, 'overLimit', v_row.over_limit,
                                'statedMaxWords', v_row.stated_max_words,
                                'provenance', v_row.provenance,
                                'createdAt', v_row.created_at);
    end if;
    -- Pending. Still running, or abandoned.
    if v_row.updated_at > now() - interval '10 minutes' then
      return jsonb_build_object('ok', true, 'state', 'running', 'id', v_row.id);
    end if;
    update public.statement_analyses
       set updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('ok', true, 'state', 'claimed', 'id', v_row.id);
  end if;

  insert into public.statement_analyses (
    user_id, draft_id, fingerprint, status, revision, prompt_attached, provenance,
    words, stated_max_words, over_limit, rubric_version, schema_version
  ) values (
    v_user, p_draft_id, p_fingerprint, 'pending', p_revision, p_prompt_attached,
    p_provenance, p_words, p_stated_max, coalesce(p_over_limit, false),
    p_rubric_version, p_schema_version
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'state', 'claimed', 'id', v_row.id);
end;
$fn$;

revoke all on function public.claim_statement_analysis(
  uuid, text, bigint, boolean, text, integer, integer, boolean, text, text) from public;
revoke all on function public.claim_statement_analysis(
  uuid, text, bigint, boolean, text, integer, integer, boolean, text, text) from anon;
grant execute on function public.claim_statement_analysis(
  uuid, text, bigint, boolean, text, integer, integer, boolean, text, text) to authenticated;

-- SETTLE. Completes a claim with a validated result, or releases it.
--
-- A FAILURE DELETES THE CLAIM rather than marking it failed. A deleted claim
-- leaves no state to reason about: the next attempt is an ordinary first
-- attempt. A 'failed' row would have to be aged out, ignored or cleaned up
-- before every retry, and getting that wrong would lock an applicant out of
-- analysing their own draft.
--
-- A RESULT IS ONLY EVER WRITTEN ONTO A PENDING ROW the caller owns. A completed
-- row is never overwritten, so a late or duplicated response cannot replace
-- feedback the applicant is already reading.
create or replace function public.settle_statement_analysis(
  p_id      uuid,
  p_review  jsonb,
  p_overall integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user    uuid := auth.uid();
  v_updated uuid;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;

  -- No result: the attempt failed, so the claim goes away entirely.
  if p_review is null or p_overall is null then
    delete from public.statement_analyses
     where id = p_id and user_id = v_user and status = 'pending';
    return jsonb_build_object('ok', true, 'state', 'released');
  end if;

  update public.statement_analyses
     set status = 'complete',
         review = p_review,
         overall = p_overall,
         updated_at = now()
   where id = p_id and user_id = v_user and status = 'pending'
  returning id into v_updated;

  if v_updated is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  return jsonb_build_object('ok', true, 'state', 'complete');
end;
$fn$;

revoke all on function public.settle_statement_analysis(uuid, jsonb, integer) from public;
revoke all on function public.settle_statement_analysis(uuid, jsonb, integer) from anon;
grant execute on function public.settle_statement_analysis(uuid, jsonb, integer) to authenticated;

commit;

-- ============================================================
-- ACTIVATION SEQUENCE
-- ============================================================
-- 1. Apply this file.
-- 2. Run supabase/manual/statement_analyses_security_check.sql and read every
--    row's `ok` column.
-- 3. Only then set STATEMENT_ANALYSIS_CACHE=on and restart.
--
-- BEFORE STEP 3 the application issues no query naming this table or either
-- function, and the analyser behaves exactly as it does today: every request is
-- a fresh model call. Nothing degrades silently -- analysisCacheEnabled() is
-- read once per request and the route takes a different path, rather than
-- catching an error and carrying on.
--
-- ROLLBACK is clearing the flag. No code change, and the stored rows are simply
-- not consulted.
