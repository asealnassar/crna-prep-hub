-- D60 — PREFLIGHT. READ-ONLY. Run this BEFORE 20260905_000_gpa_transcript_sources.sql.
--
-- Nothing here writes. Its job is to prove the migration has room to land, and
-- to capture the "before" picture of the other GPA objects so the postcheck can
-- prove the migration changed nothing else.

-- 1. The ledger must not exist yet. EXPECT: 0 rows.
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'gpa_transcript_sources';

-- 2. None of the four functions may exist yet. EXPECT: 0 rows.
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('gpa_reserve_transcript_source', 'gpa_consume_transcript_source',
                    'gpa_release_transcript_source', 'gpa_transcript_access');

-- 3. BEFORE picture of every other GPA object. Keep this output: the postcheck
--    runs the identical query and the two must match line for line.
--    EXPECT: gpa_calculations, gpa_drafts, gpa_institutions and their grants.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name like 'gpa_%'
order by table_name, grantee, privilege_type;

select tablename, policyname, cmd, roles::text
from pg_policies
where schemaname = 'public' and tablename like 'gpa_%'
order by tablename, policyname;

-- 4. Row counts that must not move. EXPECT: unchanged in the postcheck.
select
  (select count(*) from public.gpa_calculations) as calculations,
  (select count(*) from public.gpa_drafts)       as drafts,
  (select count(*) from public.gpa_institutions) as institutions;
