#!/usr/bin/env python3
"""Build the production import package for the statement-requirements catalog.

Emits three files into supabase/manual/, all generated from the SAME validated
payload so they cannot disagree with each other:

    statement_requirements_catalog_import.sql            (the only writer)
    statement_requirements_catalog_import_preflight.sql  (read-only)
    statement_requirements_catalog_import_postcheck.sql  (read-only)

This script contacts nothing, imports no database driver, holds no credential
and executes no SQL. It reads CSVs and writes text.

WHY THE SQL IS GENERATED RATHER THAN HAND-WRITTEN. The payload is 63 sets and
80 documents carrying verbatim school prompts, JSON component arrays and typed
limits. Transcribing that by hand would put a human between the reviewed data
and the executed statement, which is precisely where a prompt gets silently
reworded. The generator copies values; it never edits them. Every file it emits
carries the SHA-256 of each source it was built from, so the reviewed files can
be proven to be the files executed.

DETERMINISTIC IDS -- UUIDv5, NOT gen_random_uuid(). See the import file's own
header for the argument; the short version is that neither catalog table has a
unique constraint other than its primary key, so a database-generated id would
let a re-run insert a SECOND complete catalog with no error at all.
"""
import csv
import hashlib
import json
import os
import sys
import uuid
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from statement_catalog_invariants import assert_catalog_invariants   # noqa: E402
# Overridable so the pipeline can be rehearsed, and so the invariant below can
# be mutation-tested, against a COPY of the research set. The normaliser has
# read the same variable since it was written; this one did not, which meant a
# rehearsal silently read the real directory and appeared to pass.
RESEARCH = os.environ.get(
    'STATEMENT_RESEARCH_DIR',
    os.path.expanduser('~/Downloads/CRNA-statement-verification-2026-10-02'))
OUT_DIR = os.path.join(REPO, 'supabase', 'manual')

# Fixed for this catalog, for ever. Changing it changes every id and would make
# an already-imported catalog look absent.
NAMESPACE = uuid.UUID('b7e94634-1187-4e55-b7b1-65dbaf3ed4d5')

SET_COLS = ['id', 'school_id', 'application_cycle', 'verification_status', 'source_url',
            'verified_on', 'is_verbatim', 'original_text', 'notes', 'is_active',
            'display_order']
DOC_COLS = ['id', 'set_id', 'school_id', 'document_type', 'label', 'prompt_text',
            'components', 'min_words', 'max_words', 'min_characters', 'max_characters',
            'characters_include_spaces', 'min_pages', 'max_pages', 'page_spacing',
            'font_size_pt', 'font_family', 'margins_inches',
            'document_format_profile', 'citation_style',
            'citation_family', 'min_references', 'other_instructions', 'choice_group',
            'is_optional', 'notes', 'is_active', 'display_order', 'words_enforcement',
            'words_stated_as', 'characters_enforcement', 'characters_stated_as',
            'pages_enforcement', 'pages_stated_as', 'unenforced_length',
            'unenforced_length_verbatim']

# Column type map for the temp staging tables, mirroring 005/006/007 exactly.
SET_TYPES = {
    'id': 'uuid', 'school_id': 'uuid', 'application_cycle': 'text',
    'verification_status': 'text', 'source_url': 'text', 'verified_on': 'date',
    'is_verbatim': 'boolean', 'original_text': 'text', 'notes': 'jsonb',
    'is_active': 'boolean', 'display_order': 'integer',
}
DOC_TYPES = {
    'id': 'uuid', 'set_id': 'uuid', 'school_id': 'uuid', 'document_type': 'text',
    'label': 'text', 'prompt_text': 'text', 'components': 'jsonb',
    'min_words': 'integer', 'max_words': 'integer', 'min_characters': 'integer',
    'max_characters': 'integer', 'characters_include_spaces': 'boolean',
    'min_pages': 'numeric(4,1)', 'max_pages': 'numeric(4,1)', 'page_spacing': 'text',
    'font_size_pt': 'integer', 'font_family': 'text', 'margins_inches': 'numeric(4,2)',
    'document_format_profile': 'text',
    'citation_style': 'text', 'citation_family': 'text', 'min_references': 'integer',
    'other_instructions': 'jsonb', 'choice_group': 'text', 'is_optional': 'boolean',
    'notes': 'jsonb', 'is_active': 'boolean', 'display_order': 'integer',
    'words_enforcement': 'text', 'words_stated_as': 'text',
    'characters_enforcement': 'text', 'characters_stated_as': 'text',
    'pages_enforcement': 'text', 'pages_stated_as': 'text',
    'unenforced_length': 'text', 'unenforced_length_verbatim': 'boolean',
}

DOCUMENT_TYPES = ['personal-statement', 'goal-statement', 'diversity-statement',
                  'writing-sample', 'additional-response', 'other',
                  'statement-of-purpose', 'autobiographical-essay', 'supplemental-essay']
ENFORCEMENTS = ['truncated', 'enforced', 'target', 'suggested', 'unknown']
ENF = ', '.join("'%s'" % e for e in ENFORCEMENTS)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def lit(value, pgtype):
    """One SQL literal. Single quotes doubled -- never dollar-quoted, because a
    dollar tag could collide with a school's own prose."""
    if value is None or value == '':
        return 'null'
    if pgtype == 'boolean':
        v = str(value).strip().lower()
        if v in ('true', 't', 'yes', '1'):
            return 'true'
        if v in ('false', 'f', 'no', '0'):
            return 'false'
        raise SystemExit('not a boolean: %r' % value)
    if pgtype.startswith('integer') or pgtype.startswith('numeric'):
        return str(value).strip()          # emitted bare: 1.5 stays 1.5
    text = str(value).replace("'", "''")
    if pgtype == 'jsonb':
        return "'%s'::jsonb" % text
    if pgtype == 'uuid':
        return "'%s'::uuid" % text
    if pgtype == 'date':
        return "'%s'::date" % text
    return "'%s'" % text


def set_uuid(slug):
    return str(uuid.uuid5(NAMESPACE, 'crnaprephub:statement_requirement_set:%s' % slug))


def doc_uuid(slug, index):
    return str(uuid.uuid5(
        NAMESPACE, 'crnaprephub:statement_requirement:%s:%s' % (slug, index)))


def read(name):
    with open(os.path.join(RESEARCH, name), newline='', encoding='utf-8-sig') as fh:
        return list(csv.DictReader(fh))


def main():
    sets = read('11_statement_requirement_sets_preview.csv')
    docs = read('12_statement_requirements_preview.csv')
    rec = {r['research_program_slug']: r
           for r in read('10_school_id_reconciliation.csv')}

    if len(sets) != 63 or len(docs) != 80:
        sys.exit('STOP: the previews hold %d sets and %d documents, not 63/80. '
                 'Re-run the dry run and read its report before building an import.'
                 % (len(sets), len(docs)))

    # ---- NOTHING IS EMITTED THAT THE APPLIED SCHEMA WOULD REFUSE ----------
    #
    # Migration 006 is in production. A document holding a structured bound
    # beside the prose that bound was normalised from cannot be written by the
    # import, and cannot be written by a targeted UPDATE either -- rehearsing
    # the correction package against the real baseline is how that was found,
    # after review had read the files and missed it.
    #
    # Checked HERE as well as in the normaliser, because this is the generator
    # that produces the SQL and the review payload, and it must not depend on
    # another script having run first. The rule itself lives in
    # scripts/statement_catalog_invariants.py so the two cannot drift apart.
    assert_catalog_invariants(
        docs,
        describe=lambda d: '%s / %s' % (d['_src_program'], d['label']),
        stop=lambda message: sys.exit('STOP: %s' % message))

    # ---- deterministic ids replace the preview placeholders ----------------
    set_id_by_preview = {}
    for s in sets:
        slug = s['_src_program']
        real = set_uuid(slug)
        set_id_by_preview[s['id']] = real
        s['id'] = real
    for d in docs:
        slug, idx = d['_src_program'], d['_src_document_index']
        d['id'] = doc_uuid(slug, idx)
        if d['set_id'] not in set_id_by_preview:
            sys.exit('STOP: document %s references unknown preview set %s'
                     % (d['id'], d['set_id']))
        d['set_id'] = set_id_by_preview[d['set_id']]

    ids = [s['id'] for s in sets] + [d['id'] for d in docs]
    if len(set(ids)) != len(ids):
        sys.exit('STOP: the derived ids are not unique; the naming scheme collided')

    # ---- held back: slugs AND their production school ids ------------------
    included = {s['_src_program'] for s in sets}
    held = [r for slug, r in rec.items() if slug not in included]
    held_slugs = sorted(r['research_program_slug'] for r in held)
    held_school_ids = sorted({r['production_school_id'] for r in held
                              if r['production_school_id']})
    payload_school_ids = sorted({s['school_id'] for s in sets})
    overlap = set(held_school_ids) & set(payload_school_ids)
    if overlap:
        sys.exit('STOP: a held-back school id is also in the payload: %s' % overlap)

    # ---- distributions, embedded so the postcheck asserts exact numbers ----
    vstatus = Counter(s['verification_status'] for s in sets)
    dtypes = Counter(d['document_type'] for d in docs)
    wenf = Counter(d['words_enforcement'] or '(none)' for d in docs)
    cenf = Counter(d['characters_enforcement'] or '(none)' for d in docs)
    penf = Counter(d['pages_enforcement'] or '(none)' for d in docs)
    frac = [d for d in docs if '.' in (d['max_pages'] or '')
            or '.' in (d['min_pages'] or '')]
    unenf = [d for d in docs if d['unenforced_length']]
    hashes = {name: sha256(os.path.join(RESEARCH, name)) for name in (
        '10_school_id_reconciliation.csv',
        '11_statement_requirement_sets_preview.csv',
        '12_statement_requirements_preview.csv',
        '06_IMPORT_programs.csv', '07_IMPORT_documents.csv')}

    facts = dict(
        sets=sets, docs=docs, rec=rec, held=held, held_slugs=held_slugs,
        held_school_ids=held_school_ids, payload_school_ids=payload_school_ids,
        vstatus=vstatus, dtypes=dtypes, wenf=wenf, cenf=cenf, penf=penf,
        frac=frac, unenf=unenf, hashes=hashes,
    )
    return facts


# ---------------------------------------------------------------------------
# Emitters
# ---------------------------------------------------------------------------

def temp_ddl(name, cols, types):
    body = ',\n'.join('  %-26s %s' % (c, types[c]) for c in cols)
    return 'create temp table %s (\n%s\n) on commit drop;\n' % (name, body)


def values_block(rows, cols, types):
    out = []
    for r in rows:
        out.append('  (' + ', '.join(lit(r[c], types[c]) for c in cols) + ')')
    return ',\n'.join(out)


# ---------------------------------------------------------------------------
# THE BANNER EVERY GENERATED ARTIFACT CARRIES
# ---------------------------------------------------------------------------
# The catalog was imported into production from one build of this script, and
# then the research previews were corrected and the script was run again --
# OVERWRITING the package production had actually run. The original was never
# committed, so for a while nothing in the repository distinguished "what
# production holds" from "what we would now like it to hold", and the postcheck
# beside this file asserted the second while describing itself as a check of the
# first.
#
# EMITTED BY THE GENERATOR, NOT ADDED BY HAND, so the next regeneration cannot
# quietly drop it. The frozen baseline lives in
# supabase/manual/catalog_import_baseline/ and MIGRATION_STATUS.md records which
# is which.
NOT_PRODUCTION_BANNER = """\
-- ===========================================================================
-- GENERATED FROM THE CURRENT RESEARCH PREVIEWS -- NOT THE PACKAGE PRODUCTION RAN
-- ===========================================================================
-- This file describes the DESIRED catalog state. Production was imported from
-- the frozen baseline in supabase/manual/catalog_import_baseline/, and the two
-- differ by the typography normalization (14 documents).
--
-- DO NOT RUN THIS AGAINST PRODUCTION -- and the reason is not the obvious one.
--
-- THIS IMPORT CANNOT OVERWRITE ANYTHING. It stages the payload into TEMP tables
-- and then requires an EMPTY catalog: a precondition block raises IMPORT
-- REFUSED unless statement_requirement_sets and statement_requirements both
-- hold zero rows, and it does so before either of the two statements that write
-- to public. There is no ON CONFLICT, DELETE, TRUNCATE or UPDATE anywhere in
-- this file. Run against the current catalog it inserts nothing, the exception
-- aborts the single surrounding transaction, and production is unchanged.
--
-- THE DANGER IS WHAT THE REFUSAL INVITES. The import has no update path at all,
-- so it can never deliver a correction -- and an operator looking at a refusal
-- is one step away from "fixing" it by emptying the tables first or adding an
-- upsert, and THAT would be destructive. The correction is a targeted UPDATE of
-- the affected ids, with its own preflight.
--
-- A postcheck generated from this file asserts the NORMALIZED state and will
-- FAIL against production until that correction has been applied. That is
-- correct, and it is not a reason to rerun the import.
--
-- See supabase/manual/MIGRATION_STATUS.md.
-- ==========================================================================="""


def hash_comment(hashes, extra=''):
    L = [NOT_PRODUCTION_BANNER,
         '-- SOURCE FINGERPRINTS (SHA-256). The reviewed files are the files executed:']
    for k in sorted(hashes):
        L.append('--   %-44s %s' % (k, hashes[k]))
    if extra:
        L.append('--   %s' % extra)
    return '\n'.join(L)


def write(path, text):
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(text)
    return path


def emit_import(f):
    sets, docs, h = f['sets'], f['docs'], f['hashes']
    L = []
    A = L.append
    A('-- ============================================================================')
    A('-- Statement Studio V2 -- PRODUCTION CATALOG IMPORT.')
    A('--')
    A('-- DATA IMPORT, NOT A MIGRATION. It creates no table, column, constraint,')
    A('-- index, policy or function in public, and changes no grant. It inserts 63')
    A('-- requirement sets and 80 requirement documents and nothing else.')
    A('--')
    A('-- GENERATED by scripts/build_statement_requirements_import_sql.py from the')
    A('-- validated dry-run previews. Do not hand-edit: rebuild it. A human editing')
    A('-- 143 rows of verbatim school prose is the failure this generation exists to')
    A('-- prevent.')
    A('--')
    A(hash_comment(h))
    A('--')
    A('-- ============================================================================')
    A('-- WHY THE IDS ARE DERIVED HERE AND NOT BY THE DATABASE.')
    A('-- ============================================================================')
    A('-- Every id below is a UUIDv5 of a fixed namespace plus a stable name:')
    A('--')
    A('--   a set:      crnaprephub:statement_requirement_set:<research slug>')
    A('--   a document: crnaprephub:statement_requirement:<research slug>:<index>')
    A('--')
    A('-- so rebuilding this file from the same previews produces byte-identical ids.')
    A('--')
    A('-- THE DECIDING FACT IS THAT NEITHER CATALOG TABLE HAS A UNIQUE CONSTRAINT')
    A('-- OTHER THAN ITS PRIMARY KEY. 005 declares `id uuid primary key default')
    A('-- gen_random_uuid()` and nothing else unique -- no unique on school_id, none')
    A('-- on (school_id, application_cycle). So with database-generated ids, running')
    A('-- this file twice would insert a SECOND COMPLETE CATALOG with no error at')
    A('-- all, and every applicant would see every school twice. With the ids fixed')
    A('-- here, a second run dies on')
    A('--')
    A('--   duplicate key value violates unique constraint')
    A('--     "statement_requirement_sets_pkey"')
    A('--')
    A('-- inside the transaction, inserting nothing. The safety is the primary key')
    A('-- doing its job, which only works if WE choose the key.')
    A('--')
    A('-- It also makes an uncertain execution DECIDABLE. The ids are known before')
    A('-- the run, so counting how many of them exist afterwards distinguishes "not')
    A('-- applied" (0) from "fully applied" (143) from "something else happened"')
    A('-- (anything between). A gen_random_uuid() import leaves no such question to')
    A('-- ask. See statement_requirements_catalog_import_postcheck.sql.')
    A('--')
    A('-- RECOMMENDED FOLLOW-UP, OUT OF SCOPE HERE: a unique constraint on the')
    A('-- catalog would make this structural rather than conventional. That is a')
    A('-- schema migration and this file is not one.')
    A('--')
    A('-- ============================================================================')
    A('-- HOW IT FAILS')
    A('-- ============================================================================')
    A('-- One transaction. The payload is staged in TEMP tables first, so every')
    A('-- precondition -- including whether each school_id exists in public.schools')
    A('-- and whether a held-back programme crept in -- is checked BEFORE a single')
    A('-- row reaches the catalog. All failures are collected and reported together')
    A('-- rather than one at a time.')
    A('--')
    A('-- THERE IS NO `on conflict` ANYWHERE IN THIS FILE, deliberately. `do nothing`')
    A('-- would convert "the catalog is already there" -- the one state that must')
    A('-- stop everything -- into a silent success.')
    A('--')
    A('-- NOTHING IS ACTIVATED. Every set is inserted is_active = false, so the')
    A('-- catalog is invisible to applicants even with STATEMENT_REQUIREMENTS on.')
    A('-- Activation is a separate decision and a separate statement.')
    A('-- ============================================================================')
    A('')
    A('begin;')
    A('')
    A("-- Fail fast rather than queue behind a long transaction. The catalog tables")
    A("-- are empty and unread, so this should never wait at all.")
    A("set local lock_timeout = '5s';")
    A("set local statement_timeout = '120s';")
    A('')
    A('-- ---- staging ------------------------------------------------------------')
    A(temp_ddl('_import_sets', SET_COLS, SET_TYPES))
    A(temp_ddl('_import_docs', DOC_COLS, DOC_TYPES))
    A('create temp table _held_back (\n  slug                       text,\n'
      '  school_id                  uuid\n) on commit drop;\n')
    A('insert into _import_sets (%s) values' % ', '.join(SET_COLS))
    A(values_block(sets, SET_COLS, SET_TYPES) + ';')
    A('')
    A('insert into _import_docs (%s) values' % ', '.join(DOC_COLS))
    A(values_block(docs, DOC_COLS, DOC_TYPES) + ';')
    A('')
    A('-- Every programme the dry run held back, with its production school id where')
    A('-- it has one. Precondition 11 asserts none of these reached the payload.')
    A('insert into _held_back (slug, school_id) values')
    A(',\n'.join('  (%s, %s)' % (lit(r['research_program_slug'], 'text'),
                                 lit(r['production_school_id'] or None, 'uuid'))
                 for r in f['held']) + ';')
    A('')
    A('-- ---- PRECONDITIONS -----------------------------------------------------')
    A('do $precond$')
    A('declare')
    A("  v_fail text[] := '{}';")
    A('  v_def  text;')
    A('  v_t    text;')
    A('  v_n    bigint;')
    A('begin')
    A('  -- 1 + 4. tables and the 005 signature')
    A("  if to_regclass('public.statement_requirement_sets') is null then")
    A("    v_fail := array_append(v_fail, '005 signature: public.statement_requirement_sets is missing');")
    A('  end if;')
    A("  if to_regclass('public.statement_requirements') is null then")
    A("    v_fail := array_append(v_fail, '005 signature: public.statement_requirements is missing');")
    A('  end if;')
    A("  if to_regclass('public.schools') is null then")
    A("    v_fail := array_append(v_fail, 'public.schools is missing, so no school_id can be validated');")
    A('  end if;')
    A('')
    A('  -- 006 signature: the eight register columns')
    A('  select count(*) into v_n from information_schema.columns')
    A("   where table_schema = 'public' and table_name = 'statement_requirements'")
    A("     and column_name in ('words_enforcement','words_stated_as',")
    A("          'characters_enforcement','characters_stated_as','pages_enforcement',")
    A("          'pages_stated_as','unenforced_length','unenforced_length_verbatim');")
    A('  if v_n <> 8 then')
    A("    v_fail := array_append(v_fail, format('006 signature: %s of 8 register columns present', v_n));")
    A('  end if;')
    A('')
    A('  -- 2 + 007 signature: all nine document types are accepted')
    A('  select pg_get_constraintdef(oid) into v_def from pg_constraint')
    A("   where conname = 'statement_requirements_document_type_known'")
    A("     and conrelid = 'public.statement_requirements'::regclass;")
    A('  if v_def is null then')
    A("    v_fail := array_append(v_fail, 'the document_type constraint is missing');")
    A('  else')
    A('    foreach v_t in array array[%s] loop' % ', '.join(
        "'%s'" % t for t in DOCUMENT_TYPES))
    A("      if v_def not like '%' || quote_literal(v_t) || '%' then")
    A("        v_fail := array_append(v_fail, format('007 signature: document_type %s is not accepted', v_t));")
    A('      end if;')
    A('    end loop;')
    A('  end if;')
    A('')
    A('  -- 3. page columns carry the post-007 type')
    A("  for v_t in select unnest(array['min_pages','max_pages']) loop")
    A('    if not exists (select 1 from information_schema.columns')
    A("                    where table_schema = 'public'")
    A("                      and table_name = 'statement_requirements'")
    A("                      and column_name = v_t and data_type = 'numeric'")
    A('                      and numeric_precision = 4 and numeric_scale = 1) then')
    A("      v_fail := array_append(v_fail, format('007 signature: %s is not numeric(4,1)', v_t));")
    A('    end if;')
    A('  end loop;')
    A('')
    A('  -- 5 + 6. the catalog must be EMPTY. Not "mostly empty".')
    A('  select count(*) into v_n from public.statement_requirement_sets;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('statement_requirement_sets already holds %s row(s). "
      "This import is for an empty catalog; it does not merge. Run the postcheck and classify the state before any retry.', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from public.statement_requirements;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('statement_requirements already holds %s row(s)', v_n));")
    A('  end if;')
    A('')
    A('  -- 12. exact cardinality of the staged payload')
    A('  select count(*) into v_n from _import_sets;')
    A('  if v_n <> 63 then')
    A("    v_fail := array_append(v_fail, format('payload has %s sets, expected exactly 63', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from _import_docs;')
    A('  if v_n <> 80 then')
    A("    v_fail := array_append(v_fail, format('payload has %s documents, expected exactly 80', v_n));")
    A('  end if;')
    A('')
    A('  -- 7 + 8. every school_id exists, exactly once. No id is invented here:')
    A('  -- each one came from the owner-approved reconciliation.')
    A('  select count(*) into v_n from _import_sets s')
    A('   where not exists (select 1 from public.schools h where h.id = s.school_id);')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s payload school_id(s) are absent from public.schools', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from (')
    A('    select s.school_id from _import_sets s')
    A('      join public.schools h on h.id = s.school_id')
    A('     group by s.school_id having count(h.id) <> 1) q;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s payload school_id(s) do not resolve to exactly one school row', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from (')
    A('    select school_id from _import_sets group by school_id having count(*) > 1) q;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s school_id(s) appear in more than one payload set', v_n));")
    A('  end if;')
    A('')
    A('  -- 9. every source_url satisfies the constraint 005 will apply')
    A('  select count(*) into v_n from _import_sets')
    A("   where source_url is null or source_url !~ '^https?://[^[:space:]]+$';")
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s set(s) carry a source_url the schema would refuse', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from _import_sets where verified_on is null;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s set(s) carry no verified_on', v_n));")
    A('  end if;')
    A('')
    A('  -- 10. nothing is activated by this import')
    A('  select count(*) into v_n from _import_sets where is_active is not false;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s payload set(s) are not is_active = false', v_n));")
    A('  end if;')
    A('')
    A('  -- 11. no held-back programme, by slug OR by school id')
    A('  select count(*) into v_n from _import_sets s')
    A('    join _held_back b on b.school_id = s.school_id;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s payload set(s) carry a HELD-BACK school id', v_n));")
    A('  end if;')
    A('')
    A('  -- the verification statuses and document types the payload may contain')
    A('  select count(*) into v_n from _import_sets')
    A("   where verification_status not in ('unverified','needs-review','verified','conflicting');")
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s set(s) carry an unknown verification_status', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from _import_docs')
    A('   where document_type not in (%s);' % ', '.join("'%s'" % t for t in DOCUMENT_TYPES))
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s document(s) carry an unsupported document_type', v_n));")
    A('  end if;')
    A('')
    A('  -- the 006 length-register rules, checked on the PAYLOAD so a violation')
    A('  -- is reported as a refusal rather than as a raw constraint violation')
    A('  select count(*) into v_n from _import_docs')
    A('   where unenforced_length is not null')
    A('     and (min_words is not null or max_words is not null')
    A('       or min_characters is not null or max_characters is not null')
    A('       or min_pages is not null or max_pages is not null);')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s staged document(s) carry unenforced_length beside a numeric bound, which 006 forbids', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from _import_docs')
    A('   where unenforced_length_verbatim is not null and unenforced_length is null;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s staged document(s) carry the verbatim flag with no text', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from _import_docs')
    A("   where coalesce(words_enforcement, 'enforced') not in (%s)" % ENF)
    A("      or coalesce(characters_enforcement, 'enforced') not in (%s)" % ENF)
    A("      or coalesce(pages_enforcement, 'enforced') not in (%s);" % ENF)
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s staged document(s) carry an invalid enforcement category', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from _import_docs')
    A("   where (words_enforcement = 'truncated' and max_words is null)")
    A("      or (characters_enforcement = 'truncated' and max_characters is null)")
    A("      or (pages_enforcement = 'truncated' and max_pages is null);")
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s staged truncated register(s) have no maximum', v_n));")
    A('  end if;')
    A('')
    A('  -- every document belongs to a staged set')
    A('  select count(*) into v_n from _import_docs d')
    A('   where not exists (select 1 from _import_sets s where s.id = d.set_id);')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s document(s) reference no staged set', v_n));")
    A('  end if;')
    A('  select count(*) into v_n from _import_docs d')
    A('    join _import_sets s on s.id = d.set_id')
    A('   where d.school_id <> s.school_id;')
    A('  if v_n <> 0 then')
    A("    v_fail := array_append(v_fail, format('%s document(s) disagree with their set about school_id', v_n));")
    A('  end if;')
    A('')
    A('  if array_length(v_fail, 1) is not null then')
    A("    raise exception E'IMPORT REFUSED. % precondition(s) failed and NOTHING WAS INSERTED:\n  - %',")
    A("      array_length(v_fail, 1), array_to_string(v_fail, E'\n  - ');")
    A('  end if;')
    A("  raise notice 'preconditions passed: empty catalog, 63 sets / 80 documents staged, "
      "every school_id resolved, no held-back programme present';")
    A('end')
    A('$precond$;')
    A('')
    A('-- ---- THE ONLY TWO STATEMENTS THAT WRITE ---------------------------------')
    A('insert into public.statement_requirement_sets (%s)' % ', '.join(SET_COLS))
    A('select %s from _import_sets;' % ', '.join(SET_COLS))
    A('')
    A('insert into public.statement_requirements (%s)' % ', '.join(DOC_COLS))
    A('select %s from _import_docs;' % ', '.join(DOC_COLS))
    A('')
    A('-- ---- POSTCONDITIONS, STILL INSIDE THE TRANSACTION ----------------------')
    A('-- Anything wrong here rolls the whole import back, so the catalog is never')
    A('-- left half-right.')
    A('do $postcond$')
    A('declare')
    A("  v_fail text[] := '{}';")
    A('  v_n    bigint;')
    A('begin')
    A('  select count(*) into v_n from public.statement_requirement_sets')
    A('   where id in (select id from _import_sets);')
    A("  if v_n <> 63 then v_fail := array_append(v_fail, format('%s of 63 sets landed', v_n)); end if;")
    A('  select count(*) into v_n from public.statement_requirement_sets;')
    A("  if v_n <> 63 then v_fail := array_append(v_fail, format('the table holds %s sets, expected exactly 63', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from public.statement_requirements')
    A('   where id in (select id from _import_docs);')
    A("  if v_n <> 80 then v_fail := array_append(v_fail, format('%s of 80 documents landed', v_n)); end if;")
    A('  select count(*) into v_n from public.statement_requirements;')
    A("  if v_n <> 80 then v_fail := array_append(v_fail, format('the table holds %s documents, expected exactly 80', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from public.statement_requirement_sets where is_active;')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s imported set(s) are ACTIVE; this import activates nothing', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from public.statement_requirements d')
    A('   where not exists (select 1 from public.statement_requirement_sets s')
    A('                      where s.id = d.set_id);')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s document(s) are orphaned', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from public.statement_requirements d')
    A('    join public.statement_requirement_sets s on s.id = d.set_id')
    A('   where d.school_id <> s.school_id;')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s document(s) disagree with their set about school_id', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from (select school_id from public.statement_requirement_sets')
    A('    group by school_id having count(*) > 1) q;')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s school(s) have more than one set', v_n)); end if;")
    A('  select count(*) into v_n from (select set_id, label from public.statement_requirements')
    A('    group by set_id, label having count(*) > 1) q;')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s duplicate (set, label) document identit(ies)', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from public.statement_requirement_sets')
    A('   where school_id is null or verification_status is null or source_url is null')
    A('      or verified_on is null or original_text is null or notes is null;')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s set(s) have a NULL required field', v_n)); end if;")
    A('  select count(*) into v_n from public.statement_requirements')
    A("   where set_id is null or school_id is null or document_type is null")
    A("      or btrim(coalesce(label,'')) = '' or btrim(coalesce(prompt_text,'')) = ''")
    A('      or components is null or other_instructions is null or notes is null;')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s document(s) have a NULL or blank required field', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from public.statement_requirement_sets s')
    A('    join _held_back b on b.school_id = s.school_id;')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s HELD-BACK school id(s) reached the catalog', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from public.statement_requirement_sets')
    A("   where verification_status not in ('unverified','needs-review','verified','conflicting');")
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s unexpected verification_status', v_n)); end if;")
    A('  select count(*) into v_n from public.statement_requirements')
    A('   where document_type not in (%s);' % ', '.join("'%s'" % t for t in DOCUMENT_TYPES))
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s unsupported document_type', v_n)); end if;")
    A('')
    A('  select count(*) into v_n from public.statement_requirements')
    A('   where coalesce(words_enforcement, pages_enforcement, characters_enforcement) is not null')
    A('     and (coalesce(words_enforcement, %s) not in (%s)' % (
        "'enforced'", ', '.join("'%s'" % e for e in ENFORCEMENTS)))
    A("       or coalesce(characters_enforcement, 'enforced') not in (%s)" % ', '.join(
        "'%s'" % e for e in ENFORCEMENTS))
    A("       or coalesce(pages_enforcement, 'enforced') not in (%s));" % ', '.join(
        "'%s'" % e for e in ENFORCEMENTS))
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s invalid enforcement category', v_n)); end if;")
    A('')
    A('  -- truncation needs a maximum, in the unit that is truncated')
    A('  select count(*) into v_n from public.statement_requirements')
    A("   where (words_enforcement = 'truncated' and max_words is null)")
    A("      or (characters_enforcement = 'truncated' and max_characters is null)")
    A("      or (pages_enforcement = 'truncated' and max_pages is null);")
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s truncated register(s) with no maximum', v_n)); end if;")
    A('')
    A('  -- unenforced_length never beside a bound, and the flag never without text')
    A('  select count(*) into v_n from public.statement_requirements')
    A('   where unenforced_length is not null')
    A('     and (min_words is not null or max_words is not null')
    A('       or min_characters is not null or max_characters is not null')
    A('       or min_pages is not null or max_pages is not null);')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s row(s) carry unenforced_length beside a numeric bound', v_n)); end if;")
    A('  select count(*) into v_n from public.statement_requirements')
    A('   where unenforced_length_verbatim is not null and unenforced_length is null;')
    A("  if v_n <> 0 then v_fail := array_append(v_fail, format('%s row(s) carry the verbatim flag with no text', v_n)); end if;")
    A('')
    A('  -- the two values this import exists to carry exactly')
    A('  select count(*) into v_n from public.statement_requirements where max_pages = 1.5;')
    A('  if v_n <> %d then' % len(f['frac']))
    A("    v_fail := array_append(v_fail, format('%%s row(s) carry max_pages = 1.5, expected %d', v_n));" % len(f['frac']))
    A('  end if;')
    A('  select count(*) into v_n from public.statement_requirements where unenforced_length is not null;')
    A('  if v_n <> %d then' % len(f['unenf']))
    A("    v_fail := array_append(v_fail, format('%%s row(s) carry unenforced_length, expected %d', v_n));" % len(f['unenf']))
    A('  end if;')
    A('')
    A('  if array_length(v_fail, 1) is not null then')
    A("    raise exception E'IMPORT ROLLED BACK. % postcondition(s) failed:\n  - %',")
    A("      array_length(v_fail, 1), array_to_string(v_fail, E'\n  - ');")
    A('  end if;')
    A("  raise notice 'postconditions passed: 63 sets and 80 documents imported, all inactive';")
    A('end')
    A('$postcond$;')
    A('')
    A('commit;')
    A('')
    A('-- Nothing below this line. Activation and the rollout flags are separate')
    A('-- owner decisions and are deliberately not expressible in this file.')
    return write(os.path.join(OUT_DIR, 'statement_requirements_catalog_import.sql'),
                 '\n'.join(L) + '\n')


def _idlist(ids):
    return ',\n'.join("  ('%s'::uuid)" % i for i in ids)


def emit_preflight(f):
    sets, docs, h = f['sets'], f['docs'], f['hashes']
    set_ids = [s['id'] for s in sets]
    doc_ids = [d['id'] for d in docs]
    L = []
    A = L.append
    A('-- Statement Studio V2 -- CATALOG IMPORT PREFLIGHT.')
    A('-- READ-ONLY. Run BEFORE statement_requirements_catalog_import.sql.')
    A('-- Mutates nothing: every reference is a catalog read, a count or a literal.')
    A('--')
    A('-- GENERATED by scripts/build_statement_requirements_import_sql.py together')
    A('-- with the import it checks, so the two cannot disagree about the payload.')
    A('--')
    A('-- THE PAYLOAD IDENTITIES ARE EMBEDDED AS LITERALS, not read from a file.')
    A('-- Supabase cannot see this machine, so the 63 set ids, 80 document ids, 63')
    A('-- school ids and the held-back school ids are all written out below. That is')
    A('-- what makes this runnable in the SQL editor with nothing attached.')
    A('--')
    A(hash_comment(h))
    A('--')
    A('-- ONE STATEMENT, because the SQL editor shows only the last result of a')
    A('-- multi-statement script.')
    A('--')
    A('-- READ THE VERDICT COLUMN. Any FAIL means do not run the import.')
    A('')
    A('with')
    A('  payload_sets(id) as (values')
    A(_idlist(set_ids) + '),')
    A('  payload_docs(id) as (values')
    A(_idlist(doc_ids) + '),')
    A('  payload_schools(school_id, expected_name) as (values')
    A(',\n'.join("  ('%s'::uuid, %s)" % (s['school_id'],
                  lit(s['_src_production_school_name'], 'text')) for s in sets) + '),')
    A('  held_back(school_id) as (values')
    A(_idlist(f['held_school_ids']) + '),')
    A('  reqs as (select to_regclass(\'public.statement_requirements\') as oid),')
    A('  sets_t as (select to_regclass(\'public.statement_requirement_sets\') as oid),')
    A('  dtc as (select pg_get_constraintdef(oid) as def from pg_constraint')
    A("           where conname = 'statement_requirements_document_type_known'")
    A('             and conrelid = (select oid from reqs)),')
    A('  checks as (')
    A('')
    A('  select 100 as step, \'target database and executing role (INFO)\' as check_name,')
    A("         'db=' || current_database() || ', current_user=' || current_user as actual,")
    A("         'the production project' as expected,")
    A("         'INFO' as verdict")
    A('')
    A('  union all')
    A("  select 200, 'schema is post-007: both page columns are numeric(4,1)',")
    A('         coalesce((select string_agg(column_name || \'=\' || data_type || \'(\'')
    A('                     || numeric_precision || \',\' || numeric_scale || \')\', \' \'')
    A("                     order by column_name) from information_schema.columns")
    A("                    where table_schema = 'public'")
    A("                      and table_name = 'statement_requirements'")
    A("                      and column_name in ('min_pages','max_pages')), 'absent'),")
    A("         'both numeric(4,1)',")
    A('         case when (select count(*) from information_schema.columns')
    A("                     where table_schema = 'public'")
    A("                       and table_name = 'statement_requirements'")
    A("                       and column_name in ('min_pages','max_pages')")
    A("                       and data_type = 'numeric' and numeric_precision = 4")
    A('                       and numeric_scale = 1) = 2')
    A("              then 'PASS' else 'FAIL -- apply 007 first; the import stages 1.5 and would be refused' end")
    A('')
    A('  union all')
    A("  select 201, 'schema is post-007: all nine document types accepted',")
    A('         (select (%s)::text from dtc) || \' of 9\','
      % ' + '.join("case when def like '%%''%s''%%' then 1 else 0 end" % t
                   for t in DOCUMENT_TYPES))
    A("         '9 of 9',")
    A('         case when (select (%s) from dtc) = 9'
      % ' + '.join("case when def like '%%''%s''%%' then 1 else 0 end" % t
                   for t in DOCUMENT_TYPES))
    A("              then 'PASS' else 'FAIL -- the payload carries types this constraint would refuse' end")
    A('')
    A('  union all')
    A("  select 202, '006 signature: the eight register columns',")
    A("         (select count(*)::text from information_schema.columns")
    A("           where table_schema = 'public' and table_name = 'statement_requirements'")
    A("             and column_name in ('words_enforcement','words_stated_as',")
    A("                  'characters_enforcement','characters_stated_as','pages_enforcement',")
    A("                  'pages_stated_as','unenforced_length','unenforced_length_verbatim')) || ' of 8',")
    A("         '8 of 8',")
    A('         case when (select count(*) from information_schema.columns')
    A("                     where table_schema = 'public' and table_name = 'statement_requirements'")
    A("                       and column_name in ('words_enforcement','words_stated_as',")
    A("                            'characters_enforcement','characters_stated_as','pages_enforcement',")
    A("                            'pages_stated_as','unenforced_length','unenforced_length_verbatim')) = 8")
    A("              then 'PASS' else 'FAIL -- apply 006 first' end")
    A('')
    A('  union all')
    A("  select 300, 'statement_requirement_sets is EMPTY  <<< the import does not merge',")
    A('         (select count(*)::text from public.statement_requirement_sets),')
    A("         '0',")
    A('         case when (select count(*) from public.statement_requirement_sets) = 0')
    A("              then 'PASS'")
    A("              else 'FAIL -- the catalog is not empty. STOP. Run the POSTCHECK and classify "
      "the state before considering any write; do not run the import to see what happens.' end")
    A('')
    A('  union all')
    A("  select 301, 'statement_requirements is EMPTY',")
    A('         (select count(*)::text from public.statement_requirements),')
    A("         '0',")
    A('         case when (select count(*) from public.statement_requirements) = 0')
    A("              then 'PASS' else 'FAIL -- see step 300' end")
    A('')
    A('  union all')
    A("  select 302, 'no row already carries one of the payload''s deterministic ids',")
    A('         (select count(*)::text from public.statement_requirement_sets')
    A('           where id in (select id from payload_sets)) || \' set(s), \'')
    A('           || (select count(*)::text from public.statement_requirements')
    A('                where id in (select id from payload_docs)) || \' document(s)\','
      )
    A("         '0 and 0',")
    A('         case when (select count(*) from public.statement_requirement_sets')
    A('                     where id in (select id from payload_sets)) = 0')
    A('               and (select count(*) from public.statement_requirements')
    A('                     where id in (select id from payload_docs)) = 0')
    A("              then 'PASS -- this exact payload has not been imported'")
    A("              else 'FAIL -- SOME OF THIS PAYLOAD IS ALREADY PRESENT. This is the "
      "partial-state signal. Do not import. Run the postcheck.' end")
    A('')
    A('  union all')
    A("  select 400, 'every payload school_id exists in public.schools',")
    A('         (select count(*)::text from payload_schools p')
    A('           where not exists (select 1 from public.schools h where h.id = p.school_id))')
    A('           || \' missing of 63\','
      )
    A("         '0 missing of 63',")
    A('         case when (select count(*) from payload_schools p')
    A('                     where not exists (select 1 from public.schools h')
    A('                                        where h.id = p.school_id)) = 0')
    A("              then 'PASS -- no school id is invented; all came from the approved reconciliation'")
    A("              else 'FAIL -- a referenced school is absent. The import will refuse.' end")
    A('')
    A('  union all')
    A("  select 401, 'every payload school_id resolves to exactly one school row',")
    A('         (select count(*)::text from (select p.school_id from payload_schools p')
    A('            join public.schools h on h.id = p.school_id')
    A('           group by p.school_id having count(h.id) <> 1) q) || \' ambiguous\','
      )
    A("         '0 ambiguous',")
    A('         case when (select count(*) from (select p.school_id from payload_schools p')
    A('                      join public.schools h on h.id = p.school_id')
    A('                     group by p.school_id having count(h.id) <> 1) q) = 0')
    A("              then 'PASS' else 'FAIL' end")
    A('')
    A('  union all')
    A("  select 402, 'no school_id appears twice in the payload',")
    A('         (select count(*)::text from (select school_id from payload_schools')
    A('           group by school_id having count(*) > 1) q),')
    A("         '0',")
    A('         case when (select count(*) from (select school_id from payload_schools')
    A('                     group by school_id having count(*) > 1) q) = 0')
    A("              then 'PASS -- one set per school' else 'FAIL' end")
    A('')
    A('  union all')
    A("  select 403, 'production school NAMES still match the reconciliation',")
    A('         (select count(*)::text from payload_schools p')
    A('            join public.schools h on h.id = p.school_id')
    A('           where btrim(h.name) <> btrim(p.expected_name)) || \' mismatch(es)\','
      )
    A("         '0 mismatches',")
    A('         case when (select count(*) from payload_schools p')
    A('                      join public.schools h on h.id = p.school_id')
    A('                     where btrim(h.name) <> btrim(p.expected_name)) = 0')
    A("              then 'PASS -- every id still names the school it was approved against'")
    A("              else 'FAIL -- a school was RENAMED since the reconciliation was approved. "
      "The id may still be right, but a human must confirm it before importing.' end")
    A('')
    A('  union all')
    A("  select 404, 'no HELD-BACK school id is in the payload',")
    A('         (select count(*)::text from payload_schools p')
    A('           where p.school_id in (select school_id from held_back)),')
    A("         '0',")
    A('         case when (select count(*) from payload_schools p')
    A('                     where p.school_id in (select school_id from held_back)) = 0')
    A("              then 'PASS -- the %d held-back programmes with a production school are absent'"
      % len(f['held_school_ids']))
    A("              else 'FAIL -- a held-back programme is in the payload' end")
    A('')
    A('  union all')
    A("  select 500, 'payload cardinality',")
    A('         (select count(*)::text from payload_sets) || \' sets, \'')
    A('           || (select count(*)::text from payload_docs) || \' documents\','
      )
    A("         '63 sets, 80 documents',")
    A('         case when (select count(*) from payload_sets) = 63')
    A('               and (select count(*) from payload_docs) = 80')
    A("              then 'PASS' else 'FAIL -- the embedded payload is not the reviewed one' end")
    A('')
    A('  union all')
    A("  select 600, 'grants unchanged: SELECT only to anon and authenticated',")
    A('         coalesce((select string_agg(table_name || \'/\' || grantee || \'/\' || privilege_type,')
    A("                                     '; ' order by table_name, grantee, privilege_type)")
    A('                     from information_schema.role_table_grants')
    A("                    where table_schema = 'public'")
    A("                      and table_name in ('statement_requirements','statement_requirement_sets')")
    A("                      and grantee in ('anon','authenticated','service_role')), 'none'),")
    A("         'SELECT only, on both tables',")
    A('         case when (select count(*) from information_schema.role_table_grants')
    A("                     where table_schema = 'public'")
    A("                       and table_name in ('statement_requirements','statement_requirement_sets')")
    A("                       and grantee in ('anon','authenticated','service_role')")
    A("                       and privilege_type <> 'SELECT') = 0")
    A("              then 'PASS -- the import needs no write grant; it runs as the table owner'")
    A("              else 'FAIL -- a browser role can write the catalog' end")
    A('')
    A('  union all')
    A("  select 601, 'RLS still enabled on both catalog tables',")
    A('         (select string_agg(relname || \'=\' || relrowsecurity::text, \'; \' order by relname)')
    A('            from pg_class where oid in ((select oid from reqs), (select oid from sets_t))),')
    A("         'both true',")
    A('         case when (select count(*) from pg_class')
    A('                     where oid in ((select oid from reqs), (select oid from sets_t))')
    A('                       and relrowsecurity) = 2')
    A("              then 'PASS' else 'FAIL' end")
    A('')
    A('  union all')
    A("  select 602, 'policies still exactly the two 005 created',")
    A('         coalesce((select string_agg(tablename || \'/\' || policyname, \'; \' order by tablename)')
    A("                     from pg_policies where schemaname = 'public'")
    A("                      and tablename in ('statement_requirements','statement_requirement_sets')), 'none'),")
    A("         'two SELECT policies',")
    A("         case when (select count(*) from pg_policies where schemaname = 'public'")
    A("                     and tablename in ('statement_requirements','statement_requirement_sets')) = 2")
    A("              then 'PASS' else 'FAIL' end")
    A('')
    A('  union all')
    A("  select 700, 'neighbouring Statement Studio row counts (RECORD THESE)',")
    A("         'drafts=' || (select count(*)::text from public.statement_drafts)")
    A("           || ' prompts=' || (select count(*)::text from public.statement_prompts)")
    A("           || ' analyses=' || (select count(*)::text from public.statement_analyses),")
    A("         'record them',")
    A("         'INFO -- the import touches none of these. The postcheck compares.'")
    A('')
    A('  union all')
    A("  select 800, 'rollout flags (NOT VISIBLE FROM SQL)',")
    A("         'check the deployment environment',")
    A("         'STATEMENT_REQUIREMENTS and STATEMENT_ANALYSIS_CACHE both off',")
    A("         'INFO -- the import activates nothing and every set lands is_active = false, "
      "so the catalog stays invisible even if a flag were on. Import and activation are separate approvals.'")
    A(')')
    A('select step, check_name, actual, expected, verdict')
    A('from checks')
    A('order by step;')
    return write(os.path.join(
        OUT_DIR, 'statement_requirements_catalog_import_preflight.sql'),
        '\n'.join(L) + '\n')


def emit_postcheck(f):
    import hashlib as _h
    sets, docs, h = f['sets'], f['docs'], f['hashes']
    set_ids = sorted(s['id'] for s in sets)
    doc_ids = sorted(d['id'] for d in docs)
    # The same aggregate PostgreSQL will compute, computed here. A fingerprint
    # match proves the exact payload landed, not merely the right number of rows.
    set_fp = _h.md5(','.join(set_ids).encode()).hexdigest()
    doc_fp = _h.md5(','.join(doc_ids).encode()).hexdigest()

    bc = [d for d in docs if d['_src_program'].startswith('06-boston-college')]
    gz = [d for d in docs if d['_src_program'].startswith('39-gonzaga')]
    uw = [d for d in docs if d['_src_program'].startswith('19-university-of-wisconsin')]

    def dist_rows(counter):
        return ',\n'.join("  (%s, %d)" % (lit(k if k != '(none)' else None, 'text'), v)
                          for k, v in sorted(counter.items()))

    L = []
    A = L.append
    A('-- Statement Studio V2 -- CATALOG IMPORT POSTCHECK.')
    A('-- READ-ONLY. Run AFTER statement_requirements_catalog_import.sql.')
    A('-- Mutates nothing.')
    A('--')
    A('-- GENERATED with the import it checks, from the same payload, so the')
    A('-- expected distributions below are not a human retyping a report.')
    A('--')
    A('-- IT COMPARES FINGERPRINTS, NOT JUST COUNTS. "63 sets exist" is satisfied by')
    A('-- 63 of the wrong sets. The md5 of the ordered id list is the payload')
    A('-- identity, so step 110 fails if a single row is the wrong row.')
    A('--')
    A('-- THIS IS ALSO THE QUERY TO RUN AFTER AN UNCERTAIN EXECUTION. Step 100')
    A('-- classifies the state in one number: 0 means definitely not applied, 143')
    A('-- means fully applied, anything else means STOP. See the import header and')
    A('-- the runbook.')
    A('--')
    A('-- READ STEP 100 BEFORE READING ANYTHING ELSE. Every check from 110 down')
    A('-- describes a catalog that HAS been imported. On an empty database they all')
    A('-- report FAIL, and that is the correct answer to the question they ask -- it')
    A('-- is not a malfunction and it is not a reason to import. If step 100 says')
    A('-- DEFINITELY NOT APPLIED, the eleven failures below say the same thing a')
    A('-- second time and carry no extra information.')
    A('--')
    A(hash_comment(h, 'payload set fingerprint (md5 of ordered ids)       %s' % set_fp))
    A('--   payload document fingerprint (md5 of ordered ids)  %s' % doc_fp)
    A('--')
    A('-- ONE STATEMENT. READ THE VERDICT COLUMN.')
    A('')
    A('with')
    A('  payload_sets(id) as (values')
    A(_idlist(set_ids) + '),')
    A('  payload_docs(id) as (values')
    A(_idlist(doc_ids) + '),')
    A('  held_back(school_id) as (values')
    A(_idlist(f['held_school_ids']) + '),')
    A('  exp_vstatus(k, n) as (values')
    A(dist_rows(f['vstatus']) + '),')
    A('  exp_dtype(k, n) as (values')
    A(dist_rows(f['dtypes']) + '),')
    A('  exp_words(k, n) as (values')
    A(dist_rows(f['wenf']) + '),')
    A('  exp_chars(k, n) as (values')
    A(dist_rows(f['cenf']) + '),')
    A('  exp_pages(k, n) as (values')
    A(dist_rows(f['penf']) + '),')
    A('  checks as (')
    A('')
    A('  select 100 as step,')
    A("         'STATE CLASSIFICATION  <<< read this first after any uncertain run' as check_name,")
    A('         (select count(*)::text from public.statement_requirement_sets')
    A('            where id in (select id from payload_sets))')
    A("           || ' of 63 sets + '")
    A('           || (select count(*)::text from public.statement_requirements')
    A('                where id in (select id from payload_docs))')
    A("           || ' of 80 documents' as actual,")
    A("         '63 + 80 = fully applied' as expected,")
    A('         case')
    A('           when (select count(*) from public.statement_requirement_sets')
    A('                   where id in (select id from payload_sets)) = 0')
    A('            and (select count(*) from public.statement_requirements')
    A('                   where id in (select id from payload_docs)) = 0')
    A("             then 'DEFINITELY NOT APPLIED -- none of the payload ids exist. This is "
      "the only state from which a fresh write may be considered.'")
    A('           when (select count(*) from public.statement_requirement_sets')
    A('                   where id in (select id from payload_sets)) = 63')
    A('            and (select count(*) from public.statement_requirements')
    A('                   where id in (select id from payload_docs)) = 80')
    A("             then 'PASS -- FULLY APPLIED. Do not rerun the import.'")
    A("           else 'FAIL -- UNEXPECTED/PARTIAL STATE. STOP. Do not rerun the import and "
      "do not delete anything. The import is one transaction, so a partial row count should "
      "be impossible; something else wrote to the catalog. Inspect before any action.'")
    A('         end as verdict')
    A('')
    A('  union all')
    A("  select 101, 'no row outside the payload is in the catalog',")
    A('         (select count(*)::text from public.statement_requirement_sets')
    A('            where id not in (select id from payload_sets))')
    A("           || ' extra set(s), '")
    A('           || (select count(*)::text from public.statement_requirements')
    A('                where id not in (select id from payload_docs))')
    A("           || ' extra document(s)',")
    A("         '0 and 0',")
    A('         case when (select count(*) from public.statement_requirement_sets')
    A('                      where id not in (select id from payload_sets)) = 0')
    A('               and (select count(*) from public.statement_requirements')
    A('                      where id not in (select id from payload_docs)) = 0')
    A("              then 'PASS' else 'FAIL -- the catalog holds rows this import did not create' end")
    A('')
    A('  union all')
    A("  select 110, 'SET FINGERPRINT (md5 of the ordered id list)',")
    A('         coalesce((select md5(string_agg(id::text, \',\' order by id::text))')
    A('                     from public.statement_requirement_sets), \'(empty)\'),')
    A("         '%s'," % set_fp)
    A('         case when (select md5(string_agg(id::text, \',\' order by id::text))')
    A("                      from public.statement_requirement_sets) = '%s'" % set_fp)
    A("              then 'PASS -- every set is the exact reviewed row, not merely 63 rows'")
    A("              else 'FAIL -- the set population differs from the reviewed payload' end")
    A('')
    A('  union all')
    A("  select 111, 'DOCUMENT FINGERPRINT (md5 of the ordered id list)',")
    A('         coalesce((select md5(string_agg(id::text, \',\' order by id::text))')
    A('                     from public.statement_requirements), \'(empty)\'),')
    A("         '%s'," % doc_fp)
    A('         case when (select md5(string_agg(id::text, \',\' order by id::text))')
    A("                      from public.statement_requirements) = '%s'" % doc_fp)
    A("              then 'PASS' else 'FAIL -- the document population differs' end")
    A('')
    A('  union all')
    A("  select 200, 'every imported set is INACTIVE',")
    A('         (select count(*)::text from public.statement_requirement_sets where is_active),')
    A("         '0',")
    A('         case when (select count(*) from public.statement_requirement_sets')
    A('                      where is_active) = 0')
    A("              then 'PASS -- the catalog is invisible to applicants; activation is a separate decision'")
    A("              else 'FAIL -- a set is ACTIVE. The import does not activate; something else did.' end")
    A('')
    A('  union all')
    A("  select 201, 'every document joins to exactly one imported set',")
    A('         (select count(*)::text from public.statement_requirements d')
    A('           where (select count(*) from public.statement_requirement_sets s')
    A('                   where s.id = d.set_id) <> 1),')
    A("         '0',")
    A('         case when (select count(*) from public.statement_requirements d')
    A('                      where (select count(*) from public.statement_requirement_sets s')
    A('                              where s.id = d.set_id) <> 1) = 0')
    A("              then 'PASS' else 'FAIL -- an orphaned or ambiguous document' end")
    A('')
    A('  union all')
    A("  select 202, 'every document''s denormalised school_id matches its set',")
    A('         (select count(*)::text from public.statement_requirements d')
    A('            join public.statement_requirement_sets s on s.id = d.set_id')
    A('           where d.school_id <> s.school_id),')
    A("         '0',")
    A('         case when (select count(*) from public.statement_requirements d')
    A('                       join public.statement_requirement_sets s on s.id = d.set_id')
    A('                      where d.school_id <> s.school_id) = 0')
    A("              then 'PASS' else 'FAIL -- the picker query would read the wrong school' end")
    A('')
    A('  union all')
    A("  select 203, 'every set has a source_url and a verified_on',")
    A('         (select count(*)::text from public.statement_requirement_sets')
    A('           where source_url is null or verified_on is null),')
    A("         '0',")
    A('         case when (select count(*) from public.statement_requirement_sets')
    A('                      where source_url is null or verified_on is null) = 0')
    A("              then 'PASS -- no verification metadata was fabricated and none is missing'")
    A("              else 'FAIL' end")
    A('')
    A('  union all')
    A("  select 204, 'no HELD-BACK school reached the catalog',")
    A('         (select count(*)::text from public.statement_requirement_sets')
    A('           where school_id in (select school_id from held_back)),')
    A("         '0',")
    A('         case when (select count(*) from public.statement_requirement_sets')
    A('                      where school_id in (select school_id from held_back)) = 0')
    A("              then 'PASS' else 'FAIL -- a held-back programme is live in the catalog' end")
    A('')
    A('  union all')
    A("  select 300, 'verification_status distribution is exact',")
    A('         coalesce((select string_agg(verification_status || \'=\' || c::text, \', \' order by verification_status)')
    A('                     from (select verification_status, count(*) c')
    A('                             from public.statement_requirement_sets group by 1) q), \'(none)\'),')
    A("         %s," % lit(', '.join('%s=%d' % (k, v) for k, v in sorted(f['vstatus'].items())), 'text'))
    A('         case when not exists (')
    A('                select 1 from exp_vstatus e')
    A('                  full join (select verification_status k, count(*) n')
    A('                               from public.statement_requirement_sets group by 1) a')
    A('                         on a.k = e.k')
    A('                 where coalesce(a.n, -1) <> coalesce(e.n, -1))')
    A("              then 'PASS' else 'FAIL -- the status mix differs from the reviewed payload' end")
    A('')
    A('  union all')
    A("  select 301, 'document_type distribution is exact',")
    A('         coalesce((select string_agg(document_type || \'=\' || c::text, \', \' order by document_type)')
    A('                     from (select document_type, count(*) c')
    A('                             from public.statement_requirements group by 1) q), \'(none)\'),')
    A("         %s," % lit(', '.join('%s=%d' % (k, v) for k, v in sorted(f['dtypes'].items())), 'text'))
    A('         case when not exists (')
    A('                select 1 from exp_dtype e')
    A('                  full join (select document_type k, count(*) n')
    A('                               from public.statement_requirements group by 1) a')
    A('                         on a.k = e.k')
    A('                 where coalesce(a.n, -1) <> coalesce(e.n, -1))')
    A("              then 'PASS -- including the three types migration 007 added' else 'FAIL' end")
    A('')
    for step, col, cte, counter, label in (
            (310, 'words_enforcement', 'exp_words', f['wenf'], 'word'),
            (311, 'characters_enforcement', 'exp_chars', f['cenf'], 'character'),
            (312, 'pages_enforcement', 'exp_pages', f['penf'], 'page')):
        expected = ', '.join(
            '%s=%d' % (k if k != '(none)' else '(null)', v)
            for k, v in sorted(counter.items()))
        A('  union all')
        A("  select %d, '%s-enforcement distribution is exact'," % (step, label))
        A("         coalesce((select string_agg(coalesce(%s, '(null)') || '=' || c::text, ', '" % col)
        A("                     order by coalesce(%s, '(null)'))" % col)
        A('                     from (select %s, count(*) c' % col)
        A("                             from public.statement_requirements group by 1) q), '(none)'),")
        A('         %s,' % lit(expected, 'text'))
        A('         case when not exists (')
        A('                select 1 from %s e' % cte)
        A('                  full join (select %s k, count(*) n' % col)
        A('                               from public.statement_requirements group by 1) a')
        A("                         on coalesce(a.k, '') = coalesce(e.k, '')")
        A('                 where coalesce(a.n, -1) <> coalesce(e.n, -1))')
        A("              then 'PASS' else 'FAIL -- the %s register mix differs from the reviewed payload' end" % label)
        A('')
    A('  union all')
    A("  select 320, 'fractional page limits present, and exactly as many as reviewed',")
    A('         (select count(*)::text from public.statement_requirements')
    A('           where max_pages is not null and max_pages <> trunc(max_pages)),')
    A("         '%d'," % len(f['frac']))
    A('         case when (select count(*) from public.statement_requirements')
    A('                      where max_pages is not null and max_pages <> trunc(max_pages)) = %d'
      % len(f['frac']))
    A("              then 'PASS -- no page limit was rounded to an integer on the way in'")
    A("              else 'FAIL -- a fractional page limit was lost or invented' end")
    A('')
    if bc:
        A('  union all')
        A("  select 321, 'Boston College: both goal essays carry max_pages = 1.5 exactly',")
        A('         coalesce((select string_agg(max_pages::text || \'/\' || coalesce(pages_enforcement, \'(null)\')')
        A('                                     || \'/\' || coalesce(page_spacing, \'(null)\'), \', \' order by id::text)')
        A('                     from public.statement_requirements')
        A('                    where id in (%s)), \'(absent)\'),'
          % ', '.join("'%s'::uuid" % d['id'] for d in bc))
        A("         '%s'," % ', '.join('1.5/enforced/double' for _ in bc))
        A('         case when (select count(*) from public.statement_requirements')
        A('                      where id in (%s)' % ', '.join("'%s'::uuid" % d['id'] for d in bc))
        A("                        and max_pages = 1.5 and pages_enforcement = 'enforced'")
        A("                        and page_spacing = 'double'")
        A('                        and min_pages is null') 
        A('                        and max_words is null and max_characters is null) = %d' % len(bc))
        A("              then 'PASS -- 1.5 survived, and no word or character bound was derived from it'")
        A("              else 'FAIL' end")
        A('')
    for step, rows, who in ((330, gz, 'Gonzaga'), (331, uw, 'UW-La Crosse')):
        if not rows:
            continue
        A('  union all')
        A("  select %d, '%s: length stays PROSE ONLY, with no numeric bound'," % (step, who))
        A('         coalesce((select left(unenforced_length, 48) || \' | verbatim=\'')
        A('                     || coalesce(unenforced_length_verbatim::text, \'(null)\')')
        A('                     || \' | bounds=\' || (case when coalesce(min_words, max_words,')
        A('                          min_characters, max_characters) is null')
        A('                          and min_pages is null and max_pages is null')
        A('                          then \'none\' else \'PRESENT\' end)')
        A('                     from public.statement_requirements where id = \'%s\'::uuid), \'(absent)\'),'
          % rows[0]['id'])
        A("         'the prose, verbatim=false, bounds=none',")
        A('         case when (select count(*) from public.statement_requirements')
        A("                      where id = '%s'::uuid" % rows[0]['id'])
        A('                        and unenforced_length is not null')
        A('                        and unenforced_length_verbatim = false')
        A('                        and min_words is null and max_words is null')
        A('                        and min_characters is null and max_characters is null')
        A('                        and min_pages is null and max_pages is null')
        A('                        and pages_enforcement is null) = 1')
        A("              then 'PASS -- the sentence is published and nothing is enforced'")
        A("              else 'FAIL -- a bound was invented, or the prose was lost' end")
        A('')
    A('  union all')
    A("  select 400, 'grants unchanged: SELECT only to anon and authenticated',")
    A('         coalesce((select string_agg(table_name || \'/\' || grantee || \'/\' || privilege_type,')
    A("                                     '; ' order by table_name, grantee, privilege_type)")
    A('                     from information_schema.role_table_grants')
    A("                    where table_schema = 'public'")
    A("                      and table_name in ('statement_requirements','statement_requirement_sets')")
    A("                      and grantee in ('anon','authenticated','service_role')), 'none'),")
    A("         'SELECT only, on both tables',")
    A('         case when (select count(*) from information_schema.role_table_grants')
    A("                     where table_schema = 'public'")
    A("                       and table_name in ('statement_requirements','statement_requirement_sets')")
    A("                       and grantee in ('anon','authenticated','service_role')")
    A("                       and privilege_type <> 'SELECT') = 0")
    A("              then 'PASS -- a data import changes no grant' else 'FAIL' end")
    A('')
    A('  union all')
    A("  select 401, 'RLS unchanged: enabled on both catalog tables',")
    A('         (select string_agg(relname || \'=\' || relrowsecurity::text, \'; \' order by relname)')
    A("            from pg_class where relname in ('statement_requirements','statement_requirement_sets')")
    A("             and relnamespace = 'public'::regnamespace),")
    A("         'both true',")
    A('         case when (select count(*) from pg_class')
    A("                     where relname in ('statement_requirements','statement_requirement_sets')")
    A("                       and relnamespace = 'public'::regnamespace and relrowsecurity) = 2")
    A("              then 'PASS' else 'FAIL -- the catalog is readable without a policy' end")
    A('')
    A('  union all')
    A("  select 402, 'policies unchanged: exactly the two 005 created',")
    A('         coalesce((select string_agg(tablename || \'/\' || policyname, \'; \' order by tablename)')
    A("                     from pg_policies where schemaname = 'public'")
    A("                      and tablename in ('statement_requirements','statement_requirement_sets')), 'none'),")
    A("         'two SELECT policies',")
    A("         case when (select count(*) from pg_policies where schemaname = 'public'")
    A("                     and tablename in ('statement_requirements','statement_requirement_sets')) = 2")
    A("              then 'PASS' else 'FAIL' end")
    A('')
    A('  union all')
    A("  select 500, 'neighbouring Statement Studio tables (COMPARE TO PREFLIGHT 700)',")
    A("         'drafts=' || (select count(*)::text from public.statement_drafts)")
    A("           || ' prompts=' || (select count(*)::text from public.statement_prompts)")
    A("           || ' analyses=' || (select count(*)::text from public.statement_analyses),")
    A("         'identical to preflight step 700',")
    A("         'INFO -- this import writes only the two catalog tables. A change here "
      "did not come from it.'")
    A('')
    A('  union all')
    A("  select 600, 'rollout flags (NOT VISIBLE FROM SQL)',")
    A("         'check the deployment environment',")
    A("         'both still off',")
    A("         'INFO -- importing is not activating. Every set is is_active = false, so "
      "turning STATEMENT_REQUIREMENTS on would still show an applicant nothing.'")
    A(')')
    A('select step, check_name, actual, expected, verdict')
    A('from checks')
    A('order by step;')
    return write(os.path.join(
        OUT_DIR, 'statement_requirements_catalog_import_postcheck.sql'),
        '\n'.join(L) + '\n')


# ---------------------------------------------------------------------------
# TWO SCHOOL NAMES ARE MISSPELLED, AND NOT IN THIS CATALOG
# ---------------------------------------------------------------------------
# `schools.name` is production's own column. The statement catalog does not
# store a school name at all -- it joins -- so "Ceder Crest" and "Saint Marys
# University of Minnesota" reach an applicant through the Studio without the
# Studio having anything to do with them. Both are wrong: the research set
# records the real names, in `research_original_names`, and had them right all
# along.
#
# WHY THIS IS NOT FIXED IN THE STUDIO. A map from a wrong name to a right one,
# consulted while rendering, would make every other surface in the product
# disagree with the Studio and would have to be maintained for ever. The names
# are wrong in one row each of one table, which is where they get fixed.
#
# WHAT THIS TABLE PRODUCES. A targeted UPDATE, in its own file, which an
# operator runs once -- and the corrected name in the local review payload, so
# the Studio shows the right thing on the machine where this is being reviewed.
#
# THE PREFLIGHT IS DELIBERATELY NOT CHANGED. It asserts that the school id in
# the payload still carries the name production has today, which is how it
# proves it is looking at the school it thinks it is. It would be wrong for a
# correction that has not been applied to make that check fail.
#
# `before` IS MATCHED EXACTLY and a mismatch STOPS THE RUN: if the name has
# already been fixed, or changed to something else, a person reads it.
SCHOOL_NAME_CORRECTIONS = [
    dict(slug='09-cedar-crest-college-bsn-to-dnp-nurse-anesthesia-program',
         before='Ceder Crest',
         after='Cedar Crest College',
         why="misspelled, and shortened: the research set's own name for this "
             "programme is 'Cedar Crest College'"),
    dict(slug='44-saint-mary-s-university-of-minnesota-school-of-health-and-hu',
         before='Saint Marys University of Minnesota',
         after="Saint Mary's University of Minnesota",
         why='the possessive apostrophe is part of the name'),
]


def school_name_fixes(sets):
    """Resolve the corrections against the payload. Returns one row per fix."""
    by_slug = {s['_src_program']: s for s in sets}
    out = []
    for fix in SCHOOL_NAME_CORRECTIONS:
        s_ = by_slug.get(fix['slug'])
        if s_ is None:
            sys.exit('STOP: school-name correction for %s matches no set in the '
                     'payload' % fix['slug'])
        actual = s_['_src_production_school_name']
        if actual != fix['before']:
            sys.exit('STOP: school-name correction for %s expected %r but the '
                     'reconciliation holds %r. Read it before building.'
                     % (fix['slug'], fix['before'], actual))
        out.append(dict(fix, school_id=s_['school_id']))
    return out


SCHOOL_FIX_PATH = os.path.join(OUT_DIR, 'statement_school_name_corrections.sql')


def emit_school_name_fix(f):
    """A standalone, idempotent UPDATE for the two misspelled school names."""
    fixes = school_name_fixes(f['sets'])
    L = []
    A = L.append
    A('-- ======================================================================')
    A('-- TWO MISSPELLED SCHOOL NAMES')
    A('-- ======================================================================')
    A('-- Generated by scripts/build_statement_requirements_import_sql.py.')
    A('-- NOT APPLIED. Run it once, in the SQL editor, and read the result.')
    A('--')
    A('-- WHAT IT TOUCHES: public.schools.name, two rows, named by id.')
    A('-- WHAT IT DOES NOT TOUCH: the statement catalog, which stores no school')
    A('-- name and joins for it. Nothing in Statement Studio changes shape.')
    A('--')
    A('-- IDEMPOTENT AND NARROW. Each UPDATE matches on the id AND the current')
    A('-- wrong name, so running it twice is a no-op and running it against a')
    A('-- row somebody has already corrected by hand changes nothing.')
    A('--')
    for fix in fixes:
        A('--   %s' % fix['school_id'])
        A('--     %-38s -> %s' % (repr(fix['before']), repr(fix['after'])))
        A('--     %s' % fix['why'])
    A('--')
    A('-- ONE STATEMENT, because the SQL editor shows only the last result.')
    A('-- ======================================================================')
    A('')
    A('with corrections(school_id, wrong_name, right_name) as (values')
    A(',\n'.join("  ('%s'::uuid, %s, %s)"
                 % (x['school_id'], lit(x['before'], 'text'), lit(x['after'], 'text'))
                 for x in fixes))
    A('),')
    A('updated as (')
    A('  update public.schools as s')
    A('     set name = c.right_name')
    A('    from corrections as c')
    A('   where s.id = c.school_id')
    A('     and s.name = c.wrong_name')
    A('  returning s.id, c.wrong_name, s.name as new_name')
    A(')')
    A('select c.school_id,')
    A('       c.wrong_name,')
    A('       c.right_name,')
    A('       case')
    A("         when u.id is not null then 'CORRECTED'")
    A("         when s.id is null then 'MISSING: no school with this id'")
    A("         when s.name = c.right_name then 'ALREADY CORRECT'")
    A("         else 'UNCHANGED: the name is now ' || s.name")
    A('       end as verdict')
    A('  from corrections as c')
    A('  left join updated as u on u.id = c.school_id')
    A('  left join public.schools as s on s.id = c.school_id')
    A(' order by c.school_id;')
    write(SCHOOL_FIX_PATH, '\n'.join(L) + '\n')
    return SCHOOL_FIX_PATH


def emit_manifest(f, paths):
    """The reproducibility record: what was built, from what, and what it contains."""
    import hashlib as _h
    sets, docs = f['sets'], f['docs']
    set_fp = _h.md5(','.join(sorted(s['id'] for s in sets)).encode()).hexdigest()
    doc_fp = _h.md5(','.join(sorted(d['id'] for d in docs)).encode()).hexdigest()
    L = []
    A = L.append
    A('# Statement Studio V2 catalog import — reproducibility record')
    A('')
    A('Generated by `scripts/build_statement_requirements_import_sql.py`.')
    A('Rebuild and diff to confirm nothing drifted. **No secret appears in this file.**')
    A('')
    A('## Sources this package was built from (SHA-256)')
    A('')
    A('| File | SHA-256 |')
    A('|---|---|')
    for k in sorted(f['hashes']):
        A('| `%s` | `%s` |' % (k, f['hashes'][k]))
    A('')
    A('## The package (SHA-256)')
    A('')
    A('| File | SHA-256 |')
    A('|---|---|')
    for q in paths:
        A('| `supabase/manual/%s` | `%s` |' % (os.path.basename(q), sha256(q)))
    A('| `scripts/%s` | `%s` |' % (os.path.basename(__file__), sha256(os.path.abspath(__file__))))
    A('')
    A('## Payload identity')
    A('')
    A('Deterministic UUIDv5, namespace `%s`:' % NAMESPACE)
    A('')
    A('```')
    A('set      crnaprephub:statement_requirement_set:<research slug>')
    A('document crnaprephub:statement_requirement:<research slug>:<document index>')
    A('```')
    A('')
    A('| | |')
    A('|---|---|')
    A('| requirement sets | **%d** |' % len(sets))
    A('| requirement documents | **%d** |' % len(docs))
    A('| set id fingerprint (md5 of ordered ids) | `%s` |' % set_fp)
    A('| document id fingerprint (md5 of ordered ids) | `%s` |' % doc_fp)
    A('| sets imported active | **0** — every set is `is_active = false` |')
    A('| programmes held back | **%d** (%d of them have a production school id) |'
      % (len(f['held_slugs']), len(f['held_school_ids'])))
    A('')
    A('## Distributions the postcheck asserts exactly')
    A('')
    for name, counter in (('verification_status (sets)', f['vstatus']),
                          ('document_type (documents)', f['dtypes']),
                          ('words_enforcement', f['wenf']),
                          ('characters_enforcement', f['cenf']),
                          ('pages_enforcement', f['penf'])):
        A('**%s** — %s' % (name, ', '.join('`%s`=%d' % (k, v)
                                           for k, v in sorted(counter.items()))))
        A('')
    A('Fractional page limits: **%d** · rows carrying `unenforced_length`: **%d**'
      % (len(f['frac']), len(f['unenf'])))
    A('')
    A('## Programmes held back')
    A('')
    A('| Research slug | import_decision | has a production school id |')
    A('|---|---|---|')
    for r in sorted(f['held'], key=lambda x: x['research_program_slug']):
        A('| `%s` | %s | %s |' % (r['research_program_slug'][:58],
                                  r['import_decision'],
                                  'yes' if r['production_school_id'] else 'no'))
    return write(os.path.join(
        OUT_DIR, 'statement_requirements_catalog_import_MANIFEST.md'),
        '\n'.join(L) + '\n')


REVIEW_PAYLOAD_PATH = os.path.join(
    REPO, 'local-review', 'statement_requirements_catalog.json')


def _json_val(raw, pgtype):
    """One value, shaped as PostgREST would hand it to the row parser."""
    if raw is None or raw == '':
        return None
    if pgtype == 'boolean':
        return str(raw).strip().lower() in ('true', 't', 'yes', '1')
    if pgtype.startswith('integer'):
        return int(str(raw).strip())
    if pgtype.startswith('numeric'):
        return float(str(raw).strip())
    if pgtype == 'jsonb':
        return json.loads(raw)
    return str(raw)


def emit_review_payload(f):
    """The development-only review payload.

    THE SAME ROWS THE IMPORT STAGES, shaped as DATABASE ROWS rather than as SQL
    literals -- same deterministic ids, same values, same source. It is written
    outside `public/` on purpose: Next serves `public/`, and an inactive catalog
    behind a URL anybody can fetch is the thing the preview gate exists to
    prevent. Nothing imports this file into a client bundle; the server reads it
    at request time and only after the gate has passed.
    """
    sets, docs = f['sets'], f['docs']
    corrected_names = {x['slug']: x['after'] for x in school_name_fixes(sets)}
    out_sets = []
    for s_ in sets:
        row = {c: _json_val(s_[c], SET_TYPES[c]) for c in SET_COLS}
        # schoolName is not a column on the set; the real read takes it from the
        # school the picker already resolved. The reconciliation holds it.
        #
        # CORRECTED HERE, SO LOCAL REVIEW SEES THE RIGHT NAME. Two of these are
        # misspelled in production's own schools table; see
        # SCHOOL_NAME_CORRECTIONS and the UPDATE it generates. Until that runs,
        # production shows the misspelling and this payload shows the name the
        # research set verified -- which is the state of the correction, stated
        # honestly rather than hidden.
        row['school_name'] = corrected_names.get(
            s_['_src_program'], s_['_src_production_school_name'])
        row['_src_program'] = s_['_src_program']
        out_sets.append(row)
    out_docs = [{c: _json_val(d[c], DOC_TYPES[c]) for c in DOC_COLS} for d in docs]

    import hashlib as _h
    payload = {
        'meta': {
            'generated_by': 'scripts/build_statement_requirements_import_sql.py',
            'purpose': 'LOCAL DEVELOPMENT REVIEW ONLY. Not served, not imported '
                       'into any client bundle, not a production data source.',
            'corresponds_to': 'supabase/manual/statement_requirements_catalog_import.sql',
            'set_count': len(out_sets),
            'document_count': len(out_docs),
            'set_fingerprint': _h.md5(
                ','.join(sorted(s_['id'] for s_ in sets)).encode()).hexdigest(),
            'document_fingerprint': _h.md5(
                ','.join(sorted(d['id'] for d in docs)).encode()).hexdigest(),
            'source_sha256': f['hashes'],
        },
        'sets': out_sets,
        'documents': out_docs,
    }
    os.makedirs(os.path.dirname(REVIEW_PAYLOAD_PATH), exist_ok=True)
    with open(REVIEW_PAYLOAD_PATH, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=True)
    return REVIEW_PAYLOAD_PATH


if __name__ == '__main__':
    f = main()
    print('payload: %d sets, %d documents' % (len(f['sets']), len(f['docs'])))
    print('held back: %d programmes, %d with a production school id'
          % (len(f['held_slugs']), len(f['held_school_ids'])))
    print('fractional page rows: %d   unenforced_length rows: %d'
          % (len(f['frac']), len(f['unenf'])))
    print('verification_status: %s' % dict(f['vstatus']))
    print('document_type: %s' % dict(f['dtypes']))
    p1 = emit_import(f)
    print('wrote %s' % p1)
    print('import sql sha256 = %s' % sha256(p1))
    p2 = emit_preflight(f)
    print('wrote %s' % p2)
    p3 = emit_postcheck(f)
    print('wrote %s' % p3)
    p6 = emit_school_name_fix(f)
    print('wrote %s' % p6)
    p5 = emit_review_payload(f)
    print('wrote %s' % p5)
    p4 = emit_manifest(f, (p1, p2, p3))
    print('wrote %s' % p4)
    for q in (p1, p2, p3, p4):
        print('  sha256 %s  %s' % (sha256(q), os.path.basename(q)))
