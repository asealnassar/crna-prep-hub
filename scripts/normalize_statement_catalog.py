#!/usr/bin/env python3
"""
Move verified requirements out of free text and into the structured columns.

-----------------------------------------------------------------------------
WHY THIS STAGE EXISTS
-----------------------------------------------------------------------------
The research set verifies typography into its own column, `Font And Margins` in
02_requirement_details.csv. The step that produced the import previews copied
that column into `other_instructions` as prose and left `font_family`,
`font_size_pt` and `margins_inches` empty for all 80 documents. Downstream,
`other_instructions` means "an obligation the Studio cannot check", so a school
that stated 12-point Times New Roman was reported to the applicant as something
they had to go and verify by hand -- while the typed columns that would have
let the Studio apply it sat null.

This script closes that gap REPRODUCIBLY. The preview CSV is a generated
artifact; hand-editing it would be overwritten by the next regeneration and
would leave no record of what changed or why.

-----------------------------------------------------------------------------
A TABLE, NOT A PARSER
-----------------------------------------------------------------------------
Every transformation below is an explicit entry keyed on the exact verified
string. There is no regular expression over prose, no inference, and no
"probably means". A value that is not in the table STOPS THE RUN -- so a school
added later cannot be silently mis-parsed into a requirement it never stated.

That is also why this lives in the repository rather than beside the research
CSVs: the mapping is a reviewed product decision and belongs under version
control. The research folder is not.

-----------------------------------------------------------------------------
WHAT `other_instructions` MEANS AFTER THIS RUNS
-----------------------------------------------------------------------------
Exactly one thing: an obligation the applicant must satisfy themselves. Three
classes of text are therefore removed from it rather than carried:

  structured   The value now lives in a typed column. "12-point" becomes
               font_size_pt = 12, and "margins not stated" becomes
               margins_inches = null -- the same fact, in the field built for
               it. Leaving the prose as well would ask the applicant to meet a
               requirement the Studio had already applied.

  satisfied    True by construction for anything written in the Studio.
               "Typewritten" cannot fail in a typed editor, so there is nothing
               to check and nothing to say.

  informational  States no obligation. "Citations NOT required" rendered as a
               manual line read as an instruction to add citations.

The verified evidence is unchanged and permanent: 02_requirement_details.csv
keeps every original string, and each removal is recorded below with a reason.

-----------------------------------------------------------------------------
# LENGTH BOUNDS ARE THE SECOND HALF OF THE SAME PROBLEM
-----------------------------------------------------------------------------
The import also withheld length bounds it had verified, for a different and
more defensible reason: the research could not tell whether a published figure
was a maximum, a minimum or a suggestion, so it recorded
`words_register = needs-classification` and stored the school's sentence
instead of a bound. That is the correct default for an ambiguous figure.

IT IS NOT THE RIGHT ANSWER FOR A TWO-ENDED RANGE. "500-1,000 words" names a
floor and a ceiling; there is no reading of it under which 200 words complies.
The reviewed decision below is therefore a RE-CLASSIFICATION, recorded per
source string, not a parser and not an inference about any particular school.

READS TWO FILES AND WRITES ONE. It executes no SQL and touches no database.
"""
import csv
import json
import re
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from statement_catalog_invariants import (            # noqa: E402
    assert_catalog_invariants, clear_superseded_length_prose)
RESEARCH = os.environ.get(
    'STATEMENT_RESEARCH_DIR',
    os.path.expanduser('~/Downloads/CRNA-statement-verification-2026-10-02'))

DETAILS = '02_requirement_details.csv'
PREVIEW = '12_statement_requirements_preview.csv'

# ---------------------------------------------------------------------------
# THE REVIEWED MAPPING: verified `Font And Margins` -> structured fields
# ---------------------------------------------------------------------------
# `keep` is the prose that remains an obligation after the typed fields have
# taken what they can. It is almost always empty: a statement that a property
# was not specified is expressed by that column being null.
#
# `note` records why anything was dropped, for the reviewer reading a diff.
NOT_STATED = {'font_family': None, 'font_size_pt': None, 'margins_inches': None}

FONT_AND_MARGINS = {
    # -- nothing stated at all -------------------------------------------
    'Not stated': dict(NOT_STATED, keep=[], note='no typography stated'),

    # -- nothing stated, plus a medium that the Studio satisfies -----------
    # "Typewritten" and "typed" are true by construction of a typed editor.
    'Not stated (typewritten)': dict(
        NOT_STATED, keep=[], note='satisfied: a Studio essay is typewritten'),
    'Not stated (typed)': dict(
        NOT_STATED, keep=[], note='satisfied: a Studio essay is typed'),
    "Not stated (only 'typed')": dict(
        NOT_STATED, keep=[], note='satisfied: a Studio essay is typed'),
    'Not stated (typewritten or word-processed)': dict(
        NOT_STATED, keep=[], note='satisfied: a Studio essay is word-processed'),
    'Typewritten; font and margins not stated': dict(
        NOT_STATED, keep=[], note='satisfied: typewritten; font/margins are null'),

    # -- a size, and an explicit statement that the rest was not given -----
    '12-point; family and margins not stated': dict(
        NOT_STATED, font_size_pt=12, keep=[], note='size structured; rest null'),
    '12 pt font; family and margins not stated': dict(
        NOT_STATED, font_size_pt=12, keep=[], note='size structured; rest null'),
    '12 point font': dict(
        NOT_STATED, font_size_pt=12, keep=[], note='size structured'),

    # -- a family and a size ----------------------------------------------
    # THE SCHOOL'S OWN SPELLING IS STORED. The font registry resolves aliases
    # at render time; the catalog records what the school actually wrote.
    'Times New Roman, 12 point; margins not stated': dict(
        font_family='Times New Roman', font_size_pt=12, margins_inches=None,
        keep=[], note='family and size structured; margins null'),
    'Times New Roman 12; margins not stated': dict(
        font_family='Times New Roman', font_size_pt=12, margins_inches=None,
        keep=[], note='family and size structured; margins null'),

    # -- all three ---------------------------------------------------------
    '12-point Times New Roman, 1 inch margins': dict(
        font_family='Times New Roman', font_size_pt=12, margins_inches='1.00',
        keep=[], note='family, size and margins structured'),

    # -- a size, and a genuine qualifier on the unspecified typeface -------
    # "legible" is a real instruction and is NOT discarded; the 12 is not
    # repeated in the prose, because the typed column already carries it.
    'A legible 12 font (typeface not specified)': dict(
        NOT_STATED, font_size_pt=12,
        keep=['Typeface must be legible; typeface not specified'],
        note='size structured; the legibility qualifier is retained'),

    # -- a CHOICE, which this schema cannot hold ---------------------------
    # Blocked until migration 010 adds font_family_options / font_size_pt_options.
    # Flattening it to one font or one size would assert a requirement the
    # school did not make, so the prose is left exactly as verified.
    'Times Roman or Arial, 11 or 12 point': dict(
        NOT_STATED, keep=['Times Roman or Arial, 11 or 12 point'],
        note='BLOCKED: a choice needs migration 010; prose kept verbatim'),
}

# ---------------------------------------------------------------------------
# THE REVIEWED MAPPING: verified `Citation/Formatting Instructions`
# ---------------------------------------------------------------------------
CITATION = {
    'Not stated': dict(keep=[], note='nothing stated'),
    # ---- WHERE A LAYOUT PROFILE TAKES OVER, THE PROSE NARROWS -----------
    #
    # The page layout is applied now, so telling the applicant to "check APA
    # 7th edition" would send them to verify the margins and spacing the
    # Studio just set. What is genuinely left is the part no layout engine can
    # settle: whether the citations and references are correct.
    'APA 7th edition': dict(
        keep=['APA citation and reference formatting'],
        note='layout applied by the apa-7 profile; citation correctness is manual'),
    'APA formatting': dict(
        keep=['APA citation and reference formatting'],
        note='layout applied by the apa-7 profile; citation correctness is manual'),
    'AMA format; at least one cited article required': dict(
        keep=['AMA format; at least one cited article required'], note='actionable'),
    'Business letter format (format instruction, not a citation style)': dict(
        keep=['Business letter format (format instruction, not a citation style)'],
        note='actionable'),
    'Research evidence must be synthesized and referenced; no named style is specified':
        dict(keep=['Research evidence must be synthesized and referenced; '
                   'no named style is specified'], note='actionable'),
    'BLINDED REVIEW — no personal identifying information may appear in the essay':
        dict(keep=['BLINDED REVIEW — no personal identifying information may '
                   'appear in the essay'], note='actionable'),
    # INFORMATIONAL, AND THE ONLY ONE. A negative statement imposes nothing;
    # shown as an obligation it read as an instruction to add citations.
    'Citations NOT required': dict(
        keep=[], note='informational: states no obligation'),
}


# ---------------------------------------------------------------------------
# THE REVIEWED RE-CLASSIFICATION: verified length figures -> structured bounds
# ---------------------------------------------------------------------------
# Keyed on the EXACT verified cell, so one decision covers every school that
# published the same thing -- "1-2 pages" means the same wherever it appears.
#
# Applied ONLY where the catalog field is empty and the source has a figure.
# A row the import already bounded is never touched, and a figure with no entry
# here STOPS THE RUN rather than being guessed at.
#
# `flag` marks a decision the owner should look at again: an exclusive bound or
# a semantic exclusion that the structured columns cannot express exactly.
PAGE_BOUNDS = {
    '1-2 pages': dict(min_pages='1', max_pages='2',
                      stated_as='explicit range: "1-2 pages"', flag=None),
    '2-3 pages': dict(min_pages='2', max_pages='3',
                      stated_as='explicit range: "2-3 pages"', flag=None),
    # ---- DELIBERATELY NOT CONVERTED ------------------------------------
    #
    # These three publish a figure the structured columns would MISSTATE, so
    # they keep their verbatim sentence and carry no bound. That is not an
    # oversight to be tidied up later: a ceiling that is wrong in the
    # applicant's favour is worse than no ceiling, because the panel would
    # show a green tick for a draft the school would reject.
    #
    # Converting them needs a schema concept that does not exist -- an
    # exclusive bound, and a way to say which parts of a document a figure
    # counts. Both are recorded here for whoever adds it.
    "<2 pages (stated as 'less than two pages in length'), for the whole document":
        dict(defer='EXCLUSIVE. "Less than two pages" forbids a full two pages; '
                   'max_pages = 2 would permit exactly what the school refuses.'),
    '3 pages, EXCLUDING cover and references':
        dict(defer='SCOPED. The figure counts the essay but not the cover or the '
                   'reference list, and no column says which parts it counts.'),
    '2 pages maximum, plus an optional 3rd page for references only':
        dict(defer='SCOPED. A third page is allowed for references only, which a '
                   'single maximum cannot express.'),
}


# ---------------------------------------------------------------------------
# THE REVIEWED RE-CLASSIFICATION: a register that contradicts its own basis
# ---------------------------------------------------------------------------
# The classifier recorded, for three documents, `words_register = target` --
# which this product renders as "the stated length, not a limit" -- while the
# basis it stored quotes the school saying the opposite:
#
#     length used adjectivally: "200 word limit"
#
# The figure was discounted because it appears as a noun phrase rather than in
# a sentence. But the school's own word is "limit", and an applicant told that
# a 200-word limit is "not a limit" has been told something false.
#
# KEYED ON THE EXACT BASIS, so one decision covers every document that quotes
# the same wording, and a basis that is not listed stops the run (see
# `contradicted_register`) rather than passing silently.
REGISTER_OVERRIDE = {
    'length used adjectivally: "200 word limit"': dict(
        enforcement='enforced',
        note='the school\'s own word is "limit"; adjectival use does not soften it'),
}


def contradicted_register(register, basis):
    """
    Whether a non-limit register is contradicted by the evidence behind it.

    NARROW ON PURPOSE. It fires only when the stored register says the figure is
    NOT a bound while the basis quotes the school using the word "limit" --
    which is the one combination that cannot both be true. Anything it flags
    must be in REGISTER_OVERRIDE or the run stops; nothing is reinterpreted on
    the strength of the detector alone.
    """
    if register not in ('target', 'suggested', 'unknown'):
        return False
    quoted = basis[basis.find('"'):] if '"' in basis else ''
    return 'limit' in quoted.lower()


# ---------------------------------------------------------------------------
# THE STORED WORDING IS THE SCHOOL'S, NOT OUR CLASSIFICATION OF IT
# ---------------------------------------------------------------------------
# `*_stated_as` was written as '<why we classified it this way>: "<fragment>"',
# e.g. 'length used adjectivally: "200 word limit"'. The applicant-facing
# editor renders that column under the heading "The school's wording", so 58 of
# 79 documents showed a reader this product's own vocabulary and attributed it
# to their school.
#
# The two halves are separated here, where the value is produced:
#
#   * the column keeps the QUOTATION, which is what the heading claims;
#   * the basis travels on as a research note, so the provenance of every
#     classification is still recorded and auditable.
#
# A value with no quoted fragment yields an empty column rather than a tidied
# basis: if the school's words were never captured, nothing may stand in for
# them.
def stated_quote(stated_as):
    """The school's own fragment out of a `<basis>: "<quote>"` value."""
    if not stated_as:
        return ''
    found = re.findall(r'"([^"]+)"', stated_as)
    if found:
        text = found[-1].strip()
        # It has to carry the length. A lone classifier like "maximum", or a
        # note about what the school did NOT say, is our vocabulary rather than
        # theirs -- and every length a school publishes carries a figure.
        if text and (any(ch.isdigit() for ch in text) or len(text.split()) >= 6):
            return text
        return ''
    text = stated_as.strip()
    if re.match(r'^(length used|explicit |target marker|implicit |inferred )', text, re.I):
        return ''
    return text


def stated_basis(stated_as):
    """The classification basis, for the research record. Never applicant-facing."""
    if not stated_as:
        return ''
    head = stated_as.split(':', 1)[0].strip()
    return head if head and head != stated_as.strip() else ''


def word_bounds(min_cell, max_cell, register):
    """
    Whether an unclassified word figure is a bound after all.

    A TWO-ENDED RANGE IS A BOUND. The research deferred these because no
    official wording called the figure a maximum or a minimum -- correct for a
    lone number, which really could be a suggestion. A range states both ends,
    and no reading of "500-1,000 words" admits 200.

    A LONE FIGURE IS STILL DEFERRED. Nothing here re-classifies it; it keeps
    being shown as the school's own sentence.
    """
    if register != 'needs-classification':
        return None
    if not (min_cell and max_cell):
        return None
    return dict(min_words=min_cell, max_words=max_cell,
                enforcement='enforced',
                stated_as='explicit range: "%s-%s words"' % (min_cell, max_cell))


# ---------------------------------------------------------------------------
# THE REVIEWED CLASSIFICATION: which named standards apply to the DOCUMENT
# ---------------------------------------------------------------------------
# "APA" in a requirement does not mean "format this essay as an APA student
# paper". Both readings are in this catalog, and the difference is the whole
# decision:
#
#   "An essay ... using APA 7th edition format"      -> the essay itself
#   "excluding cover and references in AMA format"   -> the references only
#
# So the profile is keyed on the exact verified Citation/Formatting cell AND
# confirmed against the prompt wording, and `profile: None` is the common
# answer. A value that is not listed stops the run.
FORMAT_PROFILES = {
    # ---- the standard applies to the whole document --------------------
    'APA 7th edition': dict(
        profile='apa-7',
        why='the wording applies the format to the essay: '
            '"An essay ... using APA 7th edition format"'),
    'APA formatting': dict(
        profile='apa-7',
        why='the wording applies the format to the essay: '
            '"Submit a 1-2 page essay using APA formatting"'),

    # ---- the standard governs CITATIONS, not the page ------------------
    #
    # AMA here modifies "references", not the essay. Giving this a layout
    # profile would reformat a three-page letter because its bibliography has
    # a house style -- which is the mistake the profile column exists to make
    # impossible.
    'AMA format; at least one cited article required': dict(
        profile=None,
        why='AMA governs the references, not the document: '
            '"excluding cover and references in AMA format"'),

    # ---- not layout standards at all -----------------------------------
    'Business letter format (format instruction, not a citation style)': dict(
        profile=None,
        why='a genre, not a set of deterministic layout rules'),
    'Research evidence must be synthesized and referenced; no named style is specified': dict(
        profile=None, why='no named style to apply'),
    'BLINDED REVIEW — no personal identifying information may appear in the essay': dict(
        profile=None, why='a content constraint, not formatting'),
    'Citations NOT required': dict(profile=None, why='states no obligation'),
    'Not stated': dict(profile=None, why='nothing stated'),
}


def read(name):
    with open(os.path.join(RESEARCH, name), newline='', encoding='utf-8-sig') as fh:
        return list(csv.DictReader(fh)), None


def stop(message):
    sys.exit('STOP: %s' % message)


# ---------------------------------------------------------------------------
# TEXT A RESEARCHER WROTE, INSIDE A FIELD THAT IS ATTRIBUTED TO A SCHOOL
# ---------------------------------------------------------------------------
# `prompt_text` is shown to an applicant as the question their school asked,
# and `other_instructions` as an obligation their school stated. Three values
# carried something else inside them:
#
#   A DANGLING FOOTNOTE MARKER. Rutgers publishes "limited to one page*" with
#   the asterisk pointing at a footnote on their own page. The marker travelled
#   and the footnote did not, so the applicant read a reference to nothing.
#
#   AN EDITORIAL SUMMARY IN BRACKETS. Rhode Island College's prompt ended with
#   "[Purpose per the official page: ...]" -- a researcher summarising what the
#   page was for, set inside the school's own sentence.
#
#   A CLASSIFICATION IN PARENTHESES. Goldfarb's "Business letter format
#   (format instruction, not a citation style)" explains to a reviewer why the
#   value is not in the citation column. It is this project's note about the
#   requirement, not part of it.
#
# A TABLE KEYED ON THE EXACT STRING, like every other transformation in this
# file. `before` must match what the preview holds or the run STOPS: a source
# that has been re-verified since this was reviewed must be read by a person.
#
# THE RESEARCH FILES ARE NOT EDITED. 07_IMPORT_documents.csv and the detail
# CSVs keep every character they were verified with, which is what makes the
# original wording auditable; the correction happens here, in version control,
# where the reason for it is recorded beside it.
#
# AND WHAT IS REMOVED IS KEPT, in `notes`. The bracketed purpose and the
# classification are real research output -- they are simply not the school's
# words, so they move out of the quoted field and into the one that says who
# wrote them. Nothing is deleted; it is re-attributed.
TEXT_CORRECTIONS = [
    dict(slug='43-rutgers-university-school-of-nursing-dnp-nurse-anesthesia',
         label='Personal Statement',
         field='prompt_text',
         before='A Personal Statement, limited to one page*, describing a significant '
                'challenge you have faced in your academic or professional journey. How '
                'did you approach it, and what did you learn from the experience?',
         after='A Personal Statement, limited to one page, describing a significant '
               'challenge you have faced in your academic or professional journey. How '
               'did you approach it, and what did you learn from the experience?',
         note=None,
         why='the footnote the asterisk pointed at is on the school\'s page and did '
             'not travel with the sentence'),
    dict(slug='43-rutgers-university-school-of-nursing-dnp-nurse-anesthesia',
         label='Writing Sample',
         field='prompt_text',
         before='A writing sample, limited to one page*, reflecting on an unusual skill '
                'or a distinctive background, and explain how it influences your work, '
                'interactions, or goals.',
         after='A writing sample, limited to one page, reflecting on an unusual skill '
               'or a distinctive background, and explain how it influences your work, '
               'interactions, or goals.',
         note=None,
         why='the same dangling marker, in the second of this school\'s two documents'),
    dict(slug='40-rhode-island-college-zvart-onanian-school-of-nursing-bsn-dnp',
         label='Statement of Intent',
         field='prompt_text',
         before="The statement should be representative of the applicant's writing "
                'ability. The statement should be two-to-four typed pages, double-spaced '
                'and written in 12-point font. [Purpose per the official page: '
                "demonstrate the candidate's leadership and practice experience and "
                'reasons for pursuing doctoral study.]',
         after="The statement should be representative of the applicant's writing "
               'ability. The statement should be two-to-four typed pages, double-spaced '
               'and written in 12-point font.',
         note="Recorded by CRNAPREPHUB from the school's page, not quoted from it: the "
              "statement is to demonstrate the candidate's leadership and practice "
              'experience and reasons for pursuing doctoral study.',
         why='a researcher\'s summary of the page\'s purpose, set in brackets inside '
             'the quoted prompt'),
    dict(slug='22-goldfarb-school-of-nursing-at-barnes-jewish-college-dnp-nurs',
         label='Personal Statement',
         field='other_instructions',
         before='["Business letter format (format instruction, not a citation style)"]',
         after='["Business letter format"]',
         note='Recorded by CRNAPREPHUB: the business-letter instruction is a format '
              'requirement, not a citation style, which is why no citation style is '
              'stored for this document.',
         why='a parenthetical explaining the classification to a reviewer, inside an '
             'instruction attributed to the school'),
]


def apply_text_corrections(docs, by_slug_label):
    """Apply TEXT_CORRECTIONS, moving what is removed into `notes`."""
    applied = []
    for fix in TEXT_CORRECTIONS:
        d = by_slug_label.get((fix['slug'], fix['label']))
        if d is None:
            stop('text correction for %s / %s matches no document in the preview'
                 % (fix['slug'], fix['label']))
        actual = d[fix['field']]
        if actual == fix['after']:
            # Already corrected, which happens when this runs twice.
            continue
        if actual != fix['before']:
            stop('text correction for %s / %s no longer matches the source.\n'
                 '  expected: %r\n  found   : %r'
                 % (fix['slug'], fix['label'], fix['before'], actual))
        d[fix['field']] = fix['after']
        if fix['note'] is not None:
            existing = json.loads(d['notes']) if d['notes'] else []
            if fix['note'] not in existing:
                existing.append(fix['note'])
            d['notes'] = json.dumps(existing)
        applied.append(fix)
    return applied


def main():
    if not os.path.isdir(RESEARCH):
        stop('the research directory %s does not exist. Set '
             'STATEMENT_RESEARCH_DIR.' % RESEARCH)
    details, _ = read(DETAILS)
    with open(os.path.join(RESEARCH, PREVIEW), newline='', encoding='utf-8-sig') as fh:
        reader = csv.DictReader(fh)
        columns = reader.fieldnames
        docs = list(reader)

    by = {(r['Row'].strip(), r['Document #'].strip()): r for r in details}
    with open(os.path.join(RESEARCH, '07_IMPORT_documents.csv'),
              newline='', encoding='utf-8-sig') as fh:
        impby = {(r['spreadsheet_row'].strip(), r['document_index'].strip()): r
                 for r in csv.DictReader(fh)}
    changed = []
    notes = []
    deferred = []
    for d in docs:
        key = (d['_src_spreadsheet_row'].strip(),
               str(int(d['_src_document_index']) + 1))
        source = by.get(key)
        if source is None:
            stop('document %s (%s) has no verified source row %s'
                 % (d['label'], d['id'], key))

        fm = source['Font And Margins'].strip()
        cit = source['Citation/Formatting Instructions'].strip()
        # HARD FAIL, NOT A GUESS. An unmapped value means a school was added or
        # re-verified since this table was reviewed, and the right response is
        # for a person to read it -- not for this script to improvise.
        if fm not in FONT_AND_MARGINS:
            stop('unmapped "Font And Margins" value for %s: %r\n'
                 '       Add a reviewed entry to FONT_AND_MARGINS before rerunning.'
                 % (source['Original School Name'], fm))
        if cit not in CITATION:
            stop('unmapped "Citation/Formatting Instructions" value for %s: %r\n'
                 '       Add a reviewed entry to CITATION before rerunning.'
                 % (source['Original School Name'], cit))

        rule = FONT_AND_MARGINS[fm]
        before = dict(font_family=d['font_family'], font_size_pt=d['font_size_pt'],
                      margins_inches=d['margins_inches'],
                      other_instructions=d['other_instructions'],
                      min_words=d['min_words'], max_words=d['max_words'],
                      min_pages=d['min_pages'], max_pages=d['max_pages'],
                      unenforced_length=d['unenforced_length'],
                      unenforced_length_verbatim=d['unenforced_length_verbatim'])

        # ---- length bounds the import verified and then withheld -----------
        #
        # ONLY WHERE THE CATALOG IS EMPTY. A row the import already bounded is
        # authoritative and is never second-guessed here.
        source = by[key]
        cell = lambda name: (source.get(name) or '').strip()
        stated = lambda v: v and v.lower() != 'not stated' and not v.lower().startswith('not stated')

        imp_row = impby[(d['_src_spreadsheet_row'].strip(),
                         d['_src_document_index'].strip())]

        # ---- a register that contradicts its own evidence ------------------
        w_reg = imp_row['words_register'].strip()
        w_basis = (imp_row.get('words_register_basis') or '').strip()
        if contradicted_register(w_reg, w_basis) and d['words_enforcement'] != 'enforced':
            if w_basis not in REGISTER_OVERRIDE:
                stop('a word register says the figure is not a limit while its basis '
                     'quotes one, and no reviewed decision covers it.\n'
                     '       %s: register=%r basis=%r\n'
                     '       Add a reviewed entry to REGISTER_OVERRIDE before rerunning.'
                     % (source['Original School Name'], w_reg, w_basis))
            ov = REGISTER_OVERRIDE[w_basis]
            d['words_enforcement'] = ov['enforcement']
            notes.append((source['Original School Name'], d['label'], 'words register',
                          '%s -> %s' % (w_reg, ov['enforcement']), ov['note']))

        words = word_bounds(cell('Min Words') if stated(cell('Min Words')) else '',
                            cell('Max Words') if stated(cell('Max Words')) else '',
                            w_reg)
        if words is not None and not d['min_words'] and not d['max_words']:
            d['min_words'] = words['min_words']
            d['max_words'] = words['max_words']
            d['words_enforcement'] = words['enforcement']
            d['words_stated_as'] = stated_quote(words['stated_as'])
            notes.append((source['Original School Name'], d['label'],
                          'words', '%s-%s' % (words['min_words'], words['max_words']),
                          stated_basis(words['stated_as']) or None))

        # ---- a named standard that applies to the whole document ----------
        if cit not in FORMAT_PROFILES:
            stop('unmapped "Citation/Formatting Instructions" for the format '
                 'profile, %s: %r\n'
                 '       Add a reviewed entry to FORMAT_PROFILES before rerunning.'
                 % (source['Original School Name'], cit))
        wanted = FORMAT_PROFILES[cit]['profile']
        if wanted is not None and d.get('document_format_profile') != wanted:
            d['document_format_profile'] = wanted
            notes.append((source['Original School Name'], d['label'], 'format profile',
                          wanted, FORMAT_PROFILES[cit]['why']))

        pages_cell = cell('Page Limit')
        if stated(pages_cell) and not d['min_pages'] and not d['max_pages']:
            if pages_cell not in PAGE_BOUNDS:
                stop('unmapped "Page Limit" figure for %s: %r\n'
                     '       Add a reviewed entry to PAGE_BOUNDS before rerunning.'
                     % (source['Original School Name'], pages_cell))
            pb = PAGE_BOUNDS[pages_cell]
            if pb.get('defer'):
                deferred.append((source['Original School Name'], d['label'],
                                 pages_cell, pb['defer']))
            else:
                d['min_pages'] = pb['min_pages']
                d['max_pages'] = pb['max_pages']
                d['pages_enforcement'] = 'enforced'
                d['pages_stated_as'] = stated_quote(pb['stated_as'])
                notes.append((source['Original School Name'], d['label'], 'pages',
                              '%s-%s' % (pb['min_pages'] or '', pb['max_pages'] or ''),
                              pb.get('flag') or stated_basis(pb['stated_as']) or None))

        # ---- the prose a bound has superseded ------------------------------
        #
        # Every promotion above is now settled for this document, so this is
        # the one place that can see whether it ended up bounded. Migration
        # 006 refuses a row holding BOTH a structured bound and the sentence
        # saying its length is unconfirmed, and 006 is applied to production:
        # a row like that cannot be written at all, by the import or by a
        # targeted UPDATE. The rule is in scripts/statement_catalog_invariants.py
        # and it asks only about this row's data -- so the three documents
        # whose figures PAGE_BOUNDS deliberately defers keep their verbatim
        # sentence, because the same decision gave them no bound.
        dropped = clear_superseded_length_prose(d, blank='')
        if dropped:
            notes.append((source['Original School Name'], d['label'],
                          'superseded prose', ', '.join(dropped) + ' -> null',
                          'a structured bound now states this length; 006 refuses '
                          'the row that carries both'))

        d['font_family'] = rule['font_family'] or ''
        d['font_size_pt'] = '' if rule['font_size_pt'] is None else str(rule['font_size_pt'])
        d['margins_inches'] = rule['margins_inches'] or ''
        # ORDER IS THE SOURCE'S: typography first, then citation, exactly as the
        # preview composed it, so an unchanged row stays byte-identical.
        d['other_instructions'] = json.dumps(
            list(rule['keep']) + list(CITATION[cit]['keep']), ensure_ascii=False)

        after = dict(font_family=d['font_family'], font_size_pt=d['font_size_pt'],
                     margins_inches=d['margins_inches'],
                     other_instructions=d['other_instructions'],
                     min_words=d['min_words'], max_words=d['max_words'],
                     min_pages=d['min_pages'], max_pages=d['max_pages'],
                     unenforced_length=d['unenforced_length'],
                     unenforced_length_verbatim=d['unenforced_length_verbatim'])
        if before != after:
            changed.append((source['Original School Name'], d['label'], fm, cit,
                            before, after, rule['note'], CITATION[cit]['note']))

    # ---- the reviewed text corrections, last, so they see final values ----
    by_slug_label = {(d['_src_program'], d['label']): d for d in docs}
    corrected = apply_text_corrections(docs, by_slug_label)

    # ---- NO GENERATED DOCUMENT MAY VIOLATE THE APPLIED SCHEMA -------------
    #
    # Re-derived from the finished rows rather than trusted from the clear
    # above, so a transformation added later that sets a bound by some other
    # route, or a preview CSV edited by hand, stops the run here instead of
    # becoming an UPDATE production refuses. Checked BEFORE the CSV is
    # written: a refused run leaves the preview exactly as it found it.
    assert_catalog_invariants(
        docs,
        describe=lambda d: '%s / %s' % (d['_src_program'], d['label']),
        stop=stop)

    out = os.path.join(RESEARCH, PREVIEW)
    with open(out, 'w', newline='', encoding='utf-8') as fh:
        writer = csv.DictWriter(fh, fieldnames=columns)
        writer.writeheader()
        writer.writerows(docs)

    if corrected:
        print('\n--- RESEARCHER TEXT REMOVED FROM SCHOOL-ATTRIBUTED FIELDS (%d) ---'
              % len(corrected))
        for fix in corrected:
            print('  %s / %s / %s' % (fix['slug'], fix['label'], fix['field']))
            print('      %s' % fix['why'])
            print('      -> %r' % fix['after'])
            if fix['note'] is not None:
                print('      kept as a note: %r' % fix['note'])

    print('normalized %d of %d documents' % (len(changed), len(docs)))
    for school, label, fm, cit, before, after, fnote, cnote in changed:
        print('\n  %s | %s' % (school, label))
        print('    verified font/margins : %r  -> %s' % (fm, fnote))
        if cit != 'Not stated':
            print('    verified citation     : %r  -> %s' % (cit, cnote))
        print('    font_family           : %r -> %r'
              % (before['font_family'], after['font_family']))
        print('    font_size_pt          : %r -> %r'
              % (before['font_size_pt'], after['font_size_pt']))
        print('    margins_inches        : %r -> %r'
              % (before['margins_inches'], after['margins_inches']))
        print('    other_instructions    : %s -> %s'
              % (before['other_instructions'], after['other_instructions']))
    if deferred:
        print('\n--- VERIFIED FIGURES DELIBERATELY LEFT AS PROSE (%d) ---' % len(deferred))
        for school, label, cell, why in deferred:
            print('  %-44s %-34s %r' % (school[:44], label[:34], cell))
            print('      %s' % why)
    if notes:
        print('\n--- LENGTH BOUNDS RE-CLASSIFIED (%d) ---' % len(notes))
        for school, label, unit, value, flag in notes:
            print('  %-44s %-34s %s %s' % (school[:44], label[:34], unit, value))
            if flag:
                print('      REVIEW: %s' % flag)
    print('\nwrote %s' % out)
    print('NEXT: python3 scripts/build_statement_requirements_import_sql.py')


if __name__ == '__main__':
    main()
