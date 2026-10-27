-- Personal Statement Studio V2 -- the register a length was published in.
--
-- NOT APPLIED. This file is written and committed; nothing runs it. It is
-- additive only: EIGHT nullable columns on public.statement_requirements, each
-- with a CHECK -- six for the length register, and two for a length that is
-- shown and deliberately not bounded (section 1b, the owner's Option A): the
-- sentence, and whether that sentence is the school's own words. It creates no table, drops nothing, backfills nothing, touches
-- no policy, no grant, no function and no trigger, and does not alter
-- public.statement_drafts, public.statement_prompts or public.schools.
--
-- IT MUST BE APPLIED TOGETHER WITH 20261002_005 AND BEFORE THE FLAG IS SET.
-- 005 creates statement_requirements; this adds the register columns to it, and
-- lib/statement/requirements/repo.ts names those columns in its SELECT list. So
-- the ordering is 005, then 006, then STATEMENT_REQUIREMENTS=on. With 005
-- applied and 006 missing, the catalog read fails, requirementProvenance()
-- records 'read-failed' and refuses to vouch for any requirement -- which is
-- the safe direction, but it is a broken feature rather than a degraded one.
-- Neither migration is applied today and the flag is unset, so no deployed
-- database can be in that state.
--
-- WHY THIS EXISTS. Verifying all 83 programmes in the owner's research file
-- against their own published materials showed that a number is not a rule
-- until the school says so, and that schools say so in five different
-- registers. The same figure, 500, appears as:
--
--   University of Maryland        "no more than 350 words"              a cap
--   Southern Mississippi          "only the first two pages will be      a cap the
--                                  read if your essay goes over"         school enforces
--   University of South Dakota    "A written 500 word statement"        a length, never
--                                                                        called a limit
--   UC Davis                      "Suggested Length: Maximum of 250     a suggestion
--                                   words"
--   Wayne State University        "a summary (1-2 pages) double-spaced" unresolvable from
--                                                                        the source
--
-- Before these columns, all five stored as max_words/max_pages and warned
-- identically, so the product told a South Dakota applicant they had broken a
-- limit South Dakota never set. Of the 109 writing documents verified, 27 carry
-- an explicit word maximum, 9 a word range, 2 a stated length that is not a
-- maximum, 8 an explicitly advisory length, 38 a page limit alone and 25 no
-- length at all. The soft registers are not an edge case.
--
-- TYPED COLUMNS, CONSISTENT WITH 005. That migration chose typed constraint
-- columns over one jsonb blob "so the database can refuse a negative maximum
-- and a reader can see what is storable". The same reasoning applies to a
-- register: a CHECK can refuse 'definitely-a-maximum-trust-me', and a jsonb
-- blob cannot.
--
-- NO UNIT IS STILL DERIVED FROM ANOTHER. This migration adds no words-per-page
-- column, no estimate column and no conversion. A school that stated pages
-- still has min_words and max_words NULL, in every register, for ever.

-- ============================================================
-- 1. THE REGISTER COLUMNS
-- ============================================================
--
-- NULL MEANS "NOT RECORDED", WHICH IS READ AS 'enforced'. Three facts have to
-- stay distinguishable and all three already have a representation:
--
--   max_words NULL                       the school stated no word maximum
--   max_words 500, enforcement NULL      a maximum, register not recorded --
--                                        read as 'enforced', because that is
--                                        what this product has always done with
--                                        a stored maximum, and softening it
--                                        would withdraw a warning from every
--                                        existing draft
--   max_words 500, enforcement 'target'  a stated length that is not a maximum
--
-- A DEFAULT IS DELIBERATELY NOT SET. `default 'enforced'` would write the
-- strict register onto every future row that forgot to state one, making "not
-- recorded" indistinguishable from "checked, and it really is a cap". NULL
-- keeps the distinction in the database; parseEnforcement() in TypeScript is
-- the single place the strict reading is applied, and it is shared by the
-- snapshot parser and the catalog reader so the two cannot diverge.

alter table public.statement_requirements
  add column if not exists words_enforcement text;

-- The school's own sentence about the word limit, verbatim.
--
-- A QUOTATION IS NOT A CLASSIFICATION. Deciding that "Suggested Length:
-- Maximum of 250 words" is advisory is a judgement; quoting it is not. The
-- quotation travels with the judgement so an applicant can read what the school
-- actually wrote whenever the two could be read differently, and so a reviewer
-- can audit the classification without going back to the source.
alter table public.statement_requirements
  add column if not exists words_stated_as text;

alter table public.statement_requirements
  add column if not exists characters_enforcement text;
alter table public.statement_requirements
  add column if not exists characters_stated_as text;

-- PAGES GET A REGISTER TOO, even though nothing measures pages. "Recommend 2-4
-- pages" (UT Tyler) and "only the first two pages will be read" (Southern
-- Mississippi) are both unmeasurable in a plain-text editor and are not
-- remotely the same instruction. The register is what lets the interface say
-- which one an applicant is reading, without ever claiming to have counted a
-- page.
alter table public.statement_requirements
  add column if not exists pages_enforcement text;
alter table public.statement_requirements
  add column if not exists pages_stated_as text;

-- ============================================================
-- 1b. A LENGTH SHOWN AND NOT ENFORCED
-- ============================================================
--
-- THE OWNER'S APPROVED ANSWER FOR AN UNCONFIRMED LIMIT (Option A). Nine
-- verified programmes publish a length with no wording anywhere that says
-- whether it is a maximum, a minimum or a suggestion: Arkansas State's
-- "consisting of 500-1,000 words", Michigan-Flint's "Essay of 500 to 1000
-- words", Idaho State's "A 2-3 page essay", Wayne State's "a summary (1-2
-- pages)". The decision is to show the applicant the school's sentence and
-- enforce nothing.
--
-- SO THE SENTENCE NEEDS A HOME WITH NO BOUND BESIDE IT, and the register
-- columns above cannot provide one: section 2's CHECKs require min/max in a
-- unit before that unit may carry a register or a quotation, which is correct
-- for a register and exactly wrong here. This column has no such requirement,
-- because its whole purpose is to exist WITHOUT a bound.
--
-- WHY NOT other_instructions. That jsonb array is the holding pen for
-- instructions with no structured home -- "business letter format", "excluding
-- cover and references" -- and nothing downstream knows what any element of it
-- means. The interface has to say "this is a LENGTH and we are not enforcing
-- it" and the analyser has to be told not to penalise exceeding it; neither is
-- possible for an anonymous string in a list.
--
-- IT IS NOT A LIMIT AND NOTHING MAY TREAT IT AS ONE. No TypeScript path
-- compares a draft against it: measurableInEditor() is false for its kind,
-- overages() cannot produce one from prose, and legacyProjection() has nothing
-- to project into stated_max_words. It is displayed, quoted to the model with
-- an instruction not to penalise it, and digested so a change to the wording
-- costs a new analysis.
alter table public.statement_requirements
  add column if not exists unenforced_length text;

-- WHETHER THAT SENTENCE IS THE SCHOOL'S OWN WORDS.
--
-- THE FLAG DECIDES WHETHER QUOTATION MARKS APPEAR, which makes it the whole
-- meaning of the column above. `unenforced_length` is SHOWN to an applicant in
-- place of a bound, introduced either as "The school states: ..." or as
-- "Recorded requirement, not the school's exact wording: ...". A paraphrase
-- presented as the school's sentence is a misattribution the applicant cannot
-- detect and cannot check.
--
-- NULL READS AS false IN BOTH READERS, deliberately. A row written without the
-- flag is shown as a summary, because under-claiming costs a little authority
-- and over-claiming invents a sentence. `default` is omitted for the same
-- reason the register columns omit it: "not recorded" and "recorded as false"
-- stay distinguishable in the database, and the strict reading is applied in
-- one place in TypeScript.
--
-- IT IS A SEPARATE FACT FROM is_verbatim ON THE SET, which says whether the
-- set's original_text is quoted. One set can hold a quoted prompt and a
-- summarised length, or the reverse; collapsing them would lose that.
alter table public.statement_requirements
  add column if not exists unenforced_length_verbatim boolean;

-- A FLAG WITHOUT A SENTENCE DESCRIBES NOTHING. It is refused, so a row cannot
-- claim "verbatim" about text it does not carry.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_unenforced_verbatim_needs_text;
alter table public.statement_requirements
  add constraint statement_requirements_unenforced_verbatim_needs_text
  check (unenforced_length_verbatim is null or unenforced_length is not null);

-- A SENTENCE, NOT AN ESSAY, and not an empty string. Blank is refused here as
-- well as in the readers, because an empty quotation renders as a notice with
-- nothing in it.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_unenforced_length_text;
alter table public.statement_requirements
  add constraint statement_requirements_unenforced_length_text
  check (unenforced_length is null
         or char_length(btrim(unenforced_length)) between 1 and 2000);

-- A ROW MAY NOT BOTH SHOW A LENGTH AND BOUND IT IN THE SAME UNIT.
--
-- THIS IS THE DATABASE REFUSING THE CONTRADICTION. "We do not know whether this
-- is a limit" and "the maximum is 1,000" cannot both be true of the same
-- document, and a row carrying both would hand the interface two answers and
-- let whichever path ran first decide. Option A means the bound is NULL, so the
-- schema says so.
--
-- A WORD BOUND IS STILL ALLOWED BESIDE A PAGE SENTENCE and vice versa, because
-- those are different units and a school may well confirm one and not the
-- other. What is refused is a bound in ANY unit alongside a sentence that says
-- the length is unconfirmed -- which is the conservative reading, and the one
-- the nine documents actually need.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_unenforced_length_has_no_bound;
alter table public.statement_requirements
  add constraint statement_requirements_unenforced_length_has_no_bound
  check (
    unenforced_length is null
    or (min_words is null and max_words is null
        and min_characters is null and max_characters is null
        and min_pages is null and max_pages is null)
  );

-- ============================================================
-- 2. CONSTRAINTS
-- ============================================================
--
-- DROP-THEN-ADD, matching 005's style, so re-running this file is safe.
--
-- A NOTE ON CHECK SEMANTICS, because it bit this schema once already: a CHECK
-- passes when its expression is TRUE **or NULL**. Every condition below is
-- therefore written so that the NULL case is the one it intends to allow, and
-- the `is null or ...` prefixes are load-bearing rather than defensive noise.

-- The five registers and nothing else. An unrecognised value is refused here
-- rather than being quietly degraded in TypeScript, because a row that reached
-- the database with 'advisory-ish' in it would be read as the STRICT register
-- by parseEnforcement() -- safe, but not what whoever wrote it meant.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_words_enforcement_known;
alter table public.statement_requirements
  add constraint statement_requirements_words_enforcement_known
  check (words_enforcement is null
         or words_enforcement in ('truncated', 'enforced', 'target', 'suggested', 'unknown'));

alter table public.statement_requirements
  drop constraint if exists statement_requirements_characters_enforcement_known;
alter table public.statement_requirements
  add constraint statement_requirements_characters_enforcement_known
  check (characters_enforcement is null
         or characters_enforcement in ('truncated', 'enforced', 'target', 'suggested',
                                       'unknown'));

alter table public.statement_requirements
  drop constraint if exists statement_requirements_pages_enforcement_known;
alter table public.statement_requirements
  add constraint statement_requirements_pages_enforcement_known
  check (pages_enforcement is null
         or pages_enforcement in ('truncated', 'enforced', 'target', 'suggested', 'unknown'));

-- A REGISTER DESCRIBES A LIMIT, SO IT NEEDS ONE. 'suggested' with no bound and
-- no stated wording describes nothing; it would render as an empty chip and
-- would be invisible in the digest. Each register is allowed only where its own
-- unit has at least one bound.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_words_register_needs_limit;
alter table public.statement_requirements
  add constraint statement_requirements_words_register_needs_limit
  check (
    (words_enforcement is null or min_words is not null or max_words is not null)
    and (words_stated_as is null or min_words is not null or max_words is not null)
  );

alter table public.statement_requirements
  drop constraint if exists statement_requirements_characters_register_needs_limit;
alter table public.statement_requirements
  add constraint statement_requirements_characters_register_needs_limit
  check (
    (characters_enforcement is null
     or min_characters is not null or max_characters is not null)
    and (characters_stated_as is null
         or min_characters is not null or max_characters is not null)
  );

-- PAGE SPACING ALONE COUNTS AS A PAGE REQUIREMENT. 005 builds a PageLimit when
-- page_spacing is set even with no bounds -- "double-spaced" with no page count
-- is a real instruction -- so the register is permitted there too.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_pages_register_needs_limit;
alter table public.statement_requirements
  add constraint statement_requirements_pages_register_needs_limit
  check (
    (pages_enforcement is null
     or min_pages is not null or max_pages is not null or page_spacing is not null)
    and (pages_stated_as is null
         or min_pages is not null or max_pages is not null or page_spacing is not null)
  );

-- TRUNCATION NEEDS A MAXIMUM TO TRUNCATE AT. "We read only the first N" is
-- meaningless without N. A minimum cannot be truncated at, so 'truncated' is
-- refused unless the unit has an upper bound -- for pages, that bound is
-- max_pages, since "only the first N pages" is how every verified example of
-- this register is worded.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_truncation_needs_maximum;
alter table public.statement_requirements
  add constraint statement_requirements_truncation_needs_maximum
  check (
    (words_enforcement is distinct from 'truncated' or max_words is not null)
    and (characters_enforcement is distinct from 'truncated' or max_characters is not null)
    and (pages_enforcement is distinct from 'truncated' or max_pages is not null)
  );

-- A quotation is a sentence, not an essay. The same ceiling 005 uses for
-- citation_style and the other free-text fields of this table.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_stated_as_length;
alter table public.statement_requirements
  add constraint statement_requirements_stated_as_length
  check (
    (words_stated_as is null or char_length(btrim(words_stated_as)) between 1 and 2000)
    and (characters_stated_as is null
         or char_length(btrim(characters_stated_as)) between 1 and 2000)
    and (pages_stated_as is null or char_length(btrim(pages_stated_as)) between 1 and 2000)
  );

-- ============================================================
-- 3. WHAT THIS FILE DOES NOT DO
-- ============================================================
--
-- NO BACKFILL. statement_requirements has no rows: 005 is unapplied and nothing
-- has ever been imported into it. There is nothing to backfill and no UPDATE
-- statement anywhere in this file.
--
-- NO CHANGE TO statement_drafts. The register reaches a draft inside the
-- existing requirement_snapshot jsonb, which 005 already added and which the
-- TypeScript parser reads field by field. An old snapshot has no register, the
-- parser reads that as the strict default, and the draft behaves exactly as it
-- did -- including keeping its cached analysis, because requirementDigest()
-- omits the register entirely when every one of them is the default.
--
-- NO CHANGE TO stated_max_words FOR ANY EXISTING ROW. What changed is which
-- FUTURE requirement-backed drafts get a value there: legacyProjection() now
-- writes a word maximum into that column only when the school made it a rule.
-- No existing row is rewritten by this migration or by that code.
--
-- NO GRANTS. The two tables' grants were settled in 005 and are column-blind
-- for SELECT; adding columns to a table whose SELECT is already granted needs
-- no further grant, and this file deliberately issues none.
