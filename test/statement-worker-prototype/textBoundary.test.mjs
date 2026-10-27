/**
 * TEST 7 — raw extraction vs application eligibility. NOT RUN.
 *
 * THE DISTINCTION THIS FILE EXISTS TO KEEP. "Did extraction work" and "may this
 * become an essay" are different questions with different answers, and
 * conflating them is how silent truncation gets introduced.
 *
 * A 4 MB document extracts perfectly well and yields roughly half a million
 * characters. That is a SUCCESSFUL extraction of an INELIGIBLE document. The
 * worker's job is to report both facts accurately; deciding what to do about
 * them is the application's job, and it is not prototyped here.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK HERE USES `r.text.length`, NEVER `r.chars`.
 *
 * They are different numbers. The worker sums each page's text length into
 * `chars`, then returns `pageTexts.join('\n')` -- so the string it hands back
 * is `chars + numPages - 1` characters long. On a 144-page document that is a
 * 143-character gap.
 *
 * Eligibility is a question about the text the application would actually
 * receive, so it is asked of the string. Asking the counter instead is the same
 * class of mistake that produced the first boundary fixture: sizing it by a
 * number that was never the number that matters.
 * ---------------------------------------------------------------------------
 *
 * NO TRUNCATION HAPPENS ANYWHERE IN THIS PROTOTYPE. worker.mjs contains no
 * slice() on extracted text, deliberately -- the production parse-pdf route
 * does `result.text.slice(0, MAX_TEXT_CHARS)` at line 80, which is a silent
 * truncation and already contradicts the approved "no silent truncation"
 * requirement. That is a production defect to raise separately, not a pattern
 * to copy.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInWorker } from './extractInWorker.mjs'
import { FIXTURES, byKey, load } from './fixtures.mjs'
import { MAX_EXTRACTED_CHARS, MAX_SAVED_CHARS } from './limits.mjs'

/**
 * What the application WOULD decide, computed here only so the test can assert
 * the two questions stay separate. The prototype does not enforce it.
 */
const eligibility = (chars) =>
  chars > MAX_EXTRACTED_CHARS ? 'refuse-too-long'
    : chars > MAX_SAVED_CHARS ? 'editable-must-shorten-before-saving'
      : 'editable-and-savable'

test('boundary: every fixture extracts successfully, whatever its eligibility', async () => {
  const rows = []

  for (const fx of FIXTURES) {
    const r = await extractInWorker(load(fx.key), { deadlineMs: 180_000 })

    // Extraction succeeds for ALL of them, including the oversized ones.
    assert.equal(r.ok, true, `${fx.key} failed to extract`)

    const length = r.text.length          // the string, not the counter
    rows.push({
      fixture: fx.key,
      role: fx.role,
      extractedChars: length,
      estimated: fx.estimatedExtracted,
      basis: fx.estimateBasis,
      driftFromEstimate: `${(((length - fx.estimatedExtracted) / fx.estimatedExtracted) * 100).toFixed(2)}%`,
      overExtractionCeiling: length > MAX_EXTRACTED_CHARS,
      eligibility: eligibility(length),
    })
  }

  console.log('\n  extraction succeeded for every fixture; eligibility differs')
  console.table(rows)

  // The labels the Phase 0 generator assigned must match reality.
  for (const [i, fx] of FIXTURES.entries()) {
    const row = rows[i]
    if (fx.role === 'OVER') {
      assert.equal(row.overExtractionCeiling, true, `${fx.key} was labelled OVER but fits the ceiling`)
      assert.equal(row.eligibility, 'refuse-too-long')
    } else {
      assert.equal(row.overExtractionCeiling, false, `${fx.key} was labelled ${fx.role} but exceeds the ceiling`)
    }
  }
})

test('boundary: oversized text is returned whole, never truncated', async () => {
  // If anything ever starts trimming, this catches it: the returned string
  // must be the full extraction, not clipped to the ceiling.
  const r = await extractInWorker(load('mb4'), { deadlineMs: 180_000 })
  assert.equal(r.ok, true)

  // This used to assert `r.text.length === r.chars`, which cannot hold for a
  // multi-page document and would have failed on all 144 pages of this one.
  // The worker joins pages with '\n' after counting them, so the correct
  // relationship -- and the one that actually proves nothing was dropped -- is
  // one separator per page boundary.
  assert.equal(
    r.text.length,
    r.chars + r.numPages - 1,
    'the returned string is not the counted text plus one newline per page boundary',
  )

  assert.ok(r.text.length > MAX_EXTRACTED_CHARS, 'this fixture should exceed the ceiling')
  assert.notEqual(r.text.length, MAX_EXTRACTED_CHARS, 'text appears clipped to exactly the ceiling')
  console.log(`  returned ${r.text.length} chars whole; ceiling is ${MAX_EXTRACTED_CHARS}`)
})

/**
 * How close to the ceiling the AT fixture has to land to be worth having.
 *
 * 90% of the approved ceiling. A fixture at 20,000 characters is "under the
 * ceiling" and tests nothing about the boundary; this is what stops a future
 * regeneration from quietly turning the boundary case into another small one.
 * It is a property of the FIXTURE, not an application limit, and it is
 * deliberately far looser than the 48,000-49,000 the generator targets so that
 * ordinary model error cannot fail it.
 */
const BOUNDARY_FLOOR = Math.round(MAX_EXTRACTED_CHARS * 0.9)

test('boundary: the at-ceiling fixture sits just under the ceiling, and near it', async () => {
  // THE TEST THE OLD FIXTURE PASSED ANYWAY. The previous boundary fixture
  // extracted 53,706 characters against this 50,000 ceiling, and the only
  // other check on it was extraction.test.mjs's 25% drift tolerance, measured
  // against the number of characters the GENERATOR placed -- so being 7% wrong
  // about the thing the fixture existed to test registered as a pass.
  //
  // Two bounds now, both on the string the worker actually returns:
  //   upper  the approved 50,000 ceiling. Over it, the fixture is not an AT
  //          fixture and this must fail.
  //   lower  BOUNDARY_FLOOR, so "eligible" cannot be achieved by being tiny.
  const r = await extractInWorker(load('boundary'), { deadlineMs: 120_000 })
  assert.equal(r.ok, true)

  const length = r.text.length
  const fx = byKey('boundary')
  const drift = ((length - fx.estimatedExtracted) / fx.estimatedExtracted) * 100

  console.log(`  boundary fixture extracted ${length} chars`)
  console.log(`    ceiling ${MAX_EXTRACTED_CHARS}, floor ${BOUNDARY_FLOOR}`)
  console.log(`    metadata said ~${fx.estimatedExtracted} (${fx.estimateBasis}); drift ${drift.toFixed(2)}%`)

  assert.ok(
    length <= MAX_EXTRACTED_CHARS,
    `the boundary fixture extracted ${length} chars, over the ${MAX_EXTRACTED_CHARS} ceiling it exists to sit under`,
  )
  assert.ok(
    length >= BOUNDARY_FLOOR,
    `the boundary fixture extracted only ${length} chars; below ${BOUNDARY_FLOOR} it is not testing the boundary`,
  )

  // Separate question, separate assertion: is the MODEL in fixtures.mjs right?
  // The bounds above can pass while the estimate is badly wrong, and if it is,
  // that is worth knowing rather than tolerating -- every other fixture's
  // estimatedExtracted rests on the same per-page figure.
  assert.ok(
    Math.abs(drift) < 5,
    `extraction came in ${drift.toFixed(2)}% from the estimate; the per-page model in fixtures.mjs needs revisiting`,
  )
})

/**
 * A truncating call. Broader than the string the old check looked for: it
 * catches `.substr(`, any `.slice(` and any `.substring(`, not only the
 * `.slice(0,` spelling, so a truncation written as `.slice(0, n)` on one line
 * and `.substring(start, end)` on another are both seen.
 *
 * Not global: `.test()` on a /g regex carries `lastIndex` between calls and
 * would silently skip every other match.
 */
const TRUNCATOR = /\.\s*(?:slice|substring|substr)\s*\(/

/** Identifiers that carry the applicant's extracted text through worker.mjs. */
const CARRIES_EXTRACTED_TEXT = /\b(?:text|pageTexts|parts|str|chars|extracted)\b/

/** Identifiers that carry a diagnostic string, which SHOULD be shortened. */
const CARRIES_DIAGNOSTIC = /\b(?:error|message|errorMessage|stack)\b/

test('boundary: the prototype contains no truncation of extracted text', async () => {
  // WHY THIS WAS REWRITTEN. The old version searched the whole file for the
  // literal '.slice(0,' and failed on the first hit. worker.mjs contains two,
  // both `String(error?.message ?? '').slice(0, 300)` -- shortening a PARSER
  // ERROR MESSAGE so a failure cannot echo the applicant's document back in a
  // log. That is a privacy protection, and the old check called it truncation
  // of essay text. It was a false positive, and it fired the first time this
  // file was ever run.
  //
  // The guard now classifies each truncating call by WHAT IT IS APPLIED TO
  // rather than banning the operation outright.
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('./worker.mjs', import.meta.url)), 'utf8')

  // Comments are blanked rather than deleted, so line numbers still line up
  // with the file and a failure can say exactly where to look.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))

  const rawLines = src.split('\n')
  const offenders = []
  const permitted = []

  code.split('\n').forEach((line, i) => {
    if (!TRUNCATOR.test(line)) return
    const where = `worker.mjs:${i + 1}  ${rawLines[i].trim()}`

    // ORDER MATTERS, AND IT FAILS CLOSED.
    //   text present            -> offender, even if a diagnostic is also
    //                              named, because that mixture is precisely
    //                              how a truncation would hide behind one.
    //   diagnostic only         -> permitted.
    //   neither recognised      -> offender. An unclassifiable truncation is
    //                              reported rather than waved through.
    if (CARRIES_EXTRACTED_TEXT.test(line)) offenders.push(`truncates extracted text  ${where}`)
    else if (CARRIES_DIAGNOSTIC.test(line)) permitted.push(where)
    else offenders.push(`unclassifiable truncation  ${where}`)
  })

  // Exemptions are printed, never silent: a reviewer sees what was allowed.
  console.log(`\n  truncating calls permitted as diagnostics: ${permitted.length}`)
  for (const p of permitted) console.log(`    ${p}`)

  assert.deepEqual(
    offenders,
    [],
    `worker.mjs truncates extracted text:\n    ${offenders.join('\n    ')}`,
  )

  // Unchanged in substance: the worker must not know the ceiling at all.
  // Deciding what to do about an oversized document is the application's job,
  // and a worker that knows the number is a worker that can quietly enforce it.
  assert.equal(
    /\bMAX_EXTRACTED_CHARS\b/.test(code),
    false,
    'worker.mjs references the extraction ceiling; enforcing it is not the worker\'s job',
  )

  // POSITIVE GUARD. The checks above prove nothing truncates the text as it is
  // assembled today; these prove the assembly is still the same join-based
  // path, so truncation cannot be reintroduced by replacing it with something
  // this file does not recognise.
  assert.ok(
    /\bparts\s*\.\s*join\s*\(/.test(code),
    'worker.mjs no longer builds page text with parts.join(); re-check it for truncation',
  )
  assert.ok(
    /\bpageTexts\s*\.\s*join\s*\(/.test(code),
    'worker.mjs no longer joins pages with pageTexts.join(); re-check it for truncation',
  )
})
