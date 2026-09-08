-- GPA Analyzer V2 — Phase 1 foundation.
--
-- ADDITIVE ONLY. This migration:
--   * creates two new tables (gpa_institutions, gpa_drafts)
--   * adds four NULLABLE columns to gpa_calculations
--
-- It does NOT touch, rewrite, backfill or delete any existing row.
-- The 20 existing gpa_calculations rows keep engine_version = NULL, which the
-- application reads as "V1" -- they are never presented as V2 output.
--
-- Deliberately NO DEFAULT on gpa_calculations.engine_version: in Postgres 11+
-- an added column WITH a default reads back as that default for pre-existing
-- rows, which would falsely label historical rows as V2.

begin;

-- ============================================================
-- 1. INSTITUTIONS (normalized -- see report for rationale)
-- ============================================================
create table if not exists public.gpa_institutions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 200),
  -- D5: quarter coursework is flagged and excluded, never converted.
  credit_system text not null default 'unknown'
                check (credit_system in ('semester', 'quarter', 'unknown')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists gpa_institutions_user_id_idx
  on public.gpa_institutions (user_id);

-- One institution name per user; prevents duplicate schools accumulating.
create unique index if not exists gpa_institutions_user_name_uniq
  on public.gpa_institutions (user_id, lower(btrim(name)));

-- ============================================================
-- 2. ACTIVE DRAFT -- exactly one per user
-- ============================================================
-- user_id is the PRIMARY KEY, so "duplicate drafts" are impossible by
-- construction rather than by application discipline.
create table if not exists public.gpa_drafts (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  courses        jsonb not null default '[]'::jsonb,
  -- D11: NO transfer default. `transfer` stays absent/null until the user
  -- explicitly chooses, so a default can never be mistaken for a rule.
  -- D11 + D21: neither policy has a default. Both keys exist, both are JSON
  -- null, so "unchosen" is a real stored state rather than an absent key.
  policies       jsonb not null default '{"transfer":null,"retake":null}'::jsonb,
  engine_version integer not null default 2,
  -- Optimistic concurrency: a write must name the revision it read, so a stale
  -- tab cannot silently overwrite a newer save from another device.
  revision       bigint not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Bound the payload so a runaway client cannot store unbounded JSON.
-- The active draft is always V2. A modified client must not be able to store
-- -1, 0, 1, 3 or 999 here. No other version has ever written this table.
alter table public.gpa_drafts
  drop constraint if exists gpa_drafts_engine_version;
alter table public.gpa_drafts
  add constraint gpa_drafts_engine_version check (engine_version = 2);

alter table public.gpa_drafts
  drop constraint if exists gpa_drafts_courses_is_array;
alter table public.gpa_drafts
  add constraint gpa_drafts_courses_is_array
  check (jsonb_typeof(courses) = 'array' and jsonb_array_length(courses) <= 500);

-- The array-length check bounds the COUNT of courses but not their SIZE: 500
-- entries each holding megabytes would pass it. Bound the stored bytes too.
-- 1 MB is ~40x a realistic 200-course draft.
alter table public.gpa_drafts
  drop constraint if exists gpa_drafts_courses_size;
alter table public.gpa_drafts
  add constraint gpa_drafts_courses_size
  check (pg_column_size(courses) <= 1048576);

-- Policies must be an object, and `transfer` may only ever be one of three
-- values. Prevents an arbitrary string becoming a silently-honoured policy.
alter table public.gpa_drafts
  drop constraint if exists gpa_drafts_policies_shape;
alter table public.gpa_drafts
  add constraint gpa_drafts_policies_shape check (
    jsonb_typeof(policies) = 'object'
    -- `policies -> 'key'` is SQL NULL when the key is ABSENT, but 'null'::jsonb
    -- when the key is present and set to JSON null. A CHECK passes on NULL, so
    -- key presence must be asserted explicitly or a missing key slips through.
    and (policies -> 'transfer') is not null
    and (jsonb_typeof(policies -> 'transfer') = 'null'
         or policies ->> 'transfer' in ('include', 'exclude'))
    -- D21: retake gets the identical treatment. It may be JSON null (unchosen)
    -- but the key itself must exist.
    and (policies -> 'retake') is not null
    and (jsonb_typeof(policies -> 'retake') = 'null'
         or policies ->> 'retake' in ('both', 'latest'))
  );

-- ============================================================
-- 3. gpa_calculations -- additive columns only
-- ============================================================
alter table public.gpa_calculations
  add column if not exists engine_version integer,          -- NULL = V1, no default
  add column if not exists policies       jsonb,            -- policy snapshot
  add column if not exists graduate_gpa   numeric,          -- new GPA type
  add column if not exists institutions   jsonb;            -- institution snapshot

comment on column public.gpa_calculations.engine_version is
  'NULL = produced by the V1 engine and NOT recalculated. 2 = GPA Engine V2.';

-- Historical rows are NULL and must stay valid. The application only ever
-- writes 2; it reads NULL as "V1" and never writes a literal 1, so 1 is not
-- an accepted value -- there is no reason to invent a version number that
-- nothing produces. Existing rows are all NULL, so this validates immediately
-- without touching a single row.
alter table public.gpa_calculations
  drop constraint if exists gpa_calculations_engine_version;
alter table public.gpa_calculations
  add constraint gpa_calculations_engine_version
  check (engine_version is null or engine_version = 2);

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================
alter table public.gpa_institutions enable row level security;
alter table public.gpa_drafts       enable row level security;

drop policy if exists "own institutions select" on public.gpa_institutions;
drop policy if exists "own institutions insert" on public.gpa_institutions;
drop policy if exists "own institutions update" on public.gpa_institutions;
drop policy if exists "own institutions delete" on public.gpa_institutions;

create policy "own institutions select" on public.gpa_institutions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own institutions insert" on public.gpa_institutions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own institutions update" on public.gpa_institutions
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own institutions delete" on public.gpa_institutions
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "own draft select" on public.gpa_drafts;
drop policy if exists "own draft insert" on public.gpa_drafts;
drop policy if exists "own draft update" on public.gpa_drafts;
drop policy if exists "own draft delete" on public.gpa_drafts;

create policy "own draft select" on public.gpa_drafts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own draft insert" on public.gpa_drafts
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own draft update" on public.gpa_drafts
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own draft delete" on public.gpa_drafts
  for delete to authenticated using (user_id = (select auth.uid()));

-- ============================================================
-- 5. GRANTS -- revoke first, because GRANT is additive
-- ============================================================
-- PUBLIC is a real grantee in PostgreSQL and is easy to forget: a privilege
-- held by PUBLIC is held by every role, including anon. Revoke it explicitly
-- rather than trusting defaults.
revoke all on public.gpa_institutions from public;
revoke all on public.gpa_drafts       from public;
revoke all on public.gpa_institutions from anon, authenticated, service_role;
revoke all on public.gpa_drafts       from anon, authenticated, service_role;

-- D22: the ONLY grantee is `authenticated`, and every statement it issues is
-- still filtered by the RLS policies above. anon, service_role and PUBLIC get
-- nothing -- no application code path uses service_role on these tables.
grant select, insert, update, delete on public.gpa_institutions to authenticated;
grant select, insert, update, delete on public.gpa_drafts       to authenticated;

-- ============================================================
-- 6. updated_at maintenance
-- ============================================================
-- SECURITY INVOKER (the default, stated explicitly): the function runs with
-- the privileges of the caller, so it grants nothing a user does not already
-- have. No SECURITY DEFINER is needed anywhere here -- neither function reads
-- or writes any table.
-- search_path is pinned so a caller cannot shadow an unqualified name with an
-- object in a schema they control.
create or replace function public.gpa_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists gpa_institutions_touch on public.gpa_institutions;
create trigger gpa_institutions_touch before update on public.gpa_institutions
  for each row execute function public.gpa_touch_updated_at();

drop trigger if exists gpa_drafts_touch on public.gpa_drafts;
create trigger gpa_drafts_touch before update on public.gpa_drafts
  for each row execute function public.gpa_touch_updated_at();

-- ============================================================
-- 7. D18 -- DATABASE-ENFORCED REVISION INVARIANT
-- ============================================================
-- Optimistic concurrency must not depend on a well-behaved client. The
-- application's own guard is the WHERE clause:
--
--     UPDATE gpa_drafts SET ..., revision = 6
--      WHERE user_id = auth.uid() AND revision = 5
--
-- A stale writer matches zero rows and never reaches this trigger. The trigger
-- exists for the case the WHERE clause cannot cover: a modified client that
-- targets the correct row but supplies a bogus revision. It rejects any update
-- that does not advance revision by exactly one, which forbids decrementing,
-- skipping, and leaving it unchanged.
create or replace function public.gpa_drafts_enforce_revision()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.revision is distinct from old.revision + 1 then
    raise exception
      'gpa_drafts.revision must advance by exactly 1 (from % to %); got %',
      old.revision, old.revision + 1, new.revision
      using errcode = '23514';   -- check_violation
  end if;
  return new;
end $$;

drop trigger if exists gpa_drafts_revision_guard on public.gpa_drafts;
-- Fires BEFORE UPDATE. Named so it sorts before gpa_drafts_touch, though the
-- two triggers touch disjoint columns and are order-independent in practice.
create trigger gpa_drafts_revision_guard before update on public.gpa_drafts
  for each row execute function public.gpa_drafts_enforce_revision();

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Trigger
-- permission is checked at CREATE TRIGGER time, not per-firing, so revoking
-- EXECUTE does not affect the triggers -- it only removes the direct-call path.
revoke all on function public.gpa_touch_updated_at()        from public;
revoke all on function public.gpa_drafts_enforce_revision() from public;

commit;

-- ============================================================
-- VERIFICATION (run separately, read-only)
-- ============================================================
-- 1. Historical rows are intact and NOT relabelled as V2.
-- select count(*) as existing_rows,
--        count(engine_version) as rows_marked_v2
-- from public.gpa_calculations;
-- EXPECT: existing_rows = 20, rows_marked_v2 = 0
--
-- 2. D18 revision invariant. Run as a real user (RLS applies), not service_role.
--    Each statement below MUST fail with SQLSTATE 23514 except the last.
-- update gpa_drafts set revision = revision      where user_id = auth.uid();  -- unchanged -> reject
-- update gpa_drafts set revision = revision - 1  where user_id = auth.uid();  -- decrement -> reject
-- update gpa_drafts set revision = revision + 5  where user_id = auth.uid();  -- skip      -> reject
-- update gpa_drafts set revision = revision + 1  where user_id = auth.uid();  -- valid     -> 1 row
