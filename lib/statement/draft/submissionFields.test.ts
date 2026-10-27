/**
 * Migration 008: what else an applicant can tell us, and the link from a
 * submission to the catalog row it became.
 *
 * WHY THESE TESTS EXIST AS A SEPARATE FILE. 008 does three different kinds of
 * thing, and only one of them is "add a column":
 *
 *   * it ADDS capacity, which is the easy part;
 *   * it RELAXES statement_prompt_submissions_approval_shape, which is the part
 *     that could quietly undo a guarantee -- the old constraint stopped a
 *     rejected row carrying a catalog id, and the replacement has to keep that
 *     while dropping the requirement that approval imply publication;
 *   * it WIDENS a column-level SELECT grant, which is the part that could
 *     quietly disclose an administrator's private note.
 *
 * So the grant list and the constraint predicate are asserted directly, not
 * just the column list.
 *
 * AND THE PAGE LIMIT IS ASSERTED TWICE. 20261005_007 was written because an
 * integer column read Boston College's page and a half as NULL. A submission
 * field is a worse place for that bug, because the applicant is the only source
 * -- so stated_max_pages must be numeric(4,1) AND stated_pages_text must exist
 * to hold the wording a number cannot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SQL_008 = read(
  '../../../supabase/migrations/20261006_008_statement_prompt_submission_requirement_fields.sql')
const SQL_000 = read('../../../supabase/migrations/20261002_000_statement_prompt_submissions.sql')
const PREFLIGHT = read('../../../supabase/manual/statement_prompt_submission_fields_preflight.sql')
const POSTCHECK = read('../../../supabase/manual/statement_prompt_submission_fields_postcheck.sql')

/**
 * Strip SQL line comments AND single-quoted string literals.
 *
 * WITHOUT THIS THE KEYWORD SCANS BELOW ARE THEATRE. This migration's header
 * necessarily contains the words "insert", "update" and "enforced" while
 * explaining what it does not do, and the preflight's verdict strings name
 * every privilege it checks for. Only executable SQL is worth asserting about.
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

const CODE_008 = executableSql(SQL_008)

/** The ten columns, in the order the migration adds them. */
const NEW_COLUMNS = [
  'document_label', 'document_type_hint', 'stated_min_words',
  'stated_max_characters', 'stated_max_pages', 'stated_pages_text',
  'formatting_instructions', 'other_instructions', 'submitter_note',
  'approved_requirement_id',
] as const

// ===========================================================================
// WHAT IT ADDS
// ===========================================================================

test('all ten columns are added, and every one is nullable', () => {
  for (const column of NEW_COLUMNS) {
    assert.match(CODE_008, new RegExp(`add column if not exists\\s+${column}\\b`), column)
    // NOT NULL would need a default, and a default would be an inferred answer
    // to "what did the school say" -- which is the one thing this table must
    // never invent.
    assert.doesNotMatch(CODE_008, new RegExp(`${column}[^,;]*not null`, 'i'), column)
    assert.doesNotMatch(CODE_008, new RegExp(`${column}[^,;]*default`, 'i'), column)
  }
})

test('THE PAGE LIMIT CANNOT REGRESS TO AN INTEGER', () => {
  // The bug 20261005_007 existed to fix: an integer column read 1.5 as NULL.
  assert.match(CODE_008, /add column if not exists\s+stated_max_pages\s+numeric\(4,1\)/)
  assert.doesNotMatch(CODE_008, /stated_max_pages\s+integer/i)
  // AND A NUMBER IS NOT THE ONLY RECORD. Wording a number cannot hold is kept.
  assert.match(CODE_008, /add column if not exists\s+stated_pages_text\s+text/)
})

test('no enforcement register is captured from the applicant', () => {
  // 20261002_006's vocabulary is a JUDGEMENT about a school's wording. An
  // applicant has not made it, and a column inviting them to would manufacture
  // reviewed-looking data nobody reviewed.
  for (const word of ['truncated', 'enforced', 'target', 'suggested']) {
    assert.doesNotMatch(CODE_008, new RegExp(`${word}`, 'i'),
      `${word} must not appear in executable SQL`)
  }
  assert.doesNotMatch(CODE_008, /_enforcement/i)
  // Nor is anything derived from their text.
  assert.doesNotMatch(CODE_008, /create (or replace )?(trigger|function)/i)
  assert.doesNotMatch(CODE_008, /generated always as/i)
})

test('the document type is a HINT, never the canonical nine-value column', () => {
  assert.match(CODE_008, /add column if not exists\s+document_type_hint\s+text/)
  // No CHECK pinning it to the catalog's vocabulary: the applicant writes what
  // their school called it.
  assert.doesNotMatch(CODE_008, /document_type_hint[^;]*in \(/i)
  for (const canonical of ['personal-statement', 'goal-statement', 'writing-sample']) {
    assert.equal(CODE_008.includes(canonical), false, canonical)
  }
})

test('the new bounds are range-checked and ordered', () => {
  assert.match(CODE_008, /stated_min_words between 1 and 5000/)
  assert.match(CODE_008, /stated_max_characters between 1 and 100000/)
  assert.match(CODE_008, /stated_max_pages > 0 and stated_max_pages <= 99\.9/)
  // A minimum above its maximum describes nothing.
  assert.match(CODE_008, /stated_min_words <= stated_max_words/)
})

test('a whitespace-only text field is refused rather than stored as blank', () => {
  // '' would render as a present-but-empty field on the review screen, which
  // reads as "the applicant answered" when they did not.
  for (const column of ['document_label', 'document_type_hint', 'stated_pages_text',
    'formatting_instructions', 'other_instructions', 'submitter_note']) {
    assert.match(CODE_008, new RegExp(`char_length\\(btrim\\(${column}\\)\\) >= 1`), column)
  }
})

// ===========================================================================
// WHAT IT RELAXES -- THE PART THAT COULD UNDO A GUARANTEE
// ===========================================================================

test('APPROVAL NO LONGER IMPLIES PUBLICATION', () => {
  // 20261002_000's predicate required an approved row to ALREADY carry a
  // published catalog id, which made "reviewed" and "published" one state.
  // Asserted here so the thing 008 changes is on the record.
  assert.match(executableSql(SQL_000), /and approved_prompt_id is not null/i,
    'the old both-directions predicate is not where this test thinks it is')

  // 008's replacement drops that direction. The whole predicate is read, so a
  // future edit that reinstates it fails here.
  const start = CODE_008.lastIndexOf('add constraint statement_prompt_submissions_approval_shape')
  assert.ok(start > 0, 'the replacement constraint is missing')
  const predicate = CODE_008.slice(start, CODE_008.indexOf(';', start))
  assert.doesNotMatch(predicate, /approved_prompt_id is not null/i,
    'approval still requires a published catalog row')
  assert.doesNotMatch(predicate, /status <> /i,
    'the replacement still reasons about non-approved rows carrying nothing')
})

test('BUT A CATALOG LINK STILL IMPLIES APPROVAL', () => {
  // The guarantee that mattered: a rejected or withdrawn submission can never
  // carry an id it has no claim to.
  assert.match(CODE_008,
    /\(approved_prompt_id is null and approved_requirement_id is null\)\s*or status = /)
})

test('the replaced constraint is dropped before it is added, so the file re-runs', () => {
  for (const name of ['statement_prompt_submissions_approval_shape',
    'statement_prompt_submissions_text_fields_length',
    'statement_prompt_submissions_stated_ranges',
    'statement_prompt_submissions_word_bounds_ordered']) {
    const drop = CODE_008.indexOf(`drop constraint if exists ${name}`)
    const add = CODE_008.indexOf(`add constraint ${name}`)
    assert.ok(drop >= 0, `${name} is not dropped first`)
    assert.ok(add > drop, `${name} is added before it is dropped`)
  }
})

// ===========================================================================
// WHAT IT GRANTS -- THE PART THAT COULD DISCLOSE
// ===========================================================================

test('the widened grant adds the ten columns and NOTHING ELSE', () => {
  const grant = CODE_008.slice(CODE_008.indexOf('grant select ('))
  const list = grant.slice(0, grant.indexOf(')'))
  for (const column of NEW_COLUMNS) {
    assert.ok(list.includes(column), `${column} is not readable by its submitter`)
  }
  // THE TWO PRIVATE COLUMNS STAY PRIVATE. RLS filters rows, never columns, so
  // the own-row policy would otherwise hand a submitter the administrator's
  // note about them and the identity of its author.
  assert.equal(list.includes('review_note'), false, 'review_note became readable')
  assert.equal(list.includes('reviewed_by'), false, 'reviewed_by became readable')
})

test('NO WRITE PRIVILEGE IS GRANTED TO ANY ROLE', () => {
  assert.doesNotMatch(CODE_008, /grant (insert|update|delete|truncate|all)/i)
  assert.doesNotMatch(CODE_008, /to (anon|service_role)/i)
  // The only grant in the file is the column-scoped select to authenticated.
  assert.equal((CODE_008.match(/grant /gi) ?? []).length, 1)
  assert.match(CODE_008, /on public\.statement_prompt_submissions to authenticated/)
})

test('it touches nothing but this one table', () => {
  assert.equal((CODE_008.match(/alter table/gi) ?? []).length,
    (CODE_008.match(/alter table public\.statement_prompt_submissions/gi) ?? []).length)
  // No policy is created or dropped; 20261002_000's two still stand.
  assert.doesNotMatch(CODE_008, /create policy|drop policy/i)
  // And the canonical catalog is not mentioned in executable SQL at all.
  for (const table of ['statement_requirement_sets', 'statement_requirements',
    'statement_prompts', 'statement_drafts']) {
    assert.equal(CODE_008.includes(table), false, table)
  }
})

test('it is one transaction', () => {
  assert.match(CODE_008, /^\s*begin;/m)
  assert.match(CODE_008, /^\s*commit;/m)
})

// ===========================================================================
// THE PREFLIGHT AND POSTCHECK MUTATE NOTHING
// ===========================================================================

test('both scripts are read-only', () => {
  for (const [name, sql] of [['preflight', PREFLIGHT], ['postcheck', POSTCHECK]] as const) {
    const code = executableSql(sql)
    for (const forbidden of [
      /\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i,
      /\btruncate\b/i, /\balter\s+table\b/i, /\bdrop\s+\w/i, /\bcreate\s+\w/i,
      /\bgrant\b/i, /\brevoke\b/i, /\bmerge\b/i, /\bcommit\b/i, /\bbegin\b/i,
    ]) {
      assert.doesNotMatch(code, forbidden, `${name} contains ${forbidden}`)
    }
    // And each is ONE statement, because the Supabase editor shows only the last.
    assert.equal((code.match(/;/g) ?? []).length, 1, `${name} is not one statement`)
  }
})

test('the preflight establishes the state the postcheck compares against', () => {
  // A postcheck asserting "unchanged" is meaningless without a before.
  for (const recorded of ['row count', 'CHECK constraint count',
    'authenticated SELECT column count', 'submissions by status']) {
    assert.ok(PREFLIGHT.includes(recorded), `preflight does not record ${recorded}`)
    assert.ok(POSTCHECK.includes(recorded), `postcheck does not compare ${recorded}`)
  }
})

test('the preflight refuses a partially applied migration', () => {
  assert.match(PREFLIGHT, /PARTIALLY APPLIED/)
  assert.ok(PREFLIGHT.includes('none of the 10 new columns exists yet'))
})

test('the postcheck pins the page type and the private columns', () => {
  assert.ok(POSTCHECK.includes('numeric(4,1), never integer'))
  assert.ok(POSTCHECK.includes('STILL not granted'))
})
