-- Personal Statement Analyzer, Phase 0 — pre-deploy preflight.
--
-- READ-ONLY. Changes nothing. Run this in the Supabase SQL editor BEFORE
-- deploying release/statement-phase-0.
--
-- WHAT IT CHECKS. Phase 0 adds rate limiting without a migration by writing
-- into public.resume_ai_usage through the same record_ai_usage() function the
-- Resume Builder uses. That only works if this database has migration
-- 20260910_004 applied and its grants intact. Everything below is a property
-- that hardening depends on.
--
-- WHAT "PASS" LOOKS LIKE is stated in each row's label.

select 'rls enabled on resume_ai_usage (want: true)' as check,
       coalesce((select c.relrowsecurity::text
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'resume_ai_usage'),
                'TABLE MISSING — Phase 0 cannot rate limit') as result
union all
select 'policies on resume_ai_usage (want: one SELECT policy)',
       coalesce((select string_agg(policyname || ' (' || cmd || ')', ', ')
                   from pg_policies
                  where schemaname = 'public' and tablename = 'resume_ai_usage'), 'none')
union all
select 'resume_id is nullable (want: yes)',
       coalesce((select case when is_nullable = 'YES' then 'yes'
                             else 'NO — statement rows cannot be written' end
                   from information_schema.columns
                  where table_schema = 'public' and table_name = 'resume_ai_usage'
                    and column_name = 'resume_id'), 'column missing')
union all
select 'check constraints naming operation (want: none)',
       coalesce((select string_agg(conname, ', ') from pg_constraint
                  where conrelid = 'public.resume_ai_usage'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) ilike '%operation%'),
                'none — free text, as required')
union all
select 'record_ai_usage (want: exists, security definer)',
       coalesce((select 'exists, security ' || case when p.prosecdef then 'definer' else 'INVOKER — wrong' end
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'record_ai_usage' limit 1),
                'MISSING — rate limiting will fail closed and the feature will 429')
union all
select 'settle_ai_usage (want: exists, security definer)',
       coalesce((select 'exists, security ' || case when p.prosecdef then 'definer' else 'INVOKER — wrong' end
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'settle_ai_usage' limit 1),
                'MISSING')
union all
select 'authenticated may EXECUTE record_ai_usage (want: true)',
       coalesce((select has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'record_ai_usage' limit 1), 'n/a')
union all
select 'authenticated may EXECUTE settle_ai_usage (want: true)',
       coalesce((select has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'settle_ai_usage' limit 1), 'n/a')
union all
select 'authenticated may SELECT the ledger (want: true)',
       has_table_privilege('authenticated', 'public.resume_ai_usage', 'SELECT')::text
union all
-- These two must be false. A client that can insert or delete its own ledger
-- rows can reset its own rate limit, which is the whole attack the table
-- exists to stop.
select 'authenticated may INSERT directly (want: false)',
       has_table_privilege('authenticated', 'public.resume_ai_usage', 'INSERT')::text
union all
select 'authenticated may DELETE directly (want: false)',
       has_table_privilege('authenticated', 'public.resume_ai_usage', 'DELETE')::text
union all
select 'authenticated may UPDATE directly (want: false)',
       has_table_privilege('authenticated', 'public.resume_ai_usage', 'UPDATE')::text
union all
select 'rows already in the statement- namespace (want: 0)',
       (select count(*)::text from public.resume_ai_usage where operation like 'statement-%');
