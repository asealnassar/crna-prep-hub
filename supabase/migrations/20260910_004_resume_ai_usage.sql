-- Resume V2: AI usage ledger.
--
-- WHAT THIS IS NOT. It is not a quota. There is no monthly allowance, nothing
-- counts down, and no number derived from this table is ever shown to anyone.
-- The locked monetisation model puts the gate on finalising and exporting, not
-- on generation, so Free and Premium use the AI workflow freely.
--
-- WHAT IT IS. Two things: invisible abuse protection, and cost observability.
-- A script hammering the propose endpoint is caught by counting recent rows
-- here; a bill that surprises someone is explained by reading them.
--
-- WHY EVERY ATTEMPT COUNTS. A quota must not be burned by a failed call -- the
-- user did not get what they paid for. An abuse control is the opposite: if a
-- failed attempt were free, causing failures would be the way to bypass it.
-- So rows are written for every attempt and `outcome` records what became of
-- it, for the reading rather than for the counting.
--
-- NOT APPLIED BY THIS PROJECT'S TOOLING. Written to be reviewed and run by
-- hand, like every other migration in this rebuild.

begin;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.resume_ai_usage (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Kept when the resume is deleted: the call still happened and still cost
  -- money, and losing the row would let deletion erase an abuse trail.
  resume_id   uuid references public.resumes(id) on delete set null,
  operation   text not null,
  outcome     text not null default 'attempted',
  created_at  timestamptz not null default now()
);

alter table public.resume_ai_usage
  drop constraint if exists resume_ai_usage_outcome_check;
alter table public.resume_ai_usage
  add constraint resume_ai_usage_outcome_check
  check (outcome in ('attempted', 'proposed', 'rejected', 'failed'));

-- The only query shape that matters: this user's calls since a moment.
create index if not exists resume_ai_usage_user_time_idx
  on public.resume_ai_usage (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

do $guard$
begin
  if not coalesce((
    select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'resume_ai_usage'
  ), false) then
    execute 'alter table public.resume_ai_usage enable row level security';
  end if;
end $guard$;

-- SELECT only, and only your own. There is deliberately NO insert, update or
-- delete policy: writes go through record_ai_usage() below. A client that could
-- delete its own rows could reset its own rate limit, which is the whole
-- attack this table exists to stop.
do $guard$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'resume_ai_usage'
       and policyname = 'Users can view own AI usage'
  ) then
    execute 'create policy "Users can view own AI usage" on public.resume_ai_usage
             for select using (auth.uid() = user_id)';
  end if;
end $guard$;

-- ---------------------------------------------------------------------------
-- Recording
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER because the table grants no INSERT to anyone. Ownership is
-- not a parameter: the row is written for auth.uid(), so a caller cannot record
-- a call against another user -- nor, more to the point, avoid recording one
-- against themselves.
--
-- The rate DECISION is deliberately not made here. It lives in
-- lib/resume/entitlement.ts, where the windows are unit-tested, and taking
-- limits as arguments would let a caller invoking this function directly
-- nominate its own. Accepted consequence: two simultaneous requests can both
-- pass the check. For an abuse ceiling measured in tens per minute that is
-- immaterial; for a quota it would not have been.
create or replace function public.record_ai_usage(
  p_resume_id uuid,
  p_operation text,
  p_outcome   text default 'attempted'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
begin
  if v_user is null then
    return null;
  end if;

  insert into public.resume_ai_usage (user_id, resume_id, operation, outcome)
  values (
    v_user,
    p_resume_id,
    left(coalesce(p_operation, 'unknown'), 64),
    case when p_outcome in ('attempted', 'proposed', 'rejected', 'failed')
         then p_outcome else 'attempted' end
  )
  returning id into v_id;

  return v_id;
end $fn$;

-- Settles an attempt once its fate is known. Only the caller's own row, and
-- only its outcome -- the timestamp that the rate window counts cannot move.
create or replace function public.settle_ai_usage(
  p_id uuid,
  p_outcome text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or p_id is null then
    return false;
  end if;

  update public.resume_ai_usage
     set outcome = case when p_outcome in ('proposed', 'rejected', 'failed')
                        then p_outcome else outcome end
   where id = p_id
     and user_id = v_user;

  return found;
end $fn$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- GRANT is additive, so Supabase's default grants have to be revoked first.
revoke all privileges on table public.resume_ai_usage from anon, authenticated, service_role;
grant select on table public.resume_ai_usage to authenticated;
grant select, insert, update, delete on table public.resume_ai_usage to service_role;

revoke all on function public.record_ai_usage(uuid, text, text) from public;
revoke all on function public.record_ai_usage(uuid, text, text) from anon;
grant execute on function public.record_ai_usage(uuid, text, text) to authenticated;

revoke all on function public.settle_ai_usage(uuid, text) from public;
revoke all on function public.settle_ai_usage(uuid, text) from anon;
grant execute on function public.settle_ai_usage(uuid, text) to authenticated;

commit;

-- Verification, read-only. Run after applying.
--   select relrowsecurity from pg_class where relname = 'resume_ai_usage';
--   select policyname, cmd from pg_policies where tablename = 'resume_ai_usage';
--   select proname, prosecdef from pg_proc
--    where proname in ('record_ai_usage', 'settle_ai_usage');
