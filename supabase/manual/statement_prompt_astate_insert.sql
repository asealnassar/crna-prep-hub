-- Statement Studio V2 -- the catalog's first real prompt.
--
--   School : Arkansas State University, Nurse Anesthesia DNP
--   Label  : Professional Goal Statement - Published Requirements Summary
--   Length : 500-1,000 words
--   Source : https://kb.astate.edu/books/school-of-nursing/page/
--            nurse-anesthesia-doctor-of-nursing-practice-dnp-program-inforamtion
--
-- NOT A MIGRATION. This creates no table, column, policy, index or function; it
-- inserts at most ONE row into a table that already exists. It lives here
-- because supabase/manual/ is where operator-run SQL lives in this repository.
--
-- WHERE THIS HAS TO BE RUN, AND WHY. public.statement_prompts grants INSERT to
-- NOBODY -- not anon, not authenticated, not service_role (20260930_000,
-- section 5). So this cannot be run through PostgREST, the application, or any
-- API key. It must be run in the Supabase SQL editor, which connects as the
-- table owner and is therefore the one context that can write the catalog. That
-- is the design working, not an obstacle to route around.
--
-- THE SOURCE URL IS IN THIS COMMENT AND NOWHERE ELSE, because the applied
-- schema has no column for it: the catalog is id, school_id, label,
-- prompt_text, stated_max_words, application_cycle, is_active, display_order
-- and the two timestamps. Attribution would need a `source_url` column, which
-- is a migration and is out of scope here. The alternative -- putting the link
-- inside prompt_text -- is rejected: prompt_text is what an applicant reads as
-- their school's question, and a URL is not part of the question.
--
-- THE MINIMUM IS IN THE WORDING, deliberately. stated_max_words holds 1000;
-- there is no stated_min_words column, so the full range is written into the
-- text where an applicant will actually see it.
--
-- AND THE WORDING SAYS WHAT IT IS. public.statement_prompts documents
-- prompt_text as "the question, verbatim", and this is not one -- it is a
-- summary of published requirements. Rather than let a draft snapshot a
-- paraphrase as though the university had asked it, the text says so in its
-- own second paragraph, and the label repeats it. An applicant reading this in
-- the editor is told to check their own application materials.
--
-- PLAIN TEXT, NO MARKUP. prompt_text is rendered as escaped React text with
-- whitespace preserved; there is no markdown parser anywhere in the path. The
-- disclaimer is therefore stored unemphasised -- asterisks around it would be
-- displayed as asterisks. The blank line between the paragraphs IS preserved,
-- because the renderer keeps whitespace.
--
-- NOT ASCII-ONLY ANY MORE. The approved wording carries an en dash, an em dash
-- and a typographic apostrophe. All three are single code points, the column is
-- UTF-8, and char_length() counts code points -- so the ceiling is measured the
-- same way either way. Paste this file as UTF-8.
--
-- application_cycle IS LEFT NULL. The source does not state a cycle, and a
-- cycle nobody published is not a cycle.

-- ===========================================================================
-- STEP 1 -- READ ONLY. Run this FIRST and read the result.
-- ===========================================================================
-- The school's uuid is never typed into this file. It is resolved by name at
-- execution time, so there is no id to transcribe wrongly and none to invent.
--
-- WHAT YOU ARE LOOKING FOR: exactly ONE row. If this returns none, the school
-- is not in the directory and the insert below will correctly do nothing. If it
-- returns more than one, the insert will also do nothing -- and you should
-- narrow the pattern by hand rather than letting a script choose.
select id, name, location_state
from public.schools
where name ilike '%arkansas state%'
order by name;

-- ===========================================================================
-- STEP 2 -- THE INSERT. One row, or none.
-- ===========================================================================
-- IDEMPOTENT ON THE WORDING, not on the label. Two runs of this file insert one
-- row in total: the NOT EXISTS clause compares the normalised text -- case
-- folded, whitespace runs collapsed, ends trimmed -- against every prompt this
-- school already has. Re-running after an editor has reformatted the stored
-- text still matches, because the comparison ignores exactly the differences
-- reformatting introduces.
--
-- AND IT REFUSES TO GUESS. The `(select count(*) from target) = 1` guard means
-- a name that matches no school, or several, inserts nothing at all rather than
-- attaching this prompt to whichever row happened to sort first.
--
-- EVERY VALUE SATISFIES THE EXISTING CHECKS: the label is 60 code points (1-200
-- trimmed), the wording is 377 and so well under the 5,000 ceiling and not
-- blank, 1000 is inside 1-5000, a null cycle is permitted explicitly, and
-- display_order 0 is non-negative.
with wording as (
  select $prompt$Arkansas State University requires a professional goal statement of 500–1,000 words addressing your professional goals, relevant past experiences, and the contributions you expect to make to nurse anesthesia practice.

This is a summary of the university’s published requirements, not a verbatim application question. Check your current application materials for exact wording.$prompt$::text as prompt_text
),
target as (
  select id
  from public.schools
  where name ilike '%arkansas state%'
)
insert into public.statement_prompts (
  school_id,
  label,
  prompt_text,
  stated_max_words,
  application_cycle,
  is_active,
  display_order
)
select
  t.id,
  'Professional Goal Statement — Published Requirements Summary',
  w.prompt_text,
  1000,
  null,
  true,
  0
from target t
cross join wording w
where (select count(*) from target) = 1
  and not exists (
    select 1
    from public.statement_prompts p
    where p.school_id = t.id
      and lower(btrim(regexp_replace(p.prompt_text, '\s+', ' ', 'g')))
        = lower(btrim(regexp_replace(w.prompt_text, '\s+', ' ', 'g')))
  )
returning
  id,
  school_id,
  label,
  stated_max_words,
  application_cycle,
  is_active,
  display_order,
  created_at;

-- ===========================================================================
-- STEP 3 -- VERIFY. Read only, safe to run any number of times.
-- ===========================================================================
-- Expect exactly one row, is_active true, stated_max_words 1000, a null cycle,
-- and both boolean columns true: the wording states the 500-1,000 range and
-- says it is a summary rather than the university's own question.
select
  p.id,
  s.name                                   as school,
  p.label,
  p.stated_max_words,
  p.application_cycle,
  p.is_active,
  p.display_order,
  char_length(p.prompt_text)               as prompt_chars,
  p.prompt_text like '%500–1,000 words%'  as states_the_range,
  p.prompt_text like '%not a verbatim%'   as states_it_is_a_summary,
  p.created_at
from public.statement_prompts p
join public.schools s on s.id = p.school_id
where s.name ilike '%arkansas state%'
order by p.display_order, p.created_at;
