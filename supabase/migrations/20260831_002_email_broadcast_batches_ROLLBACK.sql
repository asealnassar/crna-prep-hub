-- Rollback for 20260831_002_email_broadcast_batches.sql.
--
-- Drops the batch plans (including any retained payloads, which contain
-- recipient addresses and rendered message content) and removes the three
-- columns added to email_broadcasts. email_broadcasts itself and its rows are
-- untouched.
begin;
drop table if exists public.email_broadcast_batches;
alter table public.email_broadcasts
  drop constraint if exists email_broadcasts_planned_batches_positive;
alter table public.email_broadcasts
  drop column if exists planned_batches,
  drop column if exists lease_expires_at,
  drop column if exists lease_owner;
commit;
