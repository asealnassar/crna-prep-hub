-- GPA V2 — PREFLIGHT. READ-ONLY. Run this BEFORE the migration.
-- Covers the one preflight item PostgREST cannot reach: existing constraints,
-- triggers, policies and indexes on gpa_calculations that an additive
-- migration could collide with.

-- 1. Row count and version state. EXPECT: 20 rows, 0 marked v2,
--    and "engine_version" should not appear in check 3 below at all yet.
select count(*) as existing_rows from public.gpa_calculations;

-- 2. Existing constraints on gpa_calculations.
--    EXPECT: no constraint named gpa_calculations_engine_version.
select con.conname, pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'gpa_calculations'
order by con.conname;

-- 3. Existing columns. EXPECT: engine_version / policies / graduate_gpa /
--    institutions are all ABSENT.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'gpa_calculations'
order by ordinal_position;

-- 4. Triggers on gpa_calculations. Anything here that rewrites rows on ALTER
--    would be a reason to stop.
select t.tgname, p.proname as function, t.tgenabled
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where not t.tgisinternal and c.relname = 'gpa_calculations';

-- 5. Name collisions for the objects the migration creates.
--    EXPECT: zero rows from each.
select 'TABLE ' || tablename as collision from pg_tables
where schemaname='public' and tablename in ('gpa_institutions','gpa_drafts')
union all
select 'FUNCTION ' || p.proname from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('gpa_touch_updated_at','gpa_drafts_enforce_revision')
union all
select 'INDEX ' || indexname from pg_indexes
where schemaname='public' and indexname in ('gpa_institutions_user_id_idx','gpa_institutions_user_name_uniq');

-- 6. Confirm the roles the migration grants to actually exist.
--    EXPECT: anon, authenticated, service_role all present.
select rolname from pg_roles where rolname in ('anon','authenticated','service_role') order by 1;
