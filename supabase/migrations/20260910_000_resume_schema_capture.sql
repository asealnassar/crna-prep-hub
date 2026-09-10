-- ============================================================================
-- Resume Builder: capture the existing schema into version control.
--
-- resumes, resume_sections and resume_scores were created outside the
-- migration system, so until now their columns, constraints, indexes and
-- policies existed only inside the database. Every ALTER written against them
-- was written against an inferred schema, which is how a rebuild loses data.
--
-- CREATE-ONLY. Every statement is guarded, so on a database that already has
-- these objects this file touches NOTHING: no policy is dropped, no policy is
-- recreated, and RLS is not re-enabled where it is already on. On an empty
-- database it reproduces the schema exactly as captured from pg_catalog on
-- 2026-09-10.
--
-- The guards matter more than they look. An earlier draft dropped and
-- recreated each policy, which has the same NET effect but re-asserts every
-- security predicate from a transcription rather than leaving production's
-- own policies alone -- so a single mistyped predicate would silently rewrite
-- a live RLS rule while appearing to be a no-op. PostgreSQL has no
-- `CREATE POLICY IF NOT EXISTS`, so the guard is a catalog check in a DO
-- block. Verbose, and worth it.
--
-- DELIBERATELY NOT REPRODUCED: the current table privileges. Today anon and
-- authenticated hold ALL on all three tables -- Supabase's default GRANT,
-- never revoked, because these tables never went through a migration. That is
-- corrected in 20260910_001 rather than enshrined here.
--
-- Two properties of the captured schema are worth stating because V2 depends
-- on them:
--
--   1. Every foreign key cascades on delete. Removing a user removes their
--      resumes; removing a resume removes its sections and scores. V1's
--      three-statement manual delete is redundant, not load-bearing.
--
--   2. There are NO TRIGGERS. `updated_at` is set by its default at insert
--      and never maintained afterwards, so it currently means "created".
--      See 20260910_001 for how V2 handles that.
--
-- PRE-FLIGHT (read-only). On production, expect all three to already exist.
--   select tablename from pg_tables
--   where schemaname = 'public'
--     and tablename in ('resumes','resume_sections','resume_scores');
-- ============================================================================
begin;

-- ---------------------------------------------------------------- resumes
create table if not exists public.resumes (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  title         text default 'My CRNA Resume'::text,
  template_id   text default 'modern'::text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  is_published  boolean default false,
  overall_score integer default 0
);

create index if not exists idx_resumes_user_id on public.resumes (user_id);

-- RLS is already on in production; only enable it where it is not, because
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock even when it changes nothing.
do $guard$
begin
  if not coalesce((
    select c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'resumes'
  ), false) then
    execute 'alter table public.resumes enable row level security';
  end if;
end $guard$;

do $guard$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resumes' and policyname = 'Users can view own resumes'
  ) then
    execute 'create policy "Users can view own resumes" on public.resumes for select using (auth.uid() = user_id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resumes' and policyname = 'Users can create own resumes'
  ) then
    execute 'create policy "Users can create own resumes" on public.resumes for insert with check (auth.uid() = user_id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resumes' and policyname = 'Users can update own resumes'
  ) then
    execute 'create policy "Users can update own resumes" on public.resumes for update using (auth.uid() = user_id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resumes' and policyname = 'Users can delete own resumes'
  ) then
    execute 'create policy "Users can delete own resumes" on public.resumes for delete using (auth.uid() = user_id)';
  end if;
end $guard$;

-- -------------------------------------------------------- resume_sections
create table if not exists public.resume_sections (
  id           uuid primary key default uuid_generate_v4(),
  resume_id    uuid not null references public.resumes(id) on delete cascade,
  section_type text  not null,
  section_data jsonb not null,
  order_index  integer default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists idx_resume_sections_resume_id on public.resume_sections (resume_id);
create index if not exists idx_resume_sections_type      on public.resume_sections (section_type);

-- RLS is already on in production; only enable it where it is not, because
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock even when it changes nothing.
do $guard$
begin
  if not coalesce((
    select c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'resume_sections'
  ), false) then
    execute 'alter table public.resume_sections enable row level security';
  end if;
end $guard$;

do $guard$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resume_sections' and policyname = 'Users can view own resume sections'
  ) then
    execute 'create policy "Users can view own resume sections" on public.resume_sections for select using (resume_id in (select id from public.resumes where user_id = auth.uid()))';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resume_sections' and policyname = 'Users can create own resume sections'
  ) then
    execute 'create policy "Users can create own resume sections" on public.resume_sections for insert with check (resume_id in (select id from public.resumes where user_id = auth.uid()))';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resume_sections' and policyname = 'Users can update own resume sections'
  ) then
    execute 'create policy "Users can update own resume sections" on public.resume_sections for update using (resume_id in (select id from public.resumes where user_id = auth.uid()))';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resume_sections' and policyname = 'Users can delete own resume sections'
  ) then
    execute 'create policy "Users can delete own resume sections" on public.resume_sections for delete using (resume_id in (select id from public.resumes where user_id = auth.uid()))';
  end if;
end $guard$;

-- ---------------------------------------------------------- resume_scores
-- V1's scoring table. Zero rows; its only writer was an unauthenticated route
-- retired in 123981b. Captured for completeness and otherwise left alone --
-- V2 stores its own strength figures on `resumes` (see 20260910_001).
create table if not exists public.resume_scores (
  id                   uuid primary key default uuid_generate_v4(),
  resume_id            uuid not null references public.resumes(id) on delete cascade,
  overall_score        integer default 0,
  icu_experience_score integer default 0,
  certifications_score integer default 0,
  shadowing_score      integer default 0,
  leadership_score     integer default 0,
  education_score      integer default 0,
  research_score       integer default 0,
  suggestions          jsonb default '[]'::jsonb,
  red_flags            jsonb default '[]'::jsonb,
  created_at           timestamptz default now()
);

create index if not exists idx_resume_scores_resume_id on public.resume_scores (resume_id);

-- RLS is already on in production; only enable it where it is not, because
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock even when it changes nothing.
do $guard$
begin
  if not coalesce((
    select c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'resume_scores'
  ), false) then
    execute 'alter table public.resume_scores enable row level security';
  end if;
end $guard$;

-- NOTE: there is deliberately NO delete policy here, because production has
-- none. V1's browser-side delete of score rows therefore matches zero rows.
-- It has never mattered -- the table is empty and the FK cascades anyway --
-- but reproducing the gap is more honest than quietly closing it. Adding one
-- is a separate decision.
do $guard$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resume_scores' and policyname = 'Users can view own resume scores'
  ) then
    execute 'create policy "Users can view own resume scores" on public.resume_scores for select using (resume_id in (select id from public.resumes where user_id = auth.uid()))';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resume_scores' and policyname = 'Users can create own resume scores'
  ) then
    execute 'create policy "Users can create own resume scores" on public.resume_scores for insert with check (resume_id in (select id from public.resumes where user_id = auth.uid()))';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'resume_scores' and policyname = 'Users can update own resume scores'
  ) then
    execute 'create policy "Users can update own resume scores" on public.resume_scores for update using (resume_id in (select id from public.resumes where user_id = auth.uid()))';
  end if;
end $guard$;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect 3 rows, all rowsecurity = true.
select relname, relrowsecurity
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public'
  and  c.relname in ('resumes','resume_sections','resume_scores')
order  by relname;

-- Expect 11 policies: 4 + 4 + 3.
select tablename, count(*) as policies
from   pg_policies
where  schemaname = 'public'
  and  tablename in ('resumes','resume_sections','resume_scores')
group  by tablename order by tablename;

-- Expect the row counts to be UNCHANGED by this migration.
select (select count(*) from public.resumes)         as resumes,
       (select count(*) from public.resume_sections) as sections,
       (select count(*) from public.resume_scores)   as scores;

-- On an existing schema this file creates nothing, so every policy keeps the
-- OID it had before. Capture these before and after to prove it:
select tablename, policyname, oid
from   pg_policy p join pg_class c on c.oid = p.polrelid
       join pg_policies pp on pp.policyname = p.polname and pp.tablename = c.relname
where  pp.schemaname = 'public'
  and  pp.tablename in ('resumes','resume_sections','resume_scores')
order  by tablename, policyname;
