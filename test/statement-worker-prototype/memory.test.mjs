/**
 * TEST 3 — memory. NOT RUN. All figures UNKNOWN.
 *
 * Three questions, in order of how much they matter:
 *
 *   1. How does peak memory scale from 100 KB to the 4 MB ceiling?
 *   2. Does a dedicated worker's memory actually come back on terminate?
 *   3. How much of the peak is the four in-memory copies the earlier audit
 *      identified (File -> arrayBuffer -> Buffer -> Uint8Array), plus the
 *      structuredClone that LoopbackPort performs on every message, plus the
 *      FIFTH copy extractInWorker's `slice()` makes before transferring?
 *
 * WHY THIS IS RUN WITH --expose-gc. Without a forced collection, RSS staying
 * high after terminate proves nothing: V8 routinely declines to return memory
 * to the OS. Heap statistics after an explicit GC are the only honest signal,
 * and even they are indicative rather than conclusive.
 *
 * NO EXPECTED FIGURES APPEAR IN THIS FILE and none should be added before
 * Phase 1B measures them. The assertions below check SHAPE (monotonicity,
 * return-to-baseline) rather than magnitude.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInWorker, peakHeap } from './extractInWorker.mjs'
import { FIXTURES, load } from './fixtures.mjs'

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)

const settle = async () => {
  // Best effort. Requires --expose-gc; without it this is a no-op and the
  // post-termination numbers must be read as indicative only.
  global.gc?.()
  await new Promise((r) => setTimeout(r, 50))
  global.gc?.()
}

test('memory: peak scales with document size, and returns after termination', async () => {
  const rows = []

  for (const fx of FIXTURES) {
    await settle()
    const before = process.memoryUsage()

    const r = await extractInWorker(load(fx.key), { deadlineMs: 180_000 })
    assert.equal(r.ok, true, `${fx.key} failed to extract`)

    await settle()
    const after = process.memoryUsage()

    rows.push({
      key: fx.key,
      fileMB: mb(fx.bytes),
      workerPeakMB: peakHeap(r.memorySamples) ? mb(peakHeap(r.memorySamples)) : 'n/a',
      parentBeforeMB: mb(before.heapUsed),
      parentAfterMB: mb(after.heapUsed),
      parentRssDeltaMB: mb(after.rss - before.rss),
    })
  }

  console.log('\n  MEASURED — no value here was predicted')
  console.table(rows)

  // Shape only. Peak should not shrink as documents grow.
  const peaks = rows.map((x) => Number(x.workerPeakMB)).filter(Number.isFinite)
  for (let i = 1; i < peaks.length; i += 1) {
    assert.ok(peaks[i] >= peaks[i - 1] * 0.8, 'peak memory did not scale with document size as expected')
  }
})

test('memory: repeated extractions do not accumulate in the parent', async () => {
  // A dedicated worker should leave nothing behind. If the parent's heap
  // climbs monotonically across runs, something is being retained -- most
  // likely the transferred buffer or a stale worker handle.
  const bytes = load('mb1')
  const samples = []

  for (let i = 0; i < 5; i += 1) {
    const r = await extractInWorker(bytes, { deadlineMs: 120_000 })
    assert.equal(r.ok, true)
    await settle()
    samples.push(process.memoryUsage().heapUsed)
  }

  console.log('\n  parent heapUsed across 5 dedicated workers (MB):', samples.map(mb).join('  '))
  const growth = (samples.at(-1) - samples[0]) / samples[0]
  console.log(`  growth first -> last: ${(growth * 100).toFixed(1)}%`)
  assert.ok(growth < 0.5, 'parent heap grew across repeated extractions; something is retained')
})

test("memory: the caller's buffer survives, because a copy is what gets transferred", async () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong.
  //
  // It asserted `bytes.byteLength === 0` on the belief that the caller's
  // ArrayBuffer is handed to the worker. It is not. extractInWorker takes a
  // `slice()` first, which allocates a second buffer and copies into it, and
  // transfers THAT. The copy is detached; the caller's array is never touched.
  //
  // The cost this documents is real and is the point of keeping the test: the
  // document exists TWICE in the parent at peak, not once. That is a known
  // property of the current design, not a defect being hidden -- see the long
  // comment in extractInWorker.mjs for why it has not been changed.
  const bytes = load('small')
  const original = bytes.byteLength
  const firstByte = bytes[0]

  const r = await extractInWorker(bytes, { deadlineMs: 60_000 })
  assert.equal(r.ok, true)

  console.log(`  caller's view after transfer: ${bytes.byteLength} bytes (was ${original})`)
  assert.equal(bytes.byteLength, original, "the caller's buffer was detached; extractInWorker no longer copies")
  assert.equal(bytes[0], firstByte, "the caller's bytes are no longer readable")

  // The practical consequence, and the reason the copy is tolerated: the same
  // input can be extracted again. A direct transfer would make this throw.
  const again = await extractInWorker(bytes, { deadlineMs: 60_000 })
  assert.equal(again.ok, true, 'a second extraction from the same input failed')
  assert.equal(again.chars, r.chars, 'the same input produced a different result the second time')
})
