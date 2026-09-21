-- INTERVIEW RESUME — PREFLIGHT. READ-ONLY. Run in the Supabase SQL Editor
-- immediately BEFORE 20260921_001_interview_resume.sql.
--
-- Nothing here writes, locks a row, or touches applicant data. Its job is to
-- prove the migration has room to land, that nothing is holding a lock it would
-- queue behind, and to capture the "before" picture of both tables so the
-- postcheck can prove the migration changed nothing it was not meant to.
--
-- Keep the output of checks 3, 8, 9, 10 and 12: the postcheck repeats them and
-- the two must match.
--
-- ============================================================================
-- HOW TO RUN THE MIGRATION ITSELF (after this preflight passes)
--
-- Do NOT run the migration file bare. Paste its four statements inside:
--
--   begin;
--   set local lock_timeout = '5s';
--   -- the four statements from 20260921_001_interview_resume.sql
--   commit;
--
-- Why both parts matter, each proven against a real Postgres 16:
--   * begin/commit makes it all-or-nothing. Without it, a failure after the
--     columns but before the unique index would leave session_id in place with
--     NO uniqueness enforced -- the one outcome that is unsafe for Resume.
--   * lock_timeout makes it fail in 5 seconds instead of queueing. ADD COLUMN
--     needs an ACCESS EXCLUSIVE lock; if a slow request already holds one, an
--     un-timed ALTER waits, and every query arriving after it waits behind the
--     ALTER. That queue, not the migration, is the real outage risk.
--
-- If it times out: nothing was applied. Re-run checks 5 and 6 below and retry.
--
-- Do NOT use `supabase db push`: migration history may list 008-010 as
-- pending although they were applied by hand, and a push could re-run them.
-- ============================================================================


-- 1. SCHEMA ABSENCE. None of the three columns may exist yet.
--    EXPECT: 0 rows.
--    If ANY row appears: STOP. The migration has been (partly) applied already;
--    run the postcheck instead of the migration.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'interview_grants'   and column_name in ('session_id', 'abandoned_at'))
    or (table_name = 'interview_sessions' and column_name = 'pending_turn'));


-- 2. NAME COLLISION. Nothing may occupy the index's name -- of ANY kind.
--    EXPECT: 0 rows.
--
--    This is the check that matters most. `create unique index IF NOT EXISTS`
--    does not ask whether an equivalent index exists; it asks whether ANY
--    relation has that name. If one does -- a plain non-unique index, a table,
--    a sequence -- the statement prints a NOTICE, skips, and the migration
--    REPORTS SUCCESS with no uniqueness enforced at all. Reproduced locally:
--    a pre-existing non-unique index left indisunique = false and no error.
--    Relation names share one namespace per schema, hence relkind is shown.
--    If ANY row appears: STOP. Do not run the migration.
select n.nspname as schema, c.relname as name, c.relkind as kind,
       case c.relkind when 'i' then 'index' when 'r' then 'table' when 'S' then 'sequence'
                      when 'v' then 'view'  when 'm' then 'materialized view' else c.relkind::text end as kind_name
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relname = 'interview_grants_session_id_key';


-- 3. ROW COUNTS AND SIZE. Record these; the postcheck compares against them.
--    EXPECT: hundreds of rows, well under 1 MB each (last read: 340 grants,
--    867 sessions). The index is PARTIAL on session_id IS NOT NULL and every
--    existing row will have session_id NULL, so it is built EMPTY -- the table
--    size does not affect how long the index build holds its lock.
select
  (select count(*) from public.interview_grants)   as grants,
  (select count(*) from public.interview_sessions) as sessions,
  pg_size_pretty(pg_total_relation_size('public.interview_grants'))   as grants_size,
  pg_size_pretty(pg_total_relation_size('public.interview_sessions')) as sessions_size;


-- 4. RECENT ACTIVITY. How busy interviews are right now, so the migration can
--    be run in a quiet moment. Counts only -- no row content is read.
--    EXPECT: low. A handful per hour is fine; a burst is a reason to wait.
select
  count(*) filter (where created_at > now() - interval '15 minutes') as grants_last_15m,
  count(*) filter (where created_at > now() - interval '1 hour')     as grants_last_hour
from public.interview_grants;


-- 5. LOCKS ON THE TWO TABLES. Anything here would make ALTER TABLE queue.
--    EXPECT: 0 rows.
--    If rows appear: wait for them to clear, then re-run this check. With
--    lock_timeout set the migration would fail safely anyway, but there is no
--    reason to start it into a known conflict.
select a.pid, a.state, now() - a.xact_start as xact_age, l.mode, c.relname
from pg_locks l
join pg_class c         on c.oid = l.relation
join pg_stat_activity a on a.pid = l.pid
where c.relname in ('interview_grants', 'interview_sessions')
  and a.pid <> pg_backend_pid();


-- 6. LONG-RUNNING TRANSACTIONS anywhere in the database.
--    EXPECT: 0 rows (nothing open longer than a minute).
select pid, state, now() - xact_start as xact_age, left(query, 80) as query
from pg_stat_activity
where xact_start is not null
  and now() - xact_start > interval '1 minute'
  and pid <> pg_backend_pid()
order by xact_age desc;


-- 7. PERMISSION MODEL FOR interview_sessions. THE finding that decides whether
--    Resume's CODE can deploy straight after the migration.
--
--    Resume makes the browser write a new column, pending_turn. Whether it can
--    depends entirely on HOW the browser's role was granted write access:
--
--      TABLE-level grant  -> covers every column, INCLUDING ones added later.
--                            pending_turn is writable with no further change.
--      COLUMN-level grant -> covers only the columns it names. pending_turn
--                            would be REFUSED at runtime, and Resume's Practice
--                            checkpoint would silently fail to persist.
--
--    This project uses column-level grants on several locked-down tables
--    (school_reports, email jobs, resume migration links), so the question is
--    real rather than theoretical.
--
--    NOTE: information_schema.column_privileges CANNOT answer this. It lists
--    every column under a table-level grant too (verified locally: a plain
--    table-level grant produced 6 column rows), so its row count means
--    nothing here. The two checks below are the ones that discriminate.
--
--    7a. EXPECT: authenticated -> insert = t, update = t, select = t.
--        t on insert/update means TABLE-level write access: pending_turn will
--        be writable. f on insert or update, while the browser demonstrably
--        writes this table today, means access is COLUMN-level: FLAG IT.
select r.role,
       has_table_privilege(r.role, 'public.interview_sessions', 'INSERT') as can_insert,
       has_table_privilege(r.role, 'public.interview_sessions', 'UPDATE') as can_update,
       has_table_privilege(r.role, 'public.interview_sessions', 'SELECT') as can_select
from (values ('authenticated'), ('anon')) as r(role);

--    7b. Column-level ACL entries on interview_sessions.
--        EXPECT: 0.
--        0 confirms table-level access only. Any non-zero count means someone
--        has granted per-column privileges on this table: STOP before
--        deploying Resume CODE and add pending_turn to that grant first. (The
--        migration itself is still safe to run -- it does not depend on this.)
select count(*) filter (where a.attacl is not null) as columns_with_column_level_acl,
       string_agg(a.attname, ', ') filter (where a.attacl is not null) as which_columns
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'interview_sessions'
  and a.attnum > 0 and not a.attisdropped;

--    7c. The same question for interview_grants. EXPECT: 0.
--        interview_grants is service-role only (RLS on, no policies); the
--        browser never touches it. Recorded for the before/after comparison.
select count(*) filter (where a.attacl is not null) as columns_with_column_level_acl
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'interview_grants'
  and a.attnum > 0 and not a.attisdropped;


-- 8. BEFORE: every column of both tables. KEEP THIS OUTPUT.
--    The postcheck must show exactly these PLUS the three new columns.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('interview_grants', 'interview_sessions')
order by table_name, ordinal_position;


-- 9. BEFORE: table-level grants on both tables. KEEP THIS OUTPUT.
--    The migration grants and revokes nothing; the postcheck must match.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('interview_grants', 'interview_sessions')
order by table_name, grantee, privilege_type;


-- 10. BEFORE: RLS status and every policy on both tables. KEEP THIS OUTPUT.
--     EXPECT: interview_grants has RLS enabled and NO policies (service-role
--     only, by design).
select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('interview_grants', 'interview_sessions')
order by c.relname;

select tablename, policyname, cmd, roles::text, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('interview_grants', 'interview_sessions')
order by tablename, policyname;


-- 11. BEFORE: triggers and foreign keys on both tables. KEEP THIS OUTPUT.
--     The migration adds neither; the postcheck must match.
select event_object_table as table_name, trigger_name, event_manipulation, action_timing
from information_schema.triggers
where event_object_schema = 'public' and event_object_table in ('interview_grants', 'interview_sessions')
order by table_name, trigger_name;

select conrelid::regclass as table_name, conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.interview_grants'::regclass, 'public.interview_sessions'::regclass)
order by table_name, conname;


-- 12. BEFORE: indexes on interview_grants. KEEP THIS OUTPUT.
--     The postcheck must show exactly these PLUS interview_grants_session_id_key.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'interview_grants'
order by indexname;
