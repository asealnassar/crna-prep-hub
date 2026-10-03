-- Personal Statement Studio V2 -- structured school writing requirements.
--
-- ADDITIVE ONLY. This migration creates TWO new tables and adds TWO new
-- nullable columns to public.statement_drafts. It does not touch, rewrite,
-- backfill or delete any existing row, column, index, policy, grant, function
-- or trigger. In particular it does NOT alter public.statement_prompts, does
-- NOT alter the applicant-submission tables from 20261002_000..003, does NOT
-- change their rollout flag, and does NOT modify public.schools.
--
-- WHY THESE TABLES EXIST. statement_prompts models exactly one shape: one
-- school, one question, optionally one word maximum. Real programmes ask for
-- more than that. From the owner's research file of 83 programmes: one asks for
-- three separate 500-word statements; one asks for two separate documents at
-- one page each with no word count; one asks for a four-page statement
-- answering three prompts PLUS a separate 500-word essay; one offers a choice
-- of two prompts PLUS a required 250-word response; one asks for five answers
-- limited to 2,500 CHARACTERS each; one asks for a single 1,000-word essay
-- addressing four questions and an optional fifth. None of those can be stored
-- in one row of one question and one word count.
--
-- THE MODEL HAS TWO LEVELS. A SET is everything one school asks for, from one
-- reading of their materials. A REQUIREMENT is one DOCUMENT within that set:
-- one thing the applicant submits, with its own draft, its own limits and its
-- own analysis. Questions INSIDE a document are not rows -- they are the
-- `components` array on the document, because a question inside an essay is not
-- a separate essay. That single distinction is what the whole design rests on.
--
-- statement_prompts IS NOT DEPRECATED BY THIS FILE AND IS NOT MIGRATED INTO IT.
-- The live Arkansas State prompt stays exactly where it is and keeps working.
-- A draft created against the old catalog keeps prompt_id pointing at
-- statement_prompts; a draft created against the new one sets requirement_id
-- instead. The two coexist, the application reads whichever a draft has, and
-- nothing rewrites anybody's saved work. Consolidating the two catalogs is a
-- later, separate decision that this migration deliberately does not force.
--
-- NO FOREIGN KEY TO public.schools, for the reason 20260930_000 gives at
-- length: that table predates the migrations directory and exists only in
-- production, so a REFERENCES clause would make this file fail on CI, on a
-- local Supabase and on any rebuilt staging while succeeding only against
-- production. school_id is uuid NOT NULL and carries the same value as
-- schools.id. The FK is a two-line follow-up once schools is under migration
-- control.
--
-- WHAT IS DELIBERATELY ABSENT:
--
--   * Seed rows. No requirement is populated by this migration. The 83
--     researched programmes are NOT imported, here or anywhere.
--   * An updated_at trigger. Whatever writes a row sets updated_at, as
--     statement_prompts and statement_drafts already do.
--   * Write policies and write grants for browser roles. See section 6.
--   * Any change to statement_drafts.prompt_text or stated_max_words. Those
--     columns keep their meaning and keep being written: a structured
--     requirement PROJECTS onto them (prompt text, and the word maximum when
--     there is one), which is what lets the existing editor, eligibility floor
--     and over-limit warning work unchanged. A page or character limit projects
--     to NULL in stated_max_words, because null already means "no stated word
--     limit" and that is the truth.
--
-- ROLLOUT. Nothing reads these tables unless STATEMENT_REQUIREMENTS=on. With
-- the flag unset -- which is every environment as this file is written -- the
-- application issues no query that names them, so applying this migration
-- changes no behaviour and not applying it breaks none.

begin;

-- ============================================================
-- 1. THE SET -- one school's requirements, from one reading
-- ============================================================
create table if not exists public.statement_requirement_sets (
  id                uuid        primary key default gen_random_uuid(),

  -- Same uuid as public.schools.id. No FK yet; see the header.
  school_id         uuid        not null,

  -- 'YYYY' or 'YYYY-YYYY'. NULL means not cycle-specific, exactly as
  -- statement_prompts.application_cycle means it.
  application_cycle text,

  -- ---------------------------------------------------------- provenance
  --
  -- THE FOUR FIELDS THAT DECIDE WHETHER AN APPLICANT MAY BE SHOWN THIS AS
  -- FACT. A requirement is research until somebody has checked it against the
  -- school's own current materials and recorded where and when. Until then it
  -- must not be presented as a requirement, which is what section 2's
  -- activation constraint enforces in the database rather than in code.
  --
  -- 'unverified' IS THE DEFAULT, deliberately. A row inserted by somebody who
  -- forgot to set this is not accidentally authoritative.
  verification_status text      not null default 'unverified',

  -- The page it was read from. NULL when nobody recorded one. Never invented.
  source_url        text,

  -- The date the check was made. NULL when never checked. Never invented.
  verified_on       date,

  -- TRUE only when original_text is the school's own words, unaltered.
  --
  -- A SEPARATE FACT FROM verification_status, and the two must not be merged: a
  -- quotation can be stale and a paraphrase can be current. Collapsing them
  -- would let a summary be shown as a quotation, which is the specific failure
  -- the Arkansas State entry was written to avoid.
  is_verbatim       boolean     not null default false,

  -- The requirement as recorded, before anybody structured it.
  --
  -- KEPT SO THE STRUCTURING CAN BE AUDITED. Every typed constraint on every
  -- requirement below was derived from this text by a human. When the two
  -- disagree, this is the evidence and the structure is the error.
  original_text     text        not null default '',

  -- Set-level uncertainty: conflicts between sources, scope questions. One
  -- note per element. Shown to the applicant; never resolved silently.
  notes             jsonb       not null default '[]'::jsonb,

  is_active         boolean     not null default true,
  display_order     integer     not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================================================
-- 2. SET CONSTRAINTS
-- ============================================================
-- drop-then-add throughout, so this file is re-runnable against a table that
-- already exists from a partial application.

alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_status_known;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_status_known
  check (verification_status in ('unverified', 'needs-review', 'verified', 'conflicting'));

-- Same shape as statement_prompts_cycle_format, anchored at both ends.
alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_cycle_format;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_cycle_format
  check (application_cycle is null or application_cycle ~ '^[0-9]{4}(-[0-9]{4})?$');

alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_original_length;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_original_length
  check (char_length(original_text) <= 20000);

-- An http(s) URL or nothing. Not a validator -- it refuses the obvious
-- mistakes (a bare domain, a javascript: scheme) and nothing more.
alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_source_url_shape;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_source_url_shape
  check (source_url is null or source_url ~ '^https?://[^[:space:]]+$');

alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_notes_array;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_notes_array
  check (jsonb_typeof(notes) = 'array');

alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_display_order_nonneg;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_display_order_nonneg
  check (display_order >= 0);

-- THE ONE THAT MATTERS: A SET CANNOT BE ACTIVE WITHOUT EVIDENCE.
--
-- An active set must be 'verified' AND carry a source URL AND carry a date.
-- Anything else may exist -- research is worth storing -- but is_active must be
-- false, and section 6's RLS policy makes inactive rows invisible to browsers.
--
-- WHY THIS IS A CHECK AND NOT A CODE PATH. The TypeScript gate
-- (activatableForApplicants) already refuses to show an unverified entry, and
-- this constraint is the second, independent answer: an UPDATE run by hand in
-- the SQL editor at two in the morning cannot flip is_active on a row nobody
-- checked. A status of 'conflicting' can never be active at all, because
-- sources that disagree have no single correct value to publish.
alter table public.statement_requirement_sets
  drop constraint if exists statement_requirement_sets_active_needs_evidence;
alter table public.statement_requirement_sets
  add constraint statement_requirement_sets_active_needs_evidence
  check (
    is_active = false
    or (
      verification_status = 'verified'
      and source_url is not null
      and verified_on is not null
    )
  );

-- ============================================================
-- 3. THE REQUIREMENT -- one document
-- ============================================================
create table if not exists public.statement_requirements (
  id                uuid        primary key default gen_random_uuid(),

  -- ON DELETE CASCADE is safe here and is not safe on a draft. A set and its
  -- documents are one editorial object: deleting the set deletes rows nobody
  -- has written against, because a DRAFT never references this table with a
  -- foreign key -- it stores a frozen snapshot instead. See section 5.
  set_id            uuid        not null
                                references public.statement_requirement_sets(id)
                                on delete cascade,

  -- Denormalised from the set so the picker's query filters on one table.
  -- Kept consistent by whatever writes the row; no trigger, following this
  -- repository's convention of not adding triggers for derived columns.
  school_id         uuid        not null,

  -- 'personal-statement', 'goal-statement', 'diversity-statement',
  -- 'writing-sample', 'additional-response', 'other'. Constrained below.
  document_type     text        not null default 'other',

  -- What a card shows: "Personal Statement", "Essay 2". Not the question.
  label             text        not null,

  -- The question or instructions for THIS document, as recorded. A draft
  -- stores its own snapshot, so editing this can never retroactively change
  -- the question an essay was written to answer.
  prompt_text       text        not null,

  -- The school's own questions INSIDE this one document.
  --
  -- AN ARRAY OF {id, text, optional}, AND NOT ROWS, because a question is not a
  -- document: it has no draft, no limits of its own and no separate analysis.
  -- Making them rows would make "four questions in one essay" and "four
  -- separate essays" the same shape in this schema, which is precisely the
  -- distinction the product has to get right.
  --
  -- EMPTY IS THE COMMON CASE and means one undivided prompt.
  components        jsonb       not null default '[]'::jsonb,

  -- ---------------------------------------------------------- the limits
  --
  -- TYPED COLUMNS, NOT ONE jsonb BLOB, so the database can refuse a negative
  -- maximum and a reader can see what is storable. Every one is nullable and
  -- NULL means THE SCHOOL DID NOT STATE ONE -- which is a different fact from
  -- zero and from "no limit", and must stay distinguishable.
  --
  -- AND NO UNIT IS DERIVED FROM ANOTHER. There is no column holding "estimated
  -- words" for a page limit, because that number would be this product
  -- inventing an admissions requirement. A school that stated pages has
  -- min_words and max_words NULL, for ever.
  min_words         integer,
  max_words         integer,

  min_characters    integer,
  max_characters    integer,
  -- TRUE = including spaces, FALSE = excluding, NULL = the school did not say.
  -- Three-valued on purpose: the two readings differ by about a sixth of the
  -- text, so guessing is not available.
  characters_include_spaces boolean,

  min_pages         integer,
  max_pages         integer,
  -- 'single' | 'double' | NULL. Part of what a page limit MEANS.
  page_spacing      text,

  font_size_pt      integer,
  font_family       text,
  margins_inches    numeric(4,2),

  -- The school's own wording: 'APA 7th edition', 'AMA format'. The edition is
  -- part of the requirement, so this is not reduced to a family code.
  citation_style    text,
  citation_family   text,
  min_references    integer,

  -- Requirements with no structured home, verbatim. One per array element.
  other_instructions jsonb      not null default '[]'::jsonb,

  -- ---------------------------------------------------------- shape
  --
  -- NULL means always required or always optional. A non-null value means PICK
  -- ONE OF THESE: every requirement in a set sharing the string is an
  -- alternative to the others, and the applicant writes exactly one.
  choice_group      text,

  -- A supplement the school invites but does not require.
  is_optional       boolean     not null default false,

  -- Document-level uncertainty. Array of strings, like the set's.
  notes             jsonb       not null default '[]'::jsonb,

  is_active         boolean     not null default true,
  display_order     integer     not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================================================
-- 4. REQUIREMENT CONSTRAINTS
-- ============================================================
alter table public.statement_requirements
  drop constraint if exists statement_requirements_document_type_known;
alter table public.statement_requirements
  add constraint statement_requirements_document_type_known
  check (document_type in ('personal-statement', 'goal-statement', 'diversity-statement',
                           'writing-sample', 'additional-response', 'other'));

-- Matches statement_prompts_label_length exactly.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_label_length;
alter table public.statement_requirements
  add constraint statement_requirements_label_length
  check (char_length(btrim(label)) between 1 and 200);

-- Matches statement_prompts_text_length exactly: the trimmed length must be at
-- least one so a prompt of spaces is refused, and the UNTRIMMED length is what
-- is capped, so trailing whitespace cannot push a row past the ceiling.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_prompt_length;
alter table public.statement_requirements
  add constraint statement_requirements_prompt_length
  check (char_length(btrim(prompt_text)) >= 1 and char_length(prompt_text) <= 5000);

alter table public.statement_requirements
  drop constraint if exists statement_requirements_components_array;
alter table public.statement_requirements
  add constraint statement_requirements_components_array
  check (jsonb_typeof(components) = 'array' and jsonb_array_length(components) <= 25);

alter table public.statement_requirements
  drop constraint if exists statement_requirements_other_instructions_array;
alter table public.statement_requirements
  add constraint statement_requirements_other_instructions_array
  check (jsonb_typeof(other_instructions) = 'array'
         and jsonb_array_length(other_instructions) <= 25);

alter table public.statement_requirements
  drop constraint if exists statement_requirements_notes_array;
alter table public.statement_requirements
  add constraint statement_requirements_notes_array
  check (jsonb_typeof(notes) = 'array');

-- EVERY LIMIT: NULL OR A SENSIBLE POSITIVE NUMBER.
--
-- The explicit `is null or` is retained throughout for the reason
-- 20260930_001 states: a PostgreSQL CHECK passes on TRUE *or NULL*, so a bare
-- range would already admit NULL -- but writing it out says in the constraint
-- text that NULL is permitted rather than overlooked.
alter table public.statement_requirements
  drop constraint if exists statement_requirements_word_bounds;
alter table public.statement_requirements
  add constraint statement_requirements_word_bounds
  check (
    (min_words is null or min_words between 1 and 20000)
    and (max_words is null or max_words between 1 and 20000)
    -- A minimum above the maximum is not a requirement, it is a typo.
    and (min_words is null or max_words is null or min_words <= max_words)
  );

alter table public.statement_requirements
  drop constraint if exists statement_requirements_character_bounds;
alter table public.statement_requirements
  add constraint statement_requirements_character_bounds
  check (
    (min_characters is null or min_characters between 1 and 200000)
    and (max_characters is null or max_characters between 1 and 200000)
    and (min_characters is null or max_characters is null or min_characters <= max_characters)
    -- characters_include_spaces describes a character limit. Without one it is
    -- an answer to a question nobody asked, and would be read as a limit.
    and (characters_include_spaces is null
         or min_characters is not null or max_characters is not null)
  );

alter table public.statement_requirements
  drop constraint if exists statement_requirements_page_bounds;
alter table public.statement_requirements
  add constraint statement_requirements_page_bounds
  check (
    (min_pages is null or min_pages between 1 and 200)
    and (max_pages is null or max_pages between 1 and 200)
    and (min_pages is null or max_pages is null or min_pages <= max_pages)
  );

alter table public.statement_requirements
  drop constraint if exists statement_requirements_page_spacing_known;
alter table public.statement_requirements
  add constraint statement_requirements_page_spacing_known
  check (page_spacing is null or page_spacing in ('single', 'double'));

alter table public.statement_requirements
  drop constraint if exists statement_requirements_typography_bounds;
alter table public.statement_requirements
  add constraint statement_requirements_typography_bounds
  check (
    (font_size_pt is null or font_size_pt between 4 and 72)
    and (font_family is null or char_length(btrim(font_family)) between 1 and 100)
    and (margins_inches is null or margins_inches between 0 and 6)
  );

alter table public.statement_requirements
  drop constraint if exists statement_requirements_citation_shape;
alter table public.statement_requirements
  add constraint statement_requirements_citation_shape
  check (
    (citation_family is null or citation_family in ('apa', 'ama', 'other'))
    and (min_references is null or min_references between 1 and 500)
    -- A family or a reference count without the school's own wording is a
    -- claim with nothing to show the applicant.
    and (citation_style is not null
         or (citation_family is null and min_references is null))
    and (citation_style is null or char_length(btrim(citation_style)) between 1 and 200)
  );

alter table public.statement_requirements
  drop constraint if exists statement_requirements_choice_group_shape;
alter table public.statement_requirements
  add constraint statement_requirements_choice_group_shape
  check (choice_group is null or char_length(btrim(choice_group)) between 1 and 100);

alter table public.statement_requirements
  drop constraint if exists statement_requirements_display_order_nonneg;
alter table public.statement_requirements
  add constraint statement_requirements_display_order_nonneg
  check (display_order >= 0);

-- ============================================================
-- 5. THE DRAFT'S LINK -- two nullable columns
-- ============================================================
-- NULL ON EVERY EXISTING ROW, and that is the whole backward-compatibility
-- story. A draft saved before this migration has requirement_id NULL and
-- requirement_snapshot NULL, reads exactly as it does today through
-- prompt_id/prompt_text/stated_max_words, and is never rewritten.
alter table public.statement_drafts
  add column if not exists requirement_id uuid;

-- The frozen requirement: document type, label, prompt, components, every
-- limit, the chosen alternative, provenance and notes, as of creation.
--
-- WHY A SNAPSHOT AND NOT A FOREIGN KEY. The same reason prompt_text is already
-- snapshotted onto the draft: a draft answers the question its author read. A
-- school rewords a prompt, a researcher corrects a limit, an entry is
-- deactivated -- and none of that may retroactively change what an essay was
-- written against or what it was analysed against. The snapshot is also what
-- makes the analysis cache honest: the fingerprint is computed over it, so a
-- cached result is tied to the exact requirement text it judged.
--
-- WHY jsonb AND NOT MORE COLUMNS. Fifteen nullable constraint columns on
-- statement_drafts would be fifteen columns that only matter to one feature,
-- and the shape is read and written in one place by one parser that already
-- refuses malformed input field by field. requirement_id stays a real column
-- because it is the thing queries filter and group by.
--
-- NO FOREIGN KEY ON requirement_id, deliberately. A requirement may be deleted
-- or superseded; the draft must survive that with its snapshot intact. A
-- REFERENCES clause would either block the delete or cascade away somebody's
-- essay.
alter table public.statement_drafts
  add column if not exists requirement_snapshot jsonb;

-- An object or nothing. The TypeScript parser does the field-by-field work and
-- returns null for anything malformed; this refuses the category error.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_requirement_snapshot_object;
alter table public.statement_drafts
  add constraint statement_drafts_requirement_snapshot_object
  check (requirement_snapshot is null or jsonb_typeof(requirement_snapshot) = 'object');

-- THE TWO TRAVEL TOGETHER. A snapshot with no id cannot be grouped by
-- document; an id with no snapshot is a pointer to wording that may since have
-- changed, which defeats the point of snapshotting.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_requirement_pair;
alter table public.statement_drafts
  add constraint statement_drafts_requirement_pair
  check ((requirement_id is null) = (requirement_snapshot is null));

-- A DRAFT IS EITHER PROMPT-BACKED OR REQUIREMENT-BACKED, NEVER BOTH.
--
-- prompt_id means a public.statement_prompts row -- that is what 20260930_001
-- declared it to be -- and requirement_id means a public.statement_requirements
-- row. A draft carrying both is making two claims about one question, and
-- whichever a reader joined on first would decide what the essay is judged
-- against. So the two are mutually exclusive here, and draftPromptFrom()
-- refuses the same combination independently in TypeScript.
--
-- THIS PERMITS BOTH BEING NULL, which is a general statement, and it leaves
-- every existing row valid: they all have requirement_id NULL.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_one_prompt_source;
alter table public.statement_drafts
  add constraint statement_drafts_one_prompt_source
  check (prompt_id is null or requirement_id is null);

-- AND A REQUIREMENT-BACKED DRAFT MUST CARRY ITS SCHOOL AND ITS WORDING.
-- The projection writes both, so this refuses a hand-made row that set
-- requirement_id while leaving the columns the editor and the analyser read.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_requirement_needs_prompt_text;
alter table public.statement_drafts
  add constraint statement_drafts_requirement_needs_prompt_text
  check (
    requirement_id is null
    or (school_id is not null and prompt_text is not null)
  );

-- ============================================================
-- 6. INDEXES
-- ============================================================
-- The picker's query: this school's active sets, in order.
create index if not exists statement_requirement_sets_school_active_order_idx
  on public.statement_requirement_sets (school_id, is_active, display_order);

-- A set's active documents, in order. Covers both the by-set read and the
-- by-school read the checklist needs.
create index if not exists statement_requirements_set_active_order_idx
  on public.statement_requirements (set_id, is_active, display_order);
create index if not exists statement_requirements_school_active_idx
  on public.statement_requirements (school_id, is_active);

-- "Which of this school's documents have I already started?" -- the checklist's
-- own query. PARTIAL, because the overwhelming majority of drafts have no
-- requirement and indexing their NULLs would be dead weight.
create index if not exists statement_drafts_user_requirement_idx
  on public.statement_drafts (user_id, requirement_id)
  where requirement_id is not null;

-- ============================================================
-- 7. ROW LEVEL SECURITY
-- ============================================================
-- READ-ONLY FOR EVERY BROWSER ROLE, exactly as statement_prompts is, and for
-- the same reason: this is reference data an applicant reads, and it feeds the
-- analysis prompt. A row a browser could fabricate is a sentence a browser
-- could put in front of the model.
--
-- TWO INDEPENDENT REASONS WRITES ARE IMPOSSIBLE, both present:
--   1. RLS is enabled with no insert/update/delete policy, and a missing
--      policy is a denial.
--   2. Section 8 grants no write privilege, so the command is refused before a
--      policy is consulted.
alter table public.statement_requirement_sets enable row level security;
alter table public.statement_requirements enable row level security;

drop policy if exists "active requirement set select" on public.statement_requirement_sets;

-- `using (is_active)` is the whole predicate, and section 2's constraint means
-- an active row is necessarily a verified one with a source and a date. So the
-- RLS predicate and the editorial rule "do not show applicants unverified
-- requirements" are the same condition, enforced once.
create policy "active requirement set select" on public.statement_requirement_sets
  for select to anon, authenticated using (is_active);

drop policy if exists "active requirement select" on public.statement_requirements;

-- A DOCUMENT IS VISIBLE ONLY IF ITS SET IS. Without the EXISTS clause a
-- document would remain readable after its set was deactivated, which is how a
-- withdrawn requirement leaks back into a picker.
create policy "active requirement select" on public.statement_requirements
  for select to anon, authenticated using (
    is_active
    and exists (
      select 1 from public.statement_requirement_sets s
      where s.id = statement_requirements.set_id and s.is_active
    )
  );

-- ============================================================
-- 8. GRANTS -- revoke first, because GRANT is additive
-- ============================================================
-- PUBLIC is a real grantee in PostgreSQL and is held by every role, anon
-- included. Revoke it explicitly rather than trusting defaults: Supabase's own
-- default privileges are already in place on a newly created table in this
-- schema, which is why a bare GRANT would leave unwanted privileges behind.
revoke all on public.statement_requirement_sets from public;
revoke all on public.statement_requirement_sets from anon, authenticated, service_role;
revoke all on public.statement_requirements from public;
revoke all on public.statement_requirements from anon, authenticated, service_role;

-- SELECT ONLY, and only for the two browser roles. Rows they may see are still
-- filtered by the active-only policies above.
grant select on public.statement_requirement_sets to anon, authenticated;
grant select on public.statement_requirements to anon, authenticated;

-- service_role GETS NOTHING, following statement_prompts and statement_drafts.
-- No application code path writes these tables: the catalog is populated by an
-- operator in the SQL editor, which connects as the table owner. Granting write
-- privileges now, to a role that bypasses RLS, against a table nothing writes,
-- would be a standing privilege with no caller.
--
-- statement_drafts' OWN GRANTS ARE NOT TOUCHED. `authenticated` already holds
-- select/insert/update/delete on it from 20260928_000, and the two new columns
-- are covered by those table-level privileges. No column-level grant is added
-- or needed, and the own-rows RLS policies continue to decide every statement.

commit;

-- ============================================================
-- VERIFY (read-only, after this file has been applied)
-- ============================================================
-- One query, so the Supabase SQL editor shows the whole result rather than
-- only the last statement's output. Expect: 2 new tables, RLS enabled on both,
-- select-only grants for anon and authenticated, no grants for service_role,
-- 2 new nullable columns on statement_drafts, and zero rows in either table.
--
-- select 'tables' as check, table_name, '' as detail
--   from information_schema.tables
--   where table_schema = 'public'
--     and table_name in ('statement_requirement_sets', 'statement_requirements')
-- union all
-- select 'draft columns', column_name, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'statement_drafts'
--     and column_name in ('requirement_id', 'requirement_snapshot')
-- union all
-- select 'grants', grantee || ':' || table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('statement_requirement_sets', 'statement_requirements')
-- union all
-- select 'rowcount', 'statement_requirement_sets', count(*)::text
--   from public.statement_requirement_sets
-- union all
-- select 'rowcount', 'statement_requirements', count(*)::text
--   from public.statement_requirements
-- order by 1, 2, 3;
