-- MESSAGING SECURITY — enforce the approved messaging rules in the database.
--
-- CONFIRMED FAILURE THIS REPAIRS: an authenticated member who belonged to one
-- thread could read all 671 threads and all 701 messages in the database, and
-- could insert, spoof, edit, delete, join and destroy any conversation. The
-- account owner reproduced it on a controlled admin -> lasttest@gmail.com
-- message: an unrelated member retrieved the thread, the message body, both
-- participant rows and the read-status row.
--
-- APPROVED RULES THIS ENFORCES:
--   1-3  members message ADMIN only; admin may message anyone; no user-to-user
--   4-6  a member reads only threads/messages/participants/read-status of
--        threads they participate in
--   7    a member can never send as another sender
--   8    a member can never edit or delete another member's message
--   9    a member can never change thread membership, their own or anyone's
--   10   anonymous callers cannot reach admin/broadcast capability
--   11   realtime obeys the same boundary as SELECT
--
-- SCOPE: policies, grants and three functions. NO message, thread, participant
-- or read-status ROW is created, altered or deleted. Historical conversations
-- are untouched.
--
-- *** APPLICATION GATE ***
-- create_thread_with_message and send_tier_broadcast are REPLACED here. Their
-- current bodies are not in version control; the replacements reproduce the
-- contract observed from black-box probing (see the report). Run
-- supabase/manual/messaging_security_preflight.sql section 7 FIRST and diff the
-- printed definitions against these before applying.

begin;

-- ============================================================
-- 1. HELPERS
-- ============================================================
-- A policy on thread_participants that queries thread_participants recurses.
-- These run as owner, so they read membership without re-entering RLS. They
-- answer one boolean about the CALLER and leak nothing else.
create or replace function public.messaging_is_participant(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.thread_participants tp
    where tp.thread_id = p_thread_id and tp.user_id = (select auth.uid())
  );
$$;

-- Membership of the thread a message belongs to, for read-status policies.
create or replace function public.messaging_is_participant_of_message(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.thread_messages m
    join public.thread_participants tp on tp.thread_id = m.thread_id
    where m.id = p_message_id and tp.user_id = (select auth.uid())
  );
$$;

-- May the CALLER record a delivery receipt naming p_user_id, for this message?
--
-- Deliberately ONE function rather than two. A separate
-- "is user X in message Y's thread" helper would have to be executable by
-- authenticated for the policy to use it, and PostgREST exposes anything
-- authenticated may execute -- turning it into a membership oracle that
-- answers for arbitrary message and user ids, including conversations the
-- caller has nothing to do with.
--
-- Folding the sender test INSIDE the same exists() removes that: the function
-- returns false for every message the caller did not write, whatever p_user_id
-- is. For messages the caller DID write, the answer discloses nothing new --
-- they can already read that thread's participants directly.
create or replace function public.messaging_can_deliver_receipt(
  p_message_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.thread_messages m
    join public.thread_participants tp on tp.thread_id = m.thread_id
    where m.id = p_message_id
      and m.sender_id = (select auth.uid())
      and tp.user_id = p_user_id
  );
$$;

-- May the CALLER post a reply into this thread?
--
-- A message may be added only to a thread that IS a valid conversation under
-- the approved rules -- private, two-party, admin plus one member. Three
-- conditions, evaluated together over the thread's participant set:
--
--   * exactly TWO distinct participant users;
--   * one of them is the admin;
--   * the caller is one of them.
--
-- Requiring only "caller is in it AND admin is in it" was not enough: a legacy
-- thread holding admin + user A + user B satisfies that for both A and B, so
-- two members could still reach each other through it. Pinning the count to
-- two closes that, and closes it for the admin as well -- there is no override.
--
-- The two legitimate parties are treated identically, so the member and the
-- admin can both reply in their shared thread.
--
-- Historical rows are untouched. A multi-party or user-to-user thread keeps
-- every row it has and stays readable under the participant rules; it simply
-- accepts no new message. Cleaning those up is a separate decision.
--
-- deleted_at is deliberately NOT considered: hiding a conversation is a
-- per-participant view state, and one side hiding it must not silence the
-- other.
--
-- An unresolvable admin id makes the admin clause false, so it fails closed.
--
-- Not an oracle: it takes only a thread id and returns false for every thread
-- the caller is not already in, so it discloses nothing they cannot read.
create or replace function public.messaging_can_post(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.thread_participants tp
    where tp.thread_id = p_thread_id
    group by tp.thread_id
    having count(distinct tp.user_id) = 2
       and count(*) filter (where tp.user_id = (select auth.uid())) > 0
       and count(*) filter (where tp.user_id = public.get_admin_user_id()) > 0
  );
$$;

revoke all on function public.messaging_is_participant(uuid)            from public, anon, authenticated, service_role;
revoke all on function public.messaging_can_deliver_receipt(uuid, uuid)  from public, anon, authenticated, service_role;
revoke all on function public.messaging_can_post(uuid)                  from public, anon, authenticated, service_role;
revoke all on function public.messaging_is_participant_of_message(uuid) from public, anon, authenticated, service_role;
-- Policies evaluate these as the querying role, so authenticated needs EXECUTE.
grant execute on function public.messaging_is_participant(uuid)            to authenticated;
grant execute on function public.messaging_can_deliver_receipt(uuid, uuid)  to authenticated;
grant execute on function public.messaging_can_post(uuid)                  to authenticated;
grant execute on function public.messaging_is_participant_of_message(uuid) to authenticated;

-- ============================================================
-- 2. DROP EVERY EXISTING POLICY ON THE MESSAGING TABLES
-- ============================================================
-- WHAT IS BEING REMOVED, from preflight section 5: each of the five tables
-- carries a single PERMISSIVE policy FOR ALL whose predicate is
--
--     auth.uid() IS NOT NULL
--
-- i.e. "any signed-in user may do anything to any row". That one predicate is
-- the whole of the current access control, and it is why a member of one
-- thread could read all 671 threads and all 701 messages, forge a sender,
-- edit and delete other people's messages, and delete conversations.
--
-- The policies are dropped by iterating the catalog rather than by name
-- because their names are not in version control. Keep the preflight output.
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('message_threads','thread_messages','thread_participants',
                        'message_read_status','message_deletions')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.message_threads      enable row level security;
alter table public.thread_messages      enable row level security;
alter table public.thread_participants  enable row level security;
alter table public.message_read_status  enable row level security;
alter table public.message_deletions    enable row level security;

-- ============================================================
-- 3. message_threads
-- ============================================================
-- Read: threads the caller is in, and only those. There is deliberately NO
-- admin override. Under the approved rules every legitimate conversation
-- already contains the admin as a participant, so the admin reaches their
-- inbox the same way everyone else does -- by membership. A blanket override
-- would re-create, for one account, exactly the unrestricted read this
-- migration exists to remove.
create policy "threads select own" on public.message_threads
  for select to authenticated
  using (public.messaging_is_participant(id));

-- Write: the application bumps updated_at after a reply. Restricted to threads
-- the caller participates in, and the trigger below limits it to that column,
-- so a participant cannot rename or re-own a conversation.
create policy "threads touch own" on public.message_threads
  for update to authenticated
  using (public.messaging_is_participant(id))
  with check (public.messaging_is_participant(id));

-- No INSERT and no DELETE policy: threads are created only by
-- create_thread_with_message, which runs as owner, and are never deleted by a
-- browser. Deleting a conversation is per-participant and lives on
-- thread_participants.deleted_at.

create or replace function public.messaging_threads_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- updated_at is the only field a client may move.
  if new.id is distinct from old.id
     or new.subject is distinct from old.subject
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Only updated_at may be changed on a message thread'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.messaging_threads_immutable() from public, anon, authenticated, service_role;

drop trigger if exists messaging_threads_immutable on public.message_threads;
create trigger messaging_threads_immutable
  before update on public.message_threads
  for each row execute function public.messaging_threads_immutable();

-- ============================================================
-- 4. thread_messages
-- ============================================================
create policy "messages select own threads" on public.thread_messages
  for select to authenticated
  using (public.messaging_is_participant(thread_id));

-- Rule 7: the sender is the session, not the request.
-- Rules 1-3: only into a thread the caller participates in AND that the admin
-- participates in. Membership alone is not enough -- a user-to-user thread
-- predating this migration would otherwise still accept replies, keeping the
-- no-user-to-user rule true only for NEW conversations. This preserves the
-- existing reply path, which inserts directly from the browser.
create policy "messages insert as self" on public.thread_messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.messaging_can_post(thread_id)
  );

-- Rules 8: NO update and NO delete policy for authenticated. This matches the
-- product as it stands -- the interface offers no way to edit or delete an
-- individual message, only to hide a whole conversation. Whether members
-- should be able to delete their OWN messages is an open product question and
-- is deliberately NOT decided here.

-- ============================================================
-- 5. thread_participants
-- ============================================================
create policy "participants select own threads" on public.thread_participants
  for select to authenticated
  using (public.messaging_is_participant(thread_id));

-- Rule 9: a member may only move their OWN row, and only to hide the
-- conversation. Both USING and WITH CHECK pin user_id, so a row cannot be
-- reassigned to someone else on the way through.
create policy "participants hide own" on public.thread_participants
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- No INSERT policy: joining a conversation happens only inside
-- create_thread_with_message. No DELETE policy: membership is never destroyed
-- by a browser.

create or replace function public.messaging_participants_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.thread_id is distinct from old.thread_id
     or new.user_id is distinct from old.user_id
     or new.joined_at is distinct from old.joined_at then
    raise exception 'Only deleted_at may be changed on a thread participant'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.messaging_participants_immutable() from public, anon, authenticated, service_role;

drop trigger if exists messaging_participants_immutable on public.thread_participants;
create trigger messaging_participants_immutable
  before update on public.thread_participants
  for each row execute function public.messaging_participants_immutable();

-- ============================================================
-- 6. message_read_status
-- ============================================================
create policy "read status select own threads" on public.message_read_status
  for select to authenticated
  using (public.messaging_is_participant_of_message(message_id));

-- The sender writes delivery receipts for the other participants immediately
-- after sending. Three conditions, all required:
--   1. the caller actually wrote the referenced message;
--   2. that message resolves to a real thread -- the helper joins through
--      thread_messages, so a missing or orphaned message yields false;
--   3. the user_id ON THE ROW is a participant of that message's thread.
-- The third is the one that matters: checking only that the CALLER is a
-- participant would let a sender mint receipts naming arbitrary unrelated
-- accounts.
create policy "read status deliver own message" on public.message_read_status
  for insert to authenticated
  with check (public.messaging_can_deliver_receipt(message_id, user_id));

-- Reading a conversation marks the caller's OWN receipts, never anyone else's.
-- This is the one control that already held before this migration. The trigger
-- below narrows it further, to the one column the application actually writes.
create policy "read status mark own" on public.message_read_status
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Traced, not assumed: the only UPDATE the application issues against this
-- table is in components/MessagesModal.tsx, opening a thread --
--
--   .update({ read_at: ... }).eq('message_id', msg.id).eq('user_id', user.id)
--
-- read_at and nothing else. The row-level policy above stops a caller touching
-- somebody else's receipt but would still let them rewrite message_id,
-- delivered_at or id on their own -- re-pointing a receipt at another message,
-- or backdating delivery. Only read_at may move.
create or replace function public.messaging_read_status_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.message_id is distinct from old.message_id
     or new.user_id is distinct from old.user_id
     or new.delivered_at is distinct from old.delivered_at then
    raise exception 'Only read_at may be changed on a read receipt'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.messaging_read_status_immutable() from public, anon, authenticated, service_role;

drop trigger if exists messaging_read_status_immutable on public.message_read_status;
create trigger messaging_read_status_immutable
  before update on public.message_read_status
  for each row execute function public.messaging_read_status_immutable();

-- ============================================================
-- 7. message_deletions
-- ============================================================
-- Currently empty with no writer in the application; the inbox reads it when
-- filtering a thread. Read-only to the caller's own rows. No write policy is
-- created, because no product behaviour writes here today.
create policy "deletions select own" on public.message_deletions
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ============================================================
-- 8. TABLE GRANTS -- REVOKE ALL, THEN AN EXPLICIT ALLOWLIST
-- ============================================================
-- The live grant preflight found `authenticated` holding SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on all five tables.
--
-- TRUNCATE is the serious one: it is a table-level operation that RLS does not
-- filter, so no policy written above would have stopped a signed-in user from
-- emptying every conversation on the platform in a single statement. REFERENCES
-- and TRIGGER are schema-level rights a browser session has no use for either.
--
-- Revoking named privileges one by one leaves whatever was not named, so this
-- revokes EVERYTHING first and grants back only the operations the application
-- actually performs. RLS then narrows those to the caller's own rows.
revoke all on public.message_threads      from anon, authenticated;
revoke all on public.thread_messages      from anon, authenticated;
revoke all on public.thread_participants  from anon, authenticated;
revoke all on public.message_read_status  from anon, authenticated;
revoke all on public.message_deletions    from anon, authenticated;

-- anon is granted nothing at all. Nothing signed-out has business here, and an
-- unauthenticated SELECT should say "permission denied", not return "0 rows".

-- SELECT: the inbox reads it. UPDATE: a reply bumps updated_at, and the
-- immutability trigger holds that to the one column. No INSERT -- threads are
-- created only by create_thread_with_message, which runs as its owner.
grant select, update         on public.message_threads     to authenticated;

-- SELECT: reading a conversation. INSERT: the reply path writes directly from
-- the browser. No UPDATE or DELETE -- messages are never edited or removed.
grant select, insert         on public.thread_messages     to authenticated;

-- SELECT: membership drives every policy above. UPDATE: hiding a conversation
-- sets deleted_at on the caller's own row, and the trigger holds it to that
-- column. No INSERT -- joining happens only inside create_thread_with_message.
grant select, update         on public.thread_participants to authenticated;

-- SELECT: delivery and read state. INSERT: the sender writes receipts for the
-- other party. UPDATE: opening a thread stamps read_at on the caller's own row.
grant select, insert, update on public.message_read_status to authenticated;

-- SELECT only: the inbox reads this when filtering a thread, and no product
-- behaviour writes to it today.
grant select                 on public.message_deletions   to authenticated;

-- Granted to NOBODY on any of these tables: DELETE, TRUNCATE, REFERENCES,
-- TRIGGER.
--
-- service_role is deliberately untouched -- it appears in no revoke and no
-- grant here. /api/messages/participants and /api/messages/notify both depend
-- on it, and both authorize every request against the caller's own membership
-- before using it.

-- ============================================================
-- 9. create_thread_with_message  -- rules 1, 2, 3
-- ============================================================
-- The live body is now known (preflight section 7) and is reproduced here
-- LINE FOR LINE. Only three things are added, all of them security:
--
--   * a session requirement -- the function is SECURITY DEFINER and anon holds
--     EXECUTE today, so an unauthenticated caller can create a thread whose
--     created_by and sender_id are NULL;
--   * the recipient rule (rules 1 and 3);
--   * a pinned search_path -- the live definition is SECURITY DEFINER with no
--     search_path set, which is a hijack surface in its own right.
--
-- Deliberately NOT changed, so this stays a security-only migration: no
-- recipient de-duplication, no exclusion of the caller from their own
-- recipient list, no subject/message validation, and updated_at is still left
-- to the column default rather than written explicitly.
create or replace function public.create_thread_with_message(
  p_subject text,
  p_recipient_ids uuid[],
  p_message_text text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_thread_id uuid;
  v_message_id uuid;
  v_recipient_id uuid;
  v_caller uuid := auth.uid();
  v_admin uuid;
  v_recipient uuid;
begin
  -- ADDED: anon holds EXECUTE on this SECURITY DEFINER function today.
  if v_caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- ADDED. FAIL CLOSED: with a null admin id, `v_caller <> v_admin` is NULL
  -- rather than true, so the member branch below would be skipped and any
  -- recipient accepted. An unresolvable admin is a refusal, never a bypass.
  v_admin := public.get_admin_user_id();
  if v_admin is null then
    raise exception 'Messaging is unavailable' using errcode = '42501';
  end if;

  -- ADDED: EXACTLY ONE recipient, for every caller including the admin.
  -- Every conversation is private and two-party; there are no group threads.
  -- The admin compose box already loops and calls this once per selected user
  -- with a single-element array, so this changes nothing the application does
  -- -- it stops a tampered client passing several recipients and producing one
  -- thread in which unrelated members could see each other.
  if coalesce(array_length(p_recipient_ids, 1), 0) <> 1 then
    raise exception 'Exactly one recipient is required' using errcode = '42501';
  end if;
  v_recipient := p_recipient_ids[1];
  if v_recipient is null then
    raise exception 'A recipient is required' using errcode = '42501';
  end if;

  -- ADDED (rules 1 and 3): a member may open a conversation with the admin and
  -- with nobody else. Checked here so a direct RPC call cannot reach another
  -- member -- the browser restriction is presentation only. The admin (rule 2)
  -- may address any single member.
  if v_caller <> v_admin and v_recipient <> v_admin then
    raise exception 'Members may only start a conversation with the admin'
      using errcode = '42501';
  end if;

  -- Everything below is the live definition. The only edit is schema
  -- qualification, which changes nothing about what it does -- these names
  -- already resolve to public today -- but stops resolution depending on a
  -- search_path the caller controls.
  insert into public.message_threads (subject, created_by)
  values (p_subject, auth.uid())
  returning id into v_thread_id;

  insert into public.thread_participants (thread_id, user_id)
  values (v_thread_id, auth.uid());

  foreach v_recipient_id in array p_recipient_ids
  loop
    insert into public.thread_participants (thread_id, user_id)
    values (v_thread_id, v_recipient_id);
  end loop;

  insert into public.thread_messages (thread_id, sender_id, message_text)
  values (v_thread_id, auth.uid(), p_message_text)
  returning id into v_message_id;

  foreach v_recipient_id in array p_recipient_ids
  loop
    insert into public.message_read_status (message_id, user_id, delivered_at)
    values (v_message_id, v_recipient_id, now());
  end loop;

  return v_thread_id;
end;
$function$;

revoke all on function public.create_thread_with_message(text, uuid[], text)
  from public, anon, authenticated, service_role;
-- The compose box calls this from the browser; it authorizes every call itself.
grant execute on function public.create_thread_with_message(text, uuid[], text) to authenticated;

-- ============================================================
-- 10. send_tier_broadcast  -- rule 10
-- ============================================================
-- APPROVED: the browser RPC path stays. The live body is now known and is
-- reproduced here EXACTLY -- same recipient predicate, same loop, same call
-- into create_thread_with_message, same integer count. One new thread per
-- recipient, as production has always produced.
--
-- Added, and nothing else:
--   * a session requirement;
--   * a definitive admin check against get_admin_user_id();
--   * a pinned search_path -- the live definition is SECURITY DEFINER with
--     none, so the unqualified user_profiles and create_thread_with_message
--     references resolve through whatever search_path the caller arrives with;
--   * deliberate EXECUTE grants.
--
-- SECURITY DEFINER is retained, as in production.
--
-- Why the gate matters even though a non-admin call currently returns 0:
-- that zero is not this function refusing -- there is no admin test in the
-- live body at all. The reason a non-admin call presently yields nothing has
-- not been established, and this migration does not depend on any explanation
-- of it. The check below stands on its own.
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
  -- ADDED: anon holds EXECUTE on this SECURITY DEFINER function today.
  if v_caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- ADDED (rule 10): only the authoritative admin may broadcast.
  v_admin := public.get_admin_user_id();
  if v_admin is null or v_caller <> v_admin then
    raise exception 'Only the admin may send a tier broadcast' using errcode = '42501';
  end if;

  -- Everything below is the live definition, unmodified. In particular the
  -- recipient predicate is byte for byte what production runs: no lowercasing,
  -- no trimming, no NULL coalescing, no widening of the recipient set.
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

revoke all on function public.send_tier_broadcast(text, text, text)
  from public, anon, authenticated, service_role;
-- The admin compose box calls this from the browser; it authorizes every call
-- itself, so authenticated is the only grantee.
grant execute on function public.send_tier_broadcast(text, text, text) to authenticated;

-- ============================================================
-- 11. get_admin_user_id  -- rule 10
-- ============================================================
-- WHAT IT RETURNS IS UNCHANGED: the id of the user_profiles row whose email is
-- the configured admin address, limit 1. The configured identity is not
-- touched. Only the function's own hardening changes:
--
--   * SECURITY DEFINER retained -- every signed-in member must be able to
--     resolve the admin's id to address a message, whatever their own
--     user_profiles visibility;
--   * search_path pinned, where the live definition has none;
--   * public.user_profiles schema-qualified, so resolution no longer depends
--     on a search_path the caller controls;
--   * anon loses EXECUTE.
create or replace function public.get_admin_user_id()
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return (
    select id
    from public.user_profiles
    where email = 'asealnassar@gmail.com'
    limit 1
  );
end;
$function$;

revoke all on function public.get_admin_user_id() from public, anon, authenticated, service_role;
-- The member compose box needs the admin's id to address a message.
grant execute on function public.get_admin_user_id() to authenticated;
-- The policy helpers and both messaging RPCs call it as their definer owner,
-- which needs no grant, but the API routes run as service_role and may resolve
-- the admin the same way.
grant execute on function public.get_admin_user_id() to service_role;

commit;

-- ============================================================
-- UNCHANGED BY THIS MIGRATION (stated, not assumed)
--   * every message, thread, participant and read-status ROW
--   * service_role grants on all five messaging tables
--   * email_broadcasts / email_broadcast_batches and their route
--   * user_profiles, and every non-messaging table
-- ============================================================

-- VERIFICATION (read-only, run after applying)
-- select tablename, policyname, cmd from pg_policies
--  where schemaname='public' and tablename in
--   ('message_threads','thread_messages','thread_participants',
--    'message_read_status','message_deletions')
--  order by tablename, cmd;
--
-- select (select count(*) from public.message_threads)     as threads,
--        (select count(*) from public.thread_messages)     as messages,
--        (select count(*) from public.thread_participants) as participants,
--        (select count(*) from public.message_read_status) as read_status;
-- EXPECT: identical to preflight section 12.
