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
