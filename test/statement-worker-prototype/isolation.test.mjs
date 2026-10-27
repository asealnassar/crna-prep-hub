/**
 * TEST 5 — cross-applicant isolation. NOT RUN.
 *
 * THE RISK THIS EXISTS TO RULE OUT. In a pooled design, terminating a timed-out
 * job can kill a worker that has already been handed to somebody else. The
 * dedicated design is supposed to make that impossible by construction: the
 * terminate call closes over the one handle its own call created, and there is
 * no registry to look the wrong one up in.
 *
 * "By construction" is a claim, so these tests try to break it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInWorker } from './extractInWorker.mjs'
import { load } from './fixtures.mjs'

test('isolation: cancelling one extraction does not disturb a concurrent one', async () => {
  const victim = new AbortController()

  // A runs normally. B is aborted almost immediately. They overlap.
  const a = extractInWorker(load('mb1'), { deadlineMs: 180_000 })
  const b = extractInWorker(load('mb1'), { deadlineMs: 180_000, signal: victim.signal })
  setTimeout(() => victim.abort(), 30)

  const [ra, rb] = await Promise.all([a, b])

  assert.equal(rb.ok, false, 'B should have been cancelled')
  assert.equal(rb.reason, 'aborted')

  // The one that matters: A must be untouched.
  assert.equal(ra.ok, true, "cancelling B also killed A — isolation is broken")
  assert.ok(ra.chars > 0)
})

test('isolation: one deadline expiring does not terminate another applicant', async () => {
  // A has a generous deadline; B's expires at once. Both are in flight.
  const a = extractInWorker(load('boundary'), { deadlineMs: 180_000 })
  const b = extractInWorker(load('mb4'), { deadlineMs: 20, graceMs: 200 })

  const [ra, rb] = await Promise.all([a, b])

  assert.equal(rb.ok, false)
  assert.equal(ra.ok, true, "B's deadline terminated A's worker")
})

test('isolation: a forcibly-terminated stall does not affect its neighbour', async () => {
  // The harshest case: B is force-killed mid-stall while A is working.
  const a = extractInWorker(load('mb1'), { deadlineMs: 180_000 })
  const b = extractInWorker(load('small'), {
    deadlineMs: 50, graceMs: 100, stallMs: 6_000, allowTestStall: true,
  })

  const [ra, rb] = await Promise.all([a, b])

  assert.equal(rb.terminatedForcibly, true)
  assert.equal(ra.ok, true, 'a forced terminate reached the wrong worker')
  assert.ok(ra.chars > 0)
})

/** Process-wide resident set size, in bytes. */
const rssBytes = () => process.memoryUsage().rss
const toMiB = (bytes) => (bytes / 1024 / 1024).toFixed(1)

/**
 * How often the sampler looks at RSS while the three workers run.
 *
 * 5 ms against a ~150 ms observed runtime gives roughly 30 samples. Tighter
 * would add its own overhead to the thing being measured; looser would risk
 * missing the peak entirely.
 */
const RSS_SAMPLE_INTERVAL_MS = 5

test('isolation: each extraction gets its own worker, never a shared one', async () => {
  // ---------------------------------------------------------------------
  // PROCESS-WIDE RSS, SAMPLED WHILE THREE WORKERS RUN AT ONCE.
  //
  // WHY HERE. Run B measured ~16-26 MiB of worker HEAP per extraction, one at a
  // time, and found it barely moves across a 37x range of file size -- the cost
  // is the pdf.js bundle, not the document. That makes CONCURRENCY, not upload
  // size, the thing that determines peak memory, and nothing had ever measured
  // it. This is the only test in the prototype that runs workers simultaneously.
  //
  // WHAT IT IS. A sampled maximum of the PARENT PROCESS's `rss`, which on Node
  // covers the whole process including every worker thread. It is NOT an exact
  // instantaneous peak (a 5 ms sampler can miss a shorter spike), NOT a
  // per-worker figure (threads share one RSS), and NOT a measurement of any
  // serverless memory ceiling.
  //
  // NO THRESHOLD IS ASSERTED. The point is to obtain a number to assess before
  // integration, not to gate this test on one.
  // ---------------------------------------------------------------------
  const baselineRssBytes = rssBytes()
  const rssSamples = []
  let sampler = null

  try {
    sampler = setInterval(() => rssSamples.push(rssBytes()), RSS_SAMPLE_INTERVAL_MS)
    // Never let the sampler alone hold the event loop open.
    sampler.unref?.()

    // UNCHANGED BELOW: same three fixtures, same budgets, same concurrency.
    // Three concurrent extractions must produce three independent spawn marks
    // and three independent terminations. A pool would show fewer.
    const results = await Promise.all([
      extractInWorker(load('small'), { deadlineMs: 120_000 }),
      extractInWorker(load('small'), { deadlineMs: 120_000 }),
      extractInWorker(load('small'), { deadlineMs: 120_000 }),
    ])

    for (const r of results) {
      assert.equal(r.ok, true)
      assert.equal(r.timeline.filter((m) => m.name === 'parent:spawn-requested').length, 1)
      assert.equal(r.timeline.filter((m) => m.name === 'parent:terminated').length, 1)
    }
  } finally {
    // Stopped even if an assertion above threw, so a failing run cannot leave a
    // timer behind -- and the measurement is still reported.
    clearInterval(sampler)

    const afterRssBytes = rssBytes()
    const peakRssBytes = rssSamples.length ? Math.max(...rssSamples) : null

    console.log('\n  SAMPLED PROCESS-WIDE RSS, 3 concurrent workers (MiB)')
    console.log(`    baseline            ${toMiB(baselineRssBytes)}`)
    console.log(`    sampled peak        ${peakRssBytes === null ? 'n/a — no samples' : toMiB(peakRssBytes)}`)
    console.log(`    after               ${toMiB(afterRssBytes)}`)
    console.log(`    peak over baseline  ${peakRssBytes === null ? 'n/a' : toMiB(peakRssBytes - baselineRssBytes)}`)
    console.log(`    samples             ${rssSamples.length} at ${RSS_SAMPLE_INTERVAL_MS}ms`)
    console.log('    NOTE: sampled peak, not an instantaneous maximum. Process-wide,')
    console.log("    not per-worker. Workload is 3x the 'small' fixture (0.10 MiB,")
    console.log('    4 pages) -- the SMALLEST available, so this characterises the')
    console.log('    fixed per-worker pdf.js cost, not large concurrent uploads.')
  }
})

// ---------------------------------------------------------------------------
// M1 — DOES PROCESS RSS COME BACK AFTER A FORCED COLLECTION?
//
// The test above measured a sampled peak of 238.2 MiB against a 45.7 MiB
// baseline, and 208.4 MiB still resident immediately afterwards. That reading
// answered nothing about retention, for a plain reason: it never forced a
// collection. V8 does not hand freed pages back to the OS promptly, so RSS
// staying high proves only that RSS stays high.
//
// The sequential memory suite already forces GC and found +0.9 MiB of parent
// HEAP across five extractions -- so if workers leaked, that is where it would
// have shown. What nobody has measured is RSS after a collection, with three
// workers confirmed gone. That is the one number this test adds.
//
// IT IS A SEPARATE TEST ON PURPOSE. The test above keeps its no-GC measurement
// untouched so its 238.2 / 208.4 figures stay directly comparable.
// ---------------------------------------------------------------------------

/** Parent-process V8 heap in use, in bytes. NOT the same metric as rss. */
const heapUsedBytes = () => process.memoryUsage().heapUsed

/**
 * RSS sampling interval for M1. Deliberately 10 ms, not the 5 ms above.
 *
 * This test's subject is the post-GC trajectory rather than the peak, so fewer
 * samples means less of the sampler's own overhead inside the measurement.
 */
const POST_GC_SAMPLE_INTERVAL_MS = 10

/** Settling window after the first collection. Half the authorized 500 ms ceiling. */
const POST_GC_SETTLE_MS = 250

test('isolation: three concurrent workers post-GC RSS', async () => {
  // A SILENT NO-OP WOULD MAKE EVERY POST-GC READING MEANINGLESS, so the flag is
  // a hard requirement rather than an optional-chained `global.gc?.()`.
  assert.equal(
    typeof global.gc,
    'function',
    'this test must run with --expose-gc; without it no collection happens and readings 4 and 5 are worthless',
  )

  // NO COLLECTION BEFORE THE BASELINE, deliberately.
  //
  // A pre-baseline gc() would give a tidier floor, but it would also make this
  // baseline mean something different from the 45.7 MiB the test above recorded,
  // and comparability with that figure is the more valuable property. The cost
  // is that this baseline may include collectable garbage from module load and
  // fixture reading -- acknowledged rather than hidden.
  const baselineRssBytes = rssBytes()
  const baselineHeapBytes = heapUsedBytes()

  const rssSamples = []
  let sampler = null
  let settleTimer = null

  // Filled in as the test proceeds, so the `finally` can report whatever was
  // reached even if an assertion throws part-way through.
  const m = {
    afterExitRssBytes: null,
    afterGcRssBytes: null,
    settledRssBytes: null,
    afterGcHeapBytes: null,
    settledHeapBytes: null,
    exitConfirmed: false,
    workerCount: null,
  }

  try {
    sampler = setInterval(() => rssSamples.push(rssBytes()), POST_GC_SAMPLE_INTERVAL_MS)
    sampler.unref?.()

    // Exactly three dedicated workers, the existing `small` fixture, the
    // existing deadline. Nothing about extraction behaviour changes here.
    let results = await Promise.all([
      extractInWorker(load('small'), { deadlineMs: 120_000 }),
      extractInWorker(load('small'), { deadlineMs: 120_000 }),
      extractInWorker(load('small'), { deadlineMs: 120_000 }),
    ])

    clearInterval(sampler)
    sampler = null

    // READING 3, taken the moment the three promises have resolved -- which is
    // after each call's own terminateBounded() has returned.
    m.afterExitRssBytes = rssBytes()

    // SCALARS ONLY, so the results -- and with them the extracted text, the
    // timelines and the memory samples -- become collectable before the GC that
    // is the whole point of this test. Nothing large is kept for printing.
    const lifecycle = results.map((r) => ({
      ok: r.ok,
      state: r.termination.state,
      confirmedAt: r.termination.confirmedAt,
      spawnMarks: r.timeline.filter((mk) => mk.name === 'parent:spawn-requested').length,
      terminatedMarks: r.timeline.filter((mk) => mk.name === 'parent:terminated').length,
      pdfjsCleanup: r.pdfjsCleanup,
      chars: r.chars,
    }))
    m.workerCount = lifecycle.length
    results.length = 0
    results = null

    // ---- lifecycle assertions, all from the scalars above ----
    assert.equal(lifecycle.length, 3, 'expected exactly three concurrent extractions')
    for (const [i, L] of lifecycle.entries()) {
      assert.equal(L.ok, true, `worker ${i} did not extract successfully`)
      // Exit confirmed, not merely requested.
      assert.equal(L.state, 'exited', `worker ${i} exit not confirmed: state=${L.state}`)
      assert.ok(Number.isFinite(L.confirmedAt), `worker ${i} has no confirmation timestamp`)
      // Its own worker: one spawn, one termination, in its own timeline.
      assert.equal(L.spawnMarks, 1, `worker ${i} has ${L.spawnMarks} spawn marks`)
      assert.equal(L.terminatedMarks, 1, `worker ${i} has ${L.terminatedMarks} termination marks`)
    }

    // Gate for the labelling below: readings 3-5 may only be described as
    // post-termination if every worker's exit was actually confirmed.
    m.exitConfirmed = lifecycle.every((L) => L.state === 'exited' && Number.isFinite(L.confirmedAt))
    assert.equal(m.exitConfirmed, true, 'not every worker exit was confirmed')

    // READING 4 — immediately after an explicit collection.
    global.gc()
    m.afterGcRssBytes = rssBytes()
    m.afterGcHeapBytes = heapUsedBytes()

    // READING 5 — after a bounded settle, then a second pass. V8 sometimes needs
    // two collections to release what one marks.
    await new Promise((resolve) => {
      // Deliberately NOT unref'd: this timer is awaited, so it must hold the
      // event loop open until it fires. The `finally` still clears it.
      settleTimer = setTimeout(resolve, POST_GC_SETTLE_MS)
    })
    global.gc()
    m.settledRssBytes = rssBytes()
    m.settledHeapBytes = heapUsedBytes()
  } finally {
    // Both timers stopped on every path, including a thrown assertion.
    clearInterval(sampler)
    clearTimeout(settleTimer)

    const peak = rssSamples.length ? Math.max(...rssSamples) : null
    const show = (bytes) => (bytes === null ? 'n/a' : toMiB(bytes))
    // If exit was not confirmed, the later readings are NOT post-termination
    // measurements and must not be presented as such.
    const tag = m.exitConfirmed ? '' : '   [EXIT NOT CONFIRMED — not a post-termination reading]'

    console.log(`\n  M1: PROCESS-WIDE RSS, ${m.workerCount ?? '?'} concurrent workers, with forced GC (MiB)`)
    console.log(`    1 baseline, before launch          ${show(baselineRssBytes)}`)
    console.log(`    2 sampled peak during extraction   ${show(peak)}`)
    console.log(`    3 immediately after workers exited ${show(m.afterExitRssBytes)}${tag}`)
    console.log(`    4 immediately after global.gc()    ${show(m.afterGcRssBytes)}${tag}`)
    console.log(`    5 after ${POST_GC_SETTLE_MS}ms settle + 2nd gc()     ${show(m.settledRssBytes)}${tag}`)
    console.log(`    peak over baseline                 ${peak === null ? 'n/a' : toMiB(peak - baselineRssBytes)}`)
    console.log(`    samples                            ${rssSamples.length} at ${POST_GC_SAMPLE_INTERVAL_MS}ms`)
    console.log('  PARENT V8 heapUsed (MiB) — a DIFFERENT metric from rss above')
    console.log(`    baseline                           ${show(baselineHeapBytes)}`)
    console.log(`    after global.gc()                  ${show(m.afterGcHeapBytes)}`)
    console.log(`    after settle + 2nd gc()            ${show(m.settledHeapBytes)}`)
    console.log('  READ THIS CAREFULLY:')
    console.log('    Reading 2 is a SAMPLED peak, not a guaranteed instantaneous maximum.')
    console.log('    All rss figures are process-wide; worker threads share one rss and')
    console.log('    it cannot be divided per worker.')
    console.log("    Workload is 3x the 'small' fixture (0.10 MiB, 4 pages) -- this is NOT")
    console.log('    three simultaneous maximum-size uploads.')
    console.log('    Elevated rss after gc() does NOT by itself demonstrate a leak: V8 does')
    console.log('    not promptly return freed pages to the OS. A low heapUsed does NOT')
    console.log('    prove every native allocation was released either.')
    console.log('    No memory threshold is asserted, and no serverless memory limit is')
    console.log('    verified anywhere in this repository, so none is compared against.')
  }
})

// ---------------------------------------------------------------------------
// M2 — WHAT DOES ONE MAXIMUM-SIZE DOCUMENT COST?
//
// M1 measured three of the SMALLEST fixture: 46.0 MiB baseline, 221.6 MiB
// sampled peak, 194.3 MiB after two collections. That peak was dominated by a
// fixed cost -- three pdf.js instances -- not by document size, because the
// documents were 0.10 MiB each.
//
// This test changes exactly one variable: ONE worker, and the LARGEST fixture.
// Read against M1, the pair separates the two costs that were previously
// confounded. Neither number is a limit, and this test asserts no threshold.
//
// THE FIXTURE IS A WORKER STRESS TEST, NOT AN ELIGIBLE STATEMENT. mb4 extracts
// ~515,843 characters, more than ten times the approved 50,000-character
// ceiling. It exists to load the worker, and nothing here treats it as a
// document a user could submit. textBoundary.test.mjs owns eligibility.
// ---------------------------------------------------------------------------

// Import declarations are hoisted, so placing these here rather than at the top
// of the file keeps every line above byte-for-byte unchanged.
import { byKey } from './fixtures.mjs'
import { PRODUCTION_DEADLINE_MS } from './limits.mjs'

/** The existing oversized fixture. Not modified, not regenerated. */
const M2_FIXTURE_KEY = 'mb4'

test('isolation: one large PDF process RSS and post-GC', async () => {
  // Same hard requirement as M1: a silent no-op would make readings 4 and 5
  // meaningless, so this is not an optional-chained `global.gc?.()`.
  assert.equal(
    typeof global.gc,
    'function',
    'this test must run with --expose-gc; without it no collection happens and readings 4 and 5 are worthless',
  )

  const fixture = byKey(M2_FIXTURE_KEY)

  // NO COLLECTION BEFORE THE BASELINE -- the same protocol as M1, so the two
  // baselines are measured the same way and can be read against each other.
  // The cost is the same one M1 acknowledged: this floor may include
  // collectable garbage from module load and from reading a 3.7 MiB fixture.
  const baselineRssBytes = rssBytes()
  const baselineHeapBytes = heapUsedBytes()

  const rssSamples = []
  let sampler = null
  let settleTimer = null

  // Filled in as the test proceeds so the `finally` can report whatever was
  // reached, even if an assertion throws part-way through.
  const m = {
    afterExitRssBytes: null,
    afterGcRssBytes: null,
    settledRssBytes: null,
    afterGcHeapBytes: null,
    settledHeapBytes: null,
    exitConfirmed: false,
    settleOccurred: false,
    L: null,
  }

  try {
    sampler = setInterval(() => rssSamples.push(rssBytes()), POST_GC_SAMPLE_INTERVAL_MS)
    sampler.unref?.()

    // EXACTLY ONE WORKER, the existing oversized fixture, and the approved
    // production budget -- stated explicitly rather than relying on the
    // fallback, so the plan can be asserted below.
    let result = await extractInWorker(load(M2_FIXTURE_KEY), {
      deadlineMs: PRODUCTION_DEADLINE_MS,
    })

    clearInterval(sampler)
    sampler = null

    // READING 3, taken the moment the promise resolves -- which is after this
    // call's own terminateBounded() has returned.
    m.afterExitRssBytes = rssBytes()

    // SCALARS ONLY. `result.text` is ~0.5 MB of extracted characters; its
    // length is taken here and the object is dropped, so the text, the
    // timeline and the worker's memory samples are all collectable before the
    // collection this test exists to measure. Nothing large is kept to print.
    const L = {
      ok: result.ok,
      state: result.termination.state,
      confirmedAt: result.termination.confirmedAt,
      spawnMarks: result.timeline.filter((mk) => mk.name === 'parent:spawn-requested').length,
      terminatedMarks: result.timeline.filter((mk) => mk.name === 'parent:terminated').length,
      pdfjsCleanup: result.pdfjsCleanup,
      chars: result.chars,
      numPages: result.numPages,
      textLength: result.text.length,
      elapsedMs: result.elapsedMs,
      withinBudget: result.withinBudget,
      budgetMs: result.plan.budgetMs,
    }
    m.L = L
    result = null

    // ---- lifecycle assertions, all from the scalars above ----
    assert.equal(L.ok, true, 'the large extraction did not succeed')
    assert.equal(L.state, 'exited', `worker exit not confirmed: state=${L.state}`)
    assert.ok(Number.isFinite(L.confirmedAt), 'worker has no exit-confirmation timestamp')

    // ITS OWN WORKER, and exactly one of them: one spawn and one termination in
    // this call's own timeline.
    assert.equal(L.spawnMarks, 1, `expected exactly one worker, saw ${L.spawnMarks} spawn marks`)
    assert.equal(L.terminatedMarks, 1, `expected one termination, saw ${L.terminatedMarks}`)

    // EXIT IS CONFIRMED HERE, not further down.
    //
    // All four checks that establish it have now passed -- state, a finite
    // confirmation timestamp, one spawn mark and one termination mark -- and
    // each of them throws rather than falling through, so reaching this line
    // means every one of them held. Setting the flag here rather than after the
    // character assertions is what stops a later character mismatch from
    // printing `[EXIT NOT CONFIRMED]` over readings that were, in fact, taken
    // after a confirmed exit. The first M2 run mislabelled exactly that way.
    m.exitConfirmed = L.state === 'exited' && Number.isFinite(L.confirmedAt)
    assert.equal(m.exitConfirmed, true, 'the worker exit was not confirmed')

    // THIS RESULT BELONGS TO THIS DOCUMENT. Page count is a structural fact
    // about mb4. A mismatch means the result came from something other than the
    // worker that was handed these bytes -- the failure these assertions exist
    // to catch, not a memory measurement problem.
    assert.equal(L.numPages, fixture.pages, `expected ${fixture.pages} pages, got ${L.numPages}`)

    // WHICH NUMBER THE FIXTURE HOLDS, AND WHY THE FIRST RUN FAILED.
    //
    // `fixture.estimatedExtracted` is documented in fixtures.mjs as the length
    // of `r.text` -- the FULL returned string, page separators included. The
    // first M2 run compared it against `r.chars`, the content characters alone,
    // and failed by exactly the 143 separators of a 144-page document. The
    // extraction was correct; the comparison was not.
    //
    // Both expectations below are derived from the fixture metadata and the
    // measured page count. Neither count is written into this test.
    const pageSeparators = L.numPages - 1
    assert.equal(
      L.textLength,
      fixture.estimatedExtracted,
      `expected ${fixture.estimatedExtracted} returned characters for ${M2_FIXTURE_KEY}, got ${L.textLength}`,
    )
    // Pages are joined with a newline, so this is the invariant, not chars alone.
    assert.equal(
      L.textLength,
      L.chars + L.numPages - 1,
      'returned text length does not match chars plus the page joins',
    )
    // Implied by the two above, kept for the distinct diagnostic: this one names
    // the content characters rather than the full string.
    assert.equal(
      L.chars,
      fixture.estimatedExtracted - pageSeparators,
      `expected ${fixture.estimatedExtracted - pageSeparators} content characters (full text minus ${pageSeparators} separators), got ${L.chars}`,
    )

    // The approved NORMAL budget was in force -- not a test-shortened one.
    assert.equal(L.budgetMs, PRODUCTION_DEADLINE_MS, `budget was ${L.budgetMs}, not the approved total`)
    assert.equal(L.withinBudget, true, `the operation exceeded its budget: ${L.elapsedMs} ms`)

    // The worker was not force-killed: a forced termination would mean pdf.js
    // cleanup was never attempted, and readings 3-5 would describe a killed
    // process rather than a clean one.
    assert.notEqual(
      L.pdfjsCleanup,
      'not-attempted-forced-termination',
      'the worker was forcibly terminated, so this is not a clean-exit measurement',
    )

    // READING 4 — immediately after an explicit collection.
    global.gc()
    m.afterGcRssBytes = rssBytes()
    m.afterGcHeapBytes = heapUsedBytes()

    // READING 5 — after a bounded settle, then a second pass.
    await new Promise((resolve) => {
      // Deliberately NOT unref'd: this timer is awaited, so it must hold the
      // event loop open until it fires. The `finally` still clears it.
      settleTimer = setTimeout(resolve, POST_GC_SETTLE_MS)
    })
    m.settleOccurred = true
    global.gc()
    m.settledRssBytes = rssBytes()
    m.settledHeapBytes = heapUsedBytes()

    // The settle must actually have happened, or reading 5 is just reading 4.
    assert.equal(m.settleOccurred, true, 'the settling period did not complete')
  } finally {
    // Both timers stopped on every path, including a thrown assertion.
    clearInterval(sampler)
    clearTimeout(settleTimer)

    const peak = rssSamples.length ? Math.max(...rssSamples) : null
    const show = (bytes) => (bytes === null ? 'n/a' : toMiB(bytes))
    const L = m.L
    const tag = m.exitConfirmed ? '' : '   [EXIT NOT CONFIRMED — not a post-termination reading]'

    console.log(`\n  M2: PROCESS-WIDE RSS, ONE worker, fixture '${M2_FIXTURE_KEY}' (MiB)`)
    console.log(`    1 baseline, before the worker      ${show(baselineRssBytes)}`)
    console.log(`    2 sampled peak during extraction   ${show(peak)}`)
    console.log(`    3 immediately after confirmed exit ${show(m.afterExitRssBytes)}${tag}`)
    console.log(`    4 immediately after global.gc()    ${show(m.afterGcRssBytes)}${tag}`)
    console.log(`    5 after ${POST_GC_SETTLE_MS}ms settle + 2nd gc()     ${show(m.settledRssBytes)}${tag}`)
    console.log(`    peak over baseline                 ${peak === null ? 'n/a' : toMiB(peak - baselineRssBytes)}`)
    console.log(`    samples                            ${rssSamples.length} at ${POST_GC_SAMPLE_INTERVAL_MS}ms`)
    console.log('  PARENT V8 heapUsed (MiB) — a DIFFERENT metric from rss above')
    console.log(`    baseline                           ${show(baselineHeapBytes)}`)
    console.log(`    after global.gc()                  ${show(m.afterGcHeapBytes)}`)
    console.log(`    after settle + 2nd gc()            ${show(m.settledHeapBytes)}`)
    console.log('  OPERATION')
    console.log(`    document                           ${fixture.bytes} bytes, ${fixture.pages} pages`)
    console.log(`    extracted characters               ${L ? L.chars : 'n/a'}`)
    console.log(`    duration (spawn to settled)        ${L ? `${L.elapsedMs.toFixed(1)} ms` : 'n/a'}`)
    console.log(`    budget / within budget             ${L ? `${L.budgetMs} ms / ${L.withinBudget}` : 'n/a'}`)
    console.log(`    termination state                  ${L ? L.state : 'n/a'}`)
    console.log(`    pdf.js cleanup                     ${L ? L.pdfjsCleanup : 'n/a'}`)
    console.log(`    settling period completed          ${m.settleOccurred}`)
    console.log('  READ THIS CAREFULLY:')
    console.log('    Reading 2 is a SAMPLED peak, not a guaranteed instantaneous maximum.')
    console.log('    All rss figures are process-wide; the worker thread shares this')
    console.log('    process rss and its share cannot be separated out.')
    console.log(`    Workload is ONE ${M2_FIXTURE_KEY} document. It extracts far past the approved`)
    console.log('    50,000-character ceiling and is a worker stress test, NOT an eligible')
    console.log('    personal statement.')
    console.log('    Elevated rss after gc() does NOT by itself demonstrate a leak: V8 does')
    console.log('    not promptly return freed pages to the OS. A low heapUsed does NOT')
    console.log('    prove every native allocation was released either.')
    console.log('    No memory threshold is asserted, and no serverless memory limit is')
    console.log('    verified anywhere in this repository, so none is compared against.')
  }
})
