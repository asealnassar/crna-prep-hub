-- ============================================================================
-- ROLLBACK for 20260922_001_analytics_traffic.sql and 20260922_002.
--
-- WHEN TO RUN THIS. Only to undo the Phase 3 database change. It is the exact
-- inverse of what those two files create and it touches nothing else: no
-- existing table, no existing function, no row of product data. Running it on
-- a database where the migrations were never applied is harmless.
--
-- WHAT IT DESTROYS. The four analytics tables and everything collected in
-- them. That is the point, but it is worth saying plainly: if the tracker has
-- been live, this deletes the traffic history and it cannot be recovered
-- except from a backup. At the moment of the initial release the tables are
-- empty, because tracking ships disabled.
--
-- WHAT IT DELIBERATELY LEAVES. The pg_cron EXTENSION stays. Migration 002
-- created it only if it was absent, other things may now depend on it, and
-- dropping an extension to undo one scheduled job is disproportionate. Only
-- the job itself is removed.
--
-- ORDER MATTERS. The job first, so nothing can fire mid-drop. Then the
-- functions that reference the tables. Then the tables, children before
-- parents -- though `cascade` makes that belt and braces.
-- ============================================================================
begin;

-- 1. Stop the scheduled cleanup, if pg_cron is present at all.
do $$
begin
  if to_regclass('cron.job') is not null
     and exists (select 1 from cron.job where jobname = 'analytics-retention') then
    perform cron.unschedule('analytics-retention');
  end if;
end;
$$;

-- 2. The functions.
drop function if exists public.analytics_record_event(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, uuid
);
drop function if exists public.analytics_prune(integer);

-- 3. The tables. `cascade` removes the foreign keys between them and the
--    indexes on them; nothing outside this set references any of them.
drop table if exists public.analytics_events   cascade;
drop table if exists public.analytics_sessions cascade;
drop table if exists public.analytics_visitors cascade;
drop table if exists public.analytics_ad_spend cascade;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only; run after the rollback)
--
-- Expect every row to say PASS: nothing of Phase 3 left, and the tables the
-- rest of the product depends on still present and still holding their rows.
-- ---------------------------------------------------------------------------
with gone as (
  select 'removed: ' || name as check_name,
         case when to_regclass('public.' || name) is null then 'PASS' else 'FAIL -- still present' end as verdict
  from (values ('analytics_visitors'), ('analytics_sessions'),
               ('analytics_events'), ('analytics_ad_spend')) as t(name)
),
functions_gone as (
  select 'removed: ' || name as check_name,
         case when to_regproc('public.' || name) is null then 'PASS' else 'FAIL -- still present' end as verdict
  from (values ('analytics_prune'), ('analytics_record_event')) as f(name)
),
job_gone as (
  select 'removed: retention schedule' as check_name,
         case when to_regclass('cron.job') is null then 'PASS -- no pg_cron'
              when not exists (select 1 from cron.job where jobname = 'analytics-retention') then 'PASS'
              else 'FAIL -- job still scheduled' end as verdict
),
untouched as (
  select 'untouched: ' || name as check_name,
         case when to_regclass('public.' || name) is not null then 'PASS' else 'FAIL -- MISSING' end as verdict
  from (values ('user_profiles'), ('interview_grants'), ('school_unlock_requests'),
               ('resumes'), ('school_reports')) as u(name)
)
select * from gone
union all select * from functions_gone
union all select * from job_gone
union all select * from untouched
order by check_name;
