-- ============================================================================
-- M-5 durable email notification jobs -- PHASE 2: TRIGGER + BROADCAST EXCLUSION
-- ============================================================================
--
-- Phase 1 created email_notification_jobs and left it inert. This fills it.
--
-- Still NO email behaviour change: no worker, no cron, no change to
-- /api/messages/notify, /api/messages/broadcast, MessagesModal, or either
-- broadcast queue table. Jobs simply accumulate as 'pending' and nothing
-- drains them yet. Phase 1's inline browser notifications remain the only
-- thing sending email.
--
-- ---------------------------------------------------------------------------
-- WHY THE TRIGGER AND THE GUC ARE IN ONE MIGRATION
-- ---------------------------------------------------------------------------
-- send_tier_broadcast does not insert anything itself -- it calls
-- create_thread_with_message in a loop, so a broadcast message is byte for
-- byte identical to a normal admin-to-member message, and nothing in
-- thread_messages records which it is.
--
-- A trigger shipped WITHOUT the exclusion would therefore enqueue a job for
-- every broadcast recipient, and once a worker exists that is a second email
-- to an entire tier on top of the batch system's. Splitting these across two
-- migrations would leave that window open between them. They land together.
--
-- ---------------------------------------------------------------------------
-- NO BACKFILL
-- ---------------------------------------------------------------------------
-- This migration inserts nothing. thread_messages holds 735 rows; the trigger
-- fires only for rows written after it exists.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ATOMIC
-- ---------------------------------------------------------------------------
-- The trigger and the send_tier_broadcast replacement must land together or
-- not at all. A trigger without the exclusion would enqueue a job for every
-- broadcast recipient, and DDL is transactional in Postgres, so a failure at
-- any point below leaves the deployed definitions untouched.

begin;

-- ============================================================
-- 1. The trigger function
-- ============================================================
-- SECURITY DEFINER with a pinned empty search_path, matching every other
-- messaging function. It runs as the function owner, which is also the owner
-- of email_notification_jobs -- that is why Phase 1 deliberately did NOT set
-- FORCE ROW LEVEL SECURITY on that table: forcing it would subject the owner
-- to policies that do not exist and block this insert. service_role's
-- column-scoped grants are untouched and irrelevant here; the trigger does not
-- run as service_role.
create or replace function public.messaging_enqueue_notification_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_recipients uuid[];
begin
  -- A system-authored message has no sender to attribute the email to, and
  -- the same rule already governs messaging_restore_on_reply.
  if new.sender_id is null then
    return new;
  end if;

  -- Broadcast exclusion. set_config(..., true) in send_tier_broadcast makes
  -- this transaction-local, so it cannot survive into the next request on a
  -- pooled connection. current_setting's second argument is missing_ok, so an
  -- unset GUC yields NULL rather than raising -- which is the normal case for
  -- every ordinary message.
  if coalesce(current_setting('app.skip_notification_job', true), '') = 'on' then
    return new;
  end if;

  -- Exactly one counterpart, or no job. Collected as an array rather than a
  -- bare SELECT INTO because plpgsql silently takes the first row when a
  -- query returns several -- which would invent a recipient for one of the
  -- eleven known malformed threads instead of declining to guess.
  --
  -- deleted_at is deliberately NOT filtered. A recipient who has hidden the
  -- conversation is still owed the email, and messaging_restore_on_reply is
  -- about to un-hide them. Ignoring the column also removes any dependence on
  -- which of the two AFTER INSERT triggers Postgres runs first.
  select array_agg(distinct tp.user_id)
    into v_recipients
    from public.thread_participants tp
   where tp.thread_id = new.thread_id
     and tp.user_id is distinct from new.sender_id;

  if v_recipients is null or array_length(v_recipients, 1) <> 1 then
    return new;
  end if;

  -- message_id is the primary key, so one message can hold at most one job.
  -- ON CONFLICT keeps a retried or replayed insert from raising rather than
  -- relying on that never happening.
  insert into public.email_notification_jobs (message_id, recipient_user_id)
  values (new.id, v_recipients[1])
  on conflict (message_id) do nothing;

  return new;
end;
$function$;

revoke all on function public.messaging_enqueue_notification_job()
  from public, anon, authenticated, service_role;

-- ============================================================
-- 2. The trigger
-- ============================================================
-- AFTER INSERT, so the message is committed before an obligation is recorded
-- against it, and FOR EACH ROW because the recipient is per-message.
--
-- Named to sort after messaging_restore_on_reply, which Postgres fires first
-- alphabetically. The order does not matter -- neither trigger reads what the
-- other writes -- but making it deterministic and documented is cheaper than
-- re-deriving it later.
drop trigger if exists messaging_z_enqueue_notification_job on public.thread_messages;

create trigger messaging_z_enqueue_notification_job
  after insert on public.thread_messages
  for each row
  execute function public.messaging_enqueue_notification_job();

-- ============================================================
-- 3. send_tier_broadcast -- one added statement
-- ============================================================
-- Reproduced in full because CREATE OR REPLACE FUNCTION requires the whole
-- body. Everything is byte for byte the deployed definition except the single
-- set_config call marked below. In particular the recipient predicate is
-- untouched: no lowercasing, no trimming, no NULL coalescing, no widening.
create or replace function public.send_tier_broadcast(
  p_subject text,
  p_message_text text,
  p_tier text
) returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_record record;
  v_count integer := 0;
  v_caller uuid := auth.uid();
  v_admin uuid;
begin
  -- anon holds EXECUTE on this SECURITY DEFINER function today.
  if v_caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- rule 10: only the authoritative admin may broadcast.
  v_admin := public.get_admin_user_id();
  if v_admin is null or v_caller <> v_admin then
    raise exception 'Only the admin may send a tier broadcast' using errcode = '42501';
  end if;

  -- ADDED (M-5 Phase 2): the only change to this function.
  --
  -- Every message the loop below creates is delivered by the broadcast email
  -- system -- frozen batches, idempotency keys, retries. A durable
  -- notification job for the same message would be a SECOND email to the same
  -- person, so the trigger is told to stand down for the rest of this
  -- transaction.
  --
  -- The third argument is is_local = true: the setting is discarded when this
  -- transaction ends, so it cannot leak to the next statement on a pooled
  -- connection. It is set here rather than inside create_thread_with_message
  -- so that ordinary sends through that same RPC still enqueue normally.
  perform set_config('app.skip_notification_job', 'on', true);

  -- Everything below is the live definition, unmodified.
  for v_user_record in
    select id from public.user_profiles
    where subscription_tier = p_tier
      and id != auth.uid()
  loop
    perform public.create_thread_with_message(
      p_subject,
      array[v_user_record.id],
      p_message_text
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

-- Grants restated exactly as deployed: CREATE OR REPLACE preserves them, but
-- stating them makes the end state explicit rather than inherited.
revoke all on function public.send_tier_broadcast(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.send_tier_broadcast(text, text, text) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- READ-ONLY VERIFICATION (run after applying; returns rows, changes nothing)
-- ---------------------------------------------------------------------------
-- select count(*) as jobs_must_still_be_zero from public.email_notification_jobs;
--
-- select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
--  where c.relname = 'thread_messages' and not t.tgisinternal order by tgname;
--   -- expect messaging_restore_on_reply, messaging_z_enqueue_notification_job
--
-- select prosecdef, proconfig from pg_proc
--  where proname = 'messaging_enqueue_notification_job';
--   -- expect t, {search_path=}
--
-- select pg_get_functiondef(oid) from pg_proc where proname = 'send_tier_broadcast';
--   -- expect exactly one set_config line
