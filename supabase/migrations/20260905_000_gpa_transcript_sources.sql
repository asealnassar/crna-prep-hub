-- D60 — ONE LIFETIME TRANSCRIPT SOURCE FOR FREE AND PREMIUM.
--
-- Creates the entitlement LEDGER for transcript analysis, plus the four
-- server-owned functions that are the only way to read or change it.
--
-- WHY A LEDGER AND NOT A COUNT OF ANALYSES:
-- The rule is "one SUCCESSFUL transcript analysis per account, ever". Deleting
-- the resulting analysis does not restore the allowance, so eligibility can
-- never be derived from what the user currently holds in gpa_drafts. It is
-- also not derivable from anything already stored: levelSource/categorySource
-- are overwritten by later passes and by user edits, snapshot copies carry the
-- same field values as their originals, and V1-era rows carry none of it. This
-- table is the only authoritative record.
--
-- WHAT IT DOES NOT TOUCH: gpa_drafts, gpa_institutions, gpa_calculations and
-- user_profiles are all read-only or untouched here. No existing row of any
-- table is modified, and no existing policy, grant, trigger or constraint is
-- altered.
--
-- BACKFILL: none. There is no historical record of who has analyzed a
-- transcript (proven: no import id, no source column, no reliable field), so
-- every existing account starts with an empty ledger and therefore with its
-- allowance intact. That is deliberate and is the account owner's decision to
-- make, not something inferred from heuristics.

begin;

-- ============================================================
-- 1. THE LEDGER
-- ============================================================
create table if not exists public.gpa_transcript_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 'pending'  -- reserved for an analysis that is running right now. Blocks a
  --               concurrent second request, and is released if that analysis
  --               fails, so a parser or upstream failure never burns the one
  --               allowance.
  -- 'consumed' -- a transcript analysis that actually succeeded. PERMANENT:
  --               nothing in the application ever deletes or downgrades it.
  status text not null default 'pending',
  -- A SHA-256 of the transcript text this source was issued for. It is a
  -- one-way fingerprint, NOT transcript content: it cannot be read back into
  -- the document, and no course, name, school or grade is stored here.
  --
  -- Its only job is to recognise the SAME document inside one import, so that
  -- the D44 second analysis pass and a retry after a failure consume one
  -- allowance between them rather than one each.
  document_hash text not null,
  -- Which tier the allowance was drawn against, for later support questions.
  -- Never read back as an entitlement: the tier is re-read at every decision.
  tier_at_issue text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

alter table public.gpa_transcript_sources
  drop constraint if exists gpa_transcript_sources_status;
alter table public.gpa_transcript_sources
  add constraint gpa_transcript_sources_status
  check (status in ('pending', 'consumed'));

-- Lowercase hex, exactly one SHA-256. A client cannot smuggle text in here,
-- and the column can never accumulate anything document-shaped.
alter table public.gpa_transcript_sources
  drop constraint if exists gpa_transcript_sources_hash_shape;
alter table public.gpa_transcript_sources
  add constraint gpa_transcript_sources_hash_shape
  check (document_hash ~ '^[0-9a-f]{64}$');

-- A consumed row must carry its timestamp; a pending row must not.
alter table public.gpa_transcript_sources
  drop constraint if exists gpa_transcript_sources_consumed_at;
alter table public.gpa_transcript_sources
  add constraint gpa_transcript_sources_consumed_at
  check ((status = 'consumed') = (consumed_at is not null));

create index if not exists gpa_transcript_sources_user_idx
  on public.gpa_transcript_sources (user_id);
create index if not exists gpa_transcript_sources_user_doc_idx
  on public.gpa_transcript_sources (user_id, document_hash);

comment on table public.gpa_transcript_sources is
  'Permanent per-user record of transcript analyses that succeeded. The Free/Premium one-transcript allowance is decided from this table alone, never from gpa_drafts.';

-- ============================================================
-- 2. ROW LEVEL SECURITY -- READ-ONLY TO THE USER, FOREVER
-- ============================================================
-- The user may SEE that they have used their transcript, so the app can say so
-- before they pick a file. They may not insert, update or delete: with RLS on
-- and no policy for those commands, every such statement is denied. The grants
-- below deny them a second time at the privilege level.
alter table public.gpa_transcript_sources enable row level security;

drop policy if exists "own transcript sources select" on public.gpa_transcript_sources;
create policy "own transcript sources select" on public.gpa_transcript_sources
  for select to authenticated using (user_id = (select auth.uid()));

-- ============================================================
-- 3. GRANTS -- revoke first, because GRANT is additive
-- ============================================================
revoke all on public.gpa_transcript_sources from public;
revoke all on public.gpa_transcript_sources from anon, authenticated, service_role;

-- SELECT only, and still filtered by the policy above. Nothing else is granted
-- to anyone -- including service_role, which reaches this table ONLY through
-- the SECURITY DEFINER functions below. A user cannot reset their allowance,
-- and neither can a compromised service key acting outside those functions.
grant select on public.gpa_transcript_sources to authenticated;

-- ============================================================
-- 4. RESERVE -- the only way a source is created
-- ============================================================
-- Race safety, per D35's proven pattern: a transaction-scoped advisory lock
-- keyed on the user is taken BEFORE counting, so two simultaneous first-
-- transcript requests from one account serialise. The second observes the
-- first's committed row and is refused. Different users hash to different keys
-- and never block each other. A plain check-then-insert would let both through.
--
-- The tier is re-read from user_profiles HERE rather than accepted as an
-- argument, so no caller -- including a bug in our own route -- can raise a
-- user's limit by passing one in. An unreadable profile is treated as 'free'.
create or replace function public.gpa_reserve_transcript_source(
  p_user_id uuid,
  p_document_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tier text;
  v_id uuid;
  v_status text;
  v_used integer;
begin
  if p_user_id is null or p_document_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid-request');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('gpa_transcript_source:' || p_user_id::text, 0));

  -- An analysis that died mid-flight (a killed function invocation, a closed
  -- laptop) must not lock the account out forever. Only PENDING rows expire;
  -- a consumed row is permanent and is never reclaimed here.
  delete from public.gpa_transcript_sources
   where user_id = p_user_id
     and status = 'pending'
     and created_at < now() - interval '15 minutes';

  -- Same document, still inside this import: reuse the source rather than
  -- charging a second allowance. Covers the D44 second pass and a retry after
  -- a failure. The window is deliberately short -- it exists to make ONE
  -- import cost ONE allowance, not to grant unlimited re-analysis later.
  select id, status into v_id, v_status
    from public.gpa_transcript_sources
   where user_id = p_user_id
     and document_hash = p_document_hash
     and (status = 'pending' or consumed_at > now() - interval '30 minutes')
   order by created_at desc
   limit 1;

  if v_id is not null then
    return jsonb_build_object(
      'ok', true, 'source_id', v_id, 'status', v_status, 'reused', true);
  end if;

  select lower(btrim(coalesce(subscription_tier, '')))
    into v_tier
    from public.user_profiles
   where id = p_user_id;
  v_tier := coalesce(nullif(v_tier, ''), 'free');

  if v_tier <> 'ultimate' then
    select count(*) into v_used
      from public.gpa_transcript_sources
     where user_id = p_user_id;
    if v_used >= 1 then
      return jsonb_build_object('ok', false, 'reason', 'allowance-used', 'tier', v_tier);
    end if;
  end if;

  insert into public.gpa_transcript_sources (user_id, status, document_hash, tier_at_issue)
  values (p_user_id, 'pending', p_document_hash, v_tier)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true, 'source_id', v_id, 'status', 'pending', 'reused', false, 'tier', v_tier);
end $$;

-- ============================================================
-- 5. CONSUME -- makes the allowance permanent
-- ============================================================
-- Idempotent: the second pass of one import consumes an already-consumed row
-- and that is a success, not an error.
create or replace function public.gpa_consume_transcript_source(
  p_user_id uuid,
  p_source_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_status text;
begin
  update public.gpa_transcript_sources
     set status = 'consumed', consumed_at = coalesce(consumed_at, now())
   where id = p_source_id
     and user_id = p_user_id
   returning status into v_status;

  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

-- ============================================================
-- 6. RELEASE -- a failed analysis gives the allowance back
-- ============================================================
-- Deletes ONLY a pending reservation. A consumed source is permanent: this
-- function is the app's whole vocabulary for undoing a reservation, and it
-- cannot express "un-consume".
create or replace function public.gpa_release_transcript_source(
  p_user_id uuid,
  p_source_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_deleted integer;
begin
  delete from public.gpa_transcript_sources
   where id = p_source_id
     and user_id = p_user_id
     and status = 'pending';
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('ok', true, 'released', v_deleted > 0);
end $$;

-- ============================================================
-- 7. ACCESS -- read-only pre-check, changes nothing
-- ============================================================
-- Used before the expensive work so a blocked user is told immediately, and by
-- the workspace to word the upgrade prompt. Takes no lock and inserts nothing;
-- the reservation above remains the authoritative decision.
create or replace function public.gpa_transcript_access(
  p_user_id uuid,
  p_document_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tier text;
  v_used integer;
  v_same integer := 0;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'invalid-request');
  end if;

  select lower(btrim(coalesce(subscription_tier, '')))
    into v_tier
    from public.user_profiles
   where id = p_user_id;
  v_tier := coalesce(nullif(v_tier, ''), 'free');

  if v_tier = 'ultimate' then
    return jsonb_build_object('allowed', true, 'tier', v_tier, 'unlimited', true);
  end if;

  select count(*) into v_used
    from public.gpa_transcript_sources
   where user_id = p_user_id
     and (status = 'consumed' or created_at > now() - interval '15 minutes');

  if p_document_hash ~ '^[0-9a-f]{64}$' then
    select count(*) into v_same
      from public.gpa_transcript_sources
     where user_id = p_user_id
       and document_hash = p_document_hash
       and (status = 'pending' or consumed_at > now() - interval '30 minutes');
  end if;

  return jsonb_build_object(
    'allowed', (v_used < 1 or v_same > 0),
    'reason', case when (v_used < 1 or v_same > 0) then null else 'allowance-used' end,
    'tier', v_tier, 'unlimited', false, 'used', v_used);
end $$;

-- ============================================================
-- 8. FUNCTION PRIVILEGES
-- ============================================================
-- Supabase grants EXECUTE on new public functions to anon, authenticated AND
-- service_role by default, so revoking from PUBLIC alone leaves all three.
-- Revoke each explicitly, then grant back ONLY to service_role: these run as
-- their owner and must never be callable from a browser session.
revoke all on function public.gpa_reserve_transcript_source(uuid, text)  from public, anon, authenticated, service_role;
revoke all on function public.gpa_consume_transcript_source(uuid, uuid)  from public, anon, authenticated, service_role;
revoke all on function public.gpa_release_transcript_source(uuid, uuid)  from public, anon, authenticated, service_role;
revoke all on function public.gpa_transcript_access(uuid, text)          from public, anon, authenticated, service_role;

grant execute on function public.gpa_reserve_transcript_source(uuid, text)  to service_role;
grant execute on function public.gpa_consume_transcript_source(uuid, uuid)  to service_role;
grant execute on function public.gpa_release_transcript_source(uuid, uuid)  to service_role;
grant execute on function public.gpa_transcript_access(uuid, text)          to service_role;

commit;

-- ============================================================
-- UNCHANGED BY THIS MIGRATION (stated, not assumed)
--   * gpa_drafts        -- not referenced
--   * gpa_institutions  -- not referenced
--   * gpa_calculations  -- not referenced
--   * user_profiles     -- READ ONLY, inside two functions. No column added,
--                          no row written.
--   * every existing RLS policy, grant, trigger and constraint
-- ============================================================

-- VERIFICATION (read-only, run after applying)
-- select count(*) as ledger_rows from public.gpa_transcript_sources;
-- EXPECT: 0 -- no backfill, every account keeps its allowance.
--
-- select relrowsecurity from pg_class where oid = 'public.gpa_transcript_sources'::regclass;
-- EXPECT: true
--
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_name = 'gpa_transcript_sources';
-- EXPECT: exactly one row -- authenticated / SELECT.
