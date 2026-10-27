-- ===========================================================================
-- 014  Whole-document format profiles
-- ===========================================================================
--
-- NOT APPLIED. Drafted for review. Sequenced after 008-013, all unapplied.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS, AND WHAT IT IS CAREFULLY NOT
-- ---------------------------------------------------------------------------
-- Some schools require the WHOLE document in a named format. Two in the
-- verified catalog do:
--
--   Cedar Crest     "An essay ... using APA 7th edition format"
--   New Mexico State "Submit a 1-2 page essay using APA formatting"
--
-- In both, the format modifies the essay itself, so the deterministic layout
-- rules of that standard can be applied to the body.
--
-- MOST NAMED STANDARDS DO NOT MEAN THAT. The same catalog contains:
--
--   Keiser          "excluding cover and references in AMA format"
--                   -- AMA governs the REFERENCES, not the page.
--   Goldfarb        "Business letter format"
--   Gonzaga         "referenced; no named style is specified"
--   Saint Mary's    "BLINDED REVIEW -- no personal identifying information"
--
-- Folding those into a layout profile would reformat an essay on the strength
-- of a word, which is the mistake this column exists to make impossible: the
-- profile is set ONLY where the verified wording applies the format to the
-- document, and the normalizer records the decision per school.
--
-- ---------------------------------------------------------------------------
-- IT ADDS NO CONTENT
-- ---------------------------------------------------------------------------
-- A profile selects BODY layout rules. It never causes a title page, abstract,
-- reference list, running head or heading to be generated: those are content,
-- they consume the page allowance, and no school here asked for them. A
-- school that wants them has to say so in its own fields.
-- ---------------------------------------------------------------------------

begin;

alter table public.statement_requirements
  add column if not exists document_format_profile text;

comment on column public.statement_requirements.document_format_profile is
  'A named standard whose DETERMINISTIC BODY LAYOUT rules apply to the whole '
  'document, e.g. ''apa-7''. Null unless the verified wording applies the '
  'format to the essay itself. A citation style that governs only references '
  'belongs in citation_style, never here.';

alter table public.statement_requirements
  drop constraint if exists statement_requirements_format_profile_known;
alter table public.statement_requirements
  add constraint statement_requirements_format_profile_known
  check (document_format_profile is null or document_format_profile in ('apa-7'));

commit;

-- ---------------------------------------------------------------------------
-- WHY THE LIST HAS ONE VALUE
-- ---------------------------------------------------------------------------
-- Only APA 7 has been researched against its authoritative source and only
-- APA 7 has schools in this catalog that apply it to the document. Adding a
-- value here without doing that work for it would let a profile be set that
-- nothing can render correctly.
