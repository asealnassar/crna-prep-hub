#!/usr/bin/env python3
"""
The database constraints the generated catalog must satisfy, expressed once.

-----------------------------------------------------------------------------
WHY THIS FILE EXISTS
-----------------------------------------------------------------------------
Migration 006 added

    statement_requirements_unenforced_length_has_no_bound
      check (unenforced_length is null
             or (min_words is null and max_words is null
                 and min_characters is null and max_characters is null
                 and min_pages is null and max_pages is null))

and migration 006 IS APPLIED TO PRODUCTION. For eight documents the pipeline
nonetheless produced a desired row holding both a structured bound and the
prose the bound was normalised from, so the targeted UPDATE that would install
it is not merely untidy -- it is IMPOSSIBLE. The database refuses it. That was
found by rehearsing the correction package against the real frozen baseline on
a throwaway cluster, not by reading the code.

Patching it in the correction generator fixed one artifact and left the source
pipeline able to recreate it on the next regeneration. So the rule lives here,
in one place, and the two generators that produce desired rows both consume it:

    scripts/normalize_statement_catalog.py       promotes prose into bounds
    scripts/build_statement_requirements_import_sql.py  emits the payload/SQL

-----------------------------------------------------------------------------
IT IS A RULE ABOUT DATA, NOT ABOUT SCHOOLS
-----------------------------------------------------------------------------
`clear_superseded_length_prose` asks one question of a row: does it now carry a
structured bound in any unit? If it does, the sentence saying the length is
unconfirmed is no longer true of that row and is cleared. If it does not, the
sentence is the only length information the document has and is kept exactly as
verified.

That distinction does the right thing for the three documents whose figures are
DELIBERATELY left as prose -- Franciscan La Crosse's exclusive "less than two
pages", Gonzaga's "2 pages plus an optional 3rd for references only", Keiser's
"three pages, excluding cover and references" -- because none of them is given
a bound, by the same reviewed decision that defers them. No school is named
here or anywhere in the two generators; a fourth such document would be
preserved for the same reason, and a school that stops being deferred would be
cleared for the same reason. (Franciscan Missionaries of Our Lady University is
a different school from Franciscan La Crosse and DOES take a page bound, which
is exactly the kind of near-collision a name-keyed rule would get wrong.)

-----------------------------------------------------------------------------
THE INVARIANT IS CHECKED, NOT ASSUMED
-----------------------------------------------------------------------------
`assert_catalog_invariants` re-derives every constraint below from the finished
rows and STOPS the generator. A clear that silently failed to fire, a future
transformation that sets a bound somewhere else, or a hand-edited preview CSV
all surface at generation time, where a person is watching, instead of as a
failed UPDATE against production.

Reads nothing, writes nothing, executes no SQL.
"""

# The six columns 006 counts as a structured bound, in the order the constraint
# names them. Characters are included even though no document currently carries
# one: the constraint does, and a payload that grew one later must obey it.
BOUND_COLUMNS = ('min_words', 'max_words',
                 'min_characters', 'max_characters',
                 'min_pages', 'max_pages')

PROSE_COLUMNS = ('unenforced_length', 'unenforced_length_verbatim')

# 006 also added: the flag may not be set without the text it qualifies.
#   check (unenforced_length_verbatim is null or unenforced_length is not null)
# and: the text is between 1 and 2000 characters when present.
PROSE_MAX_CHARS = 2000


def _blank(value):
    """
    Whether a cell counts as SQL NULL.

    The preview CSV holds '' for an absent number and the JSON payload holds
    None, and this rule has to read both -- the normaliser works on CSV rows
    mid-pipeline and the invariant check runs over the finished payload.
    """
    return value is None or (isinstance(value, str) and value.strip() == '')


def has_structured_bound(row):
    """Whether 006 would consider this row bounded in any unit."""
    return any(not _blank(row.get(col)) for col in BOUND_COLUMNS)


def has_length_prose(row):
    return not _blank(row.get('unenforced_length'))


def violates_unenforced_length_has_no_bound(row):
    """The constraint predicate itself, negated. True means the database refuses."""
    return has_length_prose(row) and has_structured_bound(row)


def clear_superseded_length_prose(row, blank=''):
    """
    Drop the length prose a structured bound has superseded. Returns the columns
    cleared, so a caller can record what it did.

    `blank` is what this pipeline stage writes for NULL: '' in a CSV row, None
    in a payload dict.

    THIS IS NOT ONLY SCHEMA HYGIENE. QA-006 established the same thing from the
    applicant's side: once a figure is normalised into a bound, a sentence
    reading "the length is stated but not enforced here" contradicts the panel
    sitting beside it. The application suppresses that sentence at render time
    today; clearing the column makes the data agree with the schema instead of
    depending on every reader remembering to suppress it.
    """
    if not (has_length_prose(row) and has_structured_bound(row)):
        return []
    cleared = [col for col in PROSE_COLUMNS if not _blank(row.get(col))]
    for col in PROSE_COLUMNS:
        row[col] = blank
    return cleared


def check_row(row):
    """Every 006 length-register constraint, as a list of failures for one row."""
    failures = []
    if violates_unenforced_length_has_no_bound(row):
        bound = [c for c in BOUND_COLUMNS if not _blank(row.get(c))]
        failures.append(
            'carries unenforced_length beside a structured bound (%s), which '
            'statement_requirements_unenforced_length_has_no_bound refuses'
            % ', '.join(bound))
    if not _blank(row.get('unenforced_length_verbatim')) and not has_length_prose(row):
        failures.append('unenforced_length_verbatim is set with no unenforced_length')
    prose = row.get('unenforced_length')
    if isinstance(prose, str) and prose.strip() and len(prose.strip()) > PROSE_MAX_CHARS:
        failures.append('unenforced_length is %d characters, over 006\'s limit of %d'
                        % (len(prose.strip()), PROSE_MAX_CHARS))
    return failures


def assert_catalog_invariants(rows, describe, stop):
    """
    STOP the generator unless every row would be accepted by the applied schema.

    `describe(row)` names the row for a human; `stop(message)` ends the run.
    Called with the FINISHED rows, after every transformation, so it cannot be
    satisfied by a transformation that merely intends to fix things up later.
    """
    problems = []
    for row in rows:
        for failure in check_row(row):
            problems.append('  %s: %s' % (describe(row), failure))
    if problems:
        stop('the generated catalog would be REFUSED by the applied schema.\n'
             'Migration 006 is in production; these rows cannot be written by any\n'
             'means, targeted UPDATE included.\n\n' + '\n'.join(problems))
    return len(rows)
