/**
 * TEST 2 — normal extraction. NOT RUN.
 *
 * Establishes that a text PDF goes in and text comes out, and that the worker
 * is gone afterwards. Deliberately NOT an extraction-quality test: the eight
 * fixtures in lib/pdf/fixtures/ already cover correctness against the real
 * extractor, and this prototype does not reproduce its column detection or
 * watermark filtering.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInWorker } from './extractInWorker.mjs'
import { FIXTURES, load, loadParent } from './fixtures.mjs'
import { MAX_EXTRACTED_CHARS } from './limits.mjs'

/**
 * How far extraction may land from the figure fixtures.mjs predicts.
 *
 * WAS 25%, AGAINST THE WRONG NUMBER. The old check compared what pdfjs
 * extracted against what the generator PLACED -- two quantities that differ by
 * a known ~9.8% -- and allowed 25% on top. A boundary fixture that overshot the
 * 50,000-character ceiling by 7% passed it comfortably, which is how a fixture
 * that could not do its only job survived review.
 *
 * 2% is now measured headroom rather than a guess. Phase 1B Stage 1 pinned
 * extraction at 3,580 characters per full page, and that figure reproduces both
 * measured fixtures to the character. The one unmeasured term is how a partial
 * final page's overhead apportions, worth at most 0.66% on the boundary
 * fixture. Anything beyond 2% means the model is wrong, not that a document
 * varied -- these fixtures are deterministic.
 */
const ESTIMATE_TOLERANCE = 0.02

for (const fx of FIXTURES) {
  test(`extraction: ${fx.key} (${fx.bytes} bytes, ${fx.pages} pages) yields text and shuts down`, async () => {
    const r = await extractInWorker(load(fx.key), { deadlineMs: 120_000 })

    assert.equal(r.ok, true, `extraction failed: ${r.errorName} ${r.errorMessage}`)
    assert.equal(r.numPages, fx.pages, 'page count differs from the generator')
    assert.equal(r.imageOnly, false)
    assert.ok(r.chars > 0, 'no text came back')

    // Against the RETURNED STRING and the PREDICTED extraction -- not against
    // the characters the generator placed, which is a different quantity and
    // was never the one worth checking.
    const length = r.text.length
    const drift = (length - fx.estimatedExtracted) / fx.estimatedExtracted
    console.log(`  ${fx.key}: predicted ${fx.estimatedExtracted} (${fx.estimateBasis}), `
      + `extracted ${length}, placed ${fx.chars} (${(drift * 100).toFixed(2)}% from prediction)`)
    assert.ok(
      Math.abs(drift) < ESTIMATE_TOLERANCE,
      `extraction was ${(drift * 100).toFixed(2)}% from the ${fx.estimatedExtracted} predicted in fixtures.mjs`,
    )

    // The role label has to survive contact with the real number. Without
    // this, a fixture can drift across the ceiling and still pass on tolerance
    // alone -- which is exactly what happened to the boundary fixture.
    const over = length > MAX_EXTRACTED_CHARS
    assert.equal(
      over,
      fx.role === 'OVER',
      `${fx.key} is labelled ${fx.role} but extracted ${length} against a ${MAX_EXTRACTED_CHARS} ceiling`,
    )

    // Whatever happened, the worker does not survive the call.
    assert.ok(r.timeline.some((m) => m.name === 'parent:terminated'))
    assert.equal(r.terminateError, null)
  })
}

test('extraction: an image-only scan is reported, not returned as empty text', async () => {
  // Reuses the existing Phase 0-era scan fixture rather than creating one.
  const r = await extractInWorker(loadParent('05_summit_edge_cases_scan_image_only.pdf'), { deadlineMs: 60_000 })
  assert.equal(r.ok, true)
  assert.equal(r.imageOnly, true, 'a scan must be distinguishable from a blank document')
  assert.equal(r.chars, 0)
})

test('extraction: malformed bytes fail cleanly and still terminate the worker', async () => {
  const notAPdf = new Uint8Array(Buffer.from('%PDF-1.4\nthis is not a real document\n'))
  const r = await extractInWorker(notAPdf, { deadlineMs: 30_000 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'error')
  assert.ok(r.errorMessage.length > 0)
  assert.ok(r.timeline.some((m) => m.name === 'parent:terminated'))
})
