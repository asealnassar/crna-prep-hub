-- Resume V2: import ledger.
--
-- METADATA ONLY. The locked decision is that uploaded originals are NOT
-- retained: the bytes are read, turned into text, and dropped. So this table
-- holds no file, no extracted resume text, and no prompt -- only the fact that
-- an import happened, to whom, in what format, and how it ended.
--
-- WHY A FINGERPRINT AND NOT THE TEXT. A SHA-256 of the extracted text is enough
-- to recognise the same document on a retry and skip a second AI organisation,
-- and it cannot be read back into a name, an employer or a phone number. The
-- transcript flow already keeps exactly this and says so in the same words.
--
-- SCOPED TO THE OWNER. There is no policy by which one user can see another's
-- import activity, and no unique constraint across users -- a shared public
-- resume template uploaded by two people must not tell either of them about
-- the other. Deduplication is per user, by construction.
--
-- NOT APPLIED BY THIS PROJECT'S TOOLING. Written to be reviewed and run by
-- hand, like every other migration in this rebuild.

begin;

create table if not exists public.resume_imports (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  -- Null until the draft exists, and null again if the resume is later deleted.
  -- The import still happened, and the record of it is what bounds abuse.
  resume_id           uuid references public.resumes(id) on delete set null,
  source_format       text not null,
  -- SHA-256 of the extracted text. Not the text.
  document_fingerprint text not null,
  outcome             text not null default 'attempted',
  -- A short machine code such as 'image-only-pdf'. Never a message containing
  -- anything from the document.
  refusal_code        text,
  -- Counts, for support and for showing the applicant what happened. Counts
  -- cannot reconstruct content.
  mapped_count        integer,
  uncertain_count     integer,
  unmapped_count      integer,
  rejected_count      integer,
  created_at          timestamptz not null default now()
);

alter table public.resume_imports
  drop constraint if exists resume_imports_format_check;
alter table public.resume_imports
  add constraint resume_imports_format_check
  check (source_format in ('pdf', 'docx', 'paste'));

alter table public.resume_imports
  drop constraint if exists resume_imports_outcome_check;
alter table public.resume_imports
  add constraint resume_imports_outcome_check
  check (outcome in ('attempted', 'created', 'refused', 'failed'));

-- The only two queries: this user's recent imports, and this user's prior
-- import of this exact document. Both start with user_id, which is also what
-- stops the index being useful for anything cross-user.
create index if not exists resume_imports_user_time_idx
  on public.resume_imports (user_id, created_at desc);
create index if not exists resume_imports_user_fingerprint_idx
  on public.resume_imports (user_id, document_fingerprint);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

do $guard$
begin
  if not coalesce((
    select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'resume_imports'
  ), false) then
    execute 'alter table public.resume_imports enable row level security';
  end if;
end $guard$;

-- SELECT own only. No insert, update or delete policy: writes go through the
-- functions below. A client that could delete its own rows could erase the
-- record of what it had uploaded.
do $guard$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'resume_imports'
       and policyname = 'Users can view own imports'
  ) then
    execute 'create policy "Users can view own imports" on public.resume_imports
             for select using (auth.uid() = user_id)';
  end if;
end $guard$;

-- ---------------------------------------------------------------------------
-- Recording
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER because the table grants INSERT to nobody. Ownership is not
-- a parameter: the row is written for auth.uid(), so a caller can neither
-- record an import against another user nor avoid recording one against
-- themselves.
create or replace function public.record_resume_import(
  p_source_format text,
  p_fingerprint   text,
  p_outcome       text default 'attempted',
  p_refusal_code  text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
begin
  if v_user is null then
    return null;
  end if;

  insert into public.resume_imports (user_id, source_format, document_fingerprint, outcome, refusal_code)
  values (
    v_user,
    case when p_source_format in ('pdf', 'docx', 'paste') then p_source_format else 'paste' end,
    left(coalesce(p_fingerprint, ''), 128),
    case when p_outcome in ('attempted', 'created', 'refused', 'failed') then p_outcome else 'attempted' end,
    left(p_refusal_code, 64)
  )
  returning id into v_id;

  return v_id;
end $fn$;

-- Settles an attempt once its fate is known, and attaches the draft it made.
-- Only the caller's own row; the fingerprint and timestamp cannot move.
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
  v_user uuid := auth.uid();
begin
  if v_user is null or p_id is null then
    return false;
  end if;

  update public.resume_imports
     set outcome         = case when p_outcome in ('created', 'refused', 'failed')
                                then p_outcome else outcome end,
         resume_id       = coalesce(p_resume_id, resume_id),
         refusal_code    = coalesce(left(p_refusal_code, 64), refusal_code),
         mapped_count    = coalesce(p_mapped_count, mapped_count),
         uncertain_count = coalesce(p_uncertain_count, uncertain_count),
         unmapped_count  = coalesce(p_unmapped_count, unmapped_count),
         rejected_count  = coalesce(p_rejected_count, rejected_count)
   where id = p_id
     and user_id = v_user;

  return found;
end $fn$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all privileges on table public.resume_imports from anon, authenticated, service_role;
grant select on table public.resume_imports to authenticated;
grant select, insert, update, delete on table public.resume_imports to service_role;

revoke all on function public.record_resume_import(text, text, text, text) from public;
revoke all on function public.record_resume_import(text, text, text, text) from anon;
grant execute on function public.record_resume_import(text, text, text, text) to authenticated;

revoke all on function public.settle_resume_import(uuid, text, uuid, text, integer, integer, integer, integer) from public;
revoke all on function public.settle_resume_import(uuid, text, uuid, text, integer, integer, integer, integer) from anon;
grant execute on function public.settle_resume_import(uuid, text, uuid, text, integer, integer, integer, integer) to authenticated;

commit;

-- Verification, read-only. Run after applying.
--   select relrowsecurity from pg_class where relname = 'resume_imports';
--   select policyname, cmd from pg_policies where tablename = 'resume_imports';
--   select column_name from information_schema.columns
--    where table_name = 'resume_imports';   -- no bytes, no text, no prompt
