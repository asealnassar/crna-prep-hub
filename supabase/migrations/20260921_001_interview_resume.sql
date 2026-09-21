-- ============================================================================
-- Resume an interview that is already in progress.
--
-- An interview is three things: the transcript, the engine state, and the
-- authorization to take another turn. The first two are already persisted in
-- interview_sessions. The third -- the grant id -- lived only in a React ref,
-- so a page refresh destroyed it and every continuation afterwards returned
-- 403. There was no path back into an interview the applicant had already paid
-- for, and starting again charged them a second time.
--
-- The link is stored HERE, on the grant, rather than on interview_sessions.
-- interview_sessions is written directly by the browser; a grant id sitting in
-- a client-writable row is a client-supplied credential wearing a database's
-- clothes. interview_grants is service-role only with RLS and no policies, so a
-- pointer written here cannot be forged. Resume therefore takes only a session
-- id the applicant already owns, and the SERVER resolves the grant from it.
-- ============================================================================

-- The one-time binding. Nullable because it is written a moment after the row
-- is created, and because every grant that predates this migration will never
-- have one.
alter table public.interview_grants
  add column if not exists session_id uuid;

-- Deliberately NO foreign key to interview_sessions.
--
-- That table is client-writable: a user deleting their own session row would
-- either block on a RESTRICT or silently rewrite server-owned authorization on
-- a CASCADE. The resume path already verifies ownership of both rows on every
-- request, so referential integrity here would buy nothing and hand the client
-- a lever on the grants table.

-- One session, one grant -- enforced HERE, not in application code.
--
-- The binding is an authorization relationship, and a conditional UPDATE in
-- TypeScript only narrows the race, it does not close it: two requests can both
-- observe session_id IS NULL on two different grants and both aim at the same
-- session. A unique index makes the second one fail in the database, which is
-- the only place that can actually arbitrate it.
--
-- PARTIAL, on non-null values only, because null is the normal resting state:
-- every grant issued before this feature has one, and a plain unique index
-- treats nulls as distinct anyway but the partial form says the intent out loud
-- and keeps the index small. It also doubles as the lookup index resume needs,
-- since resume queries by session_id.
create unique index if not exists interview_grants_session_id_key
  on public.interview_grants (session_id)
  where session_id is not null;

-- Abandonment is NOT completion.
--
-- Overloading `completed` would have been cheaper and wrong: it is what the
-- final report and the completion analytics read, so an abandoned interview
-- would count as a finished mock forever. A separate timestamp keeps the four
-- states distinguishable -- in progress, completed, abandoned, expired -- and
-- expired stays derived from created_at rather than stored, because a row does
-- not need writing simply because time passed.
alter table public.interview_grants
  add column if not exists abandoned_at timestamptz;

-- The deferred half of a Practice-mode checkpoint.
--
-- At a checkpoint the model has ALREADY produced the next question and the
-- grant turn has ALREADY been spent, but the UI holds both in memory until the
-- applicant clicks Continue, and the row deliberately persists the PRE-turn
-- state so the header does not count up while the review is still on screen.
-- Refresh there and the paid-for question is gone with no way back that does
-- not call the model again. This column is what makes that checkpoint
-- survivable.
--
-- Client-written, like conversation and engine_state beside it, and validated
-- on the way back out for exactly that reason.
alter table public.interview_sessions
  add column if not exists pending_turn jsonb;

-- ============================================================================
-- Historical rows are deliberately NOT backfilled.
--
-- session_id stays null on every grant that already exists, which makes every
-- interview created before this feature non-resumable without a single line of
-- special-case code: the resume query simply never matches them. They remain
-- readable in history, exactly as they are today. A backfill would have to
-- guess which session belonged to which grant, and guessing is the one thing
-- an authorization relationship must never do.
-- ============================================================================
