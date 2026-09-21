-- INTERVIEW LENGTH — PREFLIGHT. READ-ONLY. Run in the Supabase SQL Editor
-- immediately BEFORE 20260921_002_interview_length.sql.
--
-- Nothing here writes, locks a row, or reads applicant data.
--
-- The SQL Editor shows only the LAST statement's result. Run the checks one at
-- a time, or wrap them into a single SELECT so every result comes back at once.
--
-- ============================================================================
-- HOW TO RUN THE MIGRATION ITSELF (after this preflight passes)
--
--   begin;
--   set local lock_timeout = '5s';
--   -- the one statement from 20260921_002_interview_length.sql
--   commit;
--
-- ADD COLUMN takes an ACCESS EXCLUSIVE lock on interview_grants, and the CHECK
-- is validated against every existing row while it is held -- a few hundred
-- rows, all NULL, so milliseconds. lock_timeout makes a busy table fail the
-- migration in five seconds, cleanly and with nothing applied, instead of
-- queueing every interview turn behind it.
--
-- Do NOT use `supabase db push`: migration history may list 008-010 as pending
-- although they were applied by hand, and a push could re-run them.
-- ============================================================================


-- 1. The column does not exist yet.
--    EXPECT: 0 rows. Any row: STOP -- the migration has already run; go to the
--    postcheck instead.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'interview_grants'
  and column_name = 'max_primary_questions';


-- 2. The constraint name is free.
--    EXPECT: 0 rows. If one exists on some other column, the inline constraint
--    would collide and the migration would fail (safely, with nothing applied).
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conname = 'interview_grants_max_primary_questions_check';


-- 3. Size. Record it: the postcheck compares against it.
select
  (select count(*) from public.interview_grants) as grants,
  pg_size_pretty(pg_total_relation_size('public.interview_grants')) as grants_size;


-- 4. How busy interviews are right now. Counts only.
--    EXPECT: low. A burst is a reason to wait.
select
  count(*) filter (where created_at > now() - interval '15 minutes') as grants_last_15m,
  count(*) filter (where created_at > now() - interval '1 hour')     as grants_last_hour
from public.interview_grants;


-- 5. Locks on interview_grants, which ADD COLUMN would queue behind.
--    EXPECT: 0 rows.
select a.pid, a.state, now() - a.xact_start as xact_age, l.mode
from pg_locks l
join pg_class c         on c.oid = l.relation
join pg_stat_activity a on a.pid = l.pid
where c.relname = 'interview_grants'
  and a.pid <> pg_backend_pid();


-- 6. Long-running transactions anywhere.
--    EXPECT: 0 rows.
select pid, state, now() - xact_start as xact_age, left(query, 80) as query
from pg_stat_activity
where xact_start is not null
  and now() - xact_start > interval '1 minute'
  and pid <> pg_backend_pid()
order by xact_age desc;


-- 7. The server can write the new column without a grant change.
--    service_role writes interview_grants through TABLE-level privileges,
--    which cover a column added later. EXPECT: insert = t, update = t,
--    select = t. And no column-level ACLs on the table: EXPECT 0.
--    (anon and authenticated must stay f/f/f: the table is service-role only.)
select r.role,
       has_table_privilege(r.role, 'public.interview_grants', 'INSERT') as can_insert,
       has_table_privilege(r.role, 'public.interview_grants', 'UPDATE') as can_update,
       has_table_privilege(r.role, 'public.interview_grants', 'SELECT') as can_select
from (values ('service_role'), ('authenticated'), ('anon')) as r(role);

select count(*) filter (where a.attacl is not null) as columns_with_column_level_acl
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'interview_grants'
  and a.attnum > 0 and not a.attisdropped;


-- 8. BEFORE: columns and constraints. KEEP THIS OUTPUT. The postcheck must
--    show exactly these plus the one column and the one constraint.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'interview_grants'
order by ordinal_position;

select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.interview_grants'::regclass
order by conname;
