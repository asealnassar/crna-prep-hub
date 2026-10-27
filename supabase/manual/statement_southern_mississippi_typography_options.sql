-- ============================================================================
-- THE ONE DOCUMENT MIGRATION 20261008_010 WAS WRITTEN FOR
-- ============================================================================
-- 010 adds font_family_options and font_size_pt_options and ends with:
--
--     "NO BACKFILL. Every existing row keeps both arrays null; the one
--      document that needs them is converted by a separate, reviewed data
--      correction."
--
-- This is that correction. Without it 010 changes nothing an applicant can
-- see, and the only school in the catalog that PERMITS A CHOICE of typeface
-- goes on reporting it as prose the applicant must satisfy by hand.
--
-- THE SCHOOL'S OWN WORDING, UNCHANGED:
--
--     "Times Roman or Arial, 11 or 12 point"
--
-- That is a CHOICE, not a requirement, and the catalog has had no way to say
-- so: font_family holds one family, font_size_pt holds one size. Stored as
-- prose in other_instructions it renders as a manual item -- "yours to apply
-- in the final document" -- which is the opposite of the truth. The Studio can
-- offer both faces and both sizes once they are in the typed columns.
--
-- WHAT THIS CHANGES, ON EXACTLY ONE ROW:
--   font_family_options   null -> {Arial,"Times Roman"}  (canonical order)
--   font_size_pt_options  null -> {11,12}
--   other_instructions    the typography sentence removed; everything else
--                         in the array kept, in order
--
-- WHAT IT DOES NOT CHANGE: font_family and font_size_pt stay null, which 010's
-- one-representation constraints require -- a property is a single required
-- value OR a set of permitted ones, never both.
--
-- ---------------------------------------------------------------------------
-- PRECONDITIONS, AND WHY IT REFUSES RATHER THAN OVERWRITES
-- ---------------------------------------------------------------------------
-- The row is matched on its deterministic id AND on every value this
-- correction expects to find. If production has moved underneath this file --
-- a later import, a hand edit, a correction applied twice -- the WHERE clause
-- matches nothing, zero rows change, and the verdict says so. It is safe to
-- run twice: the second run reports ALREADY CORRECTED.
--
-- PREREQUISITE: 20261008_010 must be applied first. Without it the columns do
-- not exist and this file fails at parse time, which is the correct outcome.
--
-- READ THE VERDICT COLUMN. One statement, because the SQL editor shows only
-- the last result.
-- ============================================================================

with
  expected(requirement_id, school_id, families, sizes, prose) as (values (
    'f6017562-e76e-59c7-98b8-552c01dc0cb1'::uuid,
    'c37c5c06-fa01-40c0-8415-93be4f01daeb'::uuid,
    -- SORTED BY lower(value), WHICH 010's statement_text_options_ok REQUIRES.
    -- It refuses non-canonical input rather than normalising it, so that one
    -- option set has one byte representation and one fingerprint. The school's
    -- WORDING is preserved in each value; only the order is canonical, and the
    -- reader sorts identically, so nothing is lost.
    array['Arial', 'Times Roman']::text[],
    array[11, 12]::integer[],
    'Times Roman or Arial, 11 or 12 point'
  )),
  before as (
    select r.id,
           r.font_family,
           r.font_size_pt,
           r.font_family_options,
           r.font_size_pt_options,
           r.other_instructions
      from public.statement_requirements r
      join expected e on e.requirement_id = r.id
  ),
  updated as (
    update public.statement_requirements as r
       set font_family_options  = e.families,
           font_size_pt_options = e.sizes,
           -- EVERY OTHER INSTRUCTION KEPT, IN ORDER. Only the typography
           -- sentence is removed, and only if it is exactly the reviewed one.
           other_instructions   = coalesce(
             (select jsonb_agg(value order by ordinality)
                from jsonb_array_elements_text(r.other_instructions)
                     with ordinality as t(value, ordinality)
               where value <> e.prose),
             '[]'::jsonb)
      from expected e
     where r.id = e.requirement_id
       and r.school_id = e.school_id
       -- THE PRECONDITIONS. Each one is a fact this correction assumes.
       and r.font_family is null
       and r.font_size_pt is null
       and r.font_family_options is null
       and r.font_size_pt_options is null
       and r.other_instructions @> to_jsonb(array[e.prose])
    returning r.id
  )
select e.requirement_id,
       'Southern Mississippi / Personal Statement' as document,
       case
         when u.id is not null then 'CORRECTED'
         when b.id is null     then 'REFUSED: no requirement with this id'
         when b.font_family_options is not null
           or b.font_size_pt_options is not null then 'ALREADY CORRECTED'
         when b.font_family is not null
           or b.font_size_pt is not null
           then 'REFUSED: a single required family/size is set; 010 forbids both'
         when not (b.other_instructions @> to_jsonb(array[e.prose]))
           then 'REFUSED: the expected wording is not on this row any more'
         else 'REFUSED: preconditions not met'
       end as verdict,
       b.other_instructions as other_instructions_before
  from expected e
  left join before  b on b.id = e.requirement_id
  left join updated u on u.id = e.requirement_id;
