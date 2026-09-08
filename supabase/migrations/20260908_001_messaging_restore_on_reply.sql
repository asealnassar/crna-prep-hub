-- MESSAGING H-1 — a hidden conversation comes back when a new message arrives.
--
-- THE DEFECT THIS REPAIRS: "Delete conversation" sets
-- thread_participants.deleted_at for that participant, and the inbox filters on
-- `deleted_at is null`. Nothing in the application or the database ever cleared
-- the flag -- verified by grep across app/, components/, lib/ and supabase/ --
-- so the conversation was hidden permanently and every later message from the
-- other party was silently invisible, with no indication to either side.
-- Reproduced on throwaway data: hide, receive a new message, still hidden.
--
-- APPROVED BEHAVIOUR (Option A):
--   * hiding still sets that participant's deleted_at
--   * historical messages are never deleted
--   * a NEW incoming message restores the RECIPIENT's hidden conversation
--   * only the recipient's deleted_at is cleared; the sender's is untouched
--   * a hidden user sending into their own hidden thread stays hidden
--   * the restored message is unread, and the old history is intact
--   * a message with a NULL sender restores NOBODY
--
-- WHY A TRIGGER RATHER THAN THE CLIENT: after 20260908_000, the
-- "participants hide own" policy is `using (user_id = auth.uid())`, so a sender
-- cannot clear the recipient's flag from the browser -- an attempt updates zero
-- rows. Doing this client-side would mean loosening that policy back into "a
-- member may edit another member's participation", which is precisely what the
-- security migration removed. The trigger is the only place with the authority,
-- and it covers every insert path at once: the direct reply,
-- create_thread_with_message and send_tier_broadcast.
--
-- SCOPE: one function and one trigger. NO message row is read for content,
-- modified or deleted. NO policy, grant or existing trigger is altered.
-- 20260908_000_messaging_security.sql is not touched.

begin;

-- ============================================================
-- 1. THE TRIGGER FUNCTION
-- ============================================================
-- SECURITY DEFINER is required, not preferred: the row being cleared belongs to
-- the OTHER participant, and RLS would filter it to zero rows for the sender's
-- role. The function is correspondingly narrow -- it writes one column, on one
-- thread, for participants who are not the sender, and only where the flag is
-- actually set. It reads nothing and returns nothing.
create or replace function public.messaging_restore_on_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- APPROVED: a null-sender message restores nobody. Returning early also
  -- keeps `is distinct from` below from matching every participant.
  if new.sender_id is null then
    return new;
  end if;

  -- Only the recipients, only the hidden ones, and only deleted_at.
  --
  -- The `deleted_at is not null` clause means a participant who never hid the
  -- conversation is not written to at all -- no pointless update, and the
  -- BEFORE UPDATE immutability guard is not woken for a no-op.
  update public.thread_participants tp
     set deleted_at = null
   where tp.thread_id = new.thread_id
     and tp.user_id is distinct from new.sender_id
     and tp.deleted_at is not null;

  return new;
end $function$;

-- Trigger permission is checked at CREATE TRIGGER time, not on each firing, so
-- the trigger keeps working with EXECUTE granted to no application role. There
-- is no legitimate reason for a browser session to call this directly.
revoke all on function public.messaging_restore_on_reply()
  from public, anon, authenticated, service_role;

-- ============================================================
-- 2. THE TRIGGER
-- ============================================================
-- AFTER INSERT: the message is already durable, so a conversation is never
-- restored for a message that did not commit. FOR EACH ROW, because the
-- decision is per-message -- a tier broadcast inserts one message per thread
-- and each must be judged on its own sender and thread.
drop trigger if exists messaging_restore_on_reply on public.thread_messages;
create trigger messaging_restore_on_reply
  after insert on public.thread_messages
  for each row execute function public.messaging_restore_on_reply();

commit;

-- ============================================================
-- INTERACTION WITH messaging_participants_immutable (20260908_000)
-- ============================================================
-- That BEFORE UPDATE trigger raises 42501 if anything other than deleted_at
-- changes on a thread_participants row. The update above changes deleted_at
-- and nothing else, so it passes the guard rather than bypassing it -- the
-- guard stays in force for every other writer.
--
-- UNCHANGED BY THIS MIGRATION (stated, not assumed)
--   * every message, thread, participant and read-status ROW
--   * every RLS policy, table grant and function from 20260908_000
--   * deleteThread / loadThreads and the participants route
--   * message_read_status: the restored message stays unread because nothing
--     here touches read_at
-- ============================================================

-- VERIFICATION (read-only, run after applying)
-- select tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger
--  where tgrelid = 'public.thread_messages'::regclass and not tgisinternal;
-- EXPECT: one row, messaging_restore_on_reply, AFTER INSERT FOR EACH ROW.
--
-- select prosecdef, proconfig::text from pg_proc p
--  join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public' and p.proname='messaging_restore_on_reply';
-- EXPECT: true, {"search_path="}.
