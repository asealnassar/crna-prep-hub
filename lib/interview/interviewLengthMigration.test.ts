import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The interview-length migration, checked as text: it must stay the one
 * additive, backward-compatible change the currently deployed application
 * (which never names the column) can run beside. Its runtime use is tested in
 * interviewLength.test.ts; this file depends on nothing but the SQL.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const MIGRATION = read('../../supabase/migrations/20260921_002_interview_length.sql')
const PREFLIGHT = read('../../supabase/manual/interview_length_preflight.sql')
const POSTCHECK = read('../../supabase/manual/interview_length_postcheck.sql')

/** Statements with whole-line comments removed. */
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)

test('the migration adds one nullable column, checked to 5 or 10, with no default and no backfill', () => {
  const stmts = statements(MIGRATION)
  assert.equal(stmts.length, 1, 'one statement')
  assert.match(stmts[0], /^alter table public\.interview_grants\s+add column if not exists max_primary_questions smallint/)
  assert.match(stmts[0], /constraint interview_grants_max_primary_questions_check/)
  assert.match(stmts[0], /check \(max_primary_questions is null or max_primary_questions in \(5, 10\)\)/)
  const code = stmts.join('\n')
  assert.doesNotMatch(code, /default|not null|update |insert |drop |grant |revoke |policy|function|index/i)
})

test('the preflight and postcheck are read-only: every statement is a SELECT', () => {
  for (const [name, sql, expected] of [['preflight', PREFLIGHT, 10], ['postcheck', POSTCHECK, 7]] as const) {
    const stmts = statements(sql)
    assert.equal(stmts.length, expected, `${name} statement count`)
    for (const s of stmts) assert.match(s, /^select\s/i, `${name}: ${s.slice(0, 60)}`)
  }
})

test('the postcheck expects exactly the constraint the migration defines', () => {
  assert.ok(
    POSTCHECK.includes('CHECK (((max_primary_questions IS NULL) OR (max_primary_questions = ANY (ARRAY[5, 10]))))'),
    'the definition Postgres reports back for this CHECK'
  )
  assert.ok(POSTCHECK.includes("conname = 'interview_grants_max_primary_questions_check'"))
  assert.ok(PREFLIGHT.includes("where conname = 'interview_grants_max_primary_questions_check'"), 'the name is checked free first')
})
