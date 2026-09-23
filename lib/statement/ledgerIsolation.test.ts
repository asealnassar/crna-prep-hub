import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { STATEMENT_OPERATIONS, STATEMENT_OPERATION_PATTERN, isStatementOperation, timestampsFrom } from './usage.ts'
import { STATEMENT_RATE_LIMITS, checkStatementRate } from './entitlement.ts'
import { AI_RATE_LIMITS, checkAiRate } from '../resume/entitlement.ts'

/**
 * Two features, one table, two budgets.
 *
 * The Personal Statement Analyzer writes its abuse ledger into
 * `resume_ai_usage` so Phase 0 could ship without a migration. That is only
 * acceptable while the two features cannot see each other's rows. This file is
 * what keeps that true — in both directions, which is the part that is easy to
 * get half right.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const RESUME_ROUTES = [
  ['propose', strip(read('../../app/api/resume-v2/ai/propose/route.ts'))],
  ['score', strip(read('../../app/api/resume-v2/score/route.ts'))],
] as const

// ------------------------------------------------- resume is not affected

test('every resume route that reads the ledger excludes statement rows', () => {
  // Without this, analysing a personal statement silently consumes a resume AI
  // allowance the applicant never spent.
  for (const [name, source] of RESUME_ROUTES) {
    const read_ = source.slice(source.indexOf("from('resume_ai_usage')"))
    const query = read_.slice(0, read_.indexOf('.limit('))
    assert.match(
      query,
      /\.not\('operation',\s*'like',\s*STATEMENT_OPERATION_PATTERN\)/,
      `the ${name} route counts statement rows against the resume budget`
    )
  }
})

test('the resume routes use the shared constant, not a copy of the string', () => {
  for (const [name, source] of RESUME_ROUTES) {
    assert.ok(
      source.includes("import { STATEMENT_OPERATION_PATTERN } from '@/lib/statement/usage'"),
      `${name} does not share the namespace definition`
    )
    // A hand-typed duplicate is how the two drift apart.
    assert.doesNotMatch(source, /'statement-%'/, `${name} hardcodes the pattern`)
  }
})

test('the resume rate limits themselves are untouched', () => {
  // Phase 0 must not change what a resume user is allowed to do.
  assert.deepEqual([...AI_RATE_LIMITS], [
    { windowMs: 60_000, max: 10 },
    { windowMs: 60 * 60_000, max: 60 },
    { windowMs: 24 * 60 * 60_000, max: 150 },
  ])
})

test('a heavy statement user still has their whole resume allowance', () => {
  const now = 1_000_000
  // Sixty statement calls in the last hour — far past the statement ceiling.
  const statementRows = Array.from({ length: 60 }, (_, i) => ({
    created_at: new Date(now - i * 1_000).toISOString(),
    operation: STATEMENT_OPERATIONS.analyze,
  }))
  // The resume route's query excludes them, so its ledger sees nothing.
  const resumeVisible = statementRows.filter((r) => !isStatementOperation(r.operation))
  assert.equal(resumeVisible.length, 0)
  assert.equal(checkAiRate([], now, AI_RATE_LIMITS).allowed, true)
})

// ------------------------------------------- statement is not affected

test('a heavy resume user still has their whole statement allowance', () => {
  const now = 1_000_000
  const resumeRows = Array.from({ length: 150 }, (_, i) => ({
    created_at: new Date(now - i * 1_000).toISOString(),
    operation: 'improve-bullet',
  }))
  assert.deepEqual(timestampsFrom(resumeRows), [])
  assert.equal(checkStatementRate(timestampsFrom(resumeRows), now, STATEMENT_RATE_LIMITS).allowed, true)
})

test('the analytics predicate and the rate predicate are the same function', () => {
  const analytics = strip(read('../analytics/server/sections/product.ts'))
  assert.ok(
    analytics.includes("import { isStatementOperation } from '../../../statement/usage'"),
    'analytics defines its own idea of which rows are whose'
  )
  assert.ok(analytics.includes('aiUsage.rows.filter((row) => !isStatementOperation(row.operation))'))
})

test('the resume AI metric counts only resume rows', () => {
  const analytics = strip(read('../analytics/server/sections/product.ts'))
  const block = analytics.slice(analytics.indexOf('if (aiUsage.ok) {'), analytics.indexOf("diagnostics.note('resume_ai_usage'"))
  // Every consumer inside the block reads the filtered array.
  assert.doesNotMatch(block, /aiUsage\.rows\.length/, 'an unfiltered count survives')
  assert.doesNotMatch(block, /countBy\(aiUsage\.rows/, 'an unfiltered breakdown survives')
})

// --------------------------------------------------- the namespace itself

test('the pattern is anchored at the start, so it cannot match a resume operation', () => {
  assert.ok(STATEMENT_OPERATION_PATTERN.endsWith('%'))
  assert.equal(STATEMENT_OPERATION_PATTERN.startsWith('%'), false, 'a leading wildcard would match anything')
})

test('no resume operation could ever be mistaken for a statement one', () => {
  for (const operation of [
    'improve-bullet', 'generate-bullets', 'rewrite-summary', 'tighten',
    'organise-import', 'score', 'unknown', '', 'restatement-of-work',
  ]) {
    assert.equal(isStatementOperation(operation), false, operation)
  }
})
