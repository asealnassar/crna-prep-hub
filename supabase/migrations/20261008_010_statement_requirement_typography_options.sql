-- ===========================================================================
-- 010  Permitted-choice typography: font_family_options, font_size_pt_options
-- ===========================================================================
--
-- NOT APPLIED. Drafted for review. Depends on 005 ONLY. It is sequenced after
-- 008 by number, but nothing in this file needs 008 or any other pending
-- migration, so it may be applied independently.
--
-- 009 IS WITHDRAWN AND DELETED, replaced by 20261015_017. This file used to
-- name it as part of its sequence; it has no dependency on either.
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
-- A school may permit a CHOICE rather than require a value. One in the imported
-- catalog does: "Times Roman or Arial, 11 or 12 point". The existing columns
-- hold one scalar each, so the only ways to store that today are to pick one
-- option -- asserting a requirement the school did not make -- or to leave it
-- as prose and hand the applicant a requirement the Studio could have applied.
--
-- ---------------------------------------------------------------------------
-- THE SCHOOL'S OWN WORDING IS WHAT IS STORED
-- ---------------------------------------------------------------------------
-- Southern Mississippi says "Times Roman". That is what goes in the array, not
-- "Times New Roman", even though the font registry treats them as aliases.
-- Canonical DATA records what was verified; alias resolution is a RENDERING
-- decision and happens at layout time. Rewriting a school's words to make a
-- fingerprint stable would be paying for stability with accuracy -- and
-- deterministic ordering already buys the stability.
--
-- ---------------------------------------------------------------------------
-- THE DATABASE REFUSES; IT DOES NOT CLEAN
-- ---------------------------------------------------------------------------
-- The generator is responsible for emitting canonical arrays: trimmed,
-- deduplicated case-insensitively, sorted. These constraints exist so that a
-- writer which failed to do that is REJECTED rather than quietly accepted --
-- including a value carrying whitespace, which would otherwise compare equal
-- after btrim() while being stored dirty and hashing differently.
--
-- A CHECK constraint may not contain a subquery, so the set rules live in two
-- IMMUTABLE functions that the constraints call.
-- ---------------------------------------------------------------------------

begin;

create or replace function public.statement_text_options_ok(opts text[])
returns boolean
language sql
immutable
parallel safe
as $$
  select opts is null or (
    -- A SET OF ONE IS A SCALAR. The scalar column already expresses that, and
    -- two ways to say the same thing is two things to keep in agreement.
    cardinality(opts) >= 2
    and array_position(opts, null) is null
    -- ALREADY TRIMMED. Not "trims to something non-empty" -- the stored bytes
    -- must be the canonical bytes, or 'Arial ' and 'Arial' are one option
    -- stored two ways and the row hashes differently than it reads.
    and (select bool_and(o = btrim(o) and o <> '' and char_length(o) <= 100)
           from unnest(opts) o)
    -- 'Arial' and 'arial' are one option written twice.
    and cardinality(opts) = (select count(distinct lower(o)) from unnest(opts) o)
    -- One option set, one byte representation, one fingerprint. An unsorted
    -- array is refused here rather than reordered on the way in.
    and opts = (select array_agg(o order by lower(o)) from unnest(opts) o)
  );
$$;

comment on function public.statement_text_options_ok(text[]) is
  'Shape check for a permitted-value text set: at least two members, no nulls, '
  'already trimmed and non-empty, no case-insensitive duplicates, sorted by '
  'lower(value). Rejects non-canonical input rather than normalising it.';

-- EXECUTE IS NOT INHERITED QUIETLY. PostgreSQL grants EXECUTE to PUBLIC on every
-- new function, and Supabase's ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS adds
-- anon, authenticated and service_role on top of that. Neither is wanted here.
--
-- NO ROLE NEEDS A GRANT. The only writer of public.statement_requirements is the
-- SECURITY DEFINER promotion function in 20261015_017, which runs as its owner;
-- an owner keeps EXECUTE on its own functions implicitly, so the CHECK still
-- evaluates. A browser role holds no INSERT or UPDATE on the table and therefore
-- can never cause this CHECK to run. So there is no grant below, only revokes.
revoke all on function public.statement_text_options_ok(text[]) from public;
revoke all on function public.statement_text_options_ok(text[])
  from anon, authenticated, service_role;

create or replace function public.statement_int_options_ok(
  opts integer[], lo integer, hi integer)
returns boolean
language sql
immutable
parallel safe
as $$
  select opts is null or (
    cardinality(opts) >= 2
    and array_position(opts, null) is null
    -- THE SAME RANGE THE SCALAR HAS. A permitted size cannot be a size the
    -- scalar column would have refused.
    and (select bool_and(o between lo and hi) from unnest(opts) o)
    and cardinality(opts) = (select count(distinct o) from unnest(opts) o)
    and opts = (select array_agg(o order by o) from unnest(opts) o)
  );
$$;

comment on function public.statement_int_options_ok(integer[], integer, integer) is
  'Shape check for a permitted-value integer set: at least two members, no '
  'nulls, each within [lo, hi], no duplicates, ascending. Rejects non-canonical '
  'input rather than normalising it.';

-- Same reasoning as the text validator above.
revoke all on function public.statement_int_options_ok(integer[], integer, integer) from public;
revoke all on function public.statement_int_options_ok(integer[], integer, integer)
  from anon, authenticated, service_role;

alter table public.statement_requirements
  add column if not exists font_family_options  text[],
  add column if not exists font_size_pt_options integer[];

comment on column public.statement_requirements.font_family_options is
  'Font families the school PERMITS, in the school''s own wording. Null when a '
  'single family is required (font_family) or none was stated. Alias resolution '
  'is a rendering decision and does not change what is stored here.';
comment on column public.statement_requirements.font_size_pt_options is
  'Point sizes the school PERMITS. Null when a single size is required '
  '(font_size_pt) or none was stated.';

alter table public.statement_requirements
  -- A property is a single required value OR a set of permitted values. Never
  -- both: two populated representations have no defined precedence, and every
  -- reader downstream would have to invent one.
  add constraint statement_requirements_font_family_one_representation
    check (font_family is null or font_family_options is null),
  add constraint statement_requirements_font_size_one_representation
    check (font_size_pt is null or font_size_pt_options is null),
  add constraint statement_requirements_font_family_options_shape
    check (public.statement_text_options_ok(font_family_options)),
  add constraint statement_requirements_font_size_options_shape
    check (public.statement_int_options_ok(font_size_pt_options, 4, 72));

-- NO BACKFILL. Every existing row keeps both arrays null; the one document that
-- needs them is converted by a separate, reviewed data correction.

commit;

-- ---------------------------------------------------------------------------
-- STILL TO DO WHEN THIS IS APPLIED, NOT DONE HERE
-- ---------------------------------------------------------------------------
-- THE PROMOTION FUNCTION DOES NOT CARRY THESE TWO ARRAYS, and 20261015_017 --
-- which replaced the withdrawn 009 -- does not either. That is deliberate and
-- it is a FEATURE GAP, not a dropped value:
--
--   * app/admin/statement-prompts/PromotionEditor.tsx collects neither array,
--     so there is nothing for the function to carry. Nothing an administrator
--     enters is lost today.
--   * naming these columns in 017 would make 017 require 010 as well, and the
--     whole argument of 017's precondition guard is that its dependencies are
--     the ones it actually writes.
--   * the one-representation CHECKs below mean an administrator promoting a
--     permitted choice must leave font_family and font_size_pt null, which the
--     editor has no way to express.
--
-- SO THE CONDITION IS ON THE EDITOR, NOT ON THIS FILE: whenever the promotion
-- editor gains these fields, the promotion function is replaced in the SAME
-- change, and that replacement guards on 010 the way 017 guards on 008 and
-- 011. Until then a promoted document records a single required typeface or
-- none, which is what every document recorded before this migration existed.
