-- ============================================================================
-- Resume Builder V2 -- atomic create.
--
-- The companion to save_resume_v2, and it closes the last non-atomic write
-- path in the repository layer.
--
-- Creating a V2 resume writes a parent row and every one of its sections.
-- Done from TypeScript that was two PostgREST calls with a compensating
-- delete: insert the parent, insert the sections, and if the second failed,
-- try to remove the first. If THAT delete also failed -- the same network that
-- just dropped a request -- the result was a resume row with no sections,
-- which renders as an empty document the applicant cannot explain. V1 has this
-- exact failure mode and no compensation at all.
--
-- One function, one transaction. There is no window in which a parent exists
-- without its sections.
--
-- OWNERSHIP IS NOT A PARAMETER. user_id is taken from auth.uid() inside the
-- function and never from the payload, so a client cannot create a resume that
-- belongs to somebody else -- and because the sections are inserted against
-- that same parent id in the same transaction, it cannot attach sections to
-- another user's resume either. SECURITY INVOKER means RLS is still checking
-- both inserts underneath.
--
-- PRE-FLIGHT (read-only). Expect zero rows -- the function should not exist.
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'create_resume_v2';
-- ============================================================================
begin;

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
  -- ---- guards that write nothing -------------------------------------
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not-authenticated');
  end if;

  if jsonb_typeof(p_sections) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'malformed-payload',
                              'detail', 'sections must be an array');
  end if;

  -- Both lookups are RLS-filtered, so a collision with ANOTHER user's row is
  -- invisible here and falls through to the unique_violation handler below.
  -- Either way nothing is created.
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

  -- ---- both inserts, one transaction ----------------------------------
  -- user_id, schema_version, revision and both timestamps are set here, not
  -- read from the payload: a client may choose the content of its resume, not
  -- who owns it, which generation it belongs to, or when it was made.
  insert into public.resumes
    (id, user_id, title, template_id, status,
     schema_version, revision, created_at, updated_at)
  values
    (p_resume_id,
     v_user,
     p_resume->>'title',
     p_resume->>'template_id',
     coalesce(p_resume->>'status', 'draft'),
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
  -- A primary-key collision with a row this caller cannot see. The handler
  -- rolls the block back to its start, so neither insert survives, and the
  -- caller gets the same answer as the visible case rather than a 500.
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'already-exists');
end
$fn$;

revoke all on function public.create_resume_v2(uuid, jsonb, jsonb) from public;
revoke all on function public.create_resume_v2(uuid, jsonb, jsonb) from anon;
grant execute on function public.create_resume_v2(uuid, jsonb, jsonb) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only)
-- ---------------------------------------------------------------------------

-- Expect prosecdef = false and proconfig showing search_path=.
select p.proname, p.prosecdef as security_definer, p.proconfig,
       pg_get_userbyid(p.proowner) as owner
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and p.proname in ('create_resume_v2', 'save_resume_v2')
order  by p.proname;

-- Expect one row per function: authenticated / EXECUTE. No anon, no PUBLIC.
select routine_name, grantee, privilege_type
from   information_schema.routine_privileges
where  routine_schema = 'public'
  and  routine_name in ('create_resume_v2', 'save_resume_v2')
order  by routine_name, grantee;

-- Expect the row counts to be UNCHANGED. This migration writes no data.
select (select count(*) from public.resumes)         as resumes,
       (select count(*) from public.resume_sections) as sections;
