-- ============================================================================
-- Follow-up questions become a per-session choice, locked server-side.
--
-- The applicant answers "Include follow-up questions?" before the interview
-- starts. That answer has to be enforced somewhere the browser cannot reach:
-- the engine state travels with every request, so a client that flipped
-- followUpsEnabled back to true would re-enable probing in a session that had
-- declined it. interview_grants is already the server-owned record of an
-- in-progress interview -- written only with the service role, unreadable from
-- the browser -- so the choice belongs on the grant row.
--
-- DELIBERATELY NO DEFAULT.
--
-- A default would be a silent answer on the applicant's behalf, which is the
-- exact product rule this feature exists to enforce: every new interview must
-- choose. With the column NOT NULL and no default, an INSERT that omits it is
-- rejected by the database rather than quietly assigned a value. The API
-- rejects such a start with a 400 before it ever reaches this table; this is
-- the backstop behind that check.
--
-- Existing rows are backfilled to TRUE. Those interviews were created when
-- follow-ups were automatic and the applicant was never asked, so true is what
-- they actually ran with -- resuming one must not silently change how it
-- behaves. This is a statement about history, not a default for the future,
-- which is why it is an UPDATE and not a DEFAULT clause.
--
-- Ordering is not a hazard in either direction. lib/interviewSession.ts sends
-- the column on INSERT and asks for it on SELECT, and retries without it if
-- the database reports an unknown column -- so the code works before this
-- migration, and the migration works before the code.
--
-- Touches nothing else: no policies, no RLS setting, no privileges (the grants
-- on this table are table-level, so a new column is already covered), no
-- function, no other table.
--
-- PRE-FLIGHT (read-only). Expect zero rows: the column should not exist yet.
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'interview_grants'
--     and column_name = 'follow_ups_enabled';
-- ============================================================================
begin;

-- Nullable first, so the backfill has something to write into and the
-- statement is safe to re-run.
alter table public.interview_grants
  add column if not exists follow_ups_enabled boolean;

-- History: every grant that predates the choice ran with follow-ups on.
update public.interview_grants
   set follow_ups_enabled = true
 where follow_ups_enabled is null;

-- Now that no row is null, require it forever.
alter table public.interview_grants
  alter column follow_ups_enabled set not null;

-- Defensive: `add column` above sets no default, but a re-run against a
-- database where one was added by hand must still end with none.
alter table public.interview_grants
  alter column follow_ups_enabled drop default;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect exactly one row: follow_ups_enabled | boolean | NO | (null).
-- column_default MUST be null -- a default here would defeat the whole point.
select column_name, data_type, is_nullable, column_default
from   information_schema.columns
where  table_schema = 'public' and table_name = 'interview_grants'
  and  column_name = 'follow_ups_enabled';

-- Expect: zero rows still null, and every pre-existing grant reading true.
select count(*) filter (where follow_ups_enabled is null)  as still_null,
       count(*) filter (where follow_ups_enabled is true)  as enabled,
       count(*) filter (where follow_ups_enabled is false) as disabled,
       count(*)                                            as total
from   public.interview_grants;

-- Expect exactly three rows: INSERT, SELECT, UPDATE. Unchanged -- the grants
-- on this table are table-level, so the new column needs no separate grant.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'interview_grants'
  and  grantee = 'service_role'
order  by privilege_type;

-- Expect zero rows: anon and authenticated still have no access.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'interview_grants'
  and  grantee in ('anon','authenticated');

-- Expect rowsecurity = true, unchanged.
select relname, relrowsecurity
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relname = 'interview_grants';

-- An INSERT omitting the column must FAIL with a not-null violation. Not run
-- here: a schema migration should not write a production row to prove a
-- constraint. The behaviour is covered by the API's 400 and by
-- lib/interview/followUpChoice.test.ts.
