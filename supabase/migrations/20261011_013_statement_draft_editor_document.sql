-- ===========================================================================
-- 013  Constrained editor document, beside the plain essay
-- ===========================================================================
--
-- NOT APPLIED. Drafted for review. Sequenced after 008-012, all unapplied.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND COLUMN AND NOT A REPLACEMENT
-- ---------------------------------------------------------------------------
-- `essay text` is the canonical text of a draft. The analyser reads it, the
-- word and character counters count it, and the analysis fingerprint is taken
-- over it. Replacing it with a document would mean every one of those had to
-- learn to extract text, and the fingerprint would change for every existing
-- draft the first time it was opened -- invalidating analyses applicants paid
-- for, to store formatting none of them asked to pay for.
--
-- So the document sits BESIDE the essay and holds one extra fact: which
-- characters are bold.
--
-- ---------------------------------------------------------------------------
-- THE INVARIANT THIS COLUMN LIVES UNDER
-- ---------------------------------------------------------------------------
-- The plain text extracted from editor_document MUST equal essay, byte for
-- byte. If they ever disagreed the applicant would see one essay and be
-- assessed on another, and the fingerprint would no longer identify the text
-- that was analysed.
--
-- IT IS ENFORCED IN THE WRITE PATH, NOT HERE. A CHECK constraint cannot walk
-- a jsonb document and concatenate its text nodes without a function, and a
-- function that silently disagreed with the TypeScript extractor would be a
-- second implementation of the invariant -- which is how the two drift. The
-- API validates it on every save and refuses the write; see
-- documentMatchesEssay in lib/statement/layout/plainText.ts.
--
-- NULL IS A VALID AND COMMON STATE: every draft written before this column
-- existed. Those reconstruct from `essay` as a document with no bold.
-- ---------------------------------------------------------------------------

begin;

alter table public.statement_drafts
  add column if not exists editor_document jsonb,
  add column if not exists editor_document_version smallint;

comment on column public.statement_drafts.editor_document is
  'The constrained ProseMirror document: doc > paragraph > text, with the '
  '''strong'' mark and nothing else. Holds formatting only; its extracted text '
  'must equal essay, which the API enforces on every write. Null for a draft '
  'written before this column, which reconstructs from essay.';
comment on column public.statement_drafts.editor_document_version is
  'Which constrained schema the document was written against, so a later '
  'widening can be told from a document that predates it. Null with the '
  'document.';

-- THE TWO TRAVEL TOGETHER. A version with no document, or a document with no
-- version, is a row whose schema cannot be determined.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_editor_document_shape;
alter table public.statement_drafts
  add constraint statement_drafts_editor_document_shape
  check (
    (editor_document is null and editor_document_version is null)
    or (editor_document is not null and editor_document_version is not null)
  );

-- A DOCUMENT IS AN OBJECT, not an array or a scalar. The cheapest shape check
-- the database can make without reimplementing the extractor.
alter table public.statement_drafts
  drop constraint if exists statement_drafts_editor_document_is_object;
alter table public.statement_drafts
  add constraint statement_drafts_editor_document_is_object
  check (editor_document is null or jsonb_typeof(editor_document) = 'object');

alter table public.statement_drafts
  drop constraint if exists statement_drafts_editor_document_version_known;
alter table public.statement_drafts
  add constraint statement_drafts_editor_document_version_known
  check (editor_document_version is null or editor_document_version = 1);

commit;
