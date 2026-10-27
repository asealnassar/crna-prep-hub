#!/usr/bin/env python3
"""
The 28 targeted catalog corrections, as a review artifact and as SQL.

-----------------------------------------------------------------------------
WHY THIS IS GENERATED AND NOT HAND-WRITTEN
-----------------------------------------------------------------------------
The full import is NEVER RERUN -- it stages into TEMP tables and refuses unless
the catalog is empty, so it cannot deliver a correction even by accident. What
production needs instead is a targeted UPDATE per changed document, and the
only trustworthy source for "what changed" is a diff between the frozen
baseline that was actually imported and the payload the normaliser produces
today.

Both sides are read here, every differing column is emitted, and every UPDATE
carries a precondition on the OLD value. A row that has moved underneath us
matches nothing and reports REFUSED rather than overwriting work nobody
reviewed.

Outputs:
  supabase/manual/statement_catalog_corrections.sql           one statement
  supabase/manual/statement_catalog_corrections_preflight.sql read-only
  supabase/manual/STATEMENT_CATALOG_CORRECTIONS.md            the review artifact

WHY THE PREFLIGHT IS GENERATED HERE AND NOT WRITTEN BY HAND. It asks exactly
one question -- would each UPDATE match? -- and the only way to ask it without
a second interpretation of "match" is to emit the SAME predicates from the
SAME diff. The hand-written rollout preflight could not do this: its drift
check compared updated_at against created_at, and statement_requirements has
no updated_at trigger, so a row whose value had been changed reported PASS.
Found by changing one max_words on a rehearsal cluster and watching it pass.
"""
import hashlib, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from statement_catalog_invariants import check_row   # noqa: E402

REPO = os.path.dirname(HERE)
BASE = os.path.join(REPO, 'supabase/manual/catalog_import_baseline/statement_requirements_catalog.baseline.json')
CUR  = os.path.join(REPO, 'local-review/statement_requirements_catalog.json')

# Which migration a column needs before it can be written at all.
NEEDS = {
    'document_format_profile': '20261011_014',
    'font_family_options':     '20261008_010',
    'font_size_pt_options':    '20261008_010',
}

def category(cols):
    if 'document_format_profile' in cols: return 'format profile'
    if cols & {'words_enforcement', 'pages_enforcement', 'characters_enforcement',
               'min_words', 'max_words', 'min_pages', 'max_pages'}:
        return 'range / enforcement normalisation'
    if cols & {'words_stated_as', 'pages_stated_as', 'characters_stated_as'}:
        return '*_stated_as cleanup'
    if cols & {'unenforced_length', 'unenforced_length_verbatim'}:
        return 'stale unenforced_length'
    if cols & {'font_size_pt', 'font_family', 'margins_inches', 'page_spacing'}:
        return 'typography'
    if cols & {'prompt_text', 'label', 'components'}:
        return 'applicant-facing text correction'
    if 'other_instructions' in cols: return 'other'
    return 'other'

# WHY THIS DOCUMENT IS BEING CORRECTED, in one sentence, derived from the
# columns that moved. The category above groups; this explains.
REASONS = (
    ('document_format_profile',
     'the school names a standard that governs the WHOLE document, which 014 '
     'can hold and 005 could not'),
    ('unenforced_length',
     'a structured bound now states this length, so the sentence saying it is '
     'unconfirmed is both false and refused by 006'),
    ('min_words',  'a two-ended figure the import deferred is a bound: no reading '
                   'of the range admits a draft below its floor'),
    ('max_words',  'a two-ended figure the import deferred is a bound: no reading '
                   'of the range admits a draft below its floor'),
    ('min_pages',  'a published page range the import deferred is a bound'),
    ('max_pages',  'a published page range the import deferred is a bound'),
    ('words_enforcement',
     'the stored register called the figure advisory while the evidence behind '
     'it quotes the school saying "limit"'),
    ('pages_enforcement',
     'the stored register called the figure advisory while the evidence behind '
     'it quotes the school saying "limit"'),
    ('font_size_pt', 'verified typography moved out of prose and into the typed '
                     'column, so the Studio applies it instead of asking the '
                     'applicant to'),
    ('font_family',  'verified typography moved out of prose and into the typed '
                     'column, so the Studio applies it instead of asking the '
                     'applicant to'),
    ('margins_inches', 'verified typography moved out of prose and into the typed '
                       'column, so the Studio applies it instead of asking the '
                       'applicant to'),
    ('words_stated_as',
     'the column is rendered under "The school\'s wording" and held this '
     'project\'s classification of the figure rather than the school\'s words'),
    ('pages_stated_as',
     'the column is rendered under "The school\'s wording" and held this '
     'project\'s classification of the figure rather than the school\'s words'),
    ('characters_stated_as',
     'the column is rendered under "The school\'s wording" and held this '
     'project\'s classification of the figure rather than the school\'s words'),
    ('prompt_text',
     'the quoted prompt carried text a researcher wrote -- a dangling footnote '
     'marker or a bracketed summary -- inside a field attributed to the school'),
    ('other_instructions',
     'an instruction the Studio now satisfies, or states no obligation at all, '
     'was being rendered to the applicant as work they had to do'),
)

def reason(cols):
    for column, why in REASONS:
        if column in cols:
            return why
    return 'the normalised value differs from what was imported'


def value_hash(values, columns):
    """A stable digest of one document's values for the columns that move.

    JSON with sorted keys, so it does not depend on dict order, and sha256
    truncated to 12 -- long enough to identify, short enough to read in a
    table beside the values themselves.
    """
    payload = json.dumps({c: values[c] for c in columns},
                         ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()[:12]


JSONB = {'components', 'notes', 'other_instructions'}

def lit(value, column):
    if value is None: return 'null'
    if column in JSONB: return "%s::jsonb" % sql_str(json.dumps(value, ensure_ascii=False))
    if isinstance(value, bool): return 'true' if value else 'false'
    if isinstance(value, (int, float)): return repr(value)
    return sql_str(value)

def sql_str(text):
    return "'" + str(text).replace("'", "''") + "'"

def main():
    base = json.load(open(BASE)); cur = json.load(open(CUR))
    bd = {d['id']: d for d in base['documents']}
    cd = {d['id']: d for d in cur['documents']}
    bs = {s['id']: s for s in base['sets']}
    cs = {s['id']: s for s in cur['sets']}
    if set(bd) != set(cd) or set(bs) != set(cs):
        sys.exit('STOP: the id sets differ. A correction package may only UPDATE, '
                 'never insert or delete.')

    rows = []
    for did in sorted(bd):
        b, c = bd[did], cd[did]
        cols = sorted(k for k in set(b) | set(c) if b.get(k) != c.get(k))
        if not cols: continue
        school = cs[c['set_id']]['school_name']
        """
        THE DESIRED ROW IS NOW CORRECT AT SOURCE, AND VERIFIED HERE.

        statement_requirements_unenforced_length_has_no_bound (migration 006,
        applied) refuses any row holding a structured bound AND
        unenforced_length. Eight desired rows used to hold both, so the UPDATE
        that would install them was IMPOSSIBLE -- the database rejects it.
        Rehearsing this package against the real baseline on a throwaway
        cluster is how that was found.

        It was patched here first, which fixed the artifact and left the
        pipeline able to recreate the problem on the next regeneration. The
        rule now lives in scripts/statement_catalog_invariants.py and the
        normaliser applies it, so `c` arrives already consistent: the prose
        clear shows up as an ordinary column difference, with the same
        precondition on its old value as every other column.

        What remains here is the CHECK -- this generator will not emit an
        UPDATE whose desired row the applied schema would refuse, whatever
        produced the payload.
        """
        refused = check_row(c)
        if refused:
            sys.exit('STOP: the desired row for %s / %s would be refused by the '
                     'applied schema, so no UPDATE can install it:\n  %s\n'
                     'Re-run scripts/normalize_statement_catalog.py, which owns '
                     'this rule.' % (school, c['label'], '\n  '.join(refused)))

        rows.append({
            'id': did, 'school': school, 'label': c['label'],
            'columns': cols, 'category': category(set(cols)),
            'reason': reason(set(cols)),
            'needs': sorted({NEEDS[k] for k in cols if k in NEEDS}),
            'before': {k: b.get(k) for k in cols},
            'after': {k: c.get(k) for k in cols},
        })
        rows[-1]['before_hash'] = value_hash(rows[-1]['before'], cols)
        rows[-1]['after_hash'] = value_hash(rows[-1]['after'], cols)

    # ---- the review artifact ------------------------------------------------
    md = ['# Targeted catalog corrections — the frozen manifest', '',
          'Generated by `scripts/build_statement_catalog_corrections.py` from the',
          'frozen import baseline and the current normalised payload. **Not applied.**', '',
          '```',
          'NORMALIZED CATALOG CORRECTION PACKAGE  (this file)',
          '  targeted set updates      : 0',
          '  targeted document updates : %d' % len(rows),
          '',
          'SOUTHERN MISSISSIPPI TYPOGRAPHY-OPTIONS CORRECTION  (separate file)',
          '  additional documents      : 1',
          '  prerequisite              : migration 20261008_010',
          '',
          'TOTAL TARGETED DOCUMENT OPERATIONS : %d' % (len(rows) + 1),
          '  ...of which this package  : %d' % len(rows),
          '```', '',
          '**The %d and the %d are not interchangeable.** This package is the '
          'normalization diff; Southern Mississippi is an additional, separate '
          'document operation and is **not** part of it.'
          % (len(rows), len(rows) + 1), '',
          'The **set** count is zero: every change is to a document row. '
          'Southern Mississippi is **not** one of these %d — its correction '
          'needs 010\'s option columns, which are not part of the import '
          'payload, so it lives in '
          '`statement_southern_mississippi_typography_options.sql` and is a '
          '**29th** targeted document update. The two school-name corrections '
          'are a third, separate file and touch `public.schools`, not the '
          'catalog.' % len(rows), '',
          'Each row below carries the **deterministic id** (UUIDv5, so it is '
          'the same id in every environment), the columns that move, a digest '
          'of the values on each side, and the migration its columns need. '
          'The matching UPDATE in `statement_catalog_corrections.sql` carries '
          'a precondition on **every** baseline value shown here, so a row '
          'that has moved underneath this manifest matches nothing and reports '
          'REFUSED.', '',
          'Pre-apply verdicts, per document, come from the generated '
          '`statement_catalog_corrections_preflight.sql`.', '']
    bycat = {}
    for r in rows: bycat.setdefault(r['category'], []).append(r)
    md += ['| Category | Documents |', '|---|---|']
    for cat in sorted(bycat, key=lambda c: -len(bycat[c])):
        md.append('| %s | %d |' % (cat, len(bycat[cat])))
    md.append('')
    for cat in sorted(bycat, key=lambda c: -len(bycat[c])):
        md += ['## %s' % cat, '']
        for r in sorted(bycat[cat], key=lambda r: (r['school'], r['label'])):
            md.append('### %s — %s' % (r['school'], r['label']))
            md.append('')
            md.append('| | |')
            md.append('|---|---|')
            md.append('| id | `%s` |' % r['id'])
            md.append('| school | %s |' % r['school'])
            md.append('| document | %s |' % r['label'])
            md.append('| columns changed | %s |'
                      % ', '.join('`%s`' % c for c in r['columns']))
            md.append('| baseline digest | `%s` |' % r['before_hash'])
            md.append('| desired digest | `%s` |' % r['after_hash'])
            md.append('| reason | %s |' % r['reason'])
            md.append('| prerequisite migration | %s |'
                      % (', '.join('`%s`' % m for m in r['needs']) or 'none'))
            md += ['', '| column | baseline (production today) | desired |', '|---|---|---|']
            for col in r['columns']:
                md.append('| `%s` | `%s` | `%s` |' % (
                    col,
                    json.dumps(r['before'][col], ensure_ascii=False)[:90],
                    json.dumps(r['after'][col], ensure_ascii=False)[:90]))
            md.append('')
    open(os.path.join(REPO, 'supabase/manual/STATEMENT_CATALOG_CORRECTIONS.md'), 'w').write('\n'.join(md))

    # ---- the SQL ------------------------------------------------------------
    L = ["-- ========================================================================",
         "-- THE %d TARGETED CATALOG CORRECTIONS" % len(rows),
         "-- ========================================================================",
         "-- Generated by scripts/build_statement_catalog_corrections.py. NOT APPLIED.",
         "--",
         "-- ONE UPDATE PER DOCUMENT, each matched on its deterministic id AND on",
         "-- every value it expects to replace. A row that has changed underneath",
         "-- this file matches nothing, is reported REFUSED, and is left alone --",
         "-- which is the whole reason this is not a rerun of the import.",
         "--",
         "-- NOTHING IS INSERTED OR DELETED. The baseline and the current payload",
         "-- carry the same 63 set ids and the same 80 document ids; the generator",
         "-- refuses to emit anything if that stops being true.",
         "--",
         "-- SETS NEEDING CHANGES: 0. Only documents are touched.",
         "--",
         "-- PREREQUISITES: rows marked below need their migration applied first.",
         "-- Running this before them fails at parse time, which is correct.",
         "--",
         "-- READ THE VERDICT COLUMN. One statement; the SQL editor shows only the",
         "-- last result.",
         "-- ========================================================================",
         "", "with"]
    parts = []
    for i, r in enumerate(rows):
        pre = ' and '.join('%s is not distinct from %s' % (c, lit(r['before'][c], c))
                           for c in r['columns'])
        setc = ', '.join('%s = %s' % (c, lit(r['after'][c], c)) for c in r['columns'])
        parts.append(
            "  u%02d as (\n"
            "    update public.statement_requirements\n"
            "       set %s\n"
            "     where id = '%s'::uuid\n"
            "       and %s\n"
            "    returning id\n"
            "  )" % (i, setc, r['id'], pre))
    L.append(',\n'.join(parts) + ',')
    L.append("  applied(id) as (")
    L.append('    ' + '\n    union all '.join('select id from u%02d' % i for i in range(len(rows))))
    L.append("  ),")
    L.append("  expected(id, school, document, category) as (values")
    L.append(',\n'.join("    ('%s'::uuid, %s, %s, %s)" % (
        r['id'], sql_str(r['school']), sql_str(r['label']), sql_str(r['category']))
        for r in rows))
    L.append("  )")
    L.append("select e.school, e.document, e.category,")
    L.append("       case when a.id is not null then 'CORRECTED'")
    L.append("            when r.id is null then 'REFUSED: no requirement with this id'")
    L.append("            else 'REFUSED: the row no longer matches its expected values'")
    L.append("       end as verdict")
    L.append("  from expected e")
    L.append("  left join applied a on a.id = e.id")
    L.append("  left join public.statement_requirements r on r.id = e.id")
    L.append(" order by e.school, e.document;")
    open(os.path.join(REPO, 'supabase/manual/statement_catalog_corrections.sql'), 'w').write('\n'.join(L) + '\n')

    # ---- the drift check, from the same predicates -------------------------
    P = ["-- ========================================================================",
         "-- PREFLIGHT for the %d targeted catalog corrections" % len(rows),
         "-- ========================================================================",
         "-- READ-ONLY. No INSERT, UPDATE, DELETE, ALTER, CREATE or GRANT appears.",
         "-- Generated by scripts/build_statement_catalog_corrections.py, from the",
         "-- SAME diff that generates statement_catalog_corrections.sql, so the",
         "-- question it asks is the question that file will ask the database.",
         "--",
         "-- WHY THIS EXISTS SEPARATELY FROM THE ROLLOUT PREFLIGHT. That file's own",
         "-- drift check read `updated_at > created_at`, and this table has no",
         "-- updated_at trigger -- so a row whose max_words had been changed by hand",
         "-- reported PASS. Proven by doing exactly that on a throwaway cluster.",
         "-- A check that cannot fail is worse than no check, because it is read as",
         "-- evidence.",
         "--",
         "-- READY     the correction will apply, and will change this row.",
         "-- ALREADY   the row already holds the desired values; the UPDATE will",
         "--           match nothing and report REFUSED, which is the correct",
         "--           outcome for a second run.",
         "-- DRIFTED   the row holds neither the expected old values nor the",
         "--           desired ones. DO NOT APPLY. Re-review this document.",
         "-- MISSING   no requirement with this id.",
         "--",
         "-- EVERY ROW MUST READ READY before the corrections are applied, or",
         "-- ALREADY if they have already been applied. Anything else stops the",
         "-- rollout.",
         "--",
         "-- PREREQUISITES: a row whose correction needs an unapplied migration",
         "-- names a column that does not exist yet, so this file fails at parse",
         "-- time until that migration is applied. That is the correct outcome and",
         "-- it is the same failure mode the correction itself has.",
         "--",
         "-- ONE STATEMENT, because the SQL editor shows only the last result.",
         "-- ========================================================================",
         "", "with", "  expected(id, school, document, category) as (values"]
    P.append(',\n'.join("    ('%s'::uuid, %s, %s, %s)" % (
        r['id'], sql_str(r['school']), sql_str(r['label']), sql_str(r['category']))
        for r in rows))
    P.append("  ),")
    P.append("  -- One row per document: does it still match what its UPDATE expects,")
    P.append("  -- and does it already match what that UPDATE would write? The two")
    P.append("  -- predicates are the UPDATE's own WHERE clause and its own SET list,")
    P.append("  -- compared with `is not distinct from` so NULL matches NULL.")
    P.append("  state(id, matches_old, matches_new) as (values")
    parts = []
    for r in rows:
        old_pred = ' and '.join('%s is not distinct from %s' % (c, lit(r['before'][c], c))
                                for c in r['columns'])
        new_pred = ' and '.join('%s is not distinct from %s' % (c, lit(r['after'][c], c))
                                for c in r['columns'])
        parts.append(
            "    ('%s'::uuid,\n"
            "     (select (%s) from public.statement_requirements where id = '%s'::uuid),\n"
            "     (select (%s) from public.statement_requirements where id = '%s'::uuid))"
            % (r['id'], old_pred, r['id'], new_pred, r['id']))
    P.append(',\n'.join(parts))
    P.append("  )")
    P.append("select e.school, e.document, e.category,")
    P.append("       case when r.id is null then 'MISSING: no requirement with this id'")
    P.append("            when s.matches_old then 'READY'")
    P.append("            when s.matches_new then 'ALREADY: desired values already stored'")
    P.append("            else 'DRIFTED: neither the expected old nor the desired values'")
    P.append("       end as verdict")
    P.append("  from expected e")
    P.append("  left join state s on s.id = e.id")
    P.append("  left join public.statement_requirements r on r.id = e.id")
    P.append("union all")
    P.append("select 'ALL %d DOCUMENTS' as school," % len(rows))
    P.append("       (select count(*)::text from state where matches_old) || ' READY' as document,")
    P.append("       (select count(*)::text from state where matches_new) || ' ALREADY' as category,")
    P.append("       case when (select count(*) from state where matches_old) = %d" % len(rows))
    P.append("            then 'PROCEED'")
    P.append("            when (select count(*) from state where matches_new) = %d" % len(rows))
    P.append("            then 'ALREADY APPLIED -- nothing to do'")
    P.append("            else 'DO NOT APPLY -- read the rows above'")
    P.append("       end as verdict")
    P.append(" order by 1, 2;")
    open(os.path.join(REPO,
        'supabase/manual/statement_catalog_corrections_preflight.sql'),
        'w').write('\n'.join(P) + '\n')

    print('sets needing changes     : 0')
    print('documents needing changes: %d' % len(rows))
    for cat in sorted(bycat, key=lambda c: -len(bycat[c])):
        print('  %-36s %d' % (cat, len(bycat[cat])))
    pre = sorted({m for r in rows for m in r['needs']})
    print('prerequisite migrations  : %s' % (', '.join(pre) or 'none'))

if __name__ == '__main__':
    main()
