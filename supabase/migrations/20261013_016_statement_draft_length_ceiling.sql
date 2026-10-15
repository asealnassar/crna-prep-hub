-- ===========================================================================
-- 016  The saved-draft ceiling, raised to fit the requirements we publish
-- ===========================================================================
--
-- NOT APPLIED. Drafted for review.
--
-- ---------------------------------------------------------------------------
-- WHY: A SCHOOL'S OWN MAXIMUM WAS UNREACHABLE
-- ---------------------------------------------------------------------------
-- 20260928_000 set statement_drafts_essay_length at 20,000 characters. That
-- number was chosen before the requirement catalog existed, and the catalog
-- now publishes a requirement it cannot hold.
--
-- University of Tennessee Knoxville asks for 5,000-18,000 characters
-- EXCLUDING SPACES. The database counts what is stored, which includes them.
-- Ordinary prose at exactly the school's maximum measures:
--
--     18,000 characters excluding spaces   (inside the school's limit)
--     22,287 characters stored             (2,287 over the old ceiling)
--
-- So an applicant writing to the limit their school published could not save.
-- The editor refused with "That is longer than 20,000 characters", which was
-- accurate about the product and useless to the applicant.
--
-- ---------------------------------------------------------------------------
-- WHY 30,000, AND NOT A ROUNDER OR LARGER NUMBER
-- ---------------------------------------------------------------------------
-- Read off the published catalog rather than guessed, taking the largest
-- demand each kind of bound can make:
--
--   * characters  18,000 excluding spaces is the only character bound in the
--                 catalog. With pathologically short words (3 characters plus
--                 a space) that is ~24,000 stored; the measured prose fixture
--                 is 22,287.
--   * pages       5 is the largest page maximum. A single-spaced page at the
--                 Studio's own geometry holds ~4,560 characters, so five of
--                 them is ~22,800.
--   * words       1,000 is the largest word maximum: ~7,000 characters. Never
--                 the binding constraint.
--
-- 30,000 clears the worst of those by ~25% and stays well under
-- MAX_EXTRACTED_CHARS (50,000), so an upload can still extract more than a
-- draft may hold and be refused explicitly rather than truncated.
--
-- ---------------------------------------------------------------------------
-- RE-DERIVED 2026-10-15, OVER EVERY BOUND IN THE SERVED CATALOG
-- ---------------------------------------------------------------------------
-- 56 of the 79 served documents carry a length bound. Each was converted to
-- the most stored characters it could demand -- words x 12 characters, a
-- without-spaces character limit x 4/3, pages x lines x 95 characters -- and
-- the three largest were:
--
--     24,000   UT Knoxville, DNP Admission Essay   18,000 excluding spaces
--     13,680   Idaho State / Ohio State            3 pages
--     12,000   Arkansas State / Buffalo / Flint    1,000 words
--
-- HIGHEST DEMAND 24,000. HEADROOM 6,000.
--
-- No currently verified school can reasonably require more, so this number is
-- evidence and not preference. Do not raise it again without re-running that
-- derivation and finding a school that needs it: every increase costs storage
-- on editor_document as well as essay, and an increase cannot be reverted
-- once any applicant's draft has grown past the old bound.
--
-- NOTHING IS TRUNCATED, HERE OR ANYWHERE. The constraint still refuses; it
-- refuses later. lib/statement/draft/validate.ts refuses the same value with
-- the same reason before a request is ever made.
-- ---------------------------------------------------------------------------

begin;

alter table public.statement_drafts
  drop constraint if exists statement_drafts_essay_length;
alter table public.statement_drafts
  add constraint statement_drafts_essay_length check (char_length(essay) <= 30000);

commit;

-- ---------------------------------------------------------------------------
-- UNTIL THIS IS APPLIED
-- ---------------------------------------------------------------------------
-- maxSavedChars() in lib/statement/extract/limits.ts returns 20,000 unless
-- STATEMENT_DRAFT_LENGTH_CEILING is on (or simulated-live forces it), so the
-- client keeps refusing at the value the database actually enforces. Raising
-- the client alone would turn a clear, local refusal into a failed write.
