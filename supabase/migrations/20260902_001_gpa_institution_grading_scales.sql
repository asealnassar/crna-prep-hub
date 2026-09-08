-- D38-D41 — institution-specific grading scales.
--
-- Adds a nullable grading_scale to gpa_institutions. NULL means "not
-- established": the application uses the standard 4.0 fallback and surfaces it
-- as unconfirmed (D39), so no existing user's GPA blanks after this runs and
-- no mass user action is required.
--
-- ADDITIVE ONLY. Existing institution rows are untouched and keep NULL.
-- Does not reference gpa_calculations or gpa_drafts at all.
--
-- NO HELPER FUNCTION. An earlier draft validated via an IMMUTABLE plpgsql
-- function called from the CHECK. Testing showed that a CHECK-constraint
-- function IS permission-checked at DML time -- unlike a trigger function --
-- so `authenticated` writes failed with "permission denied for function".
-- Granting EXECUTE would have worked but broadens the ACL surface for no
-- reason: strict JSONPath expresses the same validation inline, with no
-- function to own, grant, or revoke.

begin;

alter table public.gpa_institutions
  add column if not exists grading_scale jsonb;

-- ============================================================
-- VALIDATION — pure expression, no function, no subquery
-- ============================================================
-- Notes on the two subtleties this encodes:
--
--  1. `v -> 'key' IS NOT NULL` is required separately from the value test.
--     `v ->> 'key'` yields SQL NULL for an ABSENT key, and a CHECK passes on
--     NULL -- so without the presence test, {"points":{...}} with no `source`
--     would slip through.
--
--  2. `strict` is required on every JSONPath. In lax mode (the default)
--     PostgreSQL auto-unwraps arrays, so {"A":[4]} matched `@.type() ==
--     "number"` and a nested array was accepted as a valid grade point.
alter table public.gpa_institutions
  drop constraint if exists gpa_institutions_grading_scale_valid;
alter table public.gpa_institutions
  add constraint gpa_institutions_grading_scale_valid check (
    grading_scale is null                                        -- not established
    or (
      jsonb_typeof(grading_scale) = 'object'

      -- source: present, a string, and one of exactly three values
      and (grading_scale -> 'source') is not null
      and jsonb_typeof(grading_scale -> 'source') = 'string'
      and (grading_scale ->> 'source') in ('default', 'transcript', 'user')

      -- points: present, an object, non-empty
      and (grading_scale -> 'points') is not null
      and jsonb_typeof(grading_scale -> 'points') = 'object'
      and grading_scale @? 'strict $.points.keyvalue()'

      -- every value must be a number (rejects string/null/array/object/bool)
      and not grading_scale @? 'strict $.points.* ? (@.type() <> "number")'

      -- and within a sensible grade-point range
      and not grading_scale @? 'strict $.points.* ? (@ < 0 || @ > 5)'

      -- D41: NO cap on the number of grade symbols. Institutions legitimately
      -- differ (+/- variants, honours grades, IB/AP, non-US notations) and any
      -- number chosen would be arbitrary. Every value is still individually
      -- type- and range-checked above.
    )
  );

commit;

-- ============================================================
-- UNCHANGED (verified in rehearsal, not assumed)
--   * existing gpa_institutions rows  -- keep NULL grading_scale
--   * RLS policies                    -- unchanged, still filter on user_id
--   * grants                          -- authenticated only; anon/service_role none
--   * name / credit_system checks     -- untouched
--   * existing GPA trigger functions  -- ACLs untouched: anon/authenticated/
--                                        service_role all remain false
--   * gpa_drafts, gpa_calculations    -- not referenced
--
-- This migration creates NO function, so it grants no EXECUTE to anyone and
-- cannot broaden any function ACL.
-- ============================================================

-- VERIFICATION (read-only, after applying)
-- select count(*) as institutions, count(grading_scale) as with_custom_scale
-- from public.gpa_institutions;
-- EXPECT: with_custom_scale = 0 immediately after migration.
