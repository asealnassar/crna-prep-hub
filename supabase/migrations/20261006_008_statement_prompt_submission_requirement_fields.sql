-- Personal Statement Studio V2 -- what else an applicant can tell us about a
-- prompt, and the link from a submission to the catalog row it became.
--
-- ADDITIVE ONLY. Ten nullable columns, four CHECK constraints on those columns,
-- one RELAXED constraint, and one widened column-level SELECT grant. No table
-- is created, no row is written, no row is read, no policy is created or
-- dropped, and no existing column changes type or nullability.
--
-- ---------------------------------------------------------------------------
-- WHY THESE COLUMNS, AND WHY NOT THE CANONICAL SHAPE
-- ---------------------------------------------------------------------------
-- 20261002_000 captured four things: the wording, a maximum word count, the
-- cycle and a source. That is what an applicant was asked for. It is not what
-- an applicant is GIVEN: a school's instruction page routinely names the
-- document, a page limit, a character limit, a font, a margin, and two
-- paragraphs of prose about what to include. Dropping all of it on the way in
-- means an administrator reviewing the submission has less than the applicant
-- had, and has to find the source again to recover it.
--
-- SO THESE ARE REPORTS, NOT CLASSIFICATIONS, and the naming says so. Every one
-- is prefixed `stated_` or suffixed `_hint`, or is plainly free prose. None of
-- them is the canonical column of the same name:
--
--   * document_type_hint is NOT statement_requirements.document_type. The
--     canonical column is constrained to nine reviewed values; this one is free
--     text, because an applicant must not have to learn our taxonomy to tell us
--     their school asked for a "Letter of Intent". The administrator maps it.
--
--   * NO ENFORCEMENT REGISTER IS CAPTURED AT ALL. 20261002_006 classifies a
--     limit as truncated / enforced / target / suggested / unknown, and that is
--     a JUDGEMENT about a school's wording. An applicant reporting "500 words
--     max" has not made it, and a column inviting them to would produce
--     reviewed-looking data nobody reviewed. The register is set by the
--     administrator during promotion, from the quotation this table preserves.
--
--   * AND NOTHING IS INFERRED FROM THEIR TEXT. No trigger, no generated column,
--     no parse. A submission is evidence; turning evidence into a register is
--     the review step.
--
-- ---------------------------------------------------------------------------
-- THE PAGE LIMIT, AND THE FRACTIONAL-PAGE PROBLEM WE ALREADY PAID FOR
-- ---------------------------------------------------------------------------
-- 20261005_007 widened min_pages/max_pages to numeric(4,1) because Boston
-- College asks for a page and a half and an integer column had been silently
-- reading it as NULL. The lesson was not "use numeric": it was that a number
-- which cannot represent the school's wording must not be the only record of
-- it.
--
-- So a page limit arrives as TWO columns, which is the same pattern 006 uses
-- for every register -- a value travelling with the quotation that justifies it:
--
--   stated_max_pages  numeric(4,1)  the number, when the applicant gave a clean
--                                   one. Same type as the canonical column, so
--                                   1.5 survives and nothing rounds at the
--                                   integer.
--   stated_pages_text text          their own words, preserved verbatim, for
--                                   everything a number cannot hold: "2 pages
--                                   double-spaced", "no more than a page and a
--                                   half excluding references", "1-2 pages".
--
-- NEITHER IS DERIVED FROM THE OTHER. The form offers a number box and a text
-- box; whatever the applicant fills in is stored as given. An administrator
-- promoting the submission reads both and decides.

begin;

-- ============================================================
-- 1. THE COLUMNS
-- ============================================================
-- All nullable. NULL means "the applicant did not say", which is a different
-- fact from zero or from an empty string and is never inferred.
alter table public.statement_prompt_submissions
  add column if not exists document_label          text,
  add column if not exists document_type_hint      text,
  add column if not exists stated_min_words        integer,
  add column if not exists stated_max_characters   integer,
  add column if not exists stated_max_pages        numeric(4,1),
  add column if not exists stated_pages_text       text,
  add column if not exists formatting_instructions text,
  add column if not exists other_instructions      text,
  add column if not exists submitter_note          text;

-- THE CATALOG LINK FOR V2, BESIDE THE ONE FOR V1.
--
-- approved_prompt_id already exists and points at public.statement_prompts --
-- the single-prompt catalog, which is what approval published when 20261002_000
-- was written. The reviewed catalog is now statement_requirements, and a
-- submission promoted into it has to say so without pretending to be a
-- statement_prompts row.
--
-- NO FOREIGN KEY, following every migration in this family: the schools capture
-- has not landed, and 20261002_000's header explains why these links are
-- deliberately unconstrained for now. The function in section 5 of the
-- promotion migration is the only writer.
alter table public.statement_prompt_submissions
  add column if not exists approved_requirement_id uuid;

-- ============================================================
-- 2. CONSTRAINTS ON THE NEW COLUMNS
-- ============================================================
-- drop-then-add, so this file is re-runnable against a partially applied table.

-- LENGTH CEILINGS, MEASURED AS GIVEN. The same two-clause shape
-- statement_prompt_submissions_text_length uses: btrim >= 1 refuses a field
-- that is only whitespace -- an applicant who typed nothing must leave NULL,
-- not an empty string, because '' would render as a present-but-blank field on
-- the review screen -- and the ceiling is measured on the text AS GIVEN so
-- trailing whitespace cannot push a row past the bound while passing the check.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_text_fields_length;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_text_fields_length
  check (
    (document_label is null
      or (char_length(btrim(document_label)) >= 1 and char_length(document_label) <= 200))
    and (document_type_hint is null
      or (char_length(btrim(document_type_hint)) >= 1
          and char_length(document_type_hint) <= 120))
    and (stated_pages_text is null
      or (char_length(btrim(stated_pages_text)) >= 1
          and char_length(stated_pages_text) <= 200))
    and (formatting_instructions is null
      or (char_length(btrim(formatting_instructions)) >= 1
          and char_length(formatting_instructions) <= 2000))
    and (other_instructions is null
      or (char_length(btrim(other_instructions)) >= 1
          and char_length(other_instructions) <= 2000))
    and (submitter_note is null
      or (char_length(btrim(submitter_note)) >= 1
          and char_length(submitter_note) <= 1000))
  );

-- NUMERIC RANGES, matching the existing stated_max_words bound where the unit
-- is the same and chosen to be generous where it is not. A submission outside
-- these is a typo or a paste accident, and refusing it at the boundary is
-- cheaper than reviewing it.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_stated_ranges;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_stated_ranges
  check (
    (stated_min_words is null or stated_min_words between 1 and 5000)
    and (stated_max_characters is null or stated_max_characters between 1 and 100000)
    -- numeric(4,1) already caps the precision; this caps the value and refuses
    -- zero, which is not a page limit.
    and (stated_max_pages is null or (stated_max_pages > 0 and stated_max_pages <= 99.9))
  );

-- A MINIMUM THAT EXCEEDS ITS MAXIMUM DESCRIBES NOTHING. Checked only when the
-- applicant supplied both; one bound alone is perfectly ordinary.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_word_bounds_ordered;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_word_bounds_ordered
  check (
    stated_min_words is null
    or stated_max_words is null
    or stated_min_words <= stated_max_words
  );

-- ============================================================
-- 3. APPROVAL AND PUBLICATION COME APART
-- ============================================================
-- THE OLD CONSTRAINT MADE THEM ONE THING, and that is the change this section
-- exists for. It read:
--
--   (status = 'approved' and approved_prompt_id is not null)
--   or (status <> 'approved' and approved_prompt_id is null)
--
-- which says an approved submission MUST already have published a catalog row.
-- That was true of the V1 flow, where deciding 'approved' inserted into
-- statement_prompts in the same function. It is not true of the reviewed
-- catalog: an administrator reads a submission, judges it sound, and then --
-- separately, deliberately, possibly days later -- converts it into a
-- statement_requirements row they have edited. Between those two acts the
-- submission is approved and nothing is published.
--
-- THE GUARANTEE THAT MATTERS IS KEPT, AND IT IS THE OTHER DIRECTION: a catalog
-- link may exist only on an approved row. A rejected or withdrawn submission
-- can never carry an id it has no claim to, which is what the original
-- constraint was protecting against. What is no longer required is the reverse
-- implication.
alter table public.statement_prompt_submissions
  drop constraint if exists statement_prompt_submissions_approval_shape;
alter table public.statement_prompt_submissions
  add constraint statement_prompt_submissions_approval_shape
  check (
    (approved_prompt_id is null and approved_requirement_id is null)
    or status = 'approved'
  );

-- ============================================================
-- 4. THE COLUMN-LEVEL SELECT GRANT, WIDENED
-- ============================================================
-- GRANT IS ADDITIVE, so this adds the new columns to the privilege authenticated
-- already holds and changes nothing else. The list is restated in full so the
-- file reads as the whole truth rather than a diff.
--
-- review_note AND reviewed_by ARE STILL ABSENT, AND THAT IS THE POINT. RLS
-- filters rows, never columns, so the own-row select policy would otherwise let
-- a submitter read an administrator's private note about them, and the identity
-- of the administrator who wrote it, straight from PostgREST. A column that is
-- not granted cannot be selected, aliased, ordered by, or filtered on.
--
-- approved_requirement_id IS GRANTED, because it is useful to its submitter --
-- "this became part of the catalog" is their own news -- and it discloses
-- nothing about anybody else.
grant select (
  id, submitted_by, school_id, prompt_text, stated_max_words, application_cycle,
  source_url, status, reviewed_at, approved_prompt_id, duplicate_of_id,
  text_fingerprint, created_at, updated_at,
  document_label, document_type_hint, stated_min_words, stated_max_characters,
  stated_max_pages, stated_pages_text, formatting_instructions,
  other_instructions, submitter_note, approved_requirement_id
) on public.statement_prompt_submissions to authenticated;

-- NO NEW INSERT, UPDATE OR DELETE GRANT, for any role. Every write to this
-- table still goes through the SECURITY DEFINER functions in 20261002_003 and
-- in the promotion migration. anon still gets nothing. service_role still gets
-- no table grant -- the privileged path is a function, not a privilege.

-- ============================================================
-- 5. COMMENTS
-- ============================================================
comment on column public.statement_prompt_submissions.document_type_hint is
  'The applicant''s own words for what kind of document this is. FREE TEXT, '
  'deliberately not the nine reviewed values of statement_requirements.'
  'document_type: an applicant must not have to learn our taxonomy. Mapped by '
  'an administrator during promotion.';

comment on column public.statement_prompt_submissions.stated_max_pages is
  'A page limit as a number, when the applicant gave a clean one. numeric(4,1) '
  'like the canonical column, so 1.5 survives. stated_pages_text holds their '
  'wording whenever a number cannot.';

comment on column public.statement_prompt_submissions.stated_pages_text is
  'The applicant''s own wording for a page limit, preserved verbatim. Exists '
  'because a number that cannot represent the school''s instruction must not be '
  'the only record of it -- the lesson of 20261005_007.';

comment on column public.statement_prompt_submissions.approved_requirement_id is
  'The public.statement_requirements row this submission was promoted into, or '
  'NULL. Set only by the promotion function, and only on an approved row. A '
  'value here does NOT mean the requirement is active: activation is a separate '
  'owner action and new sets are created is_active = false.';

commit;
