-- Rollback for 20260831_002_email_broadcast_batches.sql.
--
-- Drops the batch plans (including any retained payloads, which contain
-- recipient addresses and rendered message content), the planned_batches
-- immutability trigger and its function, and the three columns added to
-- email_broadcasts. Restores the table-wide UPDATE grant that 20260831_000
-- had given service_role, so email_broadcasts returns to its prior state.
--
-- email_broadcasts itself and its rows are untouched.
begin;

drop table if exists public.email_broadcast_batches;

drop trigger if exists email_broadcasts_freeze_planned_batches
  on public.email_broadcasts;
drop function if exists public.email_broadcasts_freeze_planned_batches();

-- Remove the column-level UPDATE grants added by this migration before
-- restoring the table-level one: Postgres tracks the two separately, so a
-- surviving column grant would be redundant but confusing in the catalogue.
revoke update (
  attempted,
  succeeded,
  failed,
  status,
  completed_at,
  planned_batches,
  lease_owner,
  lease_expires_at
) on table public.email_broadcasts from service_role;

alter table public.email_broadcasts
  drop constraint if exists email_broadcasts_planned_batches_positive;

alter table public.email_broadcasts
  drop column if exists planned_batches,
  drop column if exists lease_expires_at,
  drop column if exists lease_owner;

-- Back to the 20260831_000 grant.
grant update on table public.email_broadcasts to service_role;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect: table-level SELECT, INSERT, UPDATE for service_role; no column-level
-- UPDATE rows left over.
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema='public' and table_name='email_broadcasts'
   and grantee='service_role' order by privilege_type;

select column_name, privilege_type from information_schema.column_privileges
 where table_schema='public' and table_name='email_broadcasts'
   and grantee='service_role' and privilege_type='UPDATE';

-- Expect: zero rows.
select tgname from pg_trigger
 where tgrelid='public.email_broadcasts'::regclass and not tgisinternal;
