-- ============================================================================
-- Resume Builder V2 -- atomic save.
--
-- A V2 save writes one `resumes` row and every one of its `resume_sections`
-- rows. PostgREST has no transaction envelope, so doing that from TypeScript
-- meant five sequential HTTP calls, each its own transaction, and three ways
-- to end up with a half-written resume:
--
--   PARTIAL SAVE.  The parent UPDATE commits, the section upsert fails. The
--                  resume now claims revision N+1 while holding revision N's
--                  sections -- and the client's retry, still carrying N, is
--                  refused as stale. The applicant is told their own resume
--                  "was changed somewhere else" and cannot escape without
--                  reloading and losing their edits.
--
--   ORPHAN DELETE. The final delete fails and sections the applicant removed
--                  silently reappear.
--
--   STALE SECTIONS. Client A wins the parent CAS at revision 5 and its section
--                  upsert is slow. Client C reloads at 6, saves, and its
--                  sections land. A's in-flight upsert then overwrites them,
--                  and the stored revision claims the result is C's.
--
-- One function, one transaction, and all three become impossible.
--
-- SECURITY INVOKER, deliberately. The function runs as the caller, so the
-- existing RLS policies remain the authority on ownership -- there is no
-- privilege escalation here and no service-role client anywhere near it. The
-- one resume route that ever used the service role was retired in 123981b for
-- exactly that reason.
--
-- The compare-and-swap is the FIRST write. Every refusal returns before it,
-- so a stale save performs no writes at all -- which matters because a plpgsql
-- `return` does not roll anything back: the function runs inside the caller's
-- transaction, so an early write would commit.
--
-- Result is returned as jsonb rather than raised, so PostgREST answers 200
-- with a payload the client can discriminate instead of an error string it has
-- to parse.
--
-- PRE-FLIGHT (read-only). Expect zero rows -- the function should not exist.
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'save_resume_v2';
-- ============================================================================
begin;

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
  v_new_revision bigint;
  v_cur_revision bigint;
  v_cur_version  integer;
begin
  -- ---- guards that write nothing -------------------------------------
  if jsonb_typeof(p_sections) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'malformed-payload',
                              'detail', 'sections must be an array');
  end if;

  -- A section id belonging to ANOTHER of the caller's own resumes would
  -- otherwise be moved by the upsert below, corrupting both documents. RLS
  -- does not catch this -- both rows are legitimately the caller's. A section
  -- belonging to a DIFFERENT USER is invisible here and is stopped by RLS when
  -- the upsert attempts it, which aborts the whole function.
  if exists (
    select 1
    from jsonb_array_elements(p_sections) e
    join public.resume_sections s on s.id = (e->>'id')::uuid
    where s.resume_id <> p_resume_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'section-conflict',
                              'detail', 'a section id belongs to another resume');
  end if;

  -- ---- compare-and-swap: the first write, and the gate for the rest ----
  update public.resumes
     set title                = p_resume->>'title',
         template_id          = p_resume->>'template_id',
         status               = p_resume->>'status',
         strength_score       = nullif(p_resume->>'strength_score', '')::integer,
         strength_computed_at = nullif(p_resume->>'strength_computed_at', '')::timestamptz,
         strength_revision    = nullif(p_resume->>'strength_revision', '')::bigint,
         revision             = p_expected_revision + 1,
         updated_at           = v_now
   where id = p_resume_id
     and revision = p_expected_revision
     and schema_version = 2
  returning revision into v_new_revision;

  if not found then
    -- Say precisely why, without leaking whether an id exists. The lookup is
    -- RLS-filtered, so another user's resume reports as absent.
    select revision, schema_version
      into v_cur_revision, v_cur_version
      from public.resumes
     where id = p_resume_id;

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

  -- ---- sections, in the same transaction ------------------------------
  delete from public.resume_sections s
   where s.resume_id = p_resume_id
     and not exists (
       select 1 from jsonb_array_elements(p_sections) e
        where (e->>'id')::uuid = s.id
     );

  -- resume_id is forced to p_resume_id rather than read from the payload, so
  -- a section cannot be reparented by a crafted request.
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
end
$fn$;

-- EXECUTE defaults to PUBLIC on a new function. The function is SECURITY
-- INVOKER, so it confers no privilege of its own -- but anon holds no table
-- privileges after 20260910_001 and has no business calling it either.
revoke all on function public.save_resume_v2(uuid, bigint, jsonb, jsonb) from public;
revoke all on function public.save_resume_v2(uuid, bigint, jsonb, jsonb) from anon;
grant execute on function public.save_resume_v2(uuid, bigint, jsonb, jsonb) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect: prosecdef = false (SECURITY INVOKER) and proconfig showing
-- search_path=. A true here would mean the function runs as its owner and RLS
-- would no longer be the authority.
select p.proname, p.prosecdef as security_definer, p.proconfig,
       pg_get_userbyid(p.proowner) as owner
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and p.proname = 'save_resume_v2';

-- Expect exactly one row: authenticated / EXECUTE. No anon, no PUBLIC.
select grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public' and routine_name = 'save_resume_v2'
order  by grantee;

-- Expect the row counts to be UNCHANGED. This migration writes no data.
select (select count(*) from public.resumes)         as resumes,
       (select count(*) from public.resume_sections) as sections;
