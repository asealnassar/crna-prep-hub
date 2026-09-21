-- INTERVIEW RESUME — POSTCHECK. READ-ONLY. Run in the Supabase SQL Editor
-- immediately AFTER 20260921_001_interview_resume.sql, and BEFORE the Resume
-- application code deploys.
--
-- Nothing here writes, locks a row, or touches applicant data. It proves the
-- three columns and the index landed exactly as intended, that no historical
-- grant was bound, and that nothing else about either table moved.
--
-- Compare checks 4, 5, 6, 7 and 9 against the preflight output line for line.
--
-- Deliberately NO enforcement test that writes. Checks 2a-2c prove the index is
-- UNIQUE, VALID, and PARTIAL on the right column and predicate. That this
-- definition refuses a second grant for one session was proven against a real
-- Postgres 16 during development (A->X ok, A->X again idempotent, A->Y blocked,
-- B->X refused with 23505). Re-proving it here would mean issuing UPDATEs
-- against production, and no live interview row is worth that risk.
--
-- IF ANY CHECK FAILS: do not drop anything. The columns are nullable and
-- harmless to the running Phase 0 code. Leave them, find the cause, and fix
-- forward. Do NOT deploy the Resume code until every check here passes.


-- 1. THE THREE COLUMNS: right type, nullable, no default.
--    EXPECT exactly 3 rows, exactly these values:
--      interview_grants   | abandoned_at | timestamp with time zone | YES | (null)
--      interview_grants   | session_id   | uuid                     | YES | (null)
--      interview_sessions | pending_turn | jsonb                    | YES | (null)
--    Any column_default other than null is a FAIL: the migration sets none.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'interview_grants'   and column_name in ('session_id', 'abandoned_at'))
    or (table_name = 'interview_sessions' and column_name = 'pending_turn'))
order by table_name, column_name;


-- 2. THE UNIQUE INDEX. Its NAME existing proves nothing -- the preflight's
--    collision check exists because IF NOT EXISTS will happily skip over a
--    wrong object with the right name. Every property is checked explicitly.
--
--    2a. EXPECT exactly 1 row, every flag as shown:
--          table_name       | interview_grants
--          is_unique        | t     <- enforces one grant per session
--          is_valid         | t     <- usable; f means a failed build
--          is_ready         | t
--          is_partial       | t     <- has a WHERE clause
--          indexed_columns  | session_id
--          predicate        | (session_id IS NOT NULL)
select ic.relname                                   as index_name,
       tc.relname                                   as table_name,
       i.indisunique                                as is_unique,
       i.indisvalid                                 as is_valid,
       i.indisready                                 as is_ready,
       (i.indpred is not null)                      as is_partial,
       (select string_agg(a.attname, ', ' order by k.ord)
          from unnest(i.indkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as indexed_columns,
       pg_get_expr(i.indpred, i.indrelid)           as predicate
from pg_index i
join pg_class ic on ic.oid = i.indexrelid
join pg_class tc on tc.oid = i.indrelid
join pg_namespace n on n.oid = ic.relnamespace
where n.nspname = 'public' and ic.relname = 'interview_grants_session_id_key';

--    2b. The full definition, for the record. EXPECT exactly:
--          CREATE UNIQUE INDEX interview_grants_session_id_key
--            ON public.interview_grants USING btree (session_id)
--            WHERE (session_id IS NOT NULL)
select pg_get_indexdef(to_regclass('public.interview_grants_session_id_key')) as indexdef;

--    2c. One PASS/FAIL line summarising 2a, so a wrong index cannot be missed.
--        EXPECT: PASS.
select case
         when to_regclass('public.interview_grants_session_id_key') is null
           then 'FAIL: index missing'
         when not i.indisunique                    then 'FAIL: index is not UNIQUE'
         when not i.indisvalid                     then 'FAIL: index is not VALID'
         when i.indpred is null                    then 'FAIL: index is not PARTIAL'
         when i.indrelid <> 'public.interview_grants'::regclass
           then 'FAIL: index is on the wrong table'
         when i.indnatts <> 1                      then 'FAIL: index covers more than one column'
         when (select a.attname from pg_attribute a
                where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) <> 'session_id'
           then 'FAIL: index is not on session_id'
         when pg_get_expr(i.indpred, i.indrelid) <> '(session_id IS NOT NULL)'
           then 'FAIL: predicate is not session_id IS NOT NULL'
         else 'PASS'
       end as unique_index_check
from pg_index i
where i.indexrelid = to_regclass('public.interview_grants_session_id_key');


-- 3. NO BACKFILL. The migration writes no data, so every existing row must be
--    exactly as it was: nothing bound, nothing abandoned, no checkpoint.
--    This is what keeps every pre-Resume interview non-resumable.
--    EXPECT: bound = 0, abandoned = 0, with_pending_turn = 0.
--    (A non-zero value is only possible if Resume code is ALREADY live and
--    applicants have used it -- it must not be yet.)
select
  (select count(*) from public.interview_grants   where session_id   is not null) as bound,
  (select count(*) from public.interview_grants   where abandoned_at is not null) as abandoned,
  (select count(*) from public.interview_sessions where pending_turn is not null) as with_pending_turn;


-- 4. ROW COUNTS. EXPECT: equal to preflight check 3.
--    The migration adds and deletes no rows. A small INCREASE is possible only
--    if live interviews started in between; any DECREASE is a FAIL.
select
  (select count(*) from public.interview_grants)   as grants,
  (select count(*) from public.interview_sessions) as sessions;


-- 5. EVERY COLUMN. EXPECT: preflight check 8 output PLUS exactly the three
--    columns from check 1, and no other difference.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('interview_grants', 'interview_sessions')
order by table_name, ordinal_position;


-- 6. GRANTS UNCHANGED. EXPECT: identical to preflight check 9, line for line.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('interview_grants', 'interview_sessions')
order by table_name, grantee, privilege_type;


-- 7. RLS AND POLICIES UNCHANGED. EXPECT: identical to preflight check 10.
select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('interview_grants', 'interview_sessions')
order by c.relname;

select tablename, policyname, cmd, roles::text, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('interview_grants', 'interview_sessions')
order by tablename, policyname;


-- 8. CAN THE BROWSER WRITE pending_turn? The go/no-go for deploying Resume
--    CODE. Answered directly by Postgres, with no write attempted.
--
--    has_column_privilege is true under EITHER a table-level grant or a
--    column-level grant that names this column -- it is the authoritative
--    answer to "will this write be permitted", which is the only question
--    that matters. RLS is separate and column-agnostic: Phase 0 already
--    writes these rows under RLS, so row access is not in doubt.
--
--    EXPECT: authenticated -> insert = t, update = t, select = t.
--    If insert or update is f: STOP. Do NOT deploy Resume code. Grant
--    pending_turn to authenticated first, then re-run this check. Without it,
--    every Practice checkpoint save would be refused and the interview it
--    belongs to could not survive a refresh at that point.
select r.role,
       has_column_privilege(r.role, 'public.interview_sessions', 'pending_turn', 'INSERT') as can_insert,
       has_column_privilege(r.role, 'public.interview_sessions', 'pending_turn', 'UPDATE') as can_update,
       has_column_privilege(r.role, 'public.interview_sessions', 'pending_turn', 'SELECT') as can_select
from (values ('authenticated'), ('anon')) as r(role);

--    8b. Column-level ACL entries. EXPECT: the same count as preflight check
--        7b (0 expected). The migration grants nothing, so this must not move.
select count(*) filter (where a.attacl is not null) as columns_with_column_level_acl,
       string_agg(a.attname, ', ') filter (where a.attacl is not null) as which_columns
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'interview_sessions'
  and a.attnum > 0 and not a.attisdropped;


-- 9. TRIGGERS, CONSTRAINTS AND INDEXES. EXPECT: triggers and constraints
--    identical to preflight check 11 (the migration adds NO foreign key and no
--    trigger); indexes equal to preflight check 12 PLUS exactly
--    interview_grants_session_id_key.
select event_object_table as table_name, trigger_name, event_manipulation, action_timing
from information_schema.triggers
where event_object_schema = 'public' and event_object_table in ('interview_grants', 'interview_sessions')
order by table_name, trigger_name;

select conrelid::regclass as table_name, conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.interview_grants'::regclass, 'public.interview_sessions'::regclass)
order by table_name, conname;

select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'interview_grants'
order by indexname;
