-- ============================================================================
-- M-5 durable email notification jobs -- PHASE 1: INERT TABLE + SECURITY ONLY
-- ============================================================================
--
-- Records the durable email obligation for ONE normal (non-broadcast) message.
--
-- THIS MIGRATION IS DELIBERATELY INERT. It creates a table and its security and
-- nothing else. After applying it, production messaging behaves exactly as it
-- did before: no row is ever written here, because nothing writes here yet.
--
-- Explicitly NOT in this migration, each deferred to a later phase:
--
--   * no AFTER INSERT trigger on thread_messages, and no trigger function
--   * no transaction-local GUC, and no change to send_tier_broadcast
--   * no change to create_thread_with_message or to thread_messages
--   * no worker route, no cron schedule
--   * no backfill -- see the note below, it is the whole reason this is inert
--
-- Tier broadcasts keep their own email system (email_broadcasts,
-- email_broadcast_batches). Nothing here touches it.
--
-- ---------------------------------------------------------------------------
-- NO BACKFILL, DELIBERATELY
-- ---------------------------------------------------------------------------
-- thread_messages holds 735 rows at the time of writing. Seeding a job per
-- historical message would queue 735 emails about conversations members have
-- already read, some of them months old. This migration inserts ZERO rows and
-- must continue to. Jobs begin with the first message sent after the Phase 2
-- trigger ships.
--
-- ---------------------------------------------------------------------------
-- WHY message_id IS THE PRIMARY KEY
-- ---------------------------------------------------------------------------
-- One message, one job -- expressed structurally rather than by convention. A
-- surrogate id plus a UNIQUE constraint would say the same thing less
-- forcefully and would add a second key to keep in step. The provider
-- idempotency key is derived from this column at send time as
-- `message-notification-<message_id>`; it is deliberately not stored, because a
-- stored copy is a copy that can drift from the row it belongs to.
--
-- ON DELETE CASCADE: a deleted message has no notification obligation. Note
-- that thread_messages currently has no DELETE policy for any browser role, so
-- in practice this fires only for service-role cleanup.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT STORED, AND WHY
-- ---------------------------------------------------------------------------
-- No message body, subject, HTML payload, or recipient email address. The
-- worker will render from message_id at send time. Three reasons: the message
-- text is immutable (thread_messages has no UPDATE policy), a frozen HTML copy
-- would drift from buildNotificationEmail, and a queue table holding message
-- content is a second copy of private conversation for any future RLS mistake
-- to leak. This table holds identifiers and delivery state, nothing readable.
-- ============================================================================

create table public.email_notification_jobs (
  -- The message this job owes an email for. Primary key: exactly one job per
  -- message, enforced by the database rather than by the code that inserts.
  message_id uuid primary key
    references public.thread_messages (id) on delete cascade,

  -- Frozen at job creation. Which person is owed the email cannot change even
  -- if thread membership later does. Deliberately NOT a foreign key: a deleted
  -- profile must not silently delete the delivery record.
  recipient_user_id uuid not null,

  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,

  -- Lease, so two workers cannot claim the same job. Same shape as
  -- email_broadcast_batches, which has run this pattern in production.
  lease_owner text,
  lease_expires_at timestamptz,

  created_at timestamptz not null default now(),
  sent_at timestamptz,

  -- 'uncertain' is the honest state for a job whose email the provider may
  -- have accepted before the worker crashed, and which is now outside the
  -- window where replaying it under the same idempotency key is safe. It is
  -- never retried automatically: being early costs a manual review, being late
  -- emails a member twice.
  constraint email_notification_jobs_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'uncertain')),

  constraint email_notification_jobs_attempts_check
    check (attempts >= 0)
);

-- ---------------------------------------------------------------------------
-- INDEX
-- ---------------------------------------------------------------------------
-- One index, for the only query the worker will run:
--
--   select ... where status in ('pending','sending')
--                and next_attempt_at <= now()
--                and (lease_expires_at is null or lease_expires_at < now())
--              order by next_attempt_at
--
-- Partial on the two active statuses: every successful message ends as 'sent',
-- so that state will dominate the table forever and the worker never looks at
-- it. Keeping those rows out means the index stays proportional to outstanding
-- work rather than to lifetime volume.
--
-- next_attempt_at is the key column because it serves both the range predicate
-- and the ordering. lease_expires_at is deliberately not included: its
-- predicate is an OR against NULL, which an index cannot help, and a second
-- key column would only make the index bigger.
--
-- No index on recipient_user_id: no planned query filters by it. The primary
-- key already provides the unique index for lookups and for the FK.
create index email_notification_jobs_claimable_idx
  on public.email_notification_jobs (next_attempt_at)
  where status in ('pending', 'sending');

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY AND GRANTS
-- ---------------------------------------------------------------------------
-- This is infrastructure, not application data. No browser role -- including
-- the admin's, which is just another authenticated session -- may see or touch
-- it. There are therefore NO policies at all: with RLS enabled and no policy,
-- every row is invisible to anyone RLS applies to, and postgres_changes cannot
-- deliver what SELECT cannot return.
--
-- The privilege revocations are the real lock, and they come FIRST: Supabase's
-- default privileges grant broadly on new tables in public, so granting before
-- revoking would leave the defaults in place.
--
-- service_role is not a superuser -- it carries bypassrls, which skips row
-- policies but NOT table and column privileges. That is what makes the
-- column-scoped UPDATE below a real constraint rather than decoration.
alter table public.email_notification_jobs enable row level security;

-- Deliberately NOT `force row level security`: the Phase 2 trigger will be a
-- SECURITY DEFINER function owned by the table owner, and FORCE would subject
-- the owner to policies that do not exist, blocking the insert it needs to do.
revoke all privileges on table public.email_notification_jobs from public;
revoke all privileges on table public.email_notification_jobs from anon;
revoke all privileges on table public.email_notification_jobs from authenticated;
revoke all privileges on table public.email_notification_jobs from service_role;

-- The worker reads jobs to claim them and writes them once. INSERT is granted
-- because the eventual worker path and any reviewed manual recovery both need
-- it; the Phase 2 trigger will insert as the table owner, not as service_role.
grant select, insert on table public.email_notification_jobs to service_role;

-- UPDATE is granted per column, so no code path -- and no compromised key --
-- can rewrite which message a job belongs to or who it is owed to. Naming a
-- column outside this list in an UPDATE raises 42501.
grant update (
  status,
  attempts,
  next_attempt_at,
  last_error,
  sent_at,
  lease_owner,
  lease_expires_at
) on table public.email_notification_jobs to service_role;

-- No DELETE for anyone. Rows leave only by their message's cascade.

-- ---------------------------------------------------------------------------
-- READ-ONLY VERIFICATION (run after applying; returns rows, changes nothing)
-- ---------------------------------------------------------------------------
-- select count(*) as must_be_zero from public.email_notification_jobs;
--
-- select relrowsecurity, relforcerowsecurity
--   from pg_class where oid = 'public.email_notification_jobs'::regclass;
--
-- select grantee, privilege_type, column_name
--   from information_schema.column_privileges
--  where table_name = 'email_notification_jobs' order by grantee, column_name;
--
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_name = 'email_notification_jobs' order by grantee;
--
-- select policyname from pg_policies
--  where tablename = 'email_notification_jobs';        -- expect zero rows
--
-- select indexname, indexdef from pg_indexes
--  where tablename = 'email_notification_jobs';
--
-- select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
--  where c.relname = 'thread_messages' and not t.tgisinternal;
