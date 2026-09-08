-- D33 PREFLIGHT — READ-ONLY. Run in the Supabase SQL Editor immediately
-- BEFORE 20260902_000_gpa_multiple_analyses.sql.
-- service_role deliberately has no access to gpa_drafts (D22), so this must be
-- run as the SQL Editor's privileged role. Record the output.

-- 1. The one production draft, fully fingerprinted.
select
  count(*) over ()                         as total_rows,
  count(*) over (partition by 1)           as _ignore,
  left(user_id::text, 8) || '…'            as user_abbrev,
  revision,
  engine_version,
  policies::text                           as policies,
  jsonb_array_length(courses)              as course_count,
  md5(courses::text)                       as courses_md5,
  encode(digest(courses::text, 'sha256'), 'hex') as courses_sha256,
  created_at,
  updated_at
from public.gpa_drafts
order by created_at;
-- EXPECT: exactly 1 row (you confirmed drafts = 1, users = 1).

-- 2. Aggregate counts.
select count(*) as drafts, count(distinct user_id) as users
from public.gpa_drafts;
-- EXPECT: drafts = 1, users = 1. If drafts > 1, STOP and report.

-- 3. Current shape, to compare against afterwards.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid = 'public.gpa_drafts'::regclass
order by contype, conname;
-- EXPECT: PRIMARY KEY (user_id) present; no gpa_drafts_name_len.

select indexname from pg_indexes
where schemaname='public' and tablename='gpa_drafts' order by indexname;
-- EXPECT: gpa_drafts_pkey only.

select column_name from information_schema.columns
where table_schema='public' and table_name='gpa_drafts'
  and column_name in ('id','name');
-- EXPECT: zero rows (neither column exists yet).

-- 4. Function ACLs before, so the migration can be shown not to broaden them.
select p.proname,
       case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security,
       coalesce(array_to_string(p.proconfig, ','), '(none)')     as search_path,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'gpa%'
order by p.proname;
