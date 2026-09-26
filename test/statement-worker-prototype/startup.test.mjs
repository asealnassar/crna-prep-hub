/**
 * TEST 1 — worker startup. NOT RUN. All figures UNKNOWN.
 *
 * Answers the one unmeasured number that shaped the dedicated-vs-pool
 * decision: what it costs to create an isolate and require the 2.1 MB
 * pdf.worker.js bundle on EVERY upload. If that cost is small against a
 * 45-second budget, the case for pooling largely dissolves; if it is large,
 * the trade is real.
 *
 * THREE SPANS, MEASURED SEPARATELY, because they have different causes and
 * different fixes:
 *
 *   spawn      new Worker() -> the worker's first tick        (isolate creation)
 *   load       first tick   -> pdf.js imported                (2.1 MB require)
 *   to-first   pdf.js ready -> extraction started             (document parse)
 *
 * Reports the DISTRIBUTION, not a mean: startup cost is dominated by its tail,
 * and an average hides exactly the case an applicant complains about.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInWorker, span } from './extractInWorker.mjs'
import { load } from './fixtures.mjs'

const ITERATIONS = Number(process.env.PROTO_ITERATIONS ?? 10)

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]

test('startup: spawn, pdf.js load and first extraction are measured separately', async () => {
  const bytes = load('small')
  const spawn = [], loadPdfjs = [], toFirst = [], total = []

  for (let i = 0; i < ITERATIONS; i += 1) {
    const r = await extractInWorker(bytes, { deadlineMs: 60_000 })
    assert.equal(r.ok, true, `iteration ${i} did not extract`)

    spawn.push(span(r.timeline, 'parent:spawn-requested', 'worker:worker-entry'))
    loadPdfjs.push(span(r.timeline, 'worker:worker-entry', 'worker:pdfjs-loaded'))
    toFirst.push(span(r.timeline, 'worker:pdfjs-loaded', 'worker:extraction-started'))
    total.push(r.finishedAt - r.spawnedAt)
  }

  const report = (name, xs) => {
    const s = [...xs].sort((a, b) => a - b)
    console.log(`  ${name.padEnd(12)} min ${s[0].toFixed(1)}  p50 ${quantile(s, 0.5).toFixed(1)}  p90 ${quantile(s, 0.9).toFixed(1)}  max ${s[s.length - 1].toFixed(1)}  (ms)`)
  }
  console.log(`\n  startup over ${ITERATIONS} dedicated workers — ALL VALUES MEASURED, NONE PREDICTED`)
  report('spawn', spawn)
  report('pdfjs-load', loadPdfjs)
  report('to-first', toFirst)
  report('total', total)

  // The only assertions are that the spans exist and are ordered. No
  // threshold is asserted, because no threshold has been established.
  for (const xs of [spawn, loadPdfjs, toFirst]) {
    assert.equal(xs.length, ITERATIONS)
    for (const x of xs) assert.ok(Number.isFinite(x) && x >= 0, 'a span was not measured')
  }
})

test('startup: the cost is paid per extraction, since no worker is reused', async () => {
  // Two extractions must show two independent spawns. If a pool ever crept in,
  // the second spawn would be near-zero and this would catch it.
  const bytes = load('small')
  const a = await extractInWorker(bytes, { deadlineMs: 60_000 })
  const b = await extractInWorker(bytes, { deadlineMs: 60_000 })
  for (const r of [a, b]) {
    assert.ok(span(r.timeline, 'parent:spawn-requested', 'worker:worker-entry') > 0)
    assert.ok(r.timeline.some((m) => m.name === 'parent:terminated'))
  }
})
