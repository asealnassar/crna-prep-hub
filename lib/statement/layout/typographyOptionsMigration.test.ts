/**
 * Migration 010, asserted on its text.
 *
 * IT CANNOT BE RUN HERE, so the rules it must carry are checked as source. The
 * constraints are the only thing standing between a careless writer and a
 * permitted-value set that reads one way and hashes another.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SQL = readFileSync(
  'supabase/migrations/20261008_010_statement_requirement_typography_options.sql', 'utf8')

test('it adds both option columns and nothing else', () => {
  assert.match(SQL, /add column if not exists font_family_options\s+text\[\]/)
  assert.match(SQL, /add column if not exists font_size_pt_options integer\[\]/)
  // NO BACKFILL. Every existing row keeps both arrays null.
  assert.equal(/update public\.statement_requirements/i.test(SQL), false)
})

test('a property is a required value OR a permitted set, never both', () => {
  assert.match(SQL, /check \(font_family is null or font_family_options is null\)/)
  assert.match(SQL, /check \(font_size_pt is null or font_size_pt_options is null\)/)
})

test('THE DATABASE REFUSES DIRT RATHER THAN CLEANING IT', () => {
  // Each rule the generator is supposed to have applied, enforced rather than
  // assumed -- a writer that skipped one is rejected.
  const text = SQL.slice(SQL.indexOf('statement_text_options_ok'))
  // ALREADY TRIMMED. Not "trims to something non-empty": the stored bytes must
  // be canonical, or a value reads one way and hashes another.
  assert.match(text, /o = btrim\(o\)/)
  // No empty members, and the scalar's own length limit.
  assert.match(text, /o <> ''/)
  assert.match(text, /char_length\(o\) <= 100/)
  // A set of one is a scalar.
  assert.match(text, /cardinality\(opts\) >= 2/)
  // No nulls.
  assert.match(text, /array_position\(opts, null\) is null/)
  // 'Arial' and 'arial' are one option written twice.
  assert.match(text, /count\(distinct lower\(o\)\)/)
  // One set, one byte representation, one fingerprint.
  assert.match(text, /array_agg\(o order by lower\(o\)\)/)
})

test('and the same rules hold for permitted sizes', () => {
  const ints = SQL.slice(SQL.indexOf('statement_int_options_ok'))
  assert.match(ints, /cardinality\(opts\) >= 2/)
  assert.match(ints, /array_position\(opts, null\) is null/)
  assert.match(ints, /o between lo and hi/)
  assert.match(ints, /count\(distinct o\)/)
  assert.match(ints, /array_agg\(o order by o\)/)
  // THE SCALAR'S RANGE, not a new one: a permitted size cannot be a size the
  // scalar column would have refused.
  assert.match(SQL, /statement_int_options_ok\(font_size_pt_options, 4, 72\)/)
})

test('the checks call IMMUTABLE functions, because a CHECK cannot hold a subquery', () => {
  const bodies = SQL.match(/language sql\s+immutable/g) ?? []
  assert.equal(bodies.length, 2)
  assert.match(SQL, /check \(public\.statement_text_options_ok\(font_family_options\)\)/)
  assert.match(SQL, /check \(public\.statement_int_options_ok\(font_size_pt_options, 4, 72\)\)/)
})

test('IT IS NOT APPLIED, AND SAYS SO', () => {
  assert.match(SQL, /NOT APPLIED/)
})

test('it declares no dependency on the withdrawn 009', () => {
  /*
   * THIS ASSERTION USED TO BE `assert.match(SQL, /009/)`, under the comment
   * "it leaves 009's reviewed text alone" -- which was true when 009 was an
   * unapplied file whose text should not change. 009 is now WITHDRAWN and
   * deleted, and this file's header used to name it twice: once in its
   * sequence ("sequenced after 008/009") and once as the promotion function
   * that must later be replaced.
   *
   * The bare /009/ match still PASSES against the corrected header, because
   * the withdrawal sentences mention the number too. So it would have gone on
   * reporting green while asserting something that is no longer the rule --
   * which is the failure mode this suite exists to avoid. Replaced with the
   * rule that actually matters now.
   */
  assert.doesNotMatch(SQL, /sequenced after 008\/009/)
  assert.doesNotMatch(SQL, /009's promotion function/)
  // Every surviving mention retires it.
  for (const line of SQL.split('\n')) {
    if (!/\b009\b/.test(line)) continue
    assert.match(line, /WITHDRAWN|withdrawn|replaced/,
      `010 mentions 009 without retiring it: ${line.trim()}`)
  }
  // And 017 is named, so a reader is told where the promotion work went.
  assert.match(SQL, /20261015_017/)
})
