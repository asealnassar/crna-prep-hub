-- Delete 7 confirmed-fake test accounts.
-- Reviewed and run manually by the account owner. Not run by tooling.
--
-- Verified beforehand (read-only):
--   * none of the 7 has a stripe_customer_id -> no live subscription, no billing impact
--   * rffr@gmail.com is tier 'ultimate' with no Stripe record -> manually granted test tier
--   * ewfefef@gmail.com has 3 questions + 1 interview session -> real analytics rows
--
-- ============================================================
-- STEP 1 (READ-ONLY). Run this FIRST and read the output.
-- ============================================================
-- 1a. Confirm you are about to touch exactly these 7 rows and no others.
select id, email, created_at, last_sign_in_at
from auth.users
where email in (
  'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
  'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
)
order by created_at;
-- EXPECT: exactly 7 rows. If you see 8, STOP -- asealnassar@gmail.com (your admin
-- account) is one character away from asealnassafdvr@gmail.com.

-- 1b. Do child tables cascade, or will the delete fail on a foreign key?
select
  tc.table_name        as child_table,
  kcu.column_name      as child_column,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name
where tc.constraint_type = 'FOREIGN KEY'
  and ccu.table_schema = 'auth'
  and ccu.table_name   = 'users'
order by rc.delete_rule, tc.table_name;
-- Any child table listed as NO ACTION / RESTRICT must be cleared in Step 2
-- before the auth.users delete in Step 3 will succeed.

-- ============================================================
-- STEP 2. Clear child rows. Safe to run even where FKs cascade.
-- No temp table: every delete resolves the 7 ids inline from auth.users, so
-- there is no new object for RLS to apply to.
-- ============================================================
begin;

-- Guardrail: abort the whole transaction unless exactly the 7 intended
-- accounts match. Protects against a typo widening the email list.
do $$
declare n int;
begin
  select count(*) into n from auth.users
  where email in (
    'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
    'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
  );
  if n <> 7 then
    raise exception 'Expected 7 accounts, found %. Aborting.', n;
  end if;
end $$;

delete from resumes
  where user_id in (
    select id from auth.users where email in (
    'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
    'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
  ));

delete from user_asked_questions
  where user_id in (
    select id from auth.users where email in (
    'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
    'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
  ));

delete from interview_sessions
  where user_id in (
    select id from auth.users where email in (
    'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
    'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
  ));

delete from message_reads
  where user_id in (
    select id from auth.users where email in (
    'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
    'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
  ));

delete from thread_messages
  where sender_id in (
    select id from auth.users where email in (
    'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
    'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
  ));

delete from user_profiles
  where id in (
    select id from auth.users where email in (
    'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
    'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
  ));

-- Review the row counts above, then:
commit;   -- or: rollback;

-- ============================================================
-- STEP 3. Delete the auth users themselves. IRREVERSIBLE.
-- ============================================================
-- Preferred: Supabase Dashboard -> Authentication -> Users -> search each
-- address -> "Delete user". Seven deletions, each individually confirmed.
--
-- SQL equivalent, if you would rather do it in one shot:
--
-- delete from auth.users
-- where email in (
--   'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
--   'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
-- );
