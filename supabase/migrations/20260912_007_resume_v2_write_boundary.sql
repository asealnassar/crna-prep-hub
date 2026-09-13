-- ============================================================================
-- Resume Builder V2 -- the write boundary.
--
-- WHAT THIS CLOSES. Migration 001 grants `authenticated` table-level
-- SELECT/INSERT/UPDATE/DELETE on public.resumes and public.resume_sections, and
-- the RLS policies scope rows by owner and by nothing else. A signed-in user
-- holding the public anon key and their own JWT could therefore write any
-- column of their own rows through PostgREST, which defeated two locked product
-- rules that existed only in route handlers:
--
--   * the creation cap (Free 1, Premium 3, Ultimate unlimited), and
--   * finalization (status = 'complete' is Ultimate-only).
--
-- and let them forge schema_version, revision and the strength columns, and
-- mutate section rows outside the compare-and-swap save model.
--
-- WHY NOT "TRUST THE RPC". The first design gated everything on a
-- transaction-local marker set by the RPCs. That is wrong, and the reason is
-- worth stating plainly: create_resume_v2 and save_resume_v2 are GRANTed to
-- `authenticated` and are callable directly over PostgREST. A user does not
-- have to go through the application to reach them. A marker set by an exposed
-- function proves the write came through that function -- it proves nothing
-- whatsoever about whether the caller was allowed to make it.
--
-- So the two kinds of rule are enforced in two different ways:
--
--   TIER RULES (cap, finalization) are checked UNCONDITIONALLY, on every write,
--   whatever path it arrived by. Calling the RPC directly is subject to exactly
--   the same check as a direct UPDATE, because the check does not look at how
--   the write arrived -- only at who is making it and what they hold.
--
--   SYSTEM FIELDS (schema_version, revision, strength_*) are the only thing the
--   marker gates, and all it distinguishes is "this is the RPC doing its own
--   bookkeeping" from "this is arbitrary table DML". The marker can never widen
--   what a caller is permitted to do; it can only permit the internal columns
--   that the RPC has to write in order to work at all.
--
-- THE SERVICE-ROLE EXEMPTION is `auth.uid() is null`. A service-role connection
-- carries no `sub` claim, so auth.uid() returns null; a browser client always
-- has one, and `anon` holds no privilege on these tables at all. The offline
-- migration writer is therefore exempt from the creation cap -- it must be, or
-- migrating an owner who holds two resumes onto a Free plan would fail -- while
-- no logged-in user can reach that exemption.
--
-- 002 AND 003 ARE NOT MODIFIED. Both are replaced here with CREATE OR REPLACE
-- so the approved files stay byte-stable and the entire security delta is
-- reviewable in this one migration.
--
-- PRE-FLIGHT (read-only). Expect zero rows -- neither trigger should exist.
--   select tgname from pg_trigger
--   where tgname in ('resumes_v2_write_boundary', 'resume_sections_v2_write_boundary');
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. The caps, in one place
-- ---------------------------------------------------------------------------

-- NULL means unlimited. An unrecognised tier is treated as Free, which is the
-- safe direction: a typo in a subscription record restricts rather than opens.
create or replace function public.resume_v2_tier_cap(p_tier text)
returns integer
language sql
immutable
set search_path = ''
as $fn$
  select case lower(coalesce(p_tier, ''))
           when 'ultimate' then null
           when 'premium'  then 3
           else 1
         end;
$fn$;

revoke all on function public.resume_v2_tier_cap(text) from public;
revoke all on function public.resume_v2_tier_cap(text) from anon;

-- ---------------------------------------------------------------------------
-- 2. The write boundary on public.resumes
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER so the count and the tier lookup are reliable regardless of
-- the caller's own grants, with an empty search_path and every reference
-- schema-qualified. It is a trigger function: it takes no arguments and returns
-- `trigger`, so PostgREST does not expose it and it cannot be invoked directly.

create or replace function public.enforce_resume_v2_write_boundary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user   uuid := auth.uid();
  v_marked boolean := coalesce(current_setting('app.resume_v2_rpc', true), '') = '1';
  v_tier   text;
  v_cap    integer;
  v_held   integer;
begin
  -- No session: service_role, the offline migration writer, or maintenance.
  -- A browser client always carries a sub claim, and anon holds no privilege
  -- on this table, so this branch is unreachable from the internet.
  if v_user is null then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  -- Deleting your own resume is always allowed; RLS scopes which ones you can
  -- see. Nothing below concerns deletion.
  if tg_op = 'DELETE' then
    return old;
  end if;

  -- V1 rows are untouched by all of this. The V1 builder has to keep working
  -- unchanged for the whole rollback window, and it never writes a V2 row.
  if coalesce(new.schema_version, 1) <> 2
     and (tg_op = 'INSERT' or coalesce(old.schema_version, 1) <> 2) then
    return new;
  end if;

  -- THE TIER READ, AND ON INSERT THE LOCK THAT MAKES THE CAP STRICT.
  --
  -- Counting rows and then comparing to a cap is a read-modify-write, and two
  -- concurrent creates would otherwise both read the same count and both be
  -- allowed -- so a Free user firing two requests at once could end up with
  -- two resumes. Locking the OWNER'S user_profiles row first serializes
  -- creation per owner: the second transaction blocks until the first commits
  -- and then counts a row that already exists.
  --
  -- Per owner, never global. Two different users creating at the same moment
  -- take two different row locks and do not wait on each other.
  --
  -- It is also the right row to lock for a second reason: it is the row the
  -- tier is read from, so the tier cannot change between the check and the
  -- insert it authorises.
  if tg_op = 'INSERT' then
    select lower(coalesce(p.subscription_tier, 'free'))
      into v_tier
      from public.user_profiles p
     where p.id = new.user_id
       for update;

    -- A user with no profile row cannot be locked, and every account should
    -- have one -- handle_new_user() creates it. Falling back to a per-user
    -- advisory lock keeps the cap strict even in that state rather than
    -- leaving one unguarded path through it. Transaction-scoped, so it is
    -- released with the statement either way.
    if not found then
      perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
    end if;
  else
    select lower(coalesce(p.subscription_tier, 'free'))
      into v_tier
      from public.user_profiles p
     where p.id = v_user;
  end if;

  v_tier := coalesce(v_tier, 'free');
  v_cap  := public.resume_v2_tier_cap(v_tier);

  -- ---- INSERT ----------------------------------------------------------
  if tg_op = 'INSERT' then
    -- A V2 row may only be created through create_resume_v2. A direct insert
    -- has no legitimate caller and is refused before anything else is checked.
    if not v_marked then
      raise exception 'resume_v2: direct insert of a V2 resume is not permitted'
        using errcode = '42501';
    end if;

    -- THE CAP. Deliberately not gated on the marker: this is the check that
    -- must hold when someone calls create_resume_v2 directly, which is the
    -- whole point. Counting is done inside a DEFINER function so it sees every
    -- one of the owner's rows, not only those RLS would show the caller, and
    -- under the per-owner lock taken above so the count cannot go stale
    -- between reading it and inserting.
    if v_cap is not null then
      select count(*) into v_held
        from public.resumes r
       where r.user_id = new.user_id
         and r.schema_version = 2;

      if v_held >= v_cap then
        raise exception 'resume_v2: % plan allows % resume(s); % already exist',
          v_tier, v_cap, v_held
          using errcode = '42501';
      end if;
    end if;

    -- FINALIZATION, likewise unconditional. A new resume should be a draft in
    -- any case; this refuses the shortcut rather than silently rewriting it.
    if new.status = 'complete' and v_cap is not null then
      raise exception 'resume_v2: the % plan cannot finalize a resume', v_tier
        using errcode = '42501';
    end if;

    return new;
  end if;

  -- ---- UPDATE ----------------------------------------------------------

  -- FINALIZATION. Unconditional, so it applies equally to save_resume_v2 and
  -- to a direct UPDATE. `v_cap is not null` is precisely "not Ultimate".
  -- complete -> draft stays available to everyone, as designed: only the
  -- transition INTO complete is gated.
  if new.status = 'complete' and coalesce(old.status, 'draft') <> 'complete'
     and v_cap is not null then
    raise exception 'resume_v2: the % plan cannot finalize a resume', v_tier
      using errcode = '42501';
  end if;

  -- EVERYTHING ELSE about a V2 row moves through the RPCs. This is broader
  -- than protecting the system columns one by one, and simpler to reason
  -- about: a V2 document is written by save_resume_v2, its strength by
  -- save_resume_strength_v2, and by nothing else. Section content is covered
  -- by the companion trigger below, so the compare-and-swap model has no path
  -- around it.
  if not v_marked then
    raise exception 'resume_v2: direct update of a V2 resume is not permitted'
      using errcode = '42501';
  end if;

  -- Ownership and identity are never rewritten, by any path. RLS already
  -- refuses to hand a row to a different owner; this refuses to move one.
  if new.id <> old.id or new.user_id <> old.user_id then
    raise exception 'resume_v2: a resume cannot be reassigned'
      using errcode = '42501';
  end if;

  -- A generation change is not an edit. Nothing in either builder does this,
  -- and allowing it would let a V2 document be opened by the V1 editor.
  if new.schema_version <> old.schema_version then
    raise exception 'resume_v2: schema_version cannot be changed'
      using errcode = '42501';
  end if;

  return new;
end
$fn$;

revoke all on function public.enforce_resume_v2_write_boundary() from public;
revoke all on function public.enforce_resume_v2_write_boundary() from anon;
revoke all on function public.enforce_resume_v2_write_boundary() from authenticated;

drop trigger if exists resumes_v2_write_boundary on public.resumes;
create trigger resumes_v2_write_boundary
  before insert or update or delete on public.resumes
  for each row execute function public.enforce_resume_v2_write_boundary();

-- ---------------------------------------------------------------------------
-- 3. The write boundary on public.resume_sections
-- ---------------------------------------------------------------------------
--
-- Section rows are where a resume's actual content lives, so leaving them
-- directly writable would leave the compare-and-swap save model optional: a
-- client could rewrite its document without ever naming a revision, and two
-- tabs could overwrite each other with no conflict ever reported. Sections of a
-- V2 resume therefore move only through the save and create RPCs.
--
-- Sections of a V1 resume stay directly writable, because that is exactly how
-- the V1 builder saves and it has to keep working.

create or replace function public.enforce_resume_section_v2_boundary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user    uuid := auth.uid();
  v_marked  boolean := coalesce(current_setting('app.resume_v2_rpc', true), '') = '1';
  v_resume  uuid := case tg_op when 'DELETE' then old.resume_id else new.resume_id end;
  v_version integer;
begin
  if v_user is null then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  select r.schema_version into v_version
    from public.resumes r
   where r.id = v_resume;

  -- The parent is already gone: this is the ON DELETE CASCADE from a resume
  -- being deleted, which runs after the parent row has been removed. Refusing
  -- it would make V2 resumes undeletable.
  if v_version is null then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if v_version = 2 and not v_marked then
    raise exception 'resume_v2: section rows are written through save_resume_v2'
      using errcode = '42501';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end
$fn$;

revoke all on function public.enforce_resume_section_v2_boundary() from public;
revoke all on function public.enforce_resume_section_v2_boundary() from anon;
revoke all on function public.enforce_resume_section_v2_boundary() from authenticated;

drop trigger if exists resume_sections_v2_write_boundary on public.resume_sections;
create trigger resume_sections_v2_write_boundary
  before insert or update or delete on public.resume_sections
  for each row execute function public.enforce_resume_section_v2_boundary();

-- ---------------------------------------------------------------------------
-- 4. create_resume_v2 -- replaced: sets the marker, and stops taking a status
-- ---------------------------------------------------------------------------
--
-- Unchanged from 003 except in three respects:
--   * it sets the transaction-local marker, without which its own insert is
--     now refused;
--   * status is FORCED to 'draft' rather than read from the payload. A resume
--     is finalized by a deliberate later action, and accepting it here was a
--     way to create an already-complete resume on a Free plan; and
--   * the not-authenticated guard is kept and is now load-bearing twice over,
--     because the marker must never be set for a caller with no session.
--
-- Still SECURITY INVOKER. RLS remains in force underneath, so this function
-- confers no privilege of its own -- which is why it does not need the
-- ownership rewrite that turning it into a DEFINER would have required.

create or replace function public.create_resume_v2(
  p_resume_id uuid,
  p_resume    jsonb,
  p_sections  jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_now  timestamptz := now();
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;

  if jsonb_typeof(p_sections) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'malformed-payload',
                              'detail', 'sections must be an array');
  end if;

  if exists (select 1 from public.resumes where id = p_resume_id) then
    return jsonb_build_object('ok', false, 'reason', 'already-exists');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_sections) e
    join public.resume_sections s on s.id = (e->>'id')::uuid
  ) then
    return jsonb_build_object('ok', false, 'reason', 'section-conflict',
                              'detail', 'a section id is already in use');
  end if;

  -- Marker set only after the session has been established. Transaction-local,
  -- so it ends with this statement's transaction; PostgREST gives every request
  -- its own, and a request is either an RPC call or table DML, never both.
  perform set_config('app.resume_v2_rpc', '1', true);

  insert into public.resumes
    (id, user_id, title, template_id, status,
     schema_version, revision, created_at, updated_at)
  values
    (p_resume_id,
     v_user,
     p_resume->>'title',
     p_resume->>'template_id',
     'draft',
     2, 1, v_now, v_now);

  insert into public.resume_sections
    (id, resume_id, section_type, section_data, order_index, visible, label,
     created_at, updated_at)
  select (e->>'id')::uuid,
         p_resume_id,
         e->>'section_type',
         e->'section_data',
         coalesce((e->>'order_index')::integer, 0),
         coalesce((e->>'visible')::boolean, true),
         e->>'label',
         v_now,
         v_now
    from jsonb_array_elements(p_sections) e;

  return jsonb_build_object('ok', true, 'id', p_resume_id, 'revision', 1);

exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'already-exists');
  -- The creation cap and the finalization rule are raised by the trigger with
  -- this SQLSTATE. Turning them into an ordinary result keeps the route's error
  -- mapping intact instead of surfacing a 500 for a rule the user can act on.
  when insufficient_privilege then
    return jsonb_build_object('ok', false, 'reason', 'not-permitted',
                              'detail', sqlerrm);
end
$fn$;

revoke all on function public.create_resume_v2(uuid, jsonb, jsonb) from public;
revoke all on function public.create_resume_v2(uuid, jsonb, jsonb) from anon;
grant execute on function public.create_resume_v2(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. save_resume_v2 -- replaced: marker, explicit ownership, no strength
-- ---------------------------------------------------------------------------
--
-- Unchanged from 002 except:
--   * it sets the marker;
--   * it takes an EXPLICIT ownership check -- `and r.user_id = v_user` on both
--     the compare-and-swap and the diagnostic lookup. RLS already does this and
--     the function is still SECURITY INVOKER, so this is defence in depth
--     rather than a replacement for it. It also means the ownership rule
--     survives if this function is ever made DEFINER;
--   * it NO LONGER WRITES THE STRENGTH COLUMNS. They were read straight from
--     the payload, so every ordinary save carried a forgeable score. Strength
--     now moves through save_resume_strength_v2 and nothing else; and
--   * it refuses a finalization the caller is not entitled to, as a clean
--     result rather than an exception. The trigger enforces the same rule and
--     remains the actual boundary -- this is the readable error, not the guard.

create or replace function public.save_resume_v2(
  p_resume_id         uuid,
  p_expected_revision bigint,
  p_resume            jsonb,
  p_sections          jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_now          timestamptz := now();
  v_user         uuid := auth.uid();
  v_new_revision bigint;
  v_cur_revision bigint;
  v_cur_version  integer;
  v_status       text;
  v_tier         text;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;

  if jsonb_typeof(p_sections) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'malformed-payload',
                              'detail', 'sections must be an array');
  end if;

  v_status := coalesce(p_resume->>'status', 'draft');
  if v_status not in ('draft', 'complete') then
    return jsonb_build_object('ok', false, 'reason', 'malformed-payload',
                              'detail', 'status must be draft or complete');
  end if;

  -- Entitlement, named before anything is written. The trigger enforces it
  -- regardless; this exists so a legitimate Free user pressing a button they
  -- should not see gets a reason instead of a database error.
  if v_status = 'complete' then
    select lower(coalesce(p.subscription_tier, 'free')) into v_tier
      from public.user_profiles p where p.id = v_user;
    if public.resume_v2_tier_cap(coalesce(v_tier, 'free')) is not null then
      return jsonb_build_object('ok', false, 'reason', 'finalize-not-permitted');
    end if;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_sections) e
    join public.resume_sections s on s.id = (e->>'id')::uuid
    where s.resume_id <> p_resume_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'section-conflict',
                              'detail', 'a section id belongs to another resume');
  end if;

  perform set_config('app.resume_v2_rpc', '1', true);

  -- The compare-and-swap, now naming the owner explicitly as well as the
  -- revision. strength_score, strength_computed_at and strength_revision are
  -- deliberately absent: a save must not be able to move them.
  update public.resumes r
     set title       = p_resume->>'title',
         template_id = p_resume->>'template_id',
         status      = v_status,
         revision    = p_expected_revision + 1,
         updated_at  = v_now
   where r.id = p_resume_id
     and r.user_id = v_user
     and r.revision = p_expected_revision
     and r.schema_version = 2
  returning r.revision into v_new_revision;

  if not found then
    select r.revision, r.schema_version
      into v_cur_revision, v_cur_version
      from public.resumes r
     where r.id = p_resume_id
       and r.user_id = v_user;

    if not found then
      return jsonb_build_object('ok', false, 'reason', 'not-found');
    elsif v_cur_version <> 2 then
      return jsonb_build_object('ok', false, 'reason', 'wrong-schema-version',
                                'detail', 'schema_version=' || v_cur_version);
    else
      return jsonb_build_object('ok', false, 'reason', 'stale-revision',
                                'stored_revision', v_cur_revision);
    end if;
  end if;

  delete from public.resume_sections s
   where s.resume_id = p_resume_id
     and not exists (
       select 1 from jsonb_array_elements(p_sections) e
        where (e->>'id')::uuid = s.id
     );

  insert into public.resume_sections
    (id, resume_id, section_type, section_data, order_index, visible, label,
     created_at, updated_at)
  select (e->>'id')::uuid,
         p_resume_id,
         e->>'section_type',
         e->'section_data',
         coalesce((e->>'order_index')::integer, 0),
         coalesce((e->>'visible')::boolean, true),
         e->>'label',
         v_now,
         v_now
    from jsonb_array_elements(p_sections) e
  on conflict (id) do update
     set section_type = excluded.section_type,
         section_data = excluded.section_data,
         order_index  = excluded.order_index,
         visible      = excluded.visible,
         label        = excluded.label,
         updated_at   = excluded.updated_at;

  return jsonb_build_object('ok', true, 'revision', v_new_revision);

exception
  when insufficient_privilege then
    return jsonb_build_object('ok', false, 'reason', 'not-permitted',
                              'detail', sqlerrm);
end
$fn$;

revoke all on function public.save_resume_v2(uuid, bigint, jsonb, jsonb) from public;
revoke all on function public.save_resume_v2(uuid, bigint, jsonb, jsonb) from anon;
grant execute on function public.save_resume_v2(uuid, bigint, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. save_resume_strength_v2 -- the only way a score reaches a row
-- ---------------------------------------------------------------------------
--
-- The repository used to write the three strength columns with a direct
-- UPDATE, which the boundary above now refuses. This replaces it with the
-- narrowest possible surface: three columns, on a resume the caller owns, and
-- explicitly NOT the revision -- bumping it would immediately mark the score it
-- just stored as stale, which is the defect the scoped update existed to avoid.
--
-- HONEST LIMIT, stated rather than implied. This function is GRANTed to
-- `authenticated`, so a determined owner can call it with a number they chose
-- instead of one the scorer produced. Closing that would require the score to
-- be written by a server-side identity, and no V2 route is permitted a
-- service-role client. What this does achieve: the score is no longer writable
-- by arbitrary table DML, cannot ride along on an ordinary save, cannot be set
-- on somebody else's resume, and cannot be used to move any other column. The
-- residual is a user misreporting their own score to themselves, with no
-- entitlement, cost or cross-user consequence.

create or replace function public.save_resume_strength_v2(
  p_resume_id   uuid,
  p_score       integer,
  p_computed_at timestamptz,
  p_revision    bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;

  if p_score is null or p_score < 0 or p_score > 100 then
    return jsonb_build_object('ok', false, 'reason', 'malformed-payload',
                              'detail', 'score must be between 0 and 100');
  end if;

  perform set_config('app.resume_v2_rpc', '1', true);

  update public.resumes r
     set strength_score       = p_score,
         strength_computed_at = coalesce(p_computed_at, now()),
         strength_revision    = p_revision
   where r.id = p_resume_id
     and r.user_id = v_user
     and r.schema_version = 2;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  return jsonb_build_object('ok', true);
end
$fn$;

revoke all on function public.save_resume_strength_v2(uuid, integer, timestamptz, bigint) from public;
revoke all on function public.save_resume_strength_v2(uuid, integer, timestamptz, bigint) from anon;
grant execute on function public.save_resume_strength_v2(uuid, integer, timestamptz, bigint) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect both triggers, BEFORE, row-level, on INSERT/UPDATE/DELETE.
select c.relname as table_name, t.tgname, t.tgenabled
from   pg_trigger t join pg_class c on c.oid = t.tgrelid
where  not t.tgisinternal
  and  t.tgname in ('resumes_v2_write_boundary', 'resume_sections_v2_write_boundary')
order  by c.relname;

-- Expect prosecdef = true and proconfig {search_path=} for both trigger
-- functions, and false for the three INVOKER RPCs.
select p.proname, p.prosecdef as security_definer, p.proconfig
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public'
  and  p.proname in ('enforce_resume_v2_write_boundary',
                     'enforce_resume_section_v2_boundary',
                     'create_resume_v2', 'save_resume_v2', 'save_resume_strength_v2',
                     'resume_v2_tier_cap')
order  by p.proname;

-- Expect EXECUTE for `authenticated` on the three RPCs ONLY. The trigger
-- functions and the cap helper must appear for nobody.
select routine_name, grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public'
  and  routine_name in ('enforce_resume_v2_write_boundary',
                        'enforce_resume_section_v2_boundary',
                        'create_resume_v2', 'save_resume_v2', 'save_resume_strength_v2',
                        'resume_v2_tier_cap')
order  by routine_name, grantee;

-- Expect 1 / 3 / null.
select public.resume_v2_tier_cap('free')     as free,
       public.resume_v2_tier_cap('premium')  as premium,
       public.resume_v2_tier_cap('ultimate') as ultimate,
       public.resume_v2_tier_cap('nonsense') as unknown_tier_is_free;

-- Expect the row counts to be UNCHANGED. This migration writes no data.
select (select count(*) from public.resumes)         as resumes,
       (select count(*) from public.resume_sections) as sections,
       (select count(*) from public.resumes where schema_version = 2) as v2_resumes;
