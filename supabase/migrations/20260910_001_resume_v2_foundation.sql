-- ============================================================================
-- Resume Builder V2 -- foundation. Additive columns and grant hardening.
--
-- Runs after 20260910_000, which captured the existing schema. Nothing here
-- drops a column, rewrites a value, or changes what V1 reads: every column
-- added is nullable or defaulted so that V1's queries, which name their
-- columns explicitly, are unaffected.
--
-- V1 AND V2 COEXIST, separated by schema_version. Existing rows default to 1
-- and V2 ignores them until the Phase 11 migration converts them. V1 never
-- reads the new columns. Both builders keep working on the same tables for
-- the length of the rebuild.
--
-- WHY NO NEW TABLES. The blueprint sketched three -- section history, imports
-- and an AI usage ledger -- and this migration deliberately creates none of
-- them:
--
--   * section history is already carried inside section_data. Phase 1's
--     AuthoredText holds a bounded per-field history, which IS the lightweight
--     history the product asked for. A second, coarser mechanism in its own
--     table would be exactly the two-sources-of-truth problem that order_index
--     already demonstrates in V1.
--   * the imports table depends on whether original files are retained, which
--     is undecided. Creating it now would encode an answer.
--   * the AI usage ledger depends on per-tier quotas, also undecided.
--
-- Each belongs to the phase that needs it, once the rule it encodes exists.
--
-- WHY NO SECTION-ORDER COLUMN. order_index already exists. V1 writes it and
-- never reads it; V2 reads and writes it, and the domain model derives its
-- section array from it. One representation, no desync.
--
-- UPDATED_AT. There are no triggers on these tables, so updated_at has always
-- meant "created". No trigger is added here on purpose: one would fire for V1
-- writes too, and the V1 dashboard orders by resumes.updated_at, so edited
-- resumes would start sorting differently. That is a V1 behaviour change this
-- phase has no mandate for. V2 sets updated_at explicitly on every write from
-- lib/resume/repo, which is enforced by tests. If the trigger is wanted later
-- it is a small, separate migration.
--
-- PRE-FLIGHT (read-only). Expect zero rows -- none of these columns exist yet.
--   select table_name, column_name from information_schema.columns
--   where table_schema='public'
--     and (table_name='resumes' and column_name in
--            ('schema_version','status','revision','strength_score',
--             'strength_computed_at','strength_revision')
--       or table_name='resume_sections' and column_name in ('visible','label'));
-- ============================================================================
begin;

-- ============================================================
-- 1. resumes -- V2 columns
-- ============================================================

-- Which builder owns this row. 1 = V1, untouched by V2. Existing rows take
-- the default, so no backfill is needed and none is performed.
alter table public.resumes
  add column if not exists schema_version integer not null default 1;

alter table public.resumes
  drop constraint if exists resumes_schema_version_check;
alter table public.resumes
  add constraint resumes_schema_version_check check (schema_version in (1, 2));

-- Draft vs complete. What EARNS 'complete' is an undecided product rule, so
-- the column carries the value and asserts nothing about when it is legitimate.
alter table public.resumes
  add column if not exists status text not null default 'draft';

alter table public.resumes
  drop constraint if exists resumes_status_check;
alter table public.resumes
  add constraint resumes_status_check check (status in ('draft', 'complete'));

-- Optimistic concurrency. A write must name the revision it read, so a stale
-- tab cannot silently overwrite a newer save from another device -- the same
-- guard gpa_drafts uses. V1 never reads or writes this.
alter table public.resumes
  add column if not exists revision bigint not null default 1;

alter table public.resumes
  drop constraint if exists resumes_revision_positive;
alter table public.resumes
  add constraint resumes_revision_positive check (revision >= 1);

-- Resume Strength. Separate from V1's overall_score, which keeps its own
-- meaning (and its value of 0 on every existing row). Nullable throughout:
-- no score is a real state, distinct from a score of zero.
alter table public.resumes
  add column if not exists strength_score integer;
alter table public.resumes
  add column if not exists strength_computed_at timestamptz;
-- The revision the score was computed against, so staleness is visible
-- without recomputing.
alter table public.resumes
  add column if not exists strength_revision bigint;

alter table public.resumes
  drop constraint if exists resumes_strength_score_range;
alter table public.resumes
  add constraint resumes_strength_score_range
  check (strength_score is null or (strength_score between 0 and 100));

-- V2 reads are always filtered by schema_version; this keeps that cheap once
-- both generations share the table.
create index if not exists idx_resumes_user_schema
  on public.resumes (user_id, schema_version);

-- ============================================================
-- 2. resume_sections -- V2 columns
-- ============================================================

-- Hidden sections keep their data and do not render. Defaulting to true means
-- every existing V1 section stays visible, which is what it is today.
alter table public.resume_sections
  add column if not exists visible boolean not null default true;

-- Overrides the default heading. NULL means "use the default for this type",
-- which is a real state and not the same as an empty string.
alter table public.resume_sections
  add column if not exists label text;

-- V2 orders sections by order_index within a resume, and reads them together.
create index if not exists idx_resume_sections_resume_order
  on public.resume_sections (resume_id, order_index);

-- ============================================================
-- 3. GRANT HARDENING -- existing tables
-- ============================================================
--
-- Today anon and authenticated hold ALL privileges on all three tables:
-- DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE. That is
-- Supabase's default GRANT, never revoked, because these tables never went
-- through a migration. Two migrations in this repository already correct the
-- same default elsewhere; 20260830_003 names the mechanism: GRANT is additive,
-- so granting the wanted privileges leaves the unwanted ones in place. They
-- must be revoked first.
--
-- The specific exposure being closed: RLS filters SELECT, INSERT, UPDATE and
-- DELETE, so the REST surface is safe today -- but RLS DOES NOT APPLY TO
-- TRUNCATE, and anon holds it. PostgREST exposes no TRUNCATE verb, so this is
-- a missing layer rather than an open door. Closing it means RLS stops being
-- the only thing between the anon key and every resume in the system.
--
-- What is preserved: exactly the privileges V1 and V2 actually use, so no
-- existing behaviour changes.
--   authenticated -- SELECT/INSERT/UPDATE/DELETE. The browser client runs as
--                    this role for every page of both builders.
--   anon          -- NOTHING. Every resume page redirects to /login before it
--                    queries, so an anonymous session has no legitimate call.
--   service_role  -- SELECT/INSERT/UPDATE/DELETE, minus TRUNCATE/REFERENCES/
--                    TRIGGER. Nothing server-side uses these tables today; the
--                    one route that did was retired in 123981b.

revoke all privileges on table public.resumes         from anon, authenticated, service_role;
revoke all privileges on table public.resume_sections from anon, authenticated, service_role;
revoke all privileges on table public.resume_scores   from anon, authenticated, service_role;

grant select, insert, update, delete on table public.resumes         to authenticated;
grant select, insert, update, delete on table public.resume_sections to authenticated;
grant select, insert, update, delete on table public.resume_scores   to authenticated;

grant select, insert, update, delete on table public.resumes         to service_role;
grant select, insert, update, delete on table public.resume_sections to service_role;
grant select, insert, update, delete on table public.resume_scores   to service_role;

-- anon is granted nothing at all, deliberately.

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect 8 rows: the six new columns on resumes, the two on resume_sections.
select table_name, column_name, data_type, is_nullable, column_default
from   information_schema.columns
where  table_schema = 'public'
  and ((table_name = 'resumes' and column_name in
          ('schema_version','status','revision','strength_score',
           'strength_computed_at','strength_revision'))
    or (table_name = 'resume_sections' and column_name in ('visible','label')))
order  by table_name, column_name;

-- Expect every existing row to be V1, draft, revision 1, visible, unscored.
select count(*)                                          as resumes,
       count(*) filter (where schema_version = 1)        as v1,
       count(*) filter (where schema_version = 2)        as v2,
       count(*) filter (where status = 'draft')          as drafts,
       count(*) filter (where revision = 1)              as rev1,
       count(*) filter (where strength_score is null)    as unscored
from   public.resumes;

select count(*)                                 as sections,
       count(*) filter (where visible)          as visible,
       count(*) filter (where label is null)    as no_label
from   public.resume_sections;

-- Expect: anon absent entirely; authenticated and service_role holding
-- exactly DELETE, INSERT, SELECT, UPDATE. No TRUNCATE, REFERENCES or TRIGGER.
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from   information_schema.role_table_grants
where  table_schema = 'public'
  and  table_name in ('resumes','resume_sections','resume_scores')
  and  grantee in ('anon','authenticated','service_role')
group  by table_name, grantee
order  by table_name, grantee;

-- Expect the row counts to be UNCHANGED. This migration writes no data.
select (select count(*) from public.resumes)         as resumes,
       (select count(*) from public.resume_sections) as sections,
       (select count(*) from public.resume_scores)   as scores;
