-- GPA V2 — POST-MIGRATION VERIFICATION. READ-ONLY. Run immediately after.
-- STOP CONDITION: if rows_marked_v2 is anything but 0, stop and report.

-- STEP 3a — historical preservation
select count(*) as total_rows,
       count(engine_version) as rows_marked_v2   -- MUST be 0
from public.gpa_calculations;

-- Per-row fingerprint. Compare against the baseline in the report.
select calculation_name,
       overall_gpa, science_gpa, last60_gpa, nursing_gpa,
       md5(courses::text) as courses_md5,
       coalesce(engine_version::text,'NULL') as engine_version
from public.gpa_calculations
order by created_at
limit 5;

-- STEP 3b — new schema
select table_name from information_schema.tables
where table_schema='public' and table_name in ('gpa_institutions','gpa_drafts')
order by 1;   -- EXPECT both

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='gpa_calculations'
  and column_name in ('engine_version','policies','graduate_gpa','institutions')
order by column_name;   -- EXPECT 4 rows, all nullable

-- Privilege matrix. EXPECT: authenticated only; anon/service_role/PUBLIC none.
select r.rolname as grantee, t.tbl,
       has_table_privilege(r.rolname,t.tbl,'SELECT') as sel,
       has_table_privilege(r.rolname,t.tbl,'INSERT') as ins,
       has_table_privilege(r.rolname,t.tbl,'UPDATE') as upd,
       has_table_privilege(r.rolname,t.tbl,'DELETE') as del
from (values ('public.gpa_institutions'),('public.gpa_drafts')) t(tbl)
cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
order by t.tbl, r.rolname;

-- Function security. EXPECT: SECURITY INVOKER, search_path=pg_catalog,
-- and no PUBLIC execute.
select p.proname,
       case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security,
       coalesce(array_to_string(p.proconfig,', '),'(none)') as settings,
       coalesce(array_to_string(p.proacl,' | '),'(default PUBLIC EXECUTE)') as acl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('gpa_touch_updated_at','gpa_drafts_enforce_revision');
