-- ============================================================================
-- Tier email broadcasts: durable record + idempotency.
--
-- Background: the tier broadcast created 114 in-app messages successfully but
-- fired 114 unawaited browser requests, each making one Resend call. Roughly
-- 19 emails were accepted; the rest were lost, and nothing recorded it because
-- resend.emails.send()'s { data, error } result was never inspected.
--
-- send_tier_broadcast returns a recipient count, not an identifier, and no
-- messaging table carries a broadcast grouping column -- so there is nothing
-- durable to key retries against. This table supplies it.
--
-- Two independent layers of duplicate protection:
--   request_key  -- stops a second email_broadcasts row being created for one
--                   admin action (double-click, retry, refresh)
--   id           -- seeds the Resend batch idempotency key, so re-sending a
--                   batch of the same broadcast cannot duplicate delivery
--
-- Deliberately does NOT touch message_threads, thread_messages,
-- thread_participants, send_tier_broadcast, user_profiles, or any existing
-- RLS policy. It creates one new table and nothing else.
-- ============================================================================
begin;

create table public.email_broadcasts (
  -- Durable broadcast identity. Seeds the Resend batch idempotency key:
  --   message-broadcast-{id}-batch-{index}
  id           uuid primary key default gen_random_uuid(),

  -- Client-generated once per admin send action and replayed on retry. The
  -- UNIQUE constraint is what makes a duplicate request a no-op: the insert
  -- conflicts, the server reads the existing row, and no second broadcast is
  -- created. Deliberately not derived from subject, message text or time.
  request_key  uuid not null unique,

  -- Which audience was targeted. Recipients are resolved server-side at send
  -- time from user_profiles; no recipient list or address is stored here.
  tier         text not null,

  -- Kept for the audit trail -- it is what an admin recognises a broadcast by.
  -- The message body is deliberately NOT stored; see the migration notes.
  subject      text not null,

  -- The authenticated admin who initiated it, from the verified session.
  created_by   uuid not null references auth.users(id) on delete restrict,

  -- Outcome counters, written server-side as batches complete. These are the
  -- numbers whose absence hid the original failure.
  attempted    integer not null default 0,
  succeeded    integer not null default 0,
  failed       integer not null default 0,

  -- pending  -- row created, sending not started
  -- sending  -- at least one batch dispatched
  -- completed-- every recipient accepted by Resend
  -- partial  -- some accepted, some rejected
  -- failed   -- none accepted
  status       text not null default 'pending',

  created_at   timestamptz not null default now(),
  completed_at timestamptz,

  -- Only the tiers the compose UI actually offers.
  constraint email_broadcasts_tier_check
    check (tier in ('free', 'premium', 'ultimate')),

  constraint email_broadcasts_status_check
    check (status in ('pending', 'sending', 'completed', 'partial', 'failed')),

  constraint email_broadcasts_counts_nonnegative
    check (attempted >= 0 and succeeded >= 0 and failed >= 0),

  -- Accounted-for recipients can never exceed those attempted.
  constraint email_broadcasts_counts_within_attempted
    check (succeeded + failed <= attempted),

  -- A terminal status must carry a completion time; a non-terminal one must
  -- not, so an interrupted send cannot masquerade as finished.
  constraint email_broadcasts_completed_at_matches_status
    check (
      (status in ('completed', 'partial', 'failed') and completed_at is not null)
      or
      (status in ('pending', 'sending') and completed_at is null)
    )
);

-- Supports "recent broadcasts" lookups without scanning.
create index email_broadcasts_created_at_idx
  on public.email_broadcasts (created_at desc);

-- ---------------------------------------------------------------------------
-- Access: server-only. RLS is enabled with NO policies, and the browser roles
-- hold no privileges -- so neither anon nor authenticated has any read or
-- write path. service_role bypasses RLS and is the only way in.
--
-- Revoke before granting: Supabase's default privileges grant ALL on new
-- public tables, and GRANT is additive.
-- ---------------------------------------------------------------------------
alter table public.email_broadcasts enable row level security;

revoke all privileges on table public.email_broadcasts from public;
revoke all privileges on table public.email_broadcasts from anon;
revoke all privileges on table public.email_broadcasts from authenticated;
revoke all privileges on table public.email_broadcasts from service_role;

-- INSERT creates the record, SELECT resolves an existing request_key on
-- retry, UPDATE writes the counters and final status. No DELETE: the audit
-- trail is the point.
grant select, insert, update on table public.email_broadcasts to service_role;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect: rowsecurity = true.
select relname, relrowsecurity
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relname = 'email_broadcasts';

-- Expect: zero rows. No policies is intentional -- the browser has no path in.
select policyname from pg_policies
where  schemaname = 'public' and tablename = 'email_broadcasts';

-- Expect: exactly INSERT, SELECT, UPDATE for service_role. No rows for
-- PUBLIC, anon or authenticated.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'email_broadcasts'
  and  grantee in ('PUBLIC','anon','authenticated','service_role')
order  by grantee, privilege_type;

-- Expect: the five check constraints and the unique constraint on request_key.
select conname, pg_get_constraintdef(oid)
from   pg_constraint
where  conrelid = 'public.email_broadcasts'::regclass
order  by conname;
