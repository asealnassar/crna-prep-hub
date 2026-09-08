-- D60 — POSTCHECK. READ-ONLY. Run this AFTER 20260905_000_gpa_transcript_sources.sql.
--
-- Covers every verification item for the transcript entitlement ledger. Nothing
-- here writes, and nothing here repairs: a failing expectation is a finding to
-- report, never something to patch in place.

-- ============================================================
-- 1. THE TABLE EXISTS
-- ============================================================
-- EXPECT: exactly 1 row, relrowsecurity = true (verification item 3).
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'gpa_transcript_sources';

-- ============================================================
-- 2. COLUMNS
-- ============================================================
-- EXPECT: id uuid NOT NULL, user_id uuid NOT NULL, status text NOT NULL
--         (default 'pending'), document_hash text NOT NULL,
--         tier_at_issue text NOT NULL, created_at timestamptz NOT NULL,
--         consumed_at timestamptz NULLABLE. 7 rows.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'gpa_transcript_sources'
order by ordinal_position;

-- ============================================================
-- 3. CONSTRAINTS AND INDEXES
-- ============================================================
-- EXPECT: primary key on (id); FK user_id -> auth.users ON DELETE CASCADE;
--         gpa_transcript_sources_status, _hash_shape, _consumed_at checks.
select con.conname, pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'gpa_transcript_sources'
order by con.conname;

-- EXPECT: the primary key index plus gpa_transcript_sources_user_idx and
--         gpa_transcript_sources_user_doc_idx.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'gpa_transcript_sources'
order by indexname;

-- ============================================================
-- 4 + 5. THE CLIENT MAY READ ITS OWN ROWS AND NOTHING MORE
-- ============================================================
-- EXPECT: exactly ONE policy -- "own transcript sources select", cmd = SELECT,
--         roles = {authenticated}. No INSERT/UPDATE/DELETE policy may exist:
--         with RLS on, that is what denies those statements.
select policyname, cmd, roles::text, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'gpa_transcript_sources'
order by policyname;

-- EXPECT: exactly ONE row -- authenticated / SELECT.
--         anon, service_role and PUBLIC must not appear at all.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'gpa_transcript_sources'
order by grantee, privilege_type;

-- ============================================================
-- 6 + 7. THE FUNCTIONS AND WHO MAY RUN THEM
-- ============================================================
-- EXPECT: 4 rows, every one security_definer = true and
--         config = {search_path=pg_catalog, public}.
select p.proname,
       p.prosecdef as security_definer,
       p.proconfig::text as config,
       pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('gpa_reserve_transcript_source', 'gpa_consume_transcript_source',
                    'gpa_release_transcript_source', 'gpa_transcript_access')
order by p.proname;

-- EXPECT: exactly 4 rows, all grantee = service_role, privilege_type = EXECUTE.
--         anon, authenticated and PUBLIC must not appear.
select r.routine_name, p.grantee, p.privilege_type
from information_schema.routine_privileges p
join information_schema.routines r
  on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
where p.specific_schema = 'public'
  and r.routine_name in ('gpa_reserve_transcript_source', 'gpa_consume_transcript_source',
                         'gpa_release_transcript_source', 'gpa_transcript_access')
order by r.routine_name, p.grantee;

-- ============================================================
-- 8. THE LEDGER STARTS EMPTY
-- ============================================================
-- EXPECT: 0. No backfill: every existing account keeps its allowance, which is
--         the approved decision, not an accident.
select count(*) as ledger_rows from public.gpa_transcript_sources;

-- ============================================================
-- 9. NOTHING ELSE MOVED
-- ============================================================
-- Run the identical queries from d60_preflight.sql and compare, line for line.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name like 'gpa_%'
  and table_name <> 'gpa_transcript_sources'
order by table_name, grantee, privilege_type;

select tablename, policyname, cmd, roles::text
from pg_policies
where schemaname = 'public' and tablename like 'gpa_%'
  and tablename <> 'gpa_transcript_sources'
order by tablename, policyname;

-- EXPECT: identical to the preflight. gpa_calculations in particular must be
--         untouched -- no historical row is repaired or rewritten by D60.
select
  (select count(*) from public.gpa_calculations) as calculations,
  (select count(*) from public.gpa_drafts)       as drafts,
  (select count(*) from public.gpa_institutions) as institutions;

-- EXPECT: the D35 analysis-cap trigger is still in place and unchanged.
select tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid = t.tgrelid
where c.relname = 'gpa_drafts' and not t.tgisinternal
order by tgname;
