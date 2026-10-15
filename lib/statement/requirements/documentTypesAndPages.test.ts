/**
 * Migration 007: three more document types, and page bounds that hold a half
 * page.
 *
 * WHY THESE TESTS EXIST AS A SEPARATE FILE. 007 widens two things that were
 * previously narrow, and a widening is the kind of change that passes every
 * existing test while quietly breaking the thing it widened -- a union that
 * grows but a parser that still rejects, a column that accepts 1.5 but a
 * reader that floors it. Each test below pins one of those seams.
 *
 * THE ROUNDING TESTS ARE THE POINT. `posInt` read 1.5 as NULL, which would have
 * shown the applicant NO page limit where the school stated one and a half.
 * That failure is silent in every layer -- no error, no log, just an absent
 * requirement -- so it is asserted at the parser, the digest, the renderer and
 * the snapshot separately rather than once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NO_CONSTRAINTS, pageLimit, statedLength, wordLimit } from './constraints.ts'
import {
  DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, isDocumentType, type DocumentType,
  type RequirementSet, type WritingRequirement,
} from './requirement.ts'
import { UNVERIFIED } from './verification.ts'
import { parseRequirementSnapshot, snapshotOf } from './snapshot.ts'
import { requirementFromRow } from './repo.ts'
import { requirementDigest } from './digest.ts'
import { constraintLines } from './constraintText.ts'
import { eligibilityForRequirement, wordFloorFits } from './eligibility.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SQL_007 = read(
  '../../../supabase/migrations/20261005_007_statement_requirement_document_types_and_pages.sql')
const DRY_RUN = read('../../../scripts/statement_requirements_dry_run.py')
const PREFLIGHT = read(
  '../../../supabase/manual/statement_requirement_document_types_and_pages_preflight.sql')
const POSTCHECK = read(
  '../../../supabase/manual/statement_requirement_document_types_and_pages_postcheck.sql')

/**
 * Strip SQL line comments AND single-quoted string literals.
 *
 * WITHOUT THIS THE KEYWORD SCANS BELOW ARE THEATRE. The preflight's own verdict
 * text contains the word "insert" (explaining that numeric(4,1) rounds on one)
 * and the migration's header contains "real" (as in "the real granularity").
 * Scanning raw text would fail on prose and pass on a statement hidden in a
 * literal; only executable SQL is worth asserting about.
 */
function executableSql(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? sql.length : nl
    } else if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          j += 1; break
        }
        j += 1
      }
      out += " '' "
      i = j
    } else if (sql.startsWith('$', i)) {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        i = end < 0 ? sql.length : end + tag.length
      } else { out += sql[i]; i += 1 }
    } else { out += sql[i]; i += 1 }
  }
  return out
}

const NEW_TYPES = ['statement-of-purpose', 'autobiographical-essay',
  'supplemental-essay'] as const
const OLD_TYPES = ['personal-statement', 'goal-statement', 'diversity-statement',
  'writing-sample', 'additional-response', 'other'] as const

function req(over: Partial<WritingRequirement> & { id: string }): WritingRequirement {
  return {
    documentType: 'personal-statement', label: 'L', promptText: 'q', components: [],
    constraints: NO_CONSTRAINTS, choiceGroup: null, optional: false, displayOrder: 0,
    notes: [], ...over,
  }
}
const set = (
  requirements: readonly WritingRequirement[], over: Partial<RequirementSet> = {},
): RequirementSet => ({
  id: 'set-1', schoolId: 'school-1', schoolName: 'S', applicationCycle: null,
  verification: UNVERIFIED, originalText: 'orig', requirements, notes: [], ...over,
})
const row = (over: Record<string, unknown>) => ({
  id: 'r1', set_id: 's1', school_id: 'sc1', document_type: 'personal-statement',
  label: 'L', prompt_text: 'q', components: [], notes: [], other_instructions: [],
  display_order: 0, is_optional: false, ...over,
})

// --------------------------------------------------------------- document types

test('all NINE document types are in the union, with a label each', () => {
  assert.equal(DOCUMENT_TYPES.length, 9)
  for (const t of [...OLD_TYPES, ...NEW_TYPES]) {
    assert.ok((DOCUMENT_TYPES as readonly string[]).includes(t), t)
    assert.equal(typeof DOCUMENT_TYPE_LABELS[t as DocumentType], 'string')
    assert.ok(DOCUMENT_TYPE_LABELS[t as DocumentType].length > 0, t)
  }
})

test('NO EXISTING TYPE WAS REMOVED, which a widening makes easy to do', () => {
  for (const t of OLD_TYPES) assert.equal(isDocumentType(t), true, t)
})

test('all nine parse through a row and a snapshot, instead of degrading to other', () => {
  for (const t of [...OLD_TYPES, ...NEW_TYPES]) {
    const parsed = requirementFromRow(row({ document_type: t }))
    assert.equal(parsed?.documentType, t, `row: ${t}`)

    const snap = snapshotOf(set([req({ id: 'r1', documentType: t as DocumentType })]),
      req({ id: 'r1', documentType: t as DocumentType }))
    const round = parseRequirementSnapshot(JSON.parse(JSON.stringify(snap)))
    assert.equal(round?.documentType, t, `snapshot: ${t}`)
  }
})

test('an unknown document type is still refused, not silently accepted', () => {
  for (const bad of ['made-up', 'STATEMENT-OF-PURPOSE', 'statement_of_purpose', '', 'essay',
    null, 7, undefined]) {
    assert.equal(isDocumentType(bad), false, String(bad))
  }
  // A row carrying one degrades to 'other' rather than inventing a type -- the
  // pre-007 behaviour, deliberately unchanged.
  assert.equal(requirementFromRow(row({ document_type: 'made-up' }))?.documentType, 'other')
})

// ----------------------------------------------------------- fractional pages

test('a row with max_pages 1.5 keeps the fraction (posInt would have read NULL)', () => {
  const parsed = requirementFromRow(row({
    max_pages: 1.5, page_spacing: 'double', pages_enforcement: 'enforced',
  }))
  assert.equal(parsed?.constraints.pages?.max, 1.5)
  assert.notEqual(parsed?.constraints.pages?.max, 1)
  assert.notEqual(parsed?.constraints.pages?.max, 2)
})

test('numeric(4,1) arriving as the STRING "1.5" is read as 1.5', () => {
  // PostgREST returns this column as a number in this range, but margins_inches
  // already accepts a string rather than losing the value on a transport change
  // and pages follow the same rule.
  const parsed = requirementFromRow(row({ max_pages: '1.5', page_spacing: 'double' }))
  assert.equal(parsed?.constraints.pages?.max, 1.5)
})

test('a whole number stored as 5.0 renders as 5 pages, never "5.0 pages"', () => {
  const parsed = requirementFromRow(row({ min_pages: '3.0', max_pages: '5.0' }))
  assert.equal(parsed?.constraints.pages?.min, 3)
  assert.equal(parsed?.constraints.pages?.max, 5)
  const line = constraintLines(parsed!.constraints).join(' ')
  assert.match(line, /3–5 pages/)
  assert.doesNotMatch(line, /\d\.0/)
})

test('integer page limits still work exactly as before 007', () => {
  const parsed = requirementFromRow(row({ min_pages: 2, max_pages: 4 }))
  assert.equal(parsed?.constraints.pages?.min, 2)
  assert.equal(parsed?.constraints.pages?.max, 4)
})

test('a stored SNAPSHOT keeps its fractional page bound across a round trip', () => {
  const r = req({
    id: 'bc',
    documentType: 'goal-statement',
    constraints: {
      ...NO_CONSTRAINTS,
      pages: pageLimit({ max: 1.5, spacing: 'double', enforcement: 'enforced' }),
    },
  })
  const snap = snapshotOf(set([r]), r)
  const round = parseRequirementSnapshot(JSON.parse(JSON.stringify(snap)))
  assert.equal(round?.constraints.pages?.max, 1.5,
    'a draft frozen against a 1.5-page prompt must not thaw with no limit')
})

test('the DIGEST distinguishes 1.5 from 1 and from 2, so a cache cannot cross them', () => {
  const mk = (max: number) => {
    const r = req({
      id: 'r1',
      constraints: {
        ...NO_CONSTRAINTS,
        pages: pageLimit({ max, spacing: 'double', enforcement: 'enforced' }),
      },
    })
    return requirementDigest(snapshotOf(set([r]), r))
  }
  const [one, oneHalf, two] = [mk(1), mk(1.5), mk(2)]
  assert.notEqual(oneHalf, one)
  assert.notEqual(oneHalf, two)
  assert.notEqual(one, two)
})

test('the rendered line says 1.5 pages, not 1 and not 2', () => {
  const lines = constraintLines({
    ...NO_CONSTRAINTS,
    pages: pageLimit({ max: 1.5, spacing: 'double', enforcement: 'enforced' }),
  }).join(' ')
  assert.match(lines, /1\.5 pages/)
  assert.doesNotMatch(lines, /\b1 page\b/)
  assert.doesNotMatch(lines, /\b2 pages\b/)
})

// ------------------------------------------------- no unit derived from another

test('A FRACTIONAL PAGE LIMIT YIELDS NO WORD CEILING AND NO WORD FLOOR', () => {
  // The rule 007 must not quietly break: a page limit is not a word limit, and
  // 1.5 pages is not "about 375 words". If any conversion existed, a draft far
  // longer than a page and a half would stop being analysable.
  const pages = (max: number) => ({
    ...NO_CONSTRAINTS,
    pages: pageLimit({ max, spacing: 'double', enforcement: 'enforced' }),
  })
  const half = pages(1.5)
  assert.equal(wordFloorFits(half), true)
  for (const words of [100, 500, 5000]) {
    assert.equal(eligibilityForRequirement({ constraints: half, words }).kind, 'eligible',
      `${words} words against a 1.5-page limit must stay analysable`)
  }
  // And the page NUMBER never reaches the word logic: the floor is the
  // product's own global analysis minimum, identical whatever the page bound is.
  const floorFor = (max: number) =>
    eligibilityForRequirement({ constraints: pages(max), words: 500 }).minimumWords
  assert.equal(floorFor(1.5), floorFor(3))
  assert.equal(floorFor(1.5), floorFor(200))

  const lines = constraintLines(half).join(' ')
  assert.match(lines, /1\.5 pages maximum \(double-spaced\)/)
  assert.doesNotMatch(lines, /word/i, 'a page line must never mention words')
})

test('migration 007 adds no column that derives one unit from another', () => {
  assert.doesNotMatch(SQL_007, /estimated_words|words_per_page|approx_words|equivalent_words/i)
  // and it does not touch the word or character columns at all
  for (const col of ['min_words', 'max_words', 'min_characters', 'max_characters']) {
    assert.doesNotMatch(SQL_007, new RegExp(`alter column ${col}`, 'i'), col)
  }
})

// ------------------------------------------------------------- the migration

test('007 lists all nine document types and removes none of the six', () => {
  const m = SQL_007.match(
    /add constraint statement_requirements_document_type_known\s+check \(([\s\S]*?)\);/)
  assert.ok(m, 'the constraint is not replaced')
  for (const t of [...OLD_TYPES, ...NEW_TYPES]) {
    assert.ok(m![1]!.includes(`'${t}'`), t)
  }
})

test('007 changes BOTH page columns to numeric, and to the same type', () => {
  assert.match(SQL_007, /alter column min_pages type numeric\(4,\s*1\)/)
  assert.match(SQL_007, /alter column max_pages type numeric\(4,\s*1\)/)
  // real/double precision would store a binary approximation of 1.5's
  // neighbours. Checked against executable SQL in a TYPE position: the header
  // prose says "the real granularity", which is not a column type.
  assert.doesNotMatch(executableSql(SQL_007), /type\s+(real|double precision|float)/i)
  assert.doesNotMatch(executableSql(SQL_007), /\bserial\b|\binteger\b/i)
})

test('007 touches no grant, policy, RLS setting or row', () => {
  for (const forbidden of [/\bgrant\b/i, /\brevoke\b/i, /\bcreate policy\b/i,
    /\bdrop policy\b/i, /row level security/i, /\binsert into\b/i, /\bdelete from\b/i,
    /^\s*update\s/im]) {
    assert.doesNotMatch(executableSql(SQL_007), forbidden, String(forbidden))
  }
})

test('007 refuses to commit if the type change loses a page constraint', () => {
  // The audit block is the whole reason the migration does not re-create them.
  for (const name of ['statement_requirements_page_bounds',
    'statement_requirements_page_spacing_known',
    'statement_requirements_pages_register_needs_limit',
    'statement_requirements_truncation_needs_maximum',
    'statement_requirements_unenforced_length_has_no_bound']) {
    assert.ok(SQL_007.includes(name), name)
  }
  assert.match(SQL_007, /raise exception 'the page type change lost CHECK constraint/)
  assert.match(SQL_007, /page columns are not numeric\(4,1\) after the change/)
})

test('007 refuses a database where 005 or 006 is missing', () => {
  assert.match(SQL_007, /statement_requirements does not exist; apply 005 first/)
  assert.match(SQL_007, /pages_enforcement is missing; apply 006 first/)
})

// ------------------------------------------------- preflight and postcheck

test('the 007 preflight and postcheck are read-only single statements', () => {
  for (const [name, sql] of [['preflight', PREFLIGHT], ['postcheck', POSTCHECK]] as const) {
    const body = executableSql(sql)
    for (const forbidden of [/\binsert\b/i, /\bupdate\b/i, /\bdelete\b/i, /\balter\b/i,
      /\bcreate\b/i, /\bdrop\b/i, /\bgrant\b/i, /\brevoke\b/i, /\btruncate\b/i,
      /\bmerge\b/i, /\bdo\b/i, /\bcommit\b/i]) {
      assert.doesNotMatch(body, forbidden, `${name}: ${forbidden}`)
    }
    assert.equal((body.match(/;/g) ?? []).length, 1, `${name} must be one statement`)
  }
})

test('the preflight proves 007 has NOT run and the postcheck proves it HAS', () => {
  assert.match(PREFLIGHT, /still has ONLY the original six/)
  assert.match(PREFLIGHT, /min_pages is integer before 007/)
  assert.match(POSTCHECK, /names all NINE document types/)
  assert.match(POSTCHECK, /min_pages is numeric\(4,1\)/)
  // the postcheck must not try an invalid write to prove a constraint fires
  assert.doesNotMatch(executableSql(POSTCHECK), /exception|rollback|savepoint/i)
})

// --------------------------------------------------- the dry-run transformer

test('the transformer maps Boston College 1.5 pages rather than refusing it', () => {
  assert.match(DRY_RUN, /'1\.5 pages maximum \(per prompt\)':\s*\(None, 1\.5\)/)
})

test('Gonzaga and UW-La Crosse stay PROSE, with no numeric bound invented', () => {
  const m = DRY_RUN.match(/PROSE_ONLY_PAGE_CELLS = \{([\s\S]*?)\n\}/)
  assert.ok(m, 'there is no prose-only table')
  assert.ok(m![1]!.includes("'2 pages maximum, plus an optional 3rd page for references only'"),
    'Gonzaga')
  assert.ok(m![1]!.includes('less than two pages in length'), 'UW-La Crosse')
  // neither may appear in the table that produces bounds
  const bounds = DRY_RUN.match(/^PAGE_CELLS = \{([\s\S]*?)^\}/m)
  assert.ok(bounds)
  assert.doesNotMatch(bounds![1]!, /optional 3rd page/)
  assert.doesNotMatch(bounds![1]!, /less than two pages/)
})

test('a prose-only page cell clears every numeric bound and emits no register', () => {
  // 006 forbids unenforced_length beside any bound, so the transformer must
  // clear them rather than hope the source had none.
  assert.match(DRY_RUN, /row\['unenforced_length'\] = cell/)
  assert.match(DRY_RUN, /row\['unenforced_length_verbatim'\] = False/)
  assert.match(DRY_RUN, /row\['min_pages'\] = row\['max_pages'\] = None/)
  assert.match(DRY_RUN, /\(\) if prose_only else \('words', 'characters', 'pages'\)/)
})

test('a prose-only cell beside a word bound is HELD, not silently resolved', () => {
  assert.match(DRY_RUN, /also states a word or character bound/)
})

test('the transformer knows all nine document types', () => {
  const m = DRY_RUN.match(/^DOCUMENT_TYPES = \{([\s\S]*?)\}/m)
  assert.ok(m)
  for (const t of [...OLD_TYPES, ...NEW_TYPES]) assert.ok(m![1]!.includes(`'${t}'`), t)
})

test('the transformer still emits no SQL and opens no connection', () => {
  assert.doesNotMatch(DRY_RUN, /\bpsycopg|\bsqlalchemy|\brequests\b|\burllib\b/)
  const body = DRY_RUN.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  assert.doesNotMatch(body, /\bpsycopg\.connect|execute\(/i)
})
