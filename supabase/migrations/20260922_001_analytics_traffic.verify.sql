-- ============================================================================
-- VERIFICATION for 20260922_001_analytics_traffic.sql
--
-- READ-ONLY. Selects only: no insert, update, delete, grant or alter. Safe to
-- run before the migration (everything fails), after it (everything passes),
-- or at any time later.
--
-- ONE query on purpose. The Supabase SQL editor shows only the last result, so
-- every check is a row in a single result set rather than a separate statement.
--
-- READ IT LIKE THIS: every row must say PASS in `verdict`. Any FAIL is a reason
-- not to switch the tracker on.
-- ============================================================================

with expected_tables (name) as (
  values ('analytics_visitors'), ('analytics_sessions'),
         ('analytics_events'),   ('analytics_ad_spend')
),

-- 1. The four tables exist.
t_exists as (
  select '1. table exists: ' || name                as check_name,
         coalesce(to_regclass('public.' || name)::text, '(missing)') as found,
         'the table'                                as expected,
         case when to_regclass('public.' || name) is not null then 'PASS' else 'FAIL' end as verdict
  from   expected_tables
),

-- 2. RLS is enabled AND forced on each one.
t_rls as (
  select '2. RLS enabled+forced: ' || c.relname     as check_name,
         'enabled=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity as found,
         'enabled=true forced=true'                 as expected,
         case when c.relrowsecurity and c.relforcerowsecurity then 'PASS' else 'FAIL' end as verdict
  from   pg_class c
         join pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname in (select name from expected_tables)
),

-- 3. No policy exists on any of them. A policy would be a way in.
t_policies as (
  select '3. zero policies: ' || e.name             as check_name,
         coalesce(count(p.policyname)::text, '0')   as found,
         '0'                                        as expected,
         case when count(p.policyname) = 0 then 'PASS' else 'FAIL' end as verdict
  from   expected_tables e
         left join pg_policies p
                on p.schemaname = 'public' and p.tablename = e.name
  group  by e.name
),

-- 4. anon and authenticated hold NO privilege of any kind. This is the check
--    that catches Supabase's ALTER DEFAULT PRIVILEGES grants surviving a
--    `revoke ... from public`.
t_browser_roles as (
  select '4. no browser-role grants: ' || e.name || ' / ' || r.role as check_name,
         coalesce(string_agg(g.privilege_type, ',' order by g.privilege_type), '(none)') as found,
         '(none)'                                   as expected,
         case when count(g.privilege_type) = 0 then 'PASS' else 'FAIL' end as verdict
  from   expected_tables e
         cross join (values ('anon'), ('authenticated')) as r(role)
         left join information_schema.role_table_grants g
                on g.table_schema = 'public'
               and g.table_name   = e.name
               and g.grantee      = r.role
  group  by e.name, r.role
),

-- 5. service_role can still do its job. A revoke that went too far shows here.
t_service as (
  select '5. service_role can write: ' || e.name    as check_name,
         coalesce(string_agg(distinct g.privilege_type, ',' order by g.privilege_type), '(none)') as found,
         'DELETE,INSERT,SELECT,UPDATE'              as expected,
         case when count(distinct g.privilege_type) filter (
                where g.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')) = 4
              then 'PASS' else 'FAIL' end           as verdict
  from   expected_tables e
         left join information_schema.role_table_grants g
                on g.table_schema = 'public'
               and g.table_name   = e.name
               and g.grantee      = 'service_role'
  group  by e.name
),

-- 6. Both functions exist and only service_role may execute them. A missing
--    row here means the function was never created.
t_prune as (
  select '6. function privileges: ' || p.proname    as check_name,
         'anon=' || has_function_privilege('anon', p.oid, 'EXECUTE') ||
         ' authenticated=' || has_function_privilege('authenticated', p.oid, 'EXECUTE') ||
         ' service_role=' || has_function_privilege('service_role', p.oid, 'EXECUTE') as found,
         'anon=false authenticated=false service_role=true' as expected,
         case when not has_function_privilege('anon', p.oid, 'EXECUTE')
               and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
               and     has_function_privilege('service_role', p.oid, 'EXECUTE')
              then 'PASS' else 'FAIL' end            as verdict
  from   pg_proc p
  where  p.pronamespace = 'public'::regnamespace
    and  p.proname in ('analytics_prune', 'analytics_record_event')
),

-- 7. No column that could hold personal data. If a later change adds one of
--    these names, this row turns red.
t_no_pii as (
  select '7. no PII columns'                        as check_name,
         coalesce(string_agg(c.table_name || '.' || c.column_name, ', '), '(none)') as found,
         '(none)'                                   as expected,
         case when count(*) = 0 then 'PASS' else 'FAIL' end as verdict
  from   information_schema.columns c
  where  c.table_schema = 'public'
    and  c.table_name in (select name from expected_tables)
    and  (c.column_name ilike '%ip%address%' or c.column_name in
          ('ip', 'ip_address', 'email', 'user_agent', 'ua', 'name', 'full_name',
           'query', 'query_string', 'url', 'content_text', 'answer', 'message'))
),

-- 8. Nothing has been written yet. Expect four zeros on a fresh migration;
--    after the tracker is live these grow, which is not a failure -- the row
--    is here so you can see whether ingestion has started.
t_rows as (
  select '8. rows (informational): ' || name        as check_name,
         case when to_regclass('public.' || name) is null then '(table missing)'
              else (xpath('/row/c/text()',
                     query_to_xml('select count(*) as c from public.' || name, false, true, '')))[1]::text
         end                                        as found,
         'grows once the tracker is live'           as expected,
         'INFO'                                     as verdict
  from   expected_tables
),

-- 9. Nothing outside this migration was disturbed: the tables Phases 1 and 2
--    read must still be readable and still hold their rows.
-- A table that is absent reports as absent rather than aborting the whole
-- query: a verification script that dies on its last check has told you
-- nothing about the thirty above it.
t_untouched as (
  select '9. untouched: ' || name                   as check_name,
         case when to_regclass('public.' || name) is null then '(table missing -- CHECK THIS)'
              else (xpath('/row/c/text()',
                     query_to_xml('select count(*) as c from public.' || name, false, true, '')))[1]::text
         end                                        as found,
         'unchanged by this migration'              as expected,
         case when to_regclass('public.' || name) is null then 'FAIL' else 'INFO' end as verdict
  from   (values ('user_profiles'), ('interview_grants'), ('school_unlock_requests')) as u(name)
)

select * from t_exists
union all select * from t_rls
union all select * from t_policies
union all select * from t_browser_roles
union all select * from t_service
union all select * from t_prune
union all select * from t_no_pii
union all select * from t_rows
union all select * from t_untouched
order by check_name;
