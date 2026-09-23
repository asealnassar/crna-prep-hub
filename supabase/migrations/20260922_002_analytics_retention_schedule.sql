-- ============================================================================
-- ANALYTICS PHASE 3: MAKE THE RETENTION PROMISE TRUE
--
-- WHY THIS EXISTS. 20260922_001 created analytics_prune() and nothing called
-- it. The Privacy Policy tells visitors "usage records are deleted after 400
-- days", and a policy that states a retention period nobody enforces is not a
-- retention period, it is a sentence. This schedules it.
--
-- SEPARATE FROM 001 ON PURPOSE. Enabling an extension is the one step here
-- that can fail for reasons outside this file — a plan that does not offer
-- pg_cron, or a role that may not create it. Keeping it apart means that
-- failure cannot roll back the tables, and it can be re-run alone once the
-- extension is available.
--
-- WHAT IT SCHEDULES. One job, once a day, at 03:17 UTC — an odd minute so it
-- does not land on the hour with everything else. It calls the function 001
-- already created and already tested; this file adds no new logic and touches
-- no table.
--
-- IF pg_cron IS NOT AVAILABLE this file will fail with a clear error, which is
-- the correct outcome: retention silently not running is exactly the state
-- this migration exists to end. The fallback is a scheduled HTTP call to a
-- protected endpoint, which is more moving parts and is only worth building if
-- this path is closed.
--
-- PRE-FLIGHT (read-only). Expect the function to exist and no job yet.
--   select to_regproc('public.analytics_prune') is not null as function_exists,
--          (select count(*) from pg_extension where extname = 'pg_cron') as pg_cron_installed;
-- ============================================================================
begin;

-- Supabase installs extensions into the `extensions` schema. `if not exists`
-- makes re-running this file harmless.
create extension if not exists pg_cron;

-- Replace rather than duplicate. Older pg_cron happily schedules a second job
-- under the same name, which would prune twice a day and look like a bug the
-- next time somebody reads cron.job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'analytics-retention') then
    perform cron.unschedule('analytics-retention');
  end if;
end;
$$;

-- 400 days: the number the Privacy Policy states, and the default the function
-- already carries. Passed explicitly so the two are visibly the same number
-- rather than coincidentally the same number.
select cron.schedule(
  'analytics-retention',
  '17 3 * * *',
  $job$ select public.analytics_prune(400); $job$
);

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only; run after the migration)
--
-- Expect exactly one row: active, daily at 03:17, calling analytics_prune(400).
-- ---------------------------------------------------------------------------
select jobname,
       schedule,
       command,
       active,
       case when active and schedule = '17 3 * * *' then 'PASS' else 'FAIL' end as verdict
from   cron.job
where  jobname = 'analytics-retention';

-- What it will delete on its next run, without deleting anything now. Expect
-- zeros until the tracker has been live for longer than the retention window.
select (select count(*) from public.analytics_events
        where occurred_at < now() - interval '400 days')   as events_past_retention,
       (select count(*) from public.analytics_sessions
        where last_event_at < now() - interval '400 days') as sessions_past_retention;
