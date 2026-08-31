-- ============================================================================
-- Immutable batch snapshots + a resume lease for tier email broadcasts.
--
-- REVIEW ONLY -- not executed.
--
-- Why the previous plan was not enough. Recipients were recomputed from live
-- tier membership on every request, so `.order('email')` plus a record of
-- which batch indexes had been sent still double-delivers:
--
--   113 ordered recipients -> batch 0 = #1..#100, batch 1 = #101..#113
--   batch 0 is accepted by Resend, the process dies
--   one new Ultimate member joins, sorting into position 50
--   recomputed: batch 0 = #1..#49 + new + #50..#99, batch 1 = #100..#113
--   skipping batch 0 and sending batch 1 re-emails #100, who was already
--   delivered inside the original batch 0
--
-- Verified: exactly one recipient drifts across the boundary per inserted
-- member. Batch composition must therefore be frozen before the first send
-- and never regenerated.
--
-- Touches no existing table's data. Adds two columns to email_broadcasts and
-- one new table. Does not alter send_tier_broadcast, user_profiles, or any
-- existing RLS policy.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Lease columns on the parent broadcast.
--
-- These prevent two live requests from working the same broadcast. The lease
-- is a coordination optimisation, NOT the duplicate-delivery guarantee -- that
-- remains Resend's per-batch idempotency key. A process that hangs past its
-- lease can overlap with a second worker; identical payload plus identical key
-- is what makes that harmless.
-- ---------------------------------------------------------------------------
alter table public.email_broadcasts
  add column if not exists lease_expires_at timestamptz,
  add column if not exists lease_owner      uuid;

-- ---------------------------------------------------------------------------
-- 2. Immutable batch snapshots. Written once, before any Resend call.
-- ---------------------------------------------------------------------------
create table public.email_broadcast_batches (
  id              uuid primary key default gen_random_uuid(),

  broadcast_id    uuid not null
                    references public.email_broadcasts(id) on delete cascade,

  -- Position within the broadcast. Feeds the Resend idempotency key:
  --   message-broadcast-{broadcast_id}-batch-{batch_index}
  batch_index     integer not null,

  -- The exact addresses submitted, frozen at planning time and never
  -- recomputed. Nullable only so it can be purged after retention -- see the
  -- purge statement at the foot of this file. Order is significant: the array
  -- is replayed verbatim so the Resend payload is byte-identical.
  recipients      text[],

  -- Survives a purge, so counts stay auditable after the addresses are gone.
  recipient_count integer not null,

  -- pending    -- planned, never submitted
  -- submitting -- handed to Resend; outcome unknown if the process died here
  -- sent       -- Resend accepted the batch
  -- failed     -- terminal, non-retryable rejection
  status          text not null default 'pending',

  attempts        integer not null default 0,
  last_error      text,

  submitted_at    timestamptz,
  completed_at    timestamptz,
  purged_at       timestamptz,
  created_at      timestamptz not null default now(),

  -- One row per position. This is what makes replanning impossible and makes
  -- "have we already sent batch N?" a single lookup.
  constraint email_broadcast_batches_unique_index
    unique (broadcast_id, batch_index),

  constraint email_broadcast_batches_index_nonnegative
    check (batch_index >= 0),

  -- Resend's documented per-call maximum.
  constraint email_broadcast_batches_count_within_limit
    check (recipient_count > 0 and recipient_count <= 100),

  constraint email_broadcast_batches_status_check
    check (status in ('pending', 'submitting', 'sent', 'failed')),

  constraint email_broadcast_batches_attempts_nonnegative
    check (attempts >= 0),

  -- The snapshot must match its declared size while it exists, so a partially
  -- written array cannot be replayed as though it were complete.
  constraint email_broadcast_batches_recipients_match_count
    check (recipients is null or cardinality(recipients) = recipient_count),

  -- Purging is the only thing allowed to drop the snapshot.
  constraint email_broadcast_batches_purge_consistent
    check ((purged_at is null) or (recipients is null)),

  -- A terminal batch carries a completion time; a non-terminal one does not.
  constraint email_broadcast_batches_completed_at_matches_status
    check (
      (status in ('sent', 'failed') and completed_at is not null)
      or
      (status in ('pending', 'submitting') and completed_at is null)
    )
);

-- Resume path: find this broadcast's unfinished batches in index order.
create index email_broadcast_batches_resume_idx
  on public.email_broadcast_batches (broadcast_id, batch_index);

-- Retention sweep: find terminal batches whose snapshots are still present.
create index email_broadcast_batches_purge_idx
  on public.email_broadcast_batches (completed_at)
  where purged_at is null;

-- ---------------------------------------------------------------------------
-- 3. Access: server-only, matching email_broadcasts. RLS on with no policies
--    and no browser privileges -- two independent barriers. Revoke precedes
--    grant because Supabase's default privileges grant ALL on new public
--    tables and GRANT is additive.
-- ---------------------------------------------------------------------------
alter table public.email_broadcast_batches enable row level security;

revoke all privileges on table public.email_broadcast_batches from public;
revoke all privileges on table public.email_broadcast_batches from anon;
revoke all privileges on table public.email_broadcast_batches from authenticated;
revoke all privileges on table public.email_broadcast_batches from service_role;

-- UPDATE is needed for status transitions and for nulling recipients at purge
-- time. No DELETE: rows are retained for audit; the cascade from
-- email_broadcasts is the only removal path.
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
   and column_name in ('lease_expires_at','lease_owner');

-- ---------------------------------------------------------------------------
-- PII RETENTION SWEEP -- run on a schedule or manually. NOT part of the
-- migration. Drops address snapshots once a broadcast has been terminal long
-- enough that replay is no longer meaningful, while keeping counts and status.
-- ---------------------------------------------------------------------------
-- update public.email_broadcast_batches b
--    set recipients = null, purged_at = now()
--   from public.email_broadcasts p
--  where b.broadcast_id = p.id
--    and b.recipients is not null
--    and p.status in ('completed','partial','failed')
--    and p.completed_at < now() - interval '7 days';
