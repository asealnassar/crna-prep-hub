-- Rollback for 20260831_001_email_broadcast_batches.sql.
--
-- Drops the batch snapshots (including any retained recipient addresses) and
-- removes the lease columns. email_broadcasts itself and its data are kept.
begin;
drop table if exists public.email_broadcast_batches;
alter table public.email_broadcasts
  drop column if exists lease_expires_at,
  drop column if exists lease_owner;
commit;
