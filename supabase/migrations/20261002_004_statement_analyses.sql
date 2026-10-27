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
  -- the person who paid for it, nor refused to anybody else. Foreign key in
  -- section 2b.
  user_id           uuid        not null,

  -- The draft it is about. Same uuid as public.statement_drafts.id.
  --
  -- THE FOREIGN KEY IS DECLARED IN SECTION 2b, AND AN EARLIER COMMENT HERE WAS
  -- WRONG TO SAY IT COULD NOT BE. It said "no FK, for the reason every
  -- migration in this family gives -- the legacy schools capture has to land
  -- before this family declares any". That reason is real and it is about
  -- public.schools, which predates the migrations directory and exists only in
  -- production. It does not apply to public.statement_drafts, which
  -- 20260928_000 creates and which declares an FK of its own to auth.users.
  -- Over-generalising the schools argument left paid analyses able to outlive
  -- the drafts they quote. See section 2b.
  draft_id          uuid        not null,

  -- SHA-256 of the analysed inputs. The identity of the work, and the one
  -- column that decides whether a stored result still applies.
  fingerprint       text        not null,

  -- WHICH ATTEMPT OWNS THIS ROW RIGHT NOW. Rotated on every successful claim,
  -- including a reclaim of an abandoned one.
  --
  -- ADDED AFTER AUDIT, AND IT CLOSES A REAL HOLE. Recovery of a stale claim
  -- keeps the row's id -- deliberately, so a settle() still in flight completes
  -- THIS row rather than creating a stray second one. But the id was also the
  -- only thing settle() checked, so the request whose claim had been
  -- SUPERSEDED still held a valid handle to it:
  --
  --   T+0   request A claims. Row X, pending. A calls the model.
  --   T+11  A has not returned. Request B reclaims the stale row: same id X,
  --         updated_at refreshed. B calls the model.
  --   T+15  A returns and calls settle(X, its result). The predicate
  --         `id = X and user_id = mine and status = 'pending'` was all true,
  --         so A WROTE ITS RESULT ONTO B'S CLAIM -- and B's own settle then
  --         matched nothing, so B's paid result was discarded.
  --
  --   Worse, if A's model call FAILED it called the release path, which
  --   DELETED B's pending claim -- so B paid, got an error, and a third
  --   request could then start a fourth paid call for the same inputs.
  --
  -- SO AUTHORITY IS NOW THE TOKEN, NOT THE ID. settle() requires both, and a
  -- superseded request holds a token that no longer exists on the row. It can
  -- neither complete it nor release it; it simply learns it lost.
  --
  -- NOT UNIQUE, and not an index. It is never looked up BY -- it is only ever
  -- compared against the row the id already found, which is what keeps the
  -- primary key the access path.
  claim_token       uuid        not null default gen_random_uuid(),

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
-- 2b. REFERENTIAL INTEGRITY AND RETENTION
-- ============================================================
--
-- ADDED AFTER AUDIT. The audit asked what happens to a stored analysis when the
-- draft or the account goes away, and the answer was: nothing. The rows stayed.
--
-- AND THEY ARE NOT ANONYMOUS. The header above says the essay is not stored
-- here, which is true of the WHOLE essay and misleading about excerpts: the
-- validated review in `review` carries an `evidence` field per category, and
-- lib/statement/draft/reviewSchema.ts REQUIRES that evidence to be a real span
-- of the applicant's text -- fabricatedQuotes() rejects a result whose quote
-- does not appear in the essay. So an orphaned row holds verbatim excerpts of
-- somebody's personal statement, attached to a draft that no longer exists.
--
-- THREE PATHS LEAD THERE, AND TWO OF THEM LEAKED:
--
--   An applicant deletes a draft. deleteDraft() in draftRepo.ts is a plain
--   DELETE on statement_drafts. Without the FK below, every analysis of that
--   draft survived it.
--
--   An account is deleted. statement_drafts.user_id already references
--   auth.users(id) ON DELETE CASCADE (20260928_000), so removing the auth user
--   removes the drafts -- and, without the FK below, left their analyses.
--   supabase/manual/delete_fake_accounts.sql relies on exactly that cascade and
--   names statement_drafts nowhere, so it would not have caught this either.
--
--   An applicant deletes their account themselves. There is no such path in
--   this application today; account deletion is the administrator's script
--   above. Recorded because the absence is the reason the second path matters.
--
-- ONE FOREIGN KEY FIXES ALL OF IT, AND NO DELETION CODE CHANGES.
-- draft_id -> statement_drafts(id) ON DELETE CASCADE puts analyses on the chain
-- that already exists: auth.users -> statement_drafts -> statement_analyses.
-- The administrator's script keeps working untouched, deleteDraft() keeps being
-- one statement, and no sweep, trigger or scheduled job is introduced.
--
-- CASCADE AND NOT SET NULL, because draft_id is NOT NULL and because the point
-- is removal: an applicant who deleted their draft should not leave feedback
-- quoting it behind. A paid analysis is lost with the draft, which is the
-- correct trade and is what deleting a draft means.
--
-- NO NEW INDEX IS NEEDED. A cascading delete needs an index on the referencing
-- column or it degrades to a sequential scan per deleted parent;
-- statement_analyses_draft_idx in section 3 leads with draft_id and serves it.
alter table public.statement_analyses
  drop constraint if exists statement_analyses_draft_fk;
alter table public.statement_analyses
  add constraint statement_analyses_draft_fk
  foreign key (draft_id) references public.statement_drafts(id) on delete cascade;

-- THE SECOND KEY IS A BACKSTOP, NOT THE MECHANISM. With the draft key above,
-- every analysis is already reachable from a user through its draft -- and that
-- reachability rests on an application invariant: that claim() refuses a draft
-- the caller does not own. That invariant is now enforced (see the ownership
-- block in claim_statement_analysis) but it is still TypeScript, and a
-- retention guarantee should not depend on it. This key makes account deletion
-- remove the rows whether or not the draft link ever held.
--
-- SAME SHAPE AS statement_drafts' OWN KEY, so account deletion behaves
-- identically for both tables and there is one story rather than two.
alter table public.statement_analyses
  drop constraint if exists statement_analyses_user_fk;
alter table public.statement_analyses
  add constraint statement_analyses_user_fk
  foreign key (user_id) references auth.users(id) on delete cascade;

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
--
-- THE CALLER MUST OWN THE DRAFT, checked against public.statement_drafts before
-- anything is read or written here. Added after audit; see the block inside the
-- function for what the absence of that check allowed.
--
-- AND THE LOSER OF A RACE IS TOLD 'running', not handed a unique violation.
-- Also added after audit. The money guarantee was never at risk -- two claims
-- were always impossible -- but the loser's ANSWER used to be an exception.
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
  v_user     uuid := auth.uid();
  v_row      public.statement_analyses%rowtype;
  v_owns     boolean;
  v_attempts integer := 0;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- EVERY PARAMETER THAT BACKS A not-null OR CHECKED COLUMN IS VALIDATED HERE,
  -- so a malformed direct RPC call is answered rather than aborted. Without
  -- this, a null revision raises 23502 and a provenance of 'verified' raises
  -- 23514 -- and a constraint violation propagating out of a definer function
  -- tells the caller the constraint's name, which is more than a refusal needs
  -- to say. The application never sends these, so this costs nothing in the
  -- normal path; it exists because the function is granted to `authenticated`
  -- and is therefore reachable directly over PostgREST.
  if p_revision is null
     or p_prompt_attached is null
     or p_words is null
     or p_rubric_version is null
     or p_schema_version is null
     or (p_provenance is not null and p_provenance not in ('catalog', 'user'))
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- ---- THE DRAFT MUST BE THIS CALLER'S -----------------------------------
  --
  -- ADDED AFTER AUDIT. The first version of this function derived OWNERSHIP OF
  -- THE ANALYSIS from auth.uid() -- which was right -- but never asked whether
  -- the caller owned THE DRAFT it is about. Because this function is granted to
  -- `authenticated` and is reachable directly over PostgREST, and because the
  -- uniqueness key is (draft_id, fingerprint) with user_id deliberately absent
  -- from it, a caller could insert a pending row naming somebody else's draft.
  -- The consequence was not a data leak -- RLS still showed them only their own
  -- rows, and the row held none of the victim's content -- but it was a
  -- lockout: the victim's own claim would then find a row whose user_id is not
  -- theirs, receive 'not-found', and never be able to analyse that draft.
  --
  -- THIS READ BYPASSES RLS, WHICH IS WHY THE FILTER IS EXPLICIT. A definer
  -- function runs as the owner, so `user_id = v_user` is doing the work the
  -- policy would otherwise do, and it is written on the same line as the id so
  -- the two cannot drift apart.
  --
  -- AN ABSENT DRAFT AND SOMEBODY ELSE'S DRAFT GIVE THE SAME ANSWER. 'not-found'
  -- for both, so the function cannot be used to discover which draft ids exist.
  select exists (
    select 1 from public.statement_drafts d
     where d.id = p_draft_id and d.user_id = v_user
  ) into v_owns;

  if not v_owns then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  -- ---- CLAIM, OR REPORT THE CLAIM THAT ALREADY EXISTS --------------------
  --
  -- THE LOOP IS THE FIX FOR THE SECOND AUDIT FINDING. The first version read,
  -- then inserted; two callers who both found nothing both reached the insert,
  -- and the loser got a bare unique violation -- a 23505 out of a definer
  -- function, which the route could only turn into "the cache is unavailable".
  -- A double CLAIM was never possible and no second model call was ever made,
  -- so no applicant was ever charged twice; the defect was that the loser's
  -- answer was an exception instead of the truth, which is that somebody else
  -- is already doing this work.
  --
  -- SO THE INSERT IS `on conflict do nothing` AND THE LOOP RE-READS. Attempt
  -- one usually reads nothing and inserts successfully. A loser's insert
  -- affects no row, the loop goes round, the winner's row is now visible, and
  -- the loser is told 'running' -- which is what the route already handles and
  -- already reports as `already-running`.
  --
  -- BOUNDED AT TWO, not `loop ... end loop`. Two passes is all the race needs:
  -- one to discover the conflict and one to read the winner. An unbounded loop
  -- would spin if a row were repeatedly inserted and deleted underneath this
  -- one, and a definer function that can spin is worse than one that gives up.
  while v_attempts < 2 loop
    v_attempts := v_attempts + 1;

    select * into v_row
    from public.statement_analyses
    where draft_id = p_draft_id and fingerprint = p_fingerprint
    for update;

    if found then
      -- DEFENCE IN DEPTH. With the draft-ownership check above, a row for this
      -- draft can only belong to this caller, so this branch should now be
      -- unreachable. It stays because "should be unreachable" is a claim about
      -- today's code and this is a claim about the data.
      if v_row.user_id <> v_user then
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
      --
      -- EXPIRED CLAIMS ARE RECOVERED BY TOUCHING updated_at, not by deleting
      -- and re-inserting. The row keeps its id, so a settle() already in flight
      -- from the dead request cannot complete a DIFFERENT row -- and because
      -- settle only writes onto a row that is still 'pending' and still the
      -- caller's, a late arrival from the abandoned attempt writes the result
      -- the new attempt is waiting for rather than a stray second row.
      --
      -- A LIVE CLAIM IS REPORTED WITHOUT A TOKEN. 'running' is not authority:
      -- this caller did not win the attempt and must never be able to settle
      -- it. Returning no token is what makes that structural rather than a
      -- rule the route has to remember.
      if v_row.updated_at > now() - interval '10 minutes' then
        return jsonb_build_object('ok', true, 'state', 'running', 'id', v_row.id);
      end if;

      -- RECLAIM. The id is kept and the TOKEN IS ROTATED, which is the whole
      -- fix: the abandoned request still holds the old token, so when it
      -- eventually returns it can neither complete this row nor release it.
      update public.statement_analyses
         set updated_at = now(),
             claim_token = gen_random_uuid()
       where id = v_row.id
      returning * into v_row;
      return jsonb_build_object('ok', true, 'state', 'claimed',
                                'id', v_row.id, 'claimToken', v_row.claim_token);
    end if;

    insert into public.statement_analyses (
      user_id, draft_id, fingerprint, status, revision, prompt_attached, provenance,
      words, stated_max_words, over_limit, rubric_version, schema_version
    ) values (
      v_user, p_draft_id, p_fingerprint, 'pending', p_revision, p_prompt_attached,
      p_provenance, p_words, p_stated_max, coalesce(p_over_limit, false),
      p_rubric_version, p_schema_version
    )
    -- NAMED CONSTRAINT, NOT INFERRED COLUMNS. The constraint is created a few
    -- statements above this one, so naming it fails loudly if it is ever
    -- renamed, where `on conflict (draft_id, fingerprint)` would silently start
    -- inferring a different index.
    on conflict on constraint statement_analyses_draft_fingerprint_key do nothing
    returning * into v_row;

    if found then
      -- The column default generated the token; return it rather than
      -- generating a second one, so the row and the caller cannot disagree.
      return jsonb_build_object('ok', true, 'state', 'claimed',
                                'id', v_row.id, 'claimToken', v_row.claim_token);
    end if;
  end loop;

  -- BOTH PASSES SAW NOTHING AND INSERTED NOTHING. Reachable only if the
  -- winner's row was deleted between the conflict and the re-read, twice. There
  -- is nothing truthful to report, so this refuses rather than guessing; the
  -- route treats an unrecognised reason as a refusal and the applicant may
  -- retry. No row was written and nothing was charged.
  return jsonb_build_object('ok', false, 'reason', 'invalid');
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
-- A RESULT IS ONLY EVER WRITTEN ONTO A PENDING ROW the caller owns AND STILL
-- HOLDS THE TOKEN FOR. A completed row is never overwritten, so a late or
-- duplicated response cannot replace feedback the applicant is already reading;
-- and a SUPERSEDED request -- one whose claim was reclaimed while its model
-- call was in flight -- can neither complete nor release the replacement.
-- THE SIGNATURE CHANGED WHEN THE TOKEN WAS ADDED, so the three-argument
-- version is dropped rather than left beside the new one. `create or replace`
-- with a different argument list creates a SECOND function; leaving both would
-- mean a caller that still passes three arguments keeps the unprotected path
-- and nothing would ever say so. Dropping it makes a stale deployment fail
-- loudly with "function does not exist" instead of silently settling without a
-- token. 004 is unapplied, so there is nothing to drop today -- this exists so
-- a re-run after a partial apply cannot leave the old overload behind.
drop function if exists public.settle_statement_analysis(uuid, jsonb, integer);

create or replace function public.settle_statement_analysis(
  p_id      uuid,
  p_token   uuid,
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

  -- A SCORE OUTSIDE THE COLUMN'S RANGE IS REFUSED, NOT RAISED. Same reasoning
  -- as the parameter block in claim(): the statement_analyses_overall_range
  -- CHECK would otherwise abort this function with 23514 for a caller who
  -- reached the RPC directly. The application computes `overall` from the
  -- category scores and cannot produce an out-of-range value; this is here
  -- because the function is granted to `authenticated`.
  --
  -- A NULL OVERALL IS NOT INVALID -- it is the release path below.
  if p_overall is not null and (p_overall < 0 or p_overall > 100) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- THE TOKEN IS REQUIRED ON BOTH PATHS. A null token is not a wildcard: a
  -- caller that cannot name which attempt it is has no authority over any.
  if p_token is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- No result: the attempt failed, so the claim goes away entirely.
  --
  -- AND claim_token IS IN THE PREDICATE, which is the half of the fix that
  -- matters most. Without it, a request whose claim had been reclaimed could
  -- DELETE the replacement -- the new attempt's model call would then be paid
  -- for and have nowhere to land.
  if p_review is null or p_overall is null then
    delete from public.statement_analyses
     where id = p_id and claim_token = p_token
       and user_id = v_user and status = 'pending'
    returning id into v_updated;
    -- 'released' EITHER WAY, deliberately. A caller releasing a claim it no
    -- longer holds has nothing to fix and nothing to be told: the row it was
    -- told to let go of is already somebody else's or already gone. Reporting
    -- a failure here would make the route log an error on the normal outcome
    -- of being superseded.
    return jsonb_build_object('ok', true, 'state', 'released',
                              'released', v_updated is not null);
  end if;

  update public.statement_analyses
     set status = 'complete',
         review = p_review,
         overall = p_overall,
         updated_at = now()
   where id = p_id and claim_token = p_token
     and user_id = v_user and status = 'pending'
  returning id into v_updated;

  -- FOUR WAYS TO MISS, ONE ANSWER. Wrong id, wrong token (superseded), wrong
  -- user, or already complete -- all 'not-found', so a late request cannot
  -- learn from the refusal which of those happened to it.
  if v_updated is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  return jsonb_build_object('ok', true, 'state', 'complete');
end;
$fn$;

revoke all on function public.settle_statement_analysis(uuid, uuid, jsonb, integer)
  from public;
revoke all on function public.settle_statement_analysis(uuid, uuid, jsonb, integer)
  from anon;
grant execute on function public.settle_statement_analysis(uuid, uuid, jsonb, integer)
  to authenticated;

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
