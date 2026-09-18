-- ============================================================================
-- 009  RESUME V2: PREMIUM IS ONE RESUME
--
-- WHAT CHANGES. Exactly one value: public.resume_v2_tier_cap('premium')
-- returns 1 instead of 3. Same signature, same immutability, same (absent)
-- grants, same triggers reading it. No table, no column, no policy and no
-- data is touched.
--
-- WHY. The locked model is Free 1 / Premium 1 / Ultimate unlimited. Free and
-- Premium get the whole builder -- every template, import, AI, Resume
-- Strength, a clean preview -- and what Ultimate sells is taking the finished
-- file away. The application already refuses a second resume on every path
-- that can make one (create, duplicate and import all call
-- decideCreateResume in lib/resume/entitlement.ts), so until this is applied
-- the database's own guard is LOOSER than the rule it exists to back. That is
-- the safe direction to be wrong in, and still the wrong direction.
--
-- NOBODY LOSES A RESUME. The cap is read when a row is created, so a Premium
-- account that already holds two or three keeps all of them; it simply cannot
-- create another until it is back under the cap or upgrades. This migration
-- writes no rows and deletes none.
--
-- 007 IS NOT MODIFIED. It is applied and stays byte-stable. Replacing the
-- function here is what CREATE OR REPLACE is for, and it keeps the whole
-- delta in one reviewable file.
--
-- PRE-FLIGHT (read-only). Expect 1 / 3 / null -- the rule this replaces.
--   select public.resume_v2_tier_cap('free')     as free,
--          public.resume_v2_tier_cap('premium')  as premium,
--          public.resume_v2_tier_cap('ultimate') as ultimate;
--
-- STAGING FIRST, and staging alone until the result below has been read.
-- ============================================================================
begin;

-- NULL means unlimited. An unrecognised tier is treated as Free, which is the
-- safe direction: a typo in a subscription record restricts rather than opens.
--
-- 'premium' is kept as its own branch rather than folded into the default. The
-- two happen to be the same number today; they are not the same RULE, and the
-- day one of them moves this should be a one-line edit rather than an
-- archaeology exercise.
create or replace function public.resume_v2_tier_cap(p_tier text)
returns integer
language sql
immutable
set search_path = ''
as $fn$
  select case lower(coalesce(p_tier, ''))
           when 'ultimate' then null
           when 'premium'  then 1
           else 1
         end;
$fn$;

-- CREATE OR REPLACE keeps whatever grants the function had, and it had none:
-- the helper is private to the trigger functions and is not exposed through
-- PostgREST. Re-asserted so a replace can never quietly widen it.
revoke all on function public.resume_v2_tier_cap(text) from public;
revoke all on function public.resume_v2_tier_cap(text) from anon;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only; run after the migration)
-- ---------------------------------------------------------------------------

-- Expect 1 / 1 / null / 1.
select public.resume_v2_tier_cap('free')     as free,
       public.resume_v2_tier_cap('premium')  as premium,
       public.resume_v2_tier_cap('ultimate') as ultimate,
       public.resume_v2_tier_cap('nonsense') as unknown_tier_is_free;

-- Expect ZERO rows: the cap helper must still be executable by nobody.
select routine_name, grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public'
  and  routine_name = 'resume_v2_tier_cap';

-- Expect the row counts to be UNCHANGED. This migration writes no data.
select (select count(*) from public.resumes)         as resumes,
       (select count(*) from public.resume_sections) as sections,
       (select count(*) from public.resumes where schema_version = 2) as v2_resumes;

-- Expect the trigger that reads the cap to be untouched and still enabled.
select tgname, tgenabled
from   pg_trigger
where  tgname in ('resumes_v2_write_boundary', 'resume_sections_v2_write_boundary')
order  by tgname;
