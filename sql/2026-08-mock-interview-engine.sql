-- Mock Interview engine upgrade — OPTIONAL columns.
--
-- The app works without running this: saves fall back to the original column
-- set the first time an extended write fails. Running it enables the mode
-- filter, score/readiness badges in Past Interview Review, and persistence of
-- the full engine state (per-scenario scores, difficulty, concepts tested).
--
-- Safe to run more than once. No existing rows or columns are altered.

alter table public.interview_sessions
  add column if not exists mode text default 'practice',
  add column if not exists engine_state jsonb,
  add column if not exists overall_score numeric,
  add column if not exists readiness text;

-- Existing rows predate modes and behaved like Practice Mode.
update public.interview_sessions set mode = 'practice' where mode is null;

-- The anti-repetition lookup filters by user + type over a 36 hour window.
create index if not exists user_asked_questions_lookup_idx
  on public.user_asked_questions (user_id, interview_type, asked_at desc);

create index if not exists interview_sessions_user_created_idx
  on public.interview_sessions (user_id, created_at desc);
