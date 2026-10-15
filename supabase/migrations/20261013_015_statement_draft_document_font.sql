-- ===========================================================================
-- 015  The document's font — a whole-document layout preference
-- ===========================================================================
--
-- NOT APPLIED. Drafted for review. Sequenced after 013/014, which are also
-- unapplied.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A COLUMN AND NOT A MARK
-- ---------------------------------------------------------------------------
-- 013 added editor_document, which holds paragraphs, text and bold -- and bold
-- is an INLINE fact: these words are bold, those are not. A font is not that.
-- The whole document is in one font; there is no such thing as a word in a
-- different one here, and the Studio deliberately does not offer one, because
-- per-word fonts are how a personal statement stops looking like a personal
-- statement.
--
-- Storing it as a mark would also put it inside the text, where the hard
-- invariant 013 states -- the document's plain text must equal `essay` -- would
-- have to start ignoring an attribute. Keeping it out of the document keeps
-- that invariant a string comparison.
--
-- ---------------------------------------------------------------------------
-- IT CHANGES THE PAGE, NOT THE WRITING
-- ---------------------------------------------------------------------------
-- `essay` is untouched by a font change, so the word count, the character
-- count and the analysis fingerprint are all untouched too -- an applicant can
-- try both fonts without being charged for a second analysis. What does change
-- is where the browser wraps the text, and therefore how much of the page
-- allowance is used, which is re-measured from the rendered layout.
--
-- ---------------------------------------------------------------------------
-- THE VALUES ARE THE FACES THIS PRODUCT SHIPS
-- ---------------------------------------------------------------------------
-- Not a family name: a font the Studio does not bundle would render from
-- whatever the reader's machine has, and the page count would stop being
-- reproducible. The CHECK therefore lists the bundled faces by id, and a face
-- is only added to it in the same change that adds its files -- INCLUDING its
-- bold file, since Bold is available on every draft.
-- ---------------------------------------------------------------------------

begin;

alter table public.statement_drafts
  add column if not exists document_font text;

comment on column public.statement_drafts.document_font is
  'The bundled face this draft is laid out in. Null means the Studio default. '
  'A whole-document layout preference, never an inline mark: it is not part of '
  'editor_document and does not affect essay, the counts or the analysis '
  'fingerprint.';

alter table public.statement_drafts
  drop constraint if exists statement_drafts_document_font_known;
alter table public.statement_drafts
  add constraint statement_drafts_document_font_known
  check (document_font is null or document_font in ('tinos', 'arimo'));

commit;

-- ---------------------------------------------------------------------------
-- STILL TO DO WHEN THIS IS APPLIED, NOT DONE HERE
-- ---------------------------------------------------------------------------
-- * draftRepo.ts adds document_font to its select list and its update columns
--   in the same change that applies this; until then STATEMENT_DOCUMENT_FONT
--   gates both, because naming a column PostgREST cannot find fails the whole
--   request rather than degrading.
-- * A face added to the CHECK must be added to lib/statement/layout/
--   studioFonts.ts in the same change, with its regular AND bold files.
