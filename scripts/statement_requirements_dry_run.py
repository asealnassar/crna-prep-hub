#!/usr/bin/env python3
"""LOCAL DRY RUN: research catalog -> the 005/006 statement-requirements schema.

WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT.
It reads three CSVs from the research directory, maps the approved subset onto
the exact columns defined by

    supabase/migrations/20261002_005_statement_requirements.sql
    supabase/migrations/20261002_006_statement_requirement_length_register.sql

and writes three preview files. It does NOT connect to anything, import no
database driver, hold no credential, and emit no SQL. The only writes are its
own preview artifacts.

IT FAILS CLOSED. Every value that cannot be mapped without a human judgment
causes the affected DOCUMENT to be held back and reported -- never guessed,
never coerced, never silently dropped. A set left with no mappable document is
held back too. The held-back list is part of the output, not a footnote.

MAPPING DECISIONS A HUMAN MUST CHECK -- all recorded in the report:

  1. document_type. The CSV carries nine values; migration 005 allows six.
     statement-of-purpose, autobiographical-essay and supplemental-essay have no
     home in the constraint. Re-labelling them would override the researcher's
     own classification, so those documents are HELD, not mapped.

  2. verification_status. 'VERIFIED' -> 'verified' is a case change. 'VERIFIED
     WITH CORRECTION' is not a value 005 permits, and 08_IMPORT_REVIEW.md says
     such a row is "listed here for the owner to check against the source before
     any import" -- which is what 'needs-review' means. It is mapped there, and
     because the activation constraint requires 'verified', such a set can never
     go active by accident.

  3. PAGE LIMITS ARE THE ONE REAL GAP. The dataset structures word and character
     limits as integer columns but has NO integer page columns -- only
     page_limit_cell (prose) and page_numbers_mentioned (a digit list that reads
     "1, 5" for a 1.5-page limit and is therefore unusable as a bound). Rather
     than parse admissions prose, this script uses an EXPLICIT WHITELIST of the
     exact cell strings present, each with its reviewed integer reading. Any
     string not in that table holds the document. The whitelist is below so the
     owner can read every mapping it performs.

  4. application_cycle is NULL for every set. 005 requires 'YYYY' or
     'YYYY-YYYY'; none of the source values is in that form -- they are
     deadline narratives. The raw text is carried in a _src_ column so nothing
     is lost, but it is not forced into a column that cannot hold it.

  5. Set notes are EMPTY. The research notes are internal prose; 005's notes are
     "shown to the applicant". Promoting one to the other is an editorial
     decision, not a transformation. Raw text is in the _src_ columns.

  6. Font, margin and citation text goes verbatim into other_instructions; the
     typed font_*/margins_inches/citation_* columns stay NULL. Lossless, and it
     invents no structure the source did not state.

  7. Sets are planned is_active = false (owner instruction). Documents keep
     is_active = true: an inactive set hides its documents by itself, which is
     the gate the RLS policy already enforces.

Usage:  python3 scripts/statement_requirements_dry_run.py [research_dir]
"""
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict

DEFAULT_DIR = os.path.expanduser(
    '~/Downloads/CRNA-statement-verification-2026-10-02')

# ---------------------------------------------------------------- 005 / 006
# Nine as of migration 007. The three additions let the importer keep the
# researcher's own classification instead of flattening it to 'other'.
DOCUMENT_TYPES = {'personal-statement', 'goal-statement', 'diversity-statement',
                  'writing-sample', 'additional-response', 'other',
                  'statement-of-purpose', 'autobiographical-essay',
                  'supplemental-essay'}
VERIFICATION_STATUSES = {'unverified', 'needs-review', 'verified', 'conflicting'}
ENFORCEMENTS = {'truncated', 'enforced', 'target', 'suggested', 'unknown'}
PAGE_SPACINGS = {'single', 'double'}
CYCLE_RE = re.compile(r'^[0-9]{4}(-[0-9]{4})?$')
URL_RE = re.compile(r'^https?://[^\s]+$')
DATE_RE = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')

VERIFICATION_MAP = {
    'VERIFIED': 'verified',
    'VERIFIED WITH CORRECTION': 'needs-review',
}

# Exact page_limit_cell text -> (min_pages, max_pages). Reviewed one by one.
# A string absent from this table HOLDS the document; see REFUSED_PAGE_CELLS.
PAGE_CELLS = {
    '1 page maximum':                                   (None, 1),
    '1 page maximum (per question)':                    (None, 1),
    # numeric(4,1) as of migration 007, so one and a half pages is now a value
    # the column holds exactly rather than a limit that had to be refused.
    '1.5 pages maximum (per prompt)':                   (None, 1.5),
    '2 pages maximum':                                  (None, 2),
    '2 pages maximum for the whole statement':          (None, 2),
    '2 pages maximum; only the first two pages are read': (None, 2),
    '2 pages or less':                                  (None, 2),
    '2 to 4 pages (a stated MINIMUM of 2 as well as a maximum of 4)': (2, 4),
    '3 pages maximum':                                  (None, 3),
    '3 to 5 pages for the whole essay (a stated minimum of 3 and maximum of 5); '
    'each prompt guided at 1-2 pages':                  (3, 5),
    '4 pages maximum TOTAL':                            (None, 4),
    'Minimum 1 page, maximum 2 pages':                  (1, 2),
    'Not more than 3 pages':                            (None, 3),
}
# Cells whose length is REAL AND VERIFIED but is not a bound this schema can
# express. These do not hold the document: the sentence is published as
# unenforced_length with every numeric bound NULL, which is the shape migration
# 006 defines for exactly this case. unenforced_length_verbatim is FALSE for
# both, because the text below is the research record's description of the
# school's instruction and not a quotation of it -- the same distinction the New
# Mexico State entry exists to preserve.
PROSE_ONLY_PAGE_CELLS = {
    '2 pages maximum, plus an optional 3rd page for references only':
        'two allowances in one cell (a 2-page body plus a conditional 3rd page '
        'for references); a single max_pages would silently drop the second',
    "<2 pages (stated as 'less than two pages in length'), for the whole document":
        '"less than two pages" is a strict inequality; max_pages = 2 would permit '
        'a length the school excluded, and max_pages = 1 would forbid one it allowed',
}
# Nothing is refused outright any more. Kept as an empty table so the shape of
# the decision stays visible: a future cell with no reviewed reading belongs
# here or in one of the two tables above, never in a parser.
REFUSED_PAGE_CELLS = {}

SPACING_MAP = {
    'double spaced': 'double', 'double-spaced': 'double',
    'single-spaced': 'single', 'single-spaced (explicitly)': 'single',
}
BLANKISH = {'', 'n/a', 'none', 'not stated'}


def blank(v):
    return (v or '').strip() == '' or (v or '').strip().lower() in BLANKISH


def s(v):
    return (v or '').strip()


def as_bool(v, field, ctx, errors):
    t = s(v).lower()
    if t in ('true', 'yes', '1'):
        return True
    if t in ('false', 'no', '0'):
        return False
    if t == '':
        return None
    errors.append('%s: %s is not a boolean: %r' % (ctx, field, v))
    return None


def as_int(v, field, ctx, errors, lo, hi):
    t = s(v)
    if blank(t):
        return None
    if not re.match(r'^\d+$', t):
        errors.append('%s: %s is not an integer: %r' % (ctx, field, v))
        return None
    n = int(t)
    if not (lo <= n <= hi):
        errors.append('%s: %s=%d outside the migration bound %d..%d'
                      % (ctx, field, n, lo, hi))
        return None
    return n


def parse_components(raw):
    """'(1) a; (2) b' -> [{id,text,optional}]. Anything else -> []."""
    t = s(raw)
    if blank(t) or t.lower() == 'single undivided prompt' or t.startswith('NOT PUBLISHED'):
        return []
    parts = re.findall(r'\((\d+)\)\s*([^;]+)', t)
    if not parts:
        return []
    return [{'id': 'q%s' % n, 'text': txt.strip(), 'optional': False}
            for n, txt in parts]


def main(argv):
    rdir = argv[1] if len(argv) > 1 else DEFAULT_DIR
    rdir = os.path.abspath(os.path.expanduser(rdir))

    def rd(name):
        with open(os.path.join(rdir, name), newline='', encoding='utf-8-sig') as fh:
            return list(csv.DictReader(fh))

    progs = {r['program_id']: r for r in rd('06_IMPORT_programs.csv')}
    docs = rd('07_IMPORT_documents.csv')
    rec = {r['research_program_slug']: r for r in rd('10_school_id_reconciliation.csv')}

    errors, holds = [], []

    def hold(kind, slug, label, why):
        holds.append({'kind': kind, 'program': slug, 'document': label, 'reason': why})

    # ---------------------------------------------------- PART 2: inclusion
    included = []
    for slug, r in rec.items():
        if r['import_decision'] not in ('import-ready', 'import-ready-partial'):
            hold('program', slug, '', 'import_decision is %r' % r['import_decision'])
            continue
        if not r['production_school_id']:
            hold('program', slug, '', 'no production school_id (match_status=%s)'
                 % r['match_status'])
            continue
        if r['human_approved'] != 'YES' or r['match_status'] not in (
                'exact', 'likely-needs-review'):
            hold('program', slug, '', 'match not approved (status=%s approved=%r)'
                 % (r['match_status'], r['human_approved']))
            continue
        included.append(slug)
    included.sort()

    by_prog = defaultdict(list)
    for d in docs:
        by_prog[d['program_id']].append(d)

    # ---------------------------------------------------- transform
    sets_out, reqs_out, audit = [], [], []
    set_seq = req_seq = 0

    for slug in included:
        p, r = progs[slug], rec[slug]
        ctx = slug

        raw_status = s(p['verification_status'])
        vstatus = VERIFICATION_MAP.get(raw_status)
        if vstatus is None:
            hold('program', slug, '', 'verification_status %r has no defined '
                 'mapping to one of %s' % (raw_status, sorted(VERIFICATION_STATUSES)))
            continue
        src_url = s(p['official_source_url'])
        if not URL_RE.match(src_url):
            hold('program', slug, '', 'official_source_url does not satisfy 005: %r' % src_url)
            continue
        vdate = s(p['checked_on'])
        if not DATE_RE.match(vdate):
            hold('program', slug, '', 'checked_on is not YYYY-MM-DD: %r' % vdate)
            continue
        cycle = s(p['application_cycle'])
        cycle_db = cycle if CYCLE_RE.match(cycle) else None
        original = s(p['requirement_summary'])
        if len(original) > 20000:
            hold('program', slug, '', 'requirement_summary exceeds 005\'s 20000 limit')
            continue

        # documents first: a set with nothing mappable is not proposed at all
        kept = []
        for d in sorted(by_prog[slug], key=lambda x: s(x['document_index']) or '0'):
            lbl = s(d['label']) or '(no label)'
            dctx = '%s / %s' % (slug, lbl)
            if s(d['publication_decision']) not in ('publish', 'publish-length-verbatim'):
                hold('document', slug, lbl, 'publication_decision is %r'
                     % s(d['publication_decision']))
                continue
            dtype = s(d['document_type'])
            if dtype not in DOCUMENT_TYPES:
                hold('document', slug, lbl,
                     'document_type %r is not one of migration 005\'s six values; '
                     're-labelling it would override the researcher\'s classification'
                     % dtype)
                continue
            prompt = s(d['prompt_wording'])
            if not prompt or len(prompt) > 5000:
                hold('document', slug, lbl,
                     'prompt_wording is blank or exceeds 005\'s 5000 limit (%d)' % len(prompt))
                continue
            if not (1 <= len(lbl) <= 200):
                hold('document', slug, lbl, 'label length %d outside 005\'s 1..200' % len(lbl))
                continue

            lp = s(d['length_publication'])
            row = {
                'min_words': None, 'max_words': None,
                'min_characters': None, 'max_characters': None,
                'characters_include_spaces': None,
                'min_pages': None, 'max_pages': None, 'page_spacing': None,
                'words_enforcement': None, 'words_stated_as': None,
                'characters_enforcement': None, 'characters_stated_as': None,
                'pages_enforcement': None, 'pages_stated_as': None,
                'unenforced_length': None, 'unenforced_length_verbatim': None,
            }
            page_note = ''

            # page_spacing is a property of the document, not of a limit, and
            # 005 lets it stand alone.
            sp = SPACING_MAP.get(s(d['spacing']).lower())
            if sp:
                row['page_spacing'] = sp

            if lp == 'structured':
                row['min_words'] = as_int(d['min_words'], 'min_words', dctx, errors, 1, 20000)
                row['max_words'] = as_int(d['max_words'], 'max_words', dctx, errors, 1, 20000)
                row['min_characters'] = as_int(d['min_characters'], 'min_characters',
                                               dctx, errors, 1, 200000)
                row['max_characters'] = as_int(d['max_characters'], 'max_characters',
                                               dctx, errors, 1, 200000)
                if row['min_characters'] or row['max_characters']:
                    ccm = s(d['character_counting_method'])
                    if 'EXCLUDING' in ccm.upper():
                        row['characters_include_spaces'] = False
                    elif 'INCLUDING' in ccm.upper():
                        row['characters_include_spaces'] = True

                preg = s(d['pages_register'])
                cell = s(d['page_limit_cell'])
                prose_only = False
                if preg or not blank(cell):
                    if cell in PAGE_CELLS:
                        row['min_pages'], row['max_pages'] = PAGE_CELLS[cell]
                        for b in ('min_pages', 'max_pages'):
                            v = row[b]
                            if v is not None and not (1 <= v <= 200):
                                errors.append('%s: %s=%r outside 005\'s 1..200'
                                              % (dctx, b, v))
                        page_note = 'whitelisted: %r' % cell
                    elif cell in PROSE_ONLY_PAGE_CELLS:
                        # 006 forbids unenforced_length beside ANY numeric bound,
                        # so a cell like this may only become prose if the document
                        # states no other measurable limit. If it does, dropping
                        # one to publish the other would be a silent loss.
                        if any(not blank(d[c]) for c in
                               ('min_words', 'max_words', 'min_characters',
                                'max_characters')):
                            hold('document', slug, lbl,
                                 'page wording must stay unstructured (%s) but the '
                                 'document also states a word or character bound; '
                                 '006 forbids unenforced_length beside a bound, and '
                                 'dropping either would lose a verified limit'
                                 % PROSE_ONLY_PAGE_CELLS[cell])
                            continue
                        prose_only = True
                        page_note = 'prose-only: %r' % cell
                    elif cell in REFUSED_PAGE_CELLS:
                        hold('document', slug, lbl,
                             'page limit not mappable -- %s. Source cell: %r'
                             % (REFUSED_PAGE_CELLS[cell], cell))
                        continue
                    elif not blank(cell):
                        hold('document', slug, lbl,
                             'page_limit_cell %r is not in the reviewed whitelist; '
                             'parsing it would be a judgment' % cell)
                        continue

                if prose_only:
                    # The sentence, and nothing measurable. page_spacing stays:
                    # 006 forbids a BOUND beside unenforced_length, not a
                    # formatting instruction, and the school did state the spacing.
                    row['unenforced_length'] = cell
                    row['unenforced_length_verbatim'] = False
                    row['min_words'] = row['max_words'] = None
                    row['min_characters'] = row['max_characters'] = None
                    row['min_pages'] = row['max_pages'] = None
                    row['characters_include_spaces'] = None

                register_held = False
                for unit in (() if prose_only else ('words', 'characters', 'pages')):
                    reg = s(d['%s_register' % unit])
                    basis = s(d['%s_register_basis' % unit])
                    has_limit = (row['min_%s' % unit] is not None
                                 or row['max_%s' % unit] is not None
                                 or (unit == 'pages' and row['page_spacing'] is not None))
                    if reg:
                        if reg not in ENFORCEMENTS:
                            hold('document', slug, lbl,
                                 '%s_register %r is not one of migration 006\'s five '
                                 'values' % (unit, reg))
                            register_held = True
                            break
                        if not has_limit:
                            hold('document', slug, lbl,
                                 '%s_register %r but no %s limit survived mapping; 006 '
                                 'forbids a register without a limit' % (unit, reg, unit))
                            register_held = True
                            break
                        if reg == 'truncated' and row['max_%s' % unit] is None:
                            hold('document', slug, lbl,
                                 '%s_enforcement is truncated but there is no maximum; '
                                 '006 forbids it' % unit)
                            register_held = True
                            break
                        row['%s_enforcement' % unit] = reg
                        if basis and not blank(basis):
                            row['%s_stated_as' % unit] = basis[:2000]
                    elif basis and not blank(basis) and has_limit:
                        row['%s_stated_as' % unit] = basis[:2000]
                if register_held:
                    continue

            elif lp == 'verbatim-only':
                ul = s(d['unenforced_length'])
                if not ul:
                    hold('document', slug, lbl,
                         'length_publication is verbatim-only but unenforced_length is blank')
                    continue
                if len(ul) > 2000:
                    hold('document', slug, lbl, 'unenforced_length exceeds 006\'s 2000 limit')
                    continue
                row['unenforced_length'] = ul
                row['unenforced_length_verbatim'] = as_bool(
                    d['unenforced_length_verbatim'], 'unenforced_length_verbatim', dctx, errors)
                # 006: unenforced_length forbids EVERY numeric bound. Registers
                # need a limit, so none is emitted either.

            elif lp == 'none':
                pass
            else:
                hold('document', slug, lbl, 'unknown length_publication %r' % lp)
                continue

            other = []
            for col in ('font_and_margins', 'citation_or_formatting'):
                v = s(d[col])
                if not blank(v):
                    other.append(v)
            comps = parse_components(d['components_within_document'])
            if len(comps) > 25 or len(other) > 25:
                hold('document', slug, lbl, 'components/other_instructions exceed 005\'s 25')
                continue

            req_seq += 1
            kept.append({
                'id': 'preview-req-%04d' % req_seq,
                'set_id': None,
                'school_id': r['production_school_id'],
                'document_type': dtype,
                'label': lbl,
                'prompt_text': prompt,
                'components': json.dumps(comps, ensure_ascii=False),
                'min_words': row['min_words'], 'max_words': row['max_words'],
                'min_characters': row['min_characters'],
                'max_characters': row['max_characters'],
                'characters_include_spaces': row['characters_include_spaces'],
                'min_pages': row['min_pages'], 'max_pages': row['max_pages'],
                'page_spacing': row['page_spacing'],
                'font_size_pt': None, 'font_family': None, 'margins_inches': None,
                'citation_style': None, 'citation_family': None, 'min_references': None,
                'other_instructions': json.dumps(other, ensure_ascii=False),
                'choice_group': s(d['choice_group']) or None,
                'is_optional': bool(as_bool(d['is_optional'], 'is_optional', dctx, errors)),
                'notes': '[]',
                'is_active': True,
                'display_order': int(s(d['document_index']) or 0),
                'words_enforcement': row['words_enforcement'],
                'words_stated_as': row['words_stated_as'],
                'characters_enforcement': row['characters_enforcement'],
                'characters_stated_as': row['characters_stated_as'],
                'pages_enforcement': row['pages_enforcement'],
                'pages_stated_as': row['pages_stated_as'],
                'unenforced_length': row['unenforced_length'],
                'unenforced_length_verbatim': row['unenforced_length_verbatim'],
                '_src_program': slug,
                '_src_spreadsheet_row': s(d['spreadsheet_row']),
                '_src_document_index': s(d['document_index']),
                '_src_length_publication': lp,
                '_src_page_limit_cell': s(d['page_limit_cell']),
                '_src_page_mapping': page_note,
                '_src_unclassified_figures': s(d['unclassified_figures']),
                '_src_verbatim_or_summary': s(d['verbatim_or_summary']),
            })
            if page_note:
                audit.append((slug, lbl, s(d['page_limit_cell']),
                              row['min_pages'], row['max_pages']))

        if not kept:
            hold('program', slug, '',
                 'no document survived mapping, so no set is proposed')
            continue

        set_seq += 1
        sid = 'preview-set-%04d' % set_seq
        for k in kept:
            k['set_id'] = sid
        reqs_out.extend(kept)
        sets_out.append({
            'id': sid,
            'school_id': r['production_school_id'],
            'application_cycle': cycle_db,
            'verification_status': vstatus,
            'source_url': src_url,
            'verified_on': vdate,
            'is_verbatim': bool(as_bool(p['is_verbatim'], 'is_verbatim', ctx, errors)),
            'original_text': original,
            'notes': '[]',
            'is_active': False,
            'display_order': 0,
            '_src_program': slug,
            '_src_official_name': s(p['official_name']),
            '_src_spreadsheet_rows': s(p['spreadsheet_rows']),
            '_src_verification_status': raw_status,
            '_src_application_cycle_raw': cycle,
            '_src_production_school_name': r['production_school_name'],
            '_src_match_status': r['match_status'],
            '_src_document_count': len(kept),
        })

    return rdir, progs, docs, rec, sets_out, reqs_out, holds, errors, audit, included


SET_DB_COLS = ['id', 'school_id', 'application_cycle', 'verification_status',
               'source_url', 'verified_on', 'is_verbatim', 'original_text',
               'notes', 'is_active', 'display_order']
REQ_DB_COLS = ['id', 'set_id', 'school_id', 'document_type', 'label', 'prompt_text',
               'components', 'min_words', 'max_words', 'min_characters',
               'max_characters', 'characters_include_spaces', 'min_pages', 'max_pages',
               'page_spacing', 'font_size_pt', 'font_family', 'margins_inches',
               'citation_style', 'citation_family', 'min_references',
               'other_instructions', 'choice_group', 'is_optional', 'notes',
               'is_active', 'display_order', 'words_enforcement', 'words_stated_as',
               'characters_enforcement', 'characters_stated_as', 'pages_enforcement',
               'pages_stated_as', 'unenforced_length', 'unenforced_length_verbatim']

EXPORT_DEFAULT = os.path.expanduser(
    '~/Downloads/Supabase Snippet Untitled query-13.csv')


def validate(progs, docs, rec, sets, reqs, included, export_path):
    """Part 6. Every check returns a line; a FAIL anywhere must stop the owner."""
    v = []

    def chk(ok, label, detail=''):
        v.append(('PASS' if ok else 'FAIL', label, detail))
        return ok

    chk(len(rec) == 82, 'all 82 reconciliation rows present', '%d' % len(rec))
    chk(len({r['research_program_slug'] for r in rec.values()}) == len(rec),
        'each reconciliation row appears exactly once')

    sid_by_prog = {s_['_src_program']: s_['id'] for s_ in sets}
    chk(all(s_['school_id'] and len(s_['school_id']) == 36 for s_ in sets),
        'every proposed set has one production UUID')

    if os.path.exists(export_path):
        with open(export_path, newline='', encoding='utf-8-sig') as fh:
            ids = {r['id'].strip() for r in csv.DictReader(fh)}
        bad = [s_['id'] for s_ in sets if s_['school_id'] not in ids]
        chk(not bad, 'every proposed UUID exists in the production export',
            '%d checked against %d export rows' % (len(sets), len(ids)))
    else:
        v.append(('SKIP', 'production export not found; UUID existence unverified',
                  export_path))

    used = Counter(s_['school_id'] for s_ in sets)
    dup = {k: c for k, c in used.items() if c > 1}
    chk(not dup, 'no production UUID is used by two proposed sets', str(dup or 'none'))

    set_ids = {s_['id'] for s_ in sets}
    chk(all(r['set_id'] in set_ids for r in reqs),
        'every proposed document points to a proposed set')

    inc = set(included)
    proposed = {s_['_src_program'] for s_ in sets}
    chk(proposed <= inc, 'no programme outside the included subset is proposed')
    leaked = [s_ for s_ in sets
              if rec[s_['_src_program']]['import_decision']
              not in ('import-ready', 'import-ready-partial')]
    chk(not leaked, 'no excluded or review-required programme leaked in')
    chk(not [s_ for s_ in sets if 'evansville' in s_['_src_program']],
        'University of Evansville does not appear in the preview')
    chk(not [s_ for s_ in sets if not rec[s_['_src_program']]['production_school_id']],
        'no programme without a production school leaked in')

    req_required = ['id', 'set_id', 'school_id', 'document_type', 'label',
                    'prompt_text', 'components', 'other_instructions', 'notes']
    blanks = [(r['id'], c) for r in reqs for c in req_required
              if r[c] is None or str(r[c]).strip() == '']
    chk(not blanks, 'no blank NOT NULL document field', str(blanks[:3]))
    sblanks = [(s_['id'], c) for s_ in sets
               for c in ['id', 'school_id', 'verification_status', 'notes']
               if s_[c] is None or str(s_[c]).strip() == '']
    chk(not sblanks, 'no blank NOT NULL set field', str(sblanks[:3]))

    chk(all(r['document_type'] in DOCUMENT_TYPES for r in reqs),
        'every document_type satisfies migration 005')
    chk(all(s_['verification_status'] in VERIFICATION_STATUSES for s_ in sets),
        'every verification_status satisfies migration 005',
        str(dict(Counter(s_['verification_status'] for s_ in sets))))
    enf = [r[c] for r in reqs for c in
           ('words_enforcement', 'characters_enforcement', 'pages_enforcement') if r[c]]
    chk(all(e in ENFORCEMENTS for e in enf),
        'every length enforcement satisfies migration 006', '%d values' % len(enf))

    bad = [r['id'] for r in reqs
           for u in ('words', 'characters', 'pages')
           if r['%s_enforcement' % u] == 'truncated' and r['max_%s' % u] is None]
    chk(not bad, 'every truncated register has a maximum', str(bad))

    bad = []
    for r in reqs:
        for u in ('words', 'characters', 'pages'):
            has = (r['min_%s' % u] is not None or r['max_%s' % u] is not None
                   or (u == 'pages' and r['page_spacing'] is not None))
            if not has and (r['%s_enforcement' % u] or r['%s_stated_as' % u]):
                bad.append((r['id'], u))
    chk(not bad, 'no register metadata without its limit (006)', str(bad[:3]))

    bad = [r['id'] for r in reqs if r['unenforced_length'] and any(
        r[c] is not None for c in ('min_words', 'max_words', 'min_characters',
                                   'max_characters', 'min_pages', 'max_pages'))]
    chk(not bad, 'unenforced_length never coexists with a numeric bound (006)', str(bad))
    bad = [r['id'] for r in reqs
           if r['unenforced_length_verbatim'] is not None and not r['unenforced_length']]
    chk(not bad, 'unenforced_length_verbatim always has unenforced_length (006)', str(bad))

    # No unit is ever derived from another: a word bound may exist only where the
    # source carried a word column, and so on.
    dmap = {(d['program_id'], d['document_index']): d for d in docs}
    conv = []
    for r in reqs:
        d = dmap[(r['_src_program'], r['_src_document_index'])]
        for unit, cols in (('words', ('min_words', 'max_words')),
                           ('characters', ('min_characters', 'max_characters'))):
            for c in cols:
                if r[c] is not None and blank(d[c]):
                    conv.append((r['id'], c))
        if (r['min_pages'] is not None or r['max_pages'] is not None) \
                and blank(d['page_limit_cell']):
            conv.append((r['id'], 'pages'))
    chk(not conv, 'no page-to-word or character-to-word conversion', str(conv[:3]))

    bad = [s_['id'] for s_ in sets
           if s_['source_url'] != progs[s_['_src_program']]['official_source_url'].strip()]
    chk(not bad, 'source URLs preserved byte-for-byte, none fabricated', str(bad))
    bad = [s_['id'] for s_ in sets
           if s_['verified_on'] != progs[s_['_src_program']]['checked_on'].strip()]
    chk(not bad, 'verification dates preserved, none fabricated', str(bad))
    bad = [r['id'] for r in reqs
           if r['prompt_text'] != dmap[(r['_src_program'],
                                        r['_src_document_index'])]['prompt_wording'].strip()]
    chk(not bad, 'prompt wording not rewritten', str(bad))
    bad = [r['id'] for r in reqs
           if (r['_src_program'], r['_src_document_index']) not in dmap]
    chk(not bad, 'every preview row traces to a source document row', str(bad))
    chk(all(s_['_src_program'] in progs for s_ in sets),
        'every preview set traces to a source programme row')
    chk(all(s_['is_active'] is False for s_ in sets),
        'every proposed set is planned is_active = false')
    return v


def write_artifacts(rdir, sets, reqs, holds, audit, checks, rec, progs, docs, included):
    p11 = os.path.join(rdir, '11_statement_requirement_sets_preview.csv')
    p12 = os.path.join(rdir, '12_statement_requirements_preview.csv')
    p13 = os.path.join(rdir, '13_statement_requirements_dry_run_report.md')
    for p in (p11, p12, p13):
        if os.path.exists(p):
            sys.exit('REFUSING TO OVERWRITE an existing artifact: %s' % p)

    def dump(path, rows, dbcols):
        src = [c for c in rows[0] if c.startswith('_src_')]
        with open(path, 'w', newline='', encoding='utf-8') as fh:
            w = csv.DictWriter(fh, fieldnames=dbcols + src)
            w.writeheader()
            for r in rows:
                w.writerow({k: ('' if r[k] is None else r[k]) for k in dbcols + src})

    dump(p11, sets, SET_DB_COLS)
    dump(p12, reqs, REQ_DB_COLS)

    L = []
    A = L.append
    A('# Statement Studio V2 — requirements catalog DRY RUN\n')
    A('Generated by `scripts/statement_requirements_dry_run.py`. **No SQL was '
      'generated or executed, no database was contacted, and no production row '
      'was created or changed.** Sets are planned `is_active = false`.\n')
    A('## Totals\n')
    A('| | |\n|---|---|')
    A('| Reconciliation rows read | **%d** |' % len(rec))
    A('| Programmes eligible by Part 2 rules | **%d** |' % len(included))
    A('| Requirement sets proposed | **%d** |' % len(sets))
    A('| Requirement documents proposed | **%d** |' % len(reqs))
    A('| Programmes held back | **%d** |' % sum(1 for h in holds if h['kind'] == 'program'))
    A('| Documents held back | **%d** |\n' % sum(1 for h in holds if h['kind'] == 'document'))
    A('## Validation\n')
    A('| Verdict | Check | Detail |\n|---|---|---|')
    for verdict, label, detail in checks:
        A('| %s | %s | %s |' % (verdict, label, (detail or '')[:90]))
    A('')
    A('## Page limits — every mapping this run performed\n')
    A('The dataset has no integer page columns, only prose. Each cell below was '
      'mapped from an explicit whitelist in the script; anything absent from it '
      'held the document.\n')
    A('| Programme | Document | Source cell | min_pages | max_pages |\n|---|---|---|---|---|')
    for slug, lbl, cell, mn, mx in audit:
        A('| %s | %s | `%s` | %s | %s |' % (slug[:36], lbl[:30], cell[:60],
                                             mn if mn is not None else '—',
                                             mx if mx is not None else '—'))
    A('')
    A('## Held back\n')
    for kind in ('program', 'document'):
        rows = [h for h in holds if h['kind'] == kind]
        A('### %s (%d)\n' % ('Programmes' if kind == 'program' else 'Documents', len(rows)))
        A('| Programme | Document | Reason |\n|---|---|---|')
        for h in rows:
            A('| %s | %s | %s |' % (h['program'][:40], h['document'][:34] or '—',
                                     h['reason'][:200]))
        A('')
    A('## Distributions in the proposal\n')
    for name, counter in (('document_type', Counter(r['document_type'] for r in reqs)),
                          ('verification_status', Counter(s_['verification_status'] for s_ in sets)),
                          ('words_enforcement', Counter(r['words_enforcement'] or '(none)' for r in reqs)),
                          ('characters_enforcement', Counter(r['characters_enforcement'] or '(none)' for r in reqs)),
                          ('pages_enforcement', Counter(r['pages_enforcement'] or '(none)' for r in reqs))):
        A('**%s**\n' % name)
        A('| value | count |\n|---|---|')
        for k, c in counter.most_common():
            A('| %s | %d |' % (k, c))
        A('')
    with open(p13, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(L) + '\n')
    return p11, p12, p13


if __name__ == '__main__':
    out = main(sys.argv)
    globals().update(dict(zip(
        ['RDIR', 'PROGS', 'DOCS', 'REC', 'SETS', 'REQS', 'HOLDS', 'ERRORS',
         'AUDIT', 'INCLUDED'], out)))
    checks = validate(PROGS, DOCS, REC, SETS, REQS, INCLUDED, EXPORT_DEFAULT)
    fails = [c for c in checks if c[0] == 'FAIL']
    print('sets=%d requirements=%d holds=%d errors=%d' % (len(SETS), len(REQS),
                                                          len(HOLDS), len(ERRORS)))
    for verdict, label, detail in checks:
        print('  %-5s %-58s %s' % (verdict, label, (detail or '')[:40]))
    if ERRORS:
        print('\nMAPPING ERRORS:')
        for e in ERRORS:
            print('  ' + e)
    if fails or ERRORS:
        sys.exit('VALIDATION FAILED -- no artifacts written')
    paths = write_artifacts(RDIR, SETS, REQS, HOLDS, AUDIT, checks, REC, PROGS,
                            DOCS, INCLUDED)
    print('\nwrote:')
    for p in paths:
        print('  %s' % p)
