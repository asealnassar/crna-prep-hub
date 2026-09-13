-- ============================================================================
-- Resume Builder V2 -- the V1 migration ledger, and two DEFINER corrections.
--
-- WHY THERE IS A SEVENTH MIGRATION. Phase 11 built idempotency on a marker
-- carried in ResumeV2.importedFrom, and the Phase 12 audit found that field is
-- never written to the database: toSavePayload() does not emit it and
-- fromRows() hardcodes `importedFrom: null` (lib/resume/repo/rows.ts). For
-- ordinary imports that is correct -- their provenance lives in resume_imports
-- -- but the offline V1 migration cannot use that table, because
-- record_resume_import takes its owner from auth.uid() and the writer has no
-- session. So "has this V1 resume already been migrated?" had no answer that
-- survived the write.
--
-- WHY A TABLE AND NOT A COLUMN. The first draft of this migration put a
-- `migrated_from_v1` column on public.resumes. That was rejected, correctly:
-- migration 001 grants table-level UPDATE on public.resumes to `authenticated`,
-- and PostgreSQL cannot narrow a table-level grant by revoking one column. Any
-- signed-in user could therefore have written their own migration marker --
-- claiming somebody else's V1 resume id and causing the writer to skip it, or
-- rewriting their own provenance. A marker that the subject of the record can
-- edit is not a record.
--
-- This table is the opposite: `authenticated` and `anon` hold NO privilege on
-- it and RLS is enabled with NO policy, so a browser client is refused twice
-- over, by two independent controls. Only service_role -- which exists solely
-- in scripts/migrate-v1-resumes.ts and in no route -- may write it, and even
-- service_role may not DELETE a row or alter which resumes a row names.
--
-- NO FOREIGN KEYS, deliberately, and this is the load-bearing decision:
--
--   v1_resume_id  An FK to public.resumes would need an ON DELETE action.
--                 CASCADE would erase migration history when a V1 row is
--                 archived at the end of the 90-day window. RESTRICT would stop
--                 a user deleting their own V1 resume -- a change to live V1
--                 behaviour, which the cutover plan forbids. So: no FK. The V1
--                 row is never referenced, never locked and never touched.
--
--   v2_resume_id  No FK is what lets the writer CLAIM a link BEFORE the resume
--                 exists (see the ordering below), which is what makes an
--                 interrupted run resumable instead of leaving a row nobody can
--                 account for. It is also what makes deletion honest: when a
--                 user deletes a migrated resume the link survives, pointing at
--                 an id that is gone, which is exactly the historical fact.
--
-- WRITE ORDER, and why completed_at exists.
--
--   1. insert the link          <- claims this V1 resume, atomically
--   2. insert the resume parent
--   3. insert the sections
--   4. stamp completed_at       <- the migration is now a finished fact
--
-- The primary key on v1_resume_id means step 1 is the claim: a second writer,
-- or a second run, cannot get past it. Steps 2-4 are then recoverable, because
-- the link records what the id was going to be.
--
-- completed_at is what separates "interrupted" from "finished, then deleted by
-- the applicant". Without it those two states look identical -- a link whose
-- resume is missing -- and the writer would RESURRECT a resume its owner had
-- deliberately deleted. With it:
--
--   completed_at IS NULL      the run stopped partway. Re-running finishes it.
--   completed_at IS NOT NULL  the migration happened. Whatever the applicant
--                             has done to the resume since is theirs to have
--                             done, and the writer never touches it again.
--
-- service_role gets UPDATE on completed_at and on NOTHING ELSE -- a
-- column-level grant, so the writer can record that it finished but cannot
-- rewrite which V2 resume a V1 resume became.
--
-- PRE-FLIGHT (read-only). Expect zero rows -- the table should not exist.
--   select tablename from pg_tables
--   where schemaname = 'public' and tablename = 'resume_v1_migration_links';
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------

create table if not exists public.resume_v1_migration_links (
  -- One V1 resume can be migrated at most once. This is the guarantee, and it
  -- is a primary key rather than a unique index so it can never be null.
  v1_resume_id uuid primary key,

  -- The V2 resume it became. Not a foreign key; see the header.
  v2_resume_id uuid not null,

  -- Copied from the V1 source row by the writer, never from a session -- the
  -- offline writer has no session. This is who owned the resume that was
  -- migrated, recorded so the ledger can be read without joining to a row that
  -- may since have been deleted.
  user_id uuid not null,

  created_at timestamptz not null default now(),

  -- Null until the resume and all of its sections have landed.
  completed_at timestamptz
);

-- No two V1 resumes may claim the same V2 row. Without this a bug in the id
-- derivation would silently produce two links onto one resume.
create unique index if not exists resume_v1_migration_links_v2_key
  on public.resume_v1_migration_links (v2_resume_id);

-- The writer's two lookups: "what has been migrated" and "what did this user
-- get". Both start from a column the browser cannot read at all.
create index if not exists resume_v1_migration_links_user_idx
  on public.resume_v1_migration_links (user_id);

comment on table public.resume_v1_migration_links is
  'Append-only record of the one-time V1 -> V2 resume migration. Written only '
  'by the offline migration script under service_role. Invisible to browser '
  'clients: no grants to anon or authenticated, and RLS with no policy. Rows '
  'survive deletion of either the V1 or the V2 resume they name.';

comment on column public.resume_v1_migration_links.completed_at is
  'Set once the V2 resume and all its sections exist. NULL means an interrupted '
  'run that re-running will finish. NOT NULL means the migration is a closed '
  'fact -- if the V2 resume is missing now, its owner deleted it, and the '
  'writer must never recreate it.';

-- ---------------------------------------------------------------------------
-- 2. Row level security -- deny by default, with no way through
-- ---------------------------------------------------------------------------
--
-- RLS is enabled and NO policy is created. A table with RLS on and no policy
-- denies every row to every role that does not bypass RLS, which in Supabase is
-- every role except service_role. Combined with the grants below, a browser
-- client is stopped twice: it holds no privilege, and there is no policy that
-- would let it through if it somehow did.

do $guard$
begin
  if not coalesce((
    select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'resume_v1_migration_links'
  ), false) then
    execute 'alter table public.resume_v1_migration_links enable row level security';
  end if;
end $guard$;

-- ---------------------------------------------------------------------------
-- 3. Grants -- the browser gets nothing at all
-- ---------------------------------------------------------------------------
--
-- GRANT is additive and Supabase grants ALL to anon and authenticated on new
-- public tables by default, so the revoke is not decoration: without it this
-- table would be world-writable through PostgREST the moment it was created.

revoke all privileges on table public.resume_v1_migration_links
  from public, anon, authenticated, service_role;

-- The writer reads the ledger, claims a link, and stamps completion. It may not
-- DELETE, and it may not UPDATE anything except completed_at, so a run can
-- record what it did but cannot rewrite what an earlier run did.
grant select, insert          on table public.resume_v1_migration_links to service_role;
grant update (completed_at)   on table public.resume_v1_migration_links to service_role;

-- anon and authenticated are granted nothing whatsoever, deliberately. Nothing
-- in the application reads this table; it exists for the migration and for the
-- audit record afterwards.

-- ---------------------------------------------------------------------------
-- 4. record_ai_usage -- do not attach a call to a resume the caller does not own
-- ---------------------------------------------------------------------------
--
-- The original took p_resume_id straight into the insert. Two consequences,
-- both found by the Phase 12 audit:
--
--   * a caller could attribute their own ledger row to somebody else's resume,
--     which makes resume_id untrustworthy for any later analysis; and
--   * because resume_id has a foreign key to public.resumes, an id that does
--     not exist raised foreign_key_violation while an id that DID exist
--     succeeded -- so the function answered "is this uuid a real resume?" for
--     any uuid, through a SECURITY DEFINER path that RLS does not see.
--
-- The row is still written either way. Refusing to write it would let a caller
-- erase their own rate-limit history, which is the whole attack this table
-- exists to stop; only the attribution is dropped.

create or replace function public.record_ai_usage(
  p_resume_id uuid,
  p_operation text,
  p_outcome   text default 'attempted'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user      uuid := auth.uid();
  v_resume_id uuid;
  v_id        uuid;
begin
  if v_user is null then
    return null;
  end if;

  -- Null unless the caller owns it. Same answer for "not yours" and "does not
  -- exist", so nothing is learned from the difference.
  select r.id into v_resume_id
    from public.resumes r
   where r.id = p_resume_id
     and r.user_id = v_user;

  insert into public.resume_ai_usage (user_id, resume_id, operation, outcome)
  values (
    v_user,
    v_resume_id,
    left(coalesce(p_operation, 'unknown'), 64),
    case when p_outcome in ('attempted', 'proposed', 'rejected', 'failed')
         then p_outcome else 'attempted' end
  )
  returning id into v_id;

  return v_id;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. settle_resume_import -- the same correction, the same reasoning
-- ---------------------------------------------------------------------------

create or replace function public.settle_resume_import(
  p_id              uuid,
  p_outcome         text,
  p_resume_id       uuid default null,
  p_refusal_code    text default null,
  p_mapped_count    integer default null,
  p_uncertain_count integer default null,
  p_unmapped_count  integer default null,
  p_rejected_count  integer default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user      uuid := auth.uid();
  v_resume_id uuid;
begin
  if v_user is null or p_id is null then
    return false;
  end if;

  select r.id into v_resume_id
    from public.resumes r
   where r.id = p_resume_id
     and r.user_id = v_user;

  update public.resume_imports
     set outcome         = case when p_outcome in ('created', 'refused', 'failed')
                                then p_outcome else outcome end,
         resume_id       = coalesce(v_resume_id, resume_id),
         refusal_code    = coalesce(left(p_refusal_code, 64), refusal_code),
         mapped_count    = coalesce(p_mapped_count, mapped_count),
         uncertain_count = coalesce(p_uncertain_count, uncertain_count),
         unmapped_count  = coalesce(p_unmapped_count, unmapped_count),
         rejected_count  = coalesce(p_rejected_count, rejected_count)
   where id = p_id
     and user_id = v_user;

  return found;
end $fn$;

-- GRANT is additive and these are CREATE OR REPLACE, so the existing grants
-- survive. Restated anyway: a replaced function keeping its grants is a
-- property of the catalog, not something this file should rely on silently.
revoke all on function public.record_ai_usage(uuid, text, text) from public;
revoke all on function public.record_ai_usage(uuid, text, text) from anon;
grant execute on function public.record_ai_usage(uuid, text, text) to authenticated;

revoke all on function public.settle_resume_import(uuid, text, uuid, text, integer, integer, integer, integer) from public;
revoke all on function public.settle_resume_import(uuid, text, uuid, text, integer, integer, integer, integer) from anon;
grant execute on function public.settle_resume_import(uuid, text, uuid, text, integer, integer, integer, integer) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect five columns, and v1_resume_id as the primary key.
select column_name, data_type, is_nullable
from   information_schema.columns
where  table_schema = 'public' and table_name = 'resume_v1_migration_links'
order  by ordinal_position;

select conname, contype
from   pg_constraint
where  conrelid = 'public.resume_v1_migration_links'::regclass
order  by conname;

-- Expect RLS enabled and ZERO policies.
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'resume_v1_migration_links') as policies
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relname = 'resume_v1_migration_links';

-- Expect service_role only: SELECT, INSERT, and UPDATE on completed_at alone.
-- Expect NO rows for anon or authenticated, and no DELETE for anybody.
select grantee, privilege_type
from   information_schema.role_table_grants
where  table_schema = 'public' and table_name = 'resume_v1_migration_links'
order  by grantee, privilege_type;

select grantee, column_name, privilege_type
from   information_schema.column_privileges
where  table_schema = 'public' and table_name = 'resume_v1_migration_links'
order  by grantee, column_name;

-- Expect prosecdef = true and proconfig {search_path=} for both.
select p.proname, p.prosecdef as security_definer, p.proconfig
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public'
  and  p.proname in ('record_ai_usage', 'settle_resume_import')
order  by p.proname;

-- Expect authenticated / EXECUTE only. No anon, no PUBLIC.
select routine_name, grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public'
  and  routine_name in ('record_ai_usage', 'settle_resume_import')
order  by routine_name, grantee;

-- Expect zero. This migration creates no links; the writer does.
select count(*) as links from public.resume_v1_migration_links;

-- Expect the resume counts to be UNCHANGED. This migration writes no data.
select (select count(*) from public.resumes)         as resumes,
       (select count(*) from public.resume_sections) as sections;
