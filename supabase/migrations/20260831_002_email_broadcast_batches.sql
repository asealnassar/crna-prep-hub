-- ============================================================================
-- Frozen batch plans for tier email broadcasts.  REVIEW ONLY -- not executed.
--
-- Supersedes the 20260831_001 proposal, which froze only the recipient list.
-- That is not enough: Resend's idempotency guarantee is payload-scoped, so a
-- replay must reproduce the ENTIRE original request. Between two attempts a
-- deployment can change the HTML template, the from address, or the subject,
-- and the same key would then carry different content.
--
-- Why recipients cannot be recomputed at all. With 113 ordered recipients,
-- batch 0 = #1..#100 and batch 1 = #101..#113. If batch 0 is accepted and one
-- new member then sorts into position 50, recomputing gives batch 1 =
-- #100..#113 -- and #100, already delivered inside batch 0, is emailed again.
-- Exactly one recipient drifts per membership change. The plan is therefore
-- frozen once and never regenerated.
--
-- Adds three columns to email_broadcasts and one table. Alters no existing
-- data, no existing policy, and not send_tier_broadcast or user_profiles.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Parent: planning completion marker + coordination lease.
-- ---------------------------------------------------------------------------
alter table public.email_broadcasts
  -- NULL until the frozen plan is confirmed complete. Once set it is
  -- immutable and is the signal that sending may begin.
  add column if not exists planned_batches  integer,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists lease_owner      uuid;

alter table public.email_broadcasts
  add constraint email_broadcasts_planned_batches_positive
  check (planned_batches is null or planned_batches > 0);

-- ---------------------------------------------------------------------------
-- 2. Immutable batch plans. Inserted in ONE statement, before any Resend call.
-- ---------------------------------------------------------------------------
create table public.email_broadcast_batches (
  id              uuid primary key default gen_random_uuid(),

  broadcast_id    uuid not null
                    references public.email_broadcasts(id) on delete cascade,

  batch_index     integer not null,

  -- The exact array handed to resend.batch.send(), frozen at planning time:
  -- from, to, subject and rendered html for every recipient. Stored rather
  -- than reconstructed, because a template or from-address change between
  -- attempts would otherwise reuse an idempotency key with different content.
  -- Nullable only so it can be purged -- see the retention sweep below.
  payload         jsonb,

  -- Stored, not derived. If the key-construction formula in application code
  -- ever changes, a replay must still present the key Resend already saw.
  idempotency_key text not null,

  -- Survives a purge, so counts stay auditable once the payload is gone.
  recipient_count integer not null,

  -- pending    -- planned, never submitted to Resend
  -- submitting -- handed to Resend; outcome unknown if the process died here
  -- sent       -- Resend accepted the batch
  -- failed     -- terminal, non-retryable rejection; never delivered
  -- uncertain  -- was submitting, and is now outside the safe idempotency
  --               window. Delivery status cannot be determined and automatic
  --               replay is unsafe. Requires manual review. NOT a failure.
  status          text not null default 'pending',

  attempts        integer not null default 0,
  last_error      text,

  submitted_at    timestamptz,
  completed_at    timestamptz,
  payload_purged_at timestamptz,
  created_at      timestamptz not null default now(),

  -- One row per position: makes replanning impossible and "was batch N sent?"
  -- a single lookup.
  constraint email_broadcast_batches_unique_index
    unique (broadcast_id, batch_index),

  -- The key is globally unique, so no two batches can ever collide on it.
  constraint email_broadcast_batches_unique_key
    unique (idempotency_key),

  constraint email_broadcast_batches_index_nonnegative
    check (batch_index >= 0),

  -- Resend's documented per-call maximum.
  constraint email_broadcast_batches_count_within_limit
    check (recipient_count > 0 and recipient_count <= 100),

  constraint email_broadcast_batches_status_check
    check (status in ('pending', 'submitting', 'sent', 'failed', 'uncertain')),

  constraint email_broadcast_batches_attempts_nonnegative
    check (attempts >= 0),

  -- A payload that still exists must be a JSON array whose length matches the
  -- declared count, so a truncated plan can never be replayed as complete.
  constraint email_broadcast_batches_payload_matches_count
    check (
      payload is null
      or (jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) = recipient_count)
    ),

  -- Purging is the only thing permitted to drop the payload.
  constraint email_broadcast_batches_purge_consistent
    check (payload_purged_at is null or payload is null),

  -- Anything that has reached Resend must record when.
  constraint email_broadcast_batches_submitted_at_present
    check (
      (status = 'pending' and submitted_at is null)
      or (status in ('submitting', 'sent', 'failed', 'uncertain') and submitted_at is not null)
    ),

  -- completed_at marks "no further automatic action". uncertain qualifies:
  -- automation stops there and a human decides.
  constraint email_broadcast_batches_completed_at_matches_status
    check (
      (status in ('sent', 'failed', 'uncertain') and completed_at is not null)
      or
      (status in ('pending', 'submitting') and completed_at is null)
    )
);

-- Resume path: this broadcast's batches in index order.
create index email_broadcast_batches_resume_idx
  on public.email_broadcast_batches (broadcast_id, batch_index);

-- Sweep for batches stuck in submitting past the safe window.
create index email_broadcast_batches_stale_idx
  on public.email_broadcast_batches (submitted_at)
  where status = 'submitting';

-- Retention sweep: terminal batches whose payload is still present.
create index email_broadcast_batches_purge_idx
  on public.email_broadcast_batches (completed_at)
  where payload_purged_at is null;

-- ---------------------------------------------------------------------------
-- 3. Access: server-only, matching email_broadcasts. RLS enabled with NO
--    policies and no browser privileges -- two independent barriers. Revoke
--    precedes grant because Supabase's defaults grant ALL on new public
--    tables and GRANT is additive.
-- ---------------------------------------------------------------------------
alter table public.email_broadcast_batches enable row level security;

revoke all privileges on table public.email_broadcast_batches from public;
revoke all privileges on table public.email_broadcast_batches from anon;
revoke all privileges on table public.email_broadcast_batches from authenticated;
revoke all privileges on table public.email_broadcast_batches from service_role;

-- UPDATE covers status transitions and nulling the payload at purge time.
-- No DELETE: rows are retained for audit; the parent cascade is the only
-- removal path.
grant select, insert, update on table public.email_broadcast_batches to service_role;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------
select relname, relrowsecurity from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'email_broadcast_batches';

select policyname from pg_policies
 where schemaname = 'public' and tablename = 'email_broadcast_batches';

select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'email_broadcast_batches'
   and grantee in ('PUBLIC','anon','authenticated','service_role')
 order by grantee, privilege_type;

select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.email_broadcast_batches'::regclass order by conname;

select column_name from information_schema.columns
 where table_schema='public' and table_name='email_broadcasts'
   and column_name in ('planned_batches','lease_expires_at','lease_owner');

-- ---------------------------------------------------------------------------
-- OPERATIONAL SWEEPS -- run on a schedule. NOT part of the migration.
-- ---------------------------------------------------------------------------

-- A. Stale-submission sweep. Marks batches uncertain once they are outside
--    the safe replay window, so nothing can auto-replay them afterwards.
--    12 hours, deliberately half of Resend's ~24h retention: the cost of
--    being early is a manual review, the cost of being late is a duplicate
--    send to paying customers.
-- update public.email_broadcast_batches
--    set status = 'uncertain', completed_at = now(),
--        last_error = 'submission outcome unknown; outside safe idempotency window'
--  where status = 'submitting'
--    and submitted_at < now() - interval '12 hours';

-- B. Payload retention. Successful batches lose the payload quickly; failed
--    and uncertain keep it longer for troubleshooting. Retaining a payload
--    does NOT make a replay safe -- rule A governs that independently.
-- update public.email_broadcast_batches
--    set payload = null, payload_purged_at = now()
--  where payload is not null
--    and (
--      (status = 'sent'                    and completed_at < now() - interval '3 days')
--      or (status in ('failed','uncertain') and completed_at < now() - interval '30 days')
--    );
