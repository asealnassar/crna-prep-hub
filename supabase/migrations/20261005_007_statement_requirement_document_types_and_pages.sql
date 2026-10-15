-- ============================================================================
-- Statement Studio V2 -- three more document types, and page bounds that can
-- hold a half page.
--
-- Depends on 20261002_005_statement_requirements.sql and
-- 20261002_006_statement_requirement_length_register.sql. Additive and
-- widening: no value that was storable before this migration stops being
-- storable after it.
--
-- WHY THIS EXISTS. The dry run of the verified 82-programme research set
-- (scripts/statement_requirements_dry_run.py) refused nine documents rather
-- than coerce them, and six programmes lost their only document as a result.
-- Two distinct causes, both schema limits rather than data problems:
--
--   * FIVE DOCUMENTS carry a document_type the 005 CHECK does not list --
--     statement-of-purpose (Miami, USC x2), autobiographical-essay
--     (Michigan-Flint) and supplemental-essay (Minnesota). Re-labelling them
--     to 'other' or 'goal-statement' would have overwritten a classification a
--     human made from the school's own page, so the importer held them.
--
--   * TWO DOCUMENTS state a limit of ONE AND A HALF PAGES (Boston College's two
--     goal-statement essays). min_pages and max_pages were `integer`, so 1.5
--     could only be stored by rounding -- and rounding an admissions limit
--     either way changes what the school requires.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. Two other refused documents
-- are NOT addressed by widening a type, because their problem is not the
-- column:
--
--   * Gonzaga: "2 pages maximum, plus an optional 3rd page for references
--     only" is TWO allowances. A single max_pages expresses one of them.
--   * UW-La Crosse: "less than two pages in length" is a STRICT inequality.
--     max_pages = 2 permits a length the school excluded; 1 forbids one it
--     allowed.
--
--   Both stay unstructured: the sentence goes in unenforced_length with every
--   numeric bound NULL, which is the shape 006 already defines for a published
--   length this product does not model as a bound. No schema change is needed
--   for that and none is made here.
--
-- ============================================================================
-- THE SCALE CHOICE, AND THE ROUNDING IT STILL PERMITS.
-- ============================================================================
-- numeric(4,1), not integer, not real, not unconstrained numeric.
--
--   * EXACT. numeric is base-10 and stores 1.5 as 1.5. `real`/`double
--     precision` would store a binary approximation, and a limit shown to an
--     applicant must not drift.
--   * EVERY OLD VALUE SURVIVES. Scale 1 holds every integer the old column
--     could, and the 1..200 bound needs only three digits before the point.
--   * ONE DECIMAL IS THE REAL GRANULARITY. Schools state halves of a page.
--
-- AND THE HONEST CAVEAT: numeric(4,1) ROUNDS ON INSERT. A limit of 1.25 pages
-- would be stored as 1.3 -- silently, by PostgreSQL, with no error. That is NOT
-- defended here, because a column cannot defend it: by the time the value
-- arrives the precision is already gone. It is defended one layer up, where the
-- importer maps page prose from an explicit reviewed whitelist and refuses any
-- wording it has not been taught. If a school ever states a quarter page, the
-- right response is to stop and widen the scale deliberately -- not to let the
-- database round it.
-- ============================================================================

begin;

-- ---- 0. PRECONDITIONS ----------------------------------------------------
-- This migration ALTERS rather than creates, so unlike 005 it cannot be
-- idempotent by `if not exists` alone. It refuses loudly on a database where
-- its target does not exist, rather than half-applying.
do $pre$
begin
  if to_regclass('public.statement_requirements') is null then
    raise exception 'public.statement_requirements does not exist; apply 005 first';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'statement_requirements'
       and column_name = 'pages_enforcement')
  then
    raise exception 'pages_enforcement is missing; apply 006 first';
  end if;
end
$pre$;

-- ---- 1. document_type: six values become nine ----------------------------
--
-- REPLACED, NOT RELAXED. The constraint is still a closed set: an unknown
-- string is still refused, and 'other' is still the escape hatch for a
-- document whose own label fits none of these. The three additions are the
-- three the verified research actually contains.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_document_type_known;

alter table public.statement_requirements
  add constraint statement_requirements_document_type_known
  check (document_type in ('personal-statement', 'goal-statement',
                           'diversity-statement', 'writing-sample',
                           'additional-response', 'other',
                           'statement-of-purpose', 'autobiographical-essay',
                           'supplemental-essay'));

-- ---- 2. min_pages / max_pages: integer -> numeric(4,1) -------------------
--
-- WORD AND CHARACTER COLUMNS ARE UNTOUCHED. Half a word is not a thing a
-- school states, and widening a column nobody asked to widen is how a
-- migration acquires scope it was never reviewed for.
--
-- Both columns change in ONE statement so the table is rewritten once and the
-- two can never diverge. PostgreSQL re-validates every dependent CHECK as part
-- of this, which is why section 3 asserts rather than re-creates them.
alter table public.statement_requirements
  alter column min_pages type numeric(4,1) using min_pages::numeric(4,1),
  alter column max_pages type numeric(4,1) using max_pages::numeric(4,1);

-- ---- 3. AUDIT: every constraint that mentions a page ---------------------
--
-- NOTHING IS RE-CREATED HERE ON PURPOSE. `alter column ... type` carries the
-- dependent CHECKs across and re-validates them against the new type, so
-- re-adding them would be churn that makes the diff look bigger than the
-- change. What this block does instead is REFUSE TO COMMIT if any of them went
-- missing, which is the failure a silent carry-across would otherwise hide.
--
-- Each of the five is listed with what it must still mean:
--
--   statement_requirements_page_bounds            1..200, min <= max -- the
--       `between` and `<=` comparisons are numeric-safe, so 1.5 passes and
--       1.5 <= 2 still orders correctly.
--   statement_requirements_page_spacing_known     single|double -- never
--       mentioned a page NUMBER, so the type change cannot reach it.
--   statement_requirements_pages_register_needs_limit  a register needs a
--       min, a max OR a spacing. Tests `is not null`, not a magnitude.
--   statement_requirements_truncation_needs_maximum    'truncated' needs
--       max_pages. Tests `is not null`.
--   statement_requirements_unenforced_length_has_no_bound  unenforced_length
--       forbids every bound including the two page columns. Tests `is null`.
--
-- The three that test only for NULL are type-agnostic by construction. Only
-- page_bounds compares magnitudes, and numeric comparison is exact.
do $audit$
declare
  v_missing text[] := '{}';
  v_name    text;
  v_types   text;
begin
  foreach v_name in array array[
    'statement_requirements_page_bounds',
    'statement_requirements_page_spacing_known',
    'statement_requirements_pages_register_needs_limit',
    'statement_requirements_truncation_needs_maximum',
    'statement_requirements_unenforced_length_has_no_bound'
  ] loop
    if not exists (
      select 1 from pg_constraint
       where conrelid = 'public.statement_requirements'::regclass
         and conname = v_name and contype = 'c')
    then
      v_missing := array_append(v_missing, v_name);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'the page type change lost CHECK constraint(s): %',
      array_to_string(v_missing, ', ');
  end if;

  -- and the columns really are numeric now, with the intended scale
  select string_agg(column_name || '=' || data_type
                    || '(' || coalesce(numeric_precision::text, '?')
                    || ',' || coalesce(numeric_scale::text, '?') || ')', ' ')
    into v_types
    from information_schema.columns
   where table_schema = 'public' and table_name = 'statement_requirements'
     and column_name in ('min_pages', 'max_pages');

  if v_types is distinct from
     'max_pages=numeric(4,1) min_pages=numeric(4,1)'
     and v_types is distinct from
     'min_pages=numeric(4,1) max_pages=numeric(4,1)'
  then
    raise exception 'page columns are not numeric(4,1) after the change: %', v_types;
  end if;

  raise notice 'audit passed: 5 page constraints intact, page columns are %', v_types;
end
$audit$;

-- ---- 4. WHAT THIS MIGRATION DOES NOT CHANGE ------------------------------
--
-- Recorded so the postcheck has a list to assert against:
--
--   * no grant, policy or RLS setting is touched. 005 section 6 remains the
--     only place they are declared.
--   * no column is added, dropped or renamed.
--   * no default and no nullability changes. min_pages/max_pages were
--     nullable with no default and still are -- NULL still means THE SCHOOL
--     DID NOT STATE ONE, which is the distinction 005 exists to keep.
--   * word, character, typography, citation and register columns are
--     untouched.
--   * statement_requirement_sets is not touched at all.
--   * no row is inserted, updated or deleted. The catalog is empty at the time
--     of writing, but nothing here depends on that: every statement above is
--     DDL, and the table could hold a million rows without changing what it
--     does.
--   * no rollout flag is involved. STATEMENT_REQUIREMENTS stays off; it lives
--     in the deployment environment and no migration can set it.

commit;
