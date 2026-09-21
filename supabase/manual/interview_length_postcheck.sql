-- INTERVIEW LENGTH — POSTCHECK. READ-ONLY. Run in the Supabase SQL Editor
-- immediately AFTER 20260921_002_interview_length.sql, and BEFORE the Phase 3
-- application code deploys.
--
-- Nothing here writes, locks a row, or reads applicant data. There is
-- deliberately no write-shaped test of the CHECK: that it refuses 7 and accepts
-- 5, 10 and NULL was proven against a real Postgres 16 during development, and
-- proving it here would mean inserting into a live table.
--
-- IF ANY CHECK FAILS: do not drop anything. The column is nullable and the
-- deployed code never names it. Leave it, find the cause, fix forward, and do
-- not deploy Phase 3 until every check here passes.


-- 1. The column: smallint, nullable, no default.
--    EXPECT exactly 1 row:
--      max_primary_questions | smallint | YES | (null)
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'interview_grants'
  and column_name = 'max_primary_questions';


-- 2. The constraint: present, validated, and exactly this definition.
--    EXPECT 1 row, validated = t, definition:
--      CHECK (((max_primary_questions IS NULL) OR (max_primary_questions = ANY (ARRAY[5, 10]))))
select conname, convalidated as validated, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.interview_grants'::regclass
  and conname = 'interview_grants_max_primary_questions_check';


-- 3. No backfill. Every existing grant is still NULL, i.e. still Full.
--    EXPECT: with_length = 0. Non-zero is only possible if Phase 3 code is
--    already live and has started interviews -- it must not be yet.
select
  count(*) filter (where max_primary_questions is not null) as with_length,
  count(*) filter (where max_primary_questions is null)     as historical,
  count(*)                                                  as total
from public.interview_grants;


-- 4. The server can read and write the column; the browser still cannot.
--    EXPECT: service_role t/t/t; authenticated and anon f/f/f.
select r.role,
       has_column_privilege(r.role, 'public.interview_grants', 'max_primary_questions', 'INSERT') as can_insert,
       has_column_privilege(r.role, 'public.interview_grants', 'max_primary_questions', 'UPDATE') as can_update,
       has_column_privilege(r.role, 'public.interview_grants', 'max_primary_questions', 'SELECT') as can_select
from (values ('service_role'), ('authenticated'), ('anon')) as r(role);


-- 5. RLS unchanged: still enabled, still no policies.
--    EXPECT: rls_enabled = t, policies = 0.
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'interview_grants') as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'interview_grants';


-- 6. AFTER: columns and constraints. EXPECT: preflight check 8 plus exactly
--    max_primary_questions and interview_grants_max_primary_questions_check.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'interview_grants'
order by ordinal_position;

select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.interview_grants'::regclass
order by conname;
