-- D33-D36 — multiple named GPA analyses per user.
--
-- Converts gpa_drafts from one-row-per-user to many-rows-per-user by giving it
-- a surrogate key and a user-editable name.
--
-- ALTER-IN-PLACE rather than a replacement table: every existing constraint,
-- policy, grant and trigger on gpa_drafts is already row-scoped and stays
-- correct untouched. A new table would mean recreating all of them and moving
-- data -- strictly more failure surface for no benefit.
--
-- PRESERVES ALL EXISTING ROWS. Production holds exactly 1 draft for 1 user
-- (confirmed by the account owner). It becomes that user's first analysis,
-- named 'My Analysis', with its courses, policies, engine_version, revision
-- and timestamps untouched. No course JSON is rewritten.
--
-- TOUCHES gpa_calculations: NOT AT ALL. Those 21 rows (20 pre-V2 + 1 legitimate
-- V2 snapshot) are outside this migration entirely.

begin;

-- ============================================================
-- 1. SURROGATE KEY + NAME (D33/D36)
-- ============================================================
-- Added WITH defaults so the existing row is populated in place. Postgres 11+
-- fills these without rewriting the table, and nothing re-serialises `courses`.
alter table public.gpa_drafts
  add column if not exists id   uuid not null default gen_random_uuid();

alter table public.gpa_drafts
  add column if not exists name text not null default 'My Analysis';

alter table public.gpa_drafts drop constraint if exists gpa_drafts_name_len;
alter table public.gpa_drafts
  add constraint gpa_drafts_name_len
  check (length(btrim(name)) between 1 and 120);

-- ============================================================
-- 2. SWAP THE PRIMARY KEY (D33)
-- ============================================================
-- The single change that lifts "one analysis per user". user_id keeps its FK
-- to auth.users and its ON DELETE CASCADE; it simply stops being unique.
alter table public.gpa_drafts drop constraint if exists gpa_drafts_pkey;
alter table public.gpa_drafts add  constraint gpa_drafts_pkey primary key (id);

-- user_id was indexed for free while it was the PK. It no longer is, and every
-- query filters on it.
create index if not exists gpa_drafts_user_id_idx on public.gpa_drafts (user_id);

-- Switcher ordering: most recently updated first.
create index if not exists gpa_drafts_user_updated_idx
  on public.gpa_drafts (user_id, updated_at desc);

-- ============================================================
-- 3. D34 — PER-USER NAME UNIQUENESS, CASE- AND WHITESPACE-INSENSITIVE
-- ============================================================
-- A unique INDEX (not a constraint) because the uniqueness is over an
-- expression. Names are unique per user, never globally: two different users
-- may both own "Rutgers".
create unique index if not exists gpa_drafts_user_name_uniq
  on public.gpa_drafts (user_id, lower(btrim(name)));

-- ============================================================
-- 4. D35 — 50 ANALYSES PER USER, SAFE UNDER CONCURRENCY
-- ============================================================
-- A plain "count then insert" trigger races: two concurrent transactions each
-- count 49 and both insert, yielding 51. Postgres cannot express this as a
-- CHECK (it cannot see sibling rows), and a unique index cannot express "at
-- most N".
--
-- Fix: take a TRANSACTION-scoped advisory lock keyed on the user before
-- counting. Concurrent inserts for the SAME user serialise on that lock and
-- are released at commit, so the second transaction's count observes the
-- first's committed row. Different users hash to different keys and never
-- block each other.
create or replace function public.gpa_drafts_limit_per_user()
returns trigger
language plpgsql
security invoker                       -- runs as the caller; grants nothing extra
set search_path = pg_catalog, public   -- pinned: no shadowing of unqualified names
as $$
declare n integer;
begin
  -- Serialise concurrent creations for this user only.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  select count(*) into n from public.gpa_drafts where user_id = new.user_id;
  if n >= 50 then
    raise exception 'A user may hold at most 50 GPA analyses (currently %).', n
      using errcode = '23514';         -- check_violation
  end if;
  return new;
end $$;

drop trigger if exists gpa_drafts_limit on public.gpa_drafts;
create trigger gpa_drafts_limit before insert on public.gpa_drafts
  for each row execute function public.gpa_drafts_limit_per_user();

-- ============================================================
-- 5. FUNCTION PRIVILEGES
-- ============================================================
-- Supabase's default privileges grant EXECUTE on new public functions to anon,
-- authenticated AND service_role -- revoking from PUBLIC alone leaves all three
-- in place. Revoke each role explicitly, for the new function and for the
-- existing GPA trigger functions, so this migration cannot silently broaden
-- them and a fresh environment reproduces the hardened state.
revoke all on function public.gpa_drafts_limit_per_user()    from public, anon, authenticated, service_role;
revoke all on function public.gpa_touch_updated_at()         from public, anon, authenticated, service_role;
revoke all on function public.gpa_drafts_enforce_revision()  from public, anon, authenticated, service_role;
-- Trigger permission is checked at CREATE TRIGGER time, not per firing, so the
-- triggers keep working with no EXECUTE granted to any application role.

commit;

-- ============================================================
-- UNCHANGED AND STILL CORRECT (verified in rehearsal, not assumed)
--   * RLS policies         -- all four filter on user_id, which is untouched
--   * grants               -- authenticated only; anon/service_role/PUBLIC none
--   * D18 revision trigger -- BEFORE UPDATE FOR EACH ROW: already per-row, so
--                             it becomes per-analysis with no edit
--   * D20 500-course CHECK -- row-level, therefore per-analysis, not global
--   * 1 MB payload CHECK   -- row-level
--   * policies shape CHECK -- row-level
--   * engine_version = 2   -- row-level
--   * updated_at trigger   -- row-level
--   * gpa_calculations     -- not referenced anywhere in this migration
-- ============================================================

-- VERIFICATION (read-only, run after applying)
-- select count(*) as analyses, count(distinct user_id) as users,
--        count(*) filter (where name = 'My Analysis') as migrated_default,
--        count(*) filter (where id is null) as missing_id
-- from public.gpa_drafts;
-- EXPECT: analyses = 1, users = 1, migrated_default = 1, missing_id = 0
