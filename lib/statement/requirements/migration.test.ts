import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/**
 * COMMENTS STRIPPED BEFORE EVERY STRUCTURAL ASSERTION. This migration's header
 * explains at length what it does NOT do -- "does not alter
 * public.statement_prompts", "no column holding estimated words" -- and a
 * naive grep for "statement_prompts" or "words" would match that prose and
 * report the opposite of the truth. Every assertion below reads the stripped
 * view; the two that are ABOUT the prose say so.
 */
const stripSql = (sql: string) => sql.replace(/^\s*--.*$/gm, '')

const RAW = read('../../../supabase/migrations/20261002_005_statement_requirements.sql')
const SQL = stripSql(RAW)
const grants = (SQL.match(/^\s*(grant|revoke)[\s\S]*?;/gm) ?? []).join('\n')

// ===================================================== additive only

test('it creates exactly the two new tables and nothing else', () => {
  const created = [...SQL.matchAll(/create table if not exists (\S+)/g)].map((m) => m[1])
  assert.deepEqual(created,
    ['public.statement_requirement_sets', 'public.statement_requirements'])
  // No create table without the guard, anywhere.
  assert.equal((SQL.match(/create table(?! if not exists)/g) ?? []).length, 0)
})

test('IT TOUCHES NO EXISTING TABLE EXCEPT TO ADD NULLABLE COLUMNS', () => {
  const altered = new Set([...SQL.matchAll(/alter table (\S+)/g)].map((m) => m[1]))
  assert.deepEqual([...altered].sort(), [
    'public.statement_drafts', 'public.statement_requirement_sets', 'public.statement_requirements',
  ])
  // The only thing done to statement_drafts is adding columns and their checks.
  const draftStatements = SQL.match(/alter table public\.statement_drafts[\s\S]*?;/g) ?? []
  assert.ok(draftStatements.length >= 2)
  for (const statement of draftStatements) {
    assert.match(statement, /add column if not exists|drop constraint if exists|add constraint/)
    assert.doesNotMatch(statement, /drop column|alter column|rename|set not null/)
  }
})

test('the new draft columns are NULLABLE, so every saved draft stays valid', () => {
  assert.match(SQL, /add column if not exists requirement_id uuid;/)
  assert.match(SQL, /add column if not exists requirement_snapshot jsonb;/)
  // Neither is declared NOT NULL and neither has a default, so existing rows
  // get NULL and read exactly as they do today.
  const adds = SQL.match(/add column if not exists requirement\w+[^;]*/g) ?? []
  assert.equal(adds.length, 2)
  for (const add of adds) {
    assert.doesNotMatch(add, /not null|default/i, add)
  }
})

test('NOTHING IS DELETED, BACKFILLED OR REWRITTEN', () => {
  assert.doesNotMatch(SQL, /\bdelete from\b|\btruncate\b|\bdrop table\b/i)
  // The only UPDATE-shaped text would be a backfill. There is none.
  assert.doesNotMatch(SQL, /^\s*update\s+public\./im)
  assert.doesNotMatch(SQL, /\binsert into\b/i, 'no seed rows: the 83 schools are not imported')
})

test('it does not touch statement_prompts or the submission tables', () => {
  for (const table of [
    'statement_prompts', 'statement_prompt_submissions',
  ]) {
    assert.ok(!SQL.includes(table), `${table} is named only in the commentary`)
  }
  // And the commentary does discuss them, which is why stripping mattered.
  assert.ok(RAW.includes('statement_prompts'))
})

test('it is wrapped in one transaction', () => {
  assert.equal((SQL.match(/^\s*begin;/gm) ?? []).length, 1)
  assert.equal((SQL.match(/^\s*commit;/gm) ?? []).length, 1)
  assert.ok(SQL.indexOf('begin;') < SQL.indexOf('commit;'))
})

test('no foreign key to public.schools, which has no migration', () => {
  assert.doesNotMatch(SQL, /references\s+public\.schools/i)
  // The one FK that IS declared is set -> sets, which is safe to cascade.
  const refs = [...SQL.matchAll(/references\s+(\S+?)\(/g)].map((m) => m[1])
  assert.deepEqual(refs, ['public.statement_requirement_sets'])
})

test('A DRAFT NEVER REFERENCES THE CATALOG, so deleting a requirement cannot touch an essay', () => {
  const draftStatements = (SQL.match(/alter table public\.statement_drafts[\s\S]*?;/g) ?? []).join('\n')
  assert.doesNotMatch(draftStatements, /references/i)
  assert.doesNotMatch(draftStatements, /on delete/i)
})

// ===================================================== no invented units

test('NO COLUMN DERIVES ONE UNIT FROM ANOTHER', () => {
  // The schema-level version of the product rule. A column holding an estimated
  // word count for a page limit would be the invented conversion.
  assert.doesNotMatch(SQL, /estimated_words|words_per_page|approx_words|equivalent_words/i)
  // The three units are stored independently, each nullable.
  for (const column of ['min_words', 'max_words', 'min_characters', 'max_characters',
    'min_pages', 'max_pages']) {
    assert.ok(SQL.includes(column), column)
  }
  // And no CHECK ties a word bound to a page bound.
  const checks = (SQL.match(/add constraint[\s\S]*?;/g) ?? []).join('\n')
  assert.doesNotMatch(checks, /words[^;]*pages|pages[^;]*words/i)
})

test('every limit is nullable and bounded, and a minimum cannot exceed a maximum', () => {
  for (const pair of [['min_words', 'max_words'], ['min_characters', 'max_characters'],
    ['min_pages', 'max_pages']]) {
    const [min, max] = pair
    assert.match(SQL, new RegExp(`${min} is null or ${max} is null or ${min} <= ${max}`), min)
  }
})

test('characters_include_spaces is three-valued and requires a character limit', () => {
  assert.match(SQL, /characters_include_spaces boolean,/)
  assert.doesNotMatch(SQL, /characters_include_spaces boolean not null/)
  assert.match(SQL, /characters_include_spaces is null\s*\n?\s*or min_characters is not null or max_characters is not null/)
})

test('page spacing is constrained to the two values that mean something', () => {
  assert.match(SQL, /page_spacing is null or page_spacing in \('single', 'double'\)/)
})

// ===================================================== provenance

test('verification defaults to unverified, and the statuses are constrained', () => {
  assert.match(SQL, /verification_status text\s+not null default 'unverified'/)
  assert.match(SQL,
    /verification_status in \('unverified', 'needs-review', 'verified', 'conflicting'\)/)
})

test('is_verbatim is its own column and defaults to false', () => {
  assert.match(SQL, /is_verbatim\s+boolean\s+not null default false/)
})

test('NO SOURCE URL OR DATE IS INVENTED: both are nullable with no default', () => {
  assert.match(SQL, /source_url\s+text,/)
  assert.match(SQL, /verified_on\s+date,/)
  assert.doesNotMatch(SQL, /source_url[^,;]*default/i)
  assert.doesNotMatch(SQL, /verified_on[^,;]*default/i)
})

test('AN ACTIVE SET MUST CARRY EVIDENCE -- enforced by the database', () => {
  const constraint = SQL.match(/statement_requirement_sets_active_needs_evidence[\s\S]*?;/g)?.join('\n') ?? ''
  assert.ok(constraint.length > 0)
  assert.match(constraint, /is_active = false/)
  assert.match(constraint, /verification_status = 'verified'/)
  assert.match(constraint, /source_url is not null/)
  assert.match(constraint, /verified_on is not null/)
})

test('a conflicting set can never be active', () => {
  // Implied by the constraint above: 'conflicting' is not 'verified'.
  const constraint = SQL.match(/statement_requirement_sets_active_needs_evidence[\s\S]*?;/g)!.join('\n')
  assert.doesNotMatch(constraint, /'conflicting'/)
})

// ===================================================== RLS and grants

test('RLS is enabled on both tables with SELECT-only policies', () => {
  assert.match(SQL, /alter table public\.statement_requirement_sets enable row level security/)
  assert.match(SQL, /alter table public\.statement_requirements enable row level security/)
  const policies = [...SQL.matchAll(/create policy "([^"]+)"[\s\S]*?for (\w+)/g)]
    .map((m) => [m[1], m[2]])
  assert.deepEqual(policies, [
    ['active requirement set select', 'select'],
    ['active requirement select', 'select'],
  ])
  // No write policy of any kind: a missing policy is a denial.
  assert.doesNotMatch(SQL, /for (insert|update|delete)\b/)
})

test('A DOCUMENT IS INVISIBLE WHEN ITS SET IS INACTIVE', () => {
  const policy = SQL.match(/create policy "active requirement select"[\s\S]*?;/)![0]
  assert.match(policy, /exists \(/)
  assert.match(policy, /statement_requirement_sets s/)
  assert.match(policy, /s\.is_active/)
})

test('browsers get SELECT and nothing else; service_role gets nothing', () => {
  assert.match(grants, /revoke all on public\.statement_requirement_sets from public;/)
  assert.match(grants, /revoke all on public\.statement_requirements from public;/)
  for (const table of ['statement_requirement_sets', 'statement_requirements']) {
    assert.match(grants,
      new RegExp(`revoke all on public\\.${table} from anon, authenticated, service_role;`))
    assert.match(grants, new RegExp(`grant select on public\\.${table} to anon, authenticated;`))
  }
  // No write privilege is granted to any role on the new tables.
  const granted = grants.match(/^\s*grant [\s\S]*?;/gm) ?? []
  for (const grant of granted) {
    assert.doesNotMatch(grant, /insert|update|delete|all/i, grant)
  }
  assert.doesNotMatch(grants, /to service_role/)
})

test('statement_drafts’ existing grants are left alone', () => {
  assert.doesNotMatch(grants, /statement_drafts/)
})

// ===================================================== the pairing rule

test('requirement_id and requirement_snapshot must both be set or both be null', () => {
  assert.match(SQL,
    /check \(\(requirement_id is null\) = \(requirement_snapshot is null\)\)/)
})

test('the snapshot must be a json OBJECT or null', () => {
  assert.match(SQL,
    /requirement_snapshot is null or jsonb_typeof\(requirement_snapshot\) = 'object'/)
})

test('the jsonb arrays are constrained to arrays, with a ceiling', () => {
  assert.match(SQL, /jsonb_typeof\(components\) = 'array' and jsonb_array_length\(components\) <= 25/)
  assert.match(SQL, /jsonb_typeof\(other_instructions\) = 'array'/)
  assert.match(SQL, /jsonb_typeof\(notes\) = 'array'/)
})

// ===================================================== indexes

test('the draft index is PARTIAL, so drafts without a requirement cost nothing', () => {
  const index = SQL.match(/create index if not exists statement_drafts_user_requirement_idx[\s\S]*?;/)![0]
  assert.match(index, /where requirement_id is not null/)
})

test('every index is guarded and names a new table or the new draft column', () => {
  const indexes = [...SQL.matchAll(/create index if not exists (\S+)\s+on (\S+)/g)]
  assert.ok(indexes.length >= 4)
  assert.equal((SQL.match(/create index(?! if not exists)/g) ?? []).length, 0)
  for (const [, , table] of indexes) {
    assert.ok(['public.statement_requirement_sets', 'public.statement_requirements',
      'public.statement_drafts'].includes(table!), table)
  }
})

// ===================================================== the file is unapplied

test('the rollout flag is what gates it, and the flag is off by default', async () => {
  const { requirementsEnabled, REQUIREMENTS_ENV } = await import('../draft/rollout.ts')
  assert.equal(REQUIREMENTS_ENV, 'STATEMENT_REQUIREMENTS')
  assert.equal(requirementsEnabled({}), false)
  // The migration says so too, so an operator reading the file knows.
  assert.match(RAW, /STATEMENT_REQUIREMENTS=on/)
})

// ===========================================================================
// 20261002_006 -- THE LENGTH REGISTER
// ===========================================================================

const RAW_006 = read('../../../supabase/migrations/20261002_006_statement_requirement_length_register.sql')
const SQL_006 = stripSql(RAW_006)

test('006 IS ADDITIVE: eight nullable columns and nothing else', () => {
  const columns: readonly (readonly [string, string])[] = [
    ['words_enforcement', 'text'], ['words_stated_as', 'text'],
    ['characters_enforcement', 'text'], ['characters_stated_as', 'text'],
    ['pages_enforcement', 'text'], ['pages_stated_as', 'text'],
    ['unenforced_length', 'text'], ['unenforced_length_verbatim', 'boolean'],
  ]
  for (const [column, type] of columns) {
    assert.match(SQL_006,
      new RegExp(`add column if not exists ${column}\\s+${type};`), column)
  }
  // No table is created, dropped or renamed, and no column is removed.
  assert.doesNotMatch(SQL_006, /create table/i)
  assert.doesNotMatch(SQL_006, /drop table|drop column|rename/i)
  // `not null` would reject every existing row; there are none today, and the
  // ban is what keeps that true if any appear before this is applied.
  assert.doesNotMatch(SQL_006, /add column[^;]*not null/i)
})

test('006 TOUCHES ONLY statement_requirements', () => {
  const altered = new Set(
    [...SQL_006.matchAll(/alter table (?:if exists )?(\S+)/gi)].map((m) => m[1]!))
  assert.deepEqual([...altered], ['public.statement_requirements'])
})

test('006 BACKFILLS, DELETES AND REWRITES NOTHING', () => {
  for (const forbidden of [/\bupdate\s+public\./i, /\bdelete\s+from/i, /\binsert\s+into/i,
    /\btruncate\b/i]) {
    assert.doesNotMatch(SQL_006, forbidden, String(forbidden))
  }
})

test('006 GRANTS NOTHING: adding a column to an already-granted SELECT needs none', () => {
  assert.doesNotMatch(SQL_006, /^\s*(grant|revoke)\b/mi)
})

test('NO DEFAULT IS SET ON A REGISTER COLUMN', () => {
  // `default 'enforced'` would write the strict register onto every future row
  // that forgot to state one, making "not recorded" indistinguishable from
  // "checked, and it really is a cap". NULL keeps the two apart in the
  // database; parseEnforcement() applies the strict reading in one place.
  for (const column of ['words_enforcement', 'characters_enforcement', 'pages_enforcement']) {
    assert.doesNotMatch(SQL_006,
      new RegExp(`add column if not exists ${column}[^;]*default`, 'i'), column)
  }
})

test('THE DATABASE REFUSES A REGISTER IT DOES NOT KNOW', () => {
  for (const column of ['words_enforcement', 'characters_enforcement', 'pages_enforcement']) {
    const check = SQL_006.match(
      new RegExp(`${column} in \\(([^)]*)\\)`, 'i'))
    assert.ok(check, `${column} has no value constraint`)
    for (const register of ['truncated', 'enforced', 'target', 'suggested', 'unknown']) {
      assert.match(check![1]!, new RegExp(`'${register}'`), `${column}: ${register}`)
    }
  }
})

test('EVERY REGISTER CHECK ALLOWS NULL EXPLICITLY', () => {
  // A CHECK passes on TRUE **or NULL**, which has bitten this schema before.
  // Each condition is written so the NULL case is the one it means to allow.
  for (const column of ['words_enforcement', 'characters_enforcement', 'pages_enforcement',
    'words_stated_as', 'characters_stated_as', 'pages_stated_as']) {
    assert.match(SQL_006, new RegExp(`${column} is null`), column)
  }
})

test('A REGISTER REQUIRES A LIMIT TO DESCRIBE', () => {
  // 'suggested' with no bound renders as an empty chip and is invisible in the
  // digest, so it is refused.
  assert.match(SQL_006, /words_enforcement is null or min_words is not null or max_words is not null/)
  assert.match(SQL_006, /characters_enforcement is null\s*\n?\s*or min_characters is not null or max_characters is not null/)
  // Page spacing alone IS a page requirement, so the page register is allowed
  // there too -- matching what 005 already builds a PageLimit from.
  assert.match(SQL_006, /pages_enforcement is null\s*\n?\s*or min_pages is not null or max_pages is not null or page_spacing is not null/)
})

test('TRUNCATION REQUIRES A MAXIMUM TO TRUNCATE AT', () => {
  // "We read only the first N" is meaningless without N, and a minimum cannot
  // be truncated at.
  for (const [register, bound] of [['words_enforcement', 'max_words'],
    ['characters_enforcement', 'max_characters'], ['pages_enforcement', 'max_pages']] as const) {
    assert.match(SQL_006,
      new RegExp(`${register} is distinct from 'truncated' or ${bound} is not null`), register)
  }
})

test('006 DERIVES NO UNIT FROM ANOTHER EITHER', () => {
  // The register must not become a back door for the conversion 005 forbids.
  assert.doesNotMatch(SQL_006, /estimated_words|words_per_page|approx|equivalent_words/i)
})

test('006 SAYS IT MUST BE APPLIED WITH 005 AND BEFORE THE FLAG', () => {
  // The ordering is load-bearing: repo.ts names these columns in its SELECT, so
  // 005-applied-and-006-missing is a broken read rather than a degraded one.
  assert.match(RAW_006, /20261002_005/)
  assert.match(RAW_006, /STATEMENT_REQUIREMENTS/)
  assert.match(RAW_006, /NOT APPLIED/)
})

// ===========================================================================
// 006 section 1b -- A LENGTH SHOWN AND NOT ENFORCED (Option A)
// ===========================================================================

test('unenforced_length NEEDS NO BOUND, which is the whole point of it', () => {
  // The register columns require min/max in their unit before they may carry a
  // value. This column must NOT, because it exists to hold a length sentence
  // for a document that has no stored bound at all.
  assert.doesNotMatch(SQL_006,
    /unenforced_length is null\s*\n?\s*or min_words is not null/,
    'a bound requirement was copied onto the one column that must not have it')
  assert.match(SQL_006, /add column if not exists unenforced_length\s+text;/)
})

test('THE VERBATIM FLAG HAS NO DEFAULT AND NEEDS A SENTENCE', () => {
  // NO DEFAULT: "not recorded" and "recorded as false" stay distinguishable in
  // the database; the under-claiming reading is applied once, in TypeScript.
  assert.doesNotMatch(SQL_006,
    /add column if not exists unenforced_length_verbatim[^;]*default/i)
  assert.match(SQL_006, /add column if not exists unenforced_length_verbatim\s+boolean;/)
  // A FLAG WITHOUT TEXT CLAIMS "verbatim" ABOUT NOTHING, and is refused.
  assert.match(SQL_006,
    /unenforced_length_verbatim is null or unenforced_length is not null/)
})

test('THE DATABASE REFUSES A ROW THAT BOTH SHOWS AND BOUNDS A LENGTH', () => {
  // "We do not know whether this is a limit" and "the maximum is 1,000" cannot
  // both be true of one document. A row carrying both would hand the interface
  // two answers.
  const check = SQL_006.match(
    /statement_requirements_unenforced_length_has_no_bound\s+check \(([\s\S]*?)\);/)
  assert.ok(check, 'the contradiction is not refused')
  const body = check![1]!
  assert.match(body, /unenforced_length is null/, 'NULL is allowed, as every CHECK must')
  for (const column of ['min_words', 'max_words', 'min_characters', 'max_characters',
    'min_pages', 'max_pages']) {
    assert.match(body, new RegExp(`${column} is null`), column)
  }
})

test('unenforced_length is bounded in LENGTH and refuses a blank', () => {
  assert.match(SQL_006,
    /unenforced_length is null\s*\n?\s*or char_length\(btrim\(unenforced_length\)\) between 1 and 2000/)
})

test('006 STILL DERIVES NO UNIT FROM ANOTHER, with the new column', () => {
  // The new column holds PROSE. If a words-per-page figure were ever going to
  // appear in this schema, this is where it would be.
  assert.doesNotMatch(SQL_006, /estimated_words|words_per_page|equivalent_words|approx/i)
})
