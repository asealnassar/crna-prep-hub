-- MESSAGING SECURITY — PREFLIGHT. READ-ONLY. Run BEFORE 20260908_000_messaging_security.sql.
--
-- The core messaging tables and functions were created outside migrations, so
-- the repository has no record of their schema, policies, grants or function
-- bodies. This file captures that contract. Nothing here writes.
--
-- IMPORTANT: section 7 is a hard gate. The migration REPLACES two functions
-- whose current bodies are not in version control. Compare the definitions
-- printed there against the migration before applying it.

-- ============================================================
-- 1. TABLES, RLS STATE
-- ============================================================
-- EXPECT: five rows. Note relrowsecurity / relforcerowsecurity for each.
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('message_threads','thread_messages','thread_participants',
                    'message_read_status','message_deletions')
order by c.relname;

-- ============================================================
-- 2. COLUMNS
-- ============================================================
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('message_threads','thread_messages','thread_participants',
                     'message_read_status','message_deletions')
order by table_name, ordinal_position;

-- ============================================================
-- 3. CONSTRAINTS AND FOREIGN KEYS
-- ============================================================
-- Of particular interest: whether user columns (created_by, sender_id,
-- user_id) carry a foreign key to auth.users. Introspection over PostgREST
-- suggests they do NOT, which is why a null sender was insertable.
select con.conrelid::regclass as table_name, con.conname, pg_get_constraintdef(con.oid) as definition
from pg_constraint con join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('message_threads','thread_messages','thread_participants',
                    'message_read_status','message_deletions')
order by table_name, con.conname;

-- ============================================================
-- 4. INDEXES
-- ============================================================
-- The new policies filter on thread_participants(user_id, thread_id) and on
-- thread_messages(thread_id). Confirm those are indexed before applying.
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('message_threads','thread_messages','thread_participants',
                    'message_read_status','message_deletions')
order by tablename, indexname;

-- ============================================================
-- 5. EVERY CURRENT RLS POLICY  -- the record of what is being replaced
-- ============================================================
-- The migration drops ALL policies on these tables by iterating the catalog,
-- because their names are not known to the repository. This output is the
-- only record of what existed. KEEP IT.
select tablename, policyname, cmd, permissive, roles::text, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('message_threads','thread_messages','thread_participants',
                    'message_read_status','message_deletions')
order by tablename, cmd, policyname;

-- ============================================================
-- 6. TABLE GRANTS
-- ============================================================
-- EXPECT: anon currently holds grants on all five (an anon SELECT returns
-- "0 rows" rather than "permission denied"). service_role grants must survive
-- the migration -- /api/messages/participants and /api/messages/notify depend
-- on them.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('message_threads','thread_messages','thread_participants',
                     'message_read_status','message_deletions')
order by table_name, grantee, privilege_type;

-- ============================================================
-- 7. FUNCTION DEFINITIONS  ***  APPLICATION GATE  ***
-- ============================================================
-- create_thread_with_message and send_tier_broadcast are REPLACED by the
-- migration. Their current bodies are not in version control and were
-- reconstructed from observed behaviour only. Read these definitions and
-- confirm the replacements reproduce every side effect before applying.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       p.proconfig::text as config,
       pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_thread_with_message','send_tier_broadcast','get_admin_user_id')
order by p.proname;

-- Any OTHER function that touches messaging data, so nothing is missed.
select p.proname, p.prosecdef as security_definer,
       pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and pg_get_functiondef(p.oid) ~* '(message_threads|thread_messages|thread_participants|message_read_status|message_deletions)'
order by p.proname;

-- ============================================================
-- 8. FUNCTION EXECUTE PRIVILEGES
-- ============================================================
-- EXPECT to see anon holding EXECUTE on send_tier_broadcast and
-- get_admin_user_id. Both are removed by the migration.
select r.routine_name, p.grantee, p.privilege_type
from information_schema.routine_privileges p
join information_schema.routines r
  on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
where p.specific_schema = 'public'
  and r.routine_name in ('create_thread_with_message','send_tier_broadcast','get_admin_user_id')
order by r.routine_name, p.grantee;

-- ============================================================
-- 9. TRIGGERS
-- ============================================================
select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
  and c.relname in ('message_threads','thread_messages','thread_participants',
                    'message_read_status','message_deletions')
order by c.relname, t.tgname;

-- ============================================================
-- 10. REALTIME PUBLICATION MEMBERSHIP
-- ============================================================
-- The browser subscribes to INSERTs on thread_messages. Realtime applies the
-- SELECT policy of the subscribing role, so the new policies should close the
-- wiretap -- but that must be verified, not assumed.
select pubname, schemaname, tablename
from pg_publication_tables
where schemaname = 'public'
  and tablename in ('message_threads','thread_messages','thread_participants',
                    'message_read_status','message_deletions')
order by pubname, tablename;

-- ============================================================
-- 11. user_profiles SELECT POLICY  -- context for the broadcast design
-- ============================================================
-- A non-admin's send_tier_broadcast currently returns 0 and creates nothing.
-- The most likely reason is that the function is SECURITY INVOKER and its
-- recipient lookup sees only the caller's own profile row. Confirm here,
-- because that -- not any check inside the function -- is what is presently
-- containing it.
select policyname, cmd, roles::text, qual
from pg_policies
where schemaname = 'public' and tablename = 'user_profiles'
order by cmd, policyname;

-- ============================================================
-- 12. BASELINE ROW COUNTS  -- must be identical after the migration
-- ============================================================
select
  (select count(*) from public.message_threads)      as threads,
  (select count(*) from public.thread_messages)      as messages,
  (select count(*) from public.thread_participants)  as participants,
  (select count(*) from public.message_read_status)  as read_status,
  (select count(*) from public.message_deletions)    as deletions;
