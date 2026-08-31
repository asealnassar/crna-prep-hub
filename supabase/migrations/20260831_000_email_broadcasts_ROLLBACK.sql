-- Rollback for 20260831_000_email_broadcasts.sql.
--
-- Safe: the table is new and server-only, so nothing else references it.
-- Dropping it discards the broadcast audit trail, which is the only loss.
begin;
drop table if exists public.email_broadcasts;
commit;
