/**
 * The worker side of one dedicated PDF extraction. TEST-ONLY PROTOTYPE.
 *
 * One of these runs per upload and is never reused. When it finishes, fails or
 * is terminated, the whole isolate goes with it -- which is the entire reason
 * the dedicated design was chosen over a pool: between-applicant isolation is
 * structural here rather than dependent on a cleanup call succeeding.
 *
 * ---------------------------------------------------------------------------
 * FOUR DIFFERENCES FROM lib/pdf/extract.ts, EACH DELIBERATE
 *
 * 1. THE LOADING TASK IS KEPT. Production does `getDocument({...}).promise`
 *    and throws the task away, which makes `loadingTask.destroy()` -- the only
 *    documented way to tear down the document and its transport -- unreachable.
 *    Here the task is held so cleanup is possible at all.
 *
 * 2. streamTextContent() REPLACES getTextContent(). They are not alternatives:
 *    getTextContent() internally creates the same stream and pumps a reader it
 *    never exposes, so a caller cannot stop a page mid-way. Reading the stream
 *    directly is what makes cancellation possible between 100-item chunks
 *    instead of only between whole pages.
 *
 * 3. CANCELLATION IS CHECKED, and cleanup runs in a `finally`. Production has
 *    neither.
 *
 * 4. THE LOOP YIELDS TO THE EVENT LOOP. Checking a flag is useless if nothing
 *    can ever set it. Phase 1B measured the parent requesting cancellation at
 *    +200.7 ms and this worker carrying on for another 30 pages and 35.7 ms
 *    before completing normally -- the flag never became true. `parentPort`
 *    messages are MACROTASKS, and pdf.js's fake worker dispatches over a
 *    LoopbackPort using microtasks, so a loop that only awaits pdf.js promises
 *    drains the microtask queue forever and never lets the message handler run.
 *    `setImmediate` is the fix: see yieldToEventLoop below.
 *
 * It does NOT reproduce production's column detection, watermark filtering or
 * line reconstruction. This prototype measures worker mechanics -- startup,
 * memory, cancellation, teardown -- not extraction quality, which the eight
 * fixtures in lib/pdf/fixtures/ already cover against the real extractor.
 * ---------------------------------------------------------------------------
 */

import { parentPort, workerData } from 'node:worker_threads'

/** Absolute, comparable across processes, sub-millisecond. */
const now = () => performance.timeOrigin + performance.now()

const T_ENTRY = now()

const post = (msg) => parentPort.postMessage(msg)
const phase = (name, extra = {}) => post({ type: 'phase', phase: name, at: now(), ...extra })
const memory = (label) => post({ type: 'memory', label, at: now(), usage: process.memoryUsage() })

/**
 * Hand the event loop one full turn.
 *
 * THIS IS THE CANCELLATION FIX. `setImmediate` schedules a MACROTASK, so
 * awaiting it lets Node drain the check phase -- which is where an inbound
 * `parentPort` message is delivered. Awaiting a pdf.js promise does not: the
 * legacy build's fake worker dispatches over a LoopbackPort with microtasks, so
 * a loop built only from pdf.js awaits never returns to the event loop and the
 * message handler below never runs. That is why the flag stayed false for 30
 * pages while the parent believed it had asked the worker to stop.
 *
 * NOT A SLEEP. It adds no wall-clock delay of its own; it only surrenders the
 * turn. Nothing here waits on a timer.
 */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve))

/**
 * How many stream chunks to read between yields.
 *
 * WHY 4, AND NOT 1 OR 74. A chunk is up to 100 text items, and the measured
 * rate is ~1.58 ms per 74-page document page, so roughly 0.26 ms per chunk:
 *
 *   every item     ~500 yields per page. Absurd, and the brief rules it out.
 *   every chunk    ~6 per page, ~444 for the 2 MB fixture. Latency ~0.3 ms,
 *                  overhead ~8% of a 117 ms extraction.
 *   every 4 chunks ~1.5 per page, ~111 plus 74 page-boundary yields. Latency
 *                  ~1 ms, overhead ~2%.                              <- chosen
 *   per page only  ~1.6 ms typical, but unbounded on a single dense page.
 *
 * 4 buys a ~1 ms cancellation latency for ~2% of extraction time, against a
 * cooperative reserve of 2,000 ms in production -- three orders of magnitude of
 * headroom. The page-boundary yield below is what bounds the pathological case
 * of one page with a very large text layer, which a chunk counter alone would
 * not.
 *
 * BOTH FIGURES ABOVE ARE ESTIMATES derived from one measured run. The overhead
 * of this change has NOT been measured.
 */
const YIELD_EVERY_CHUNKS = 4

/** Set by a `cancel` message from the parent. Checked at every yield point. */
let cancelled = false
let cancelReason = null

// Registered after the helpers above so `phase` is unambiguously initialised by
// the time any message can arrive: delivery is a macrotask, and macrotasks only
// run once this module has finished evaluating.
parentPort.on('message', (msg) => {
  if (msg?.type !== 'cancel') return
  // The first request is the one that matters; a second must not re-announce.
  if (cancelled) return
  cancelled = true
  // A short, plain string or nothing. The parent sends 'deadline' or 'aborted';
  // anything longer or of another type is REJECTED rather than trimmed, because
  // this value ends up inside an error message that crosses back to the parent.
  //
  // Rejecting rather than slicing is deliberate. A control value that arrives
  // malformed should not be quietly reshaped into something plausible -- and a
  // `.slice()` here would also, correctly, be flagged by the no-truncation guard
  // in textBoundary.test.mjs, which cannot tell a bounded control string from a
  // truncated document.
  const reason = msg.reason
  cancelReason = typeof reason === 'string' && reason.length > 0 && reason.length <= 40
    ? reason
    : 'cancelled'
  // B. PROOF OF DELIVERY. The timeline previously could not distinguish "the
  // parent asked" from "the worker heard", which is exactly the ambiguity the
  // last diagnostic run could not resolve. Reason only -- no document content,
  // no buffers, no error text.
  phase('cancel-received', { reason: cancelReason })
})

class Cancelled extends Error {
  constructor(reason) {
    super(`extraction cancelled: ${reason}`)
    this.name = 'Cancelled'
  }
}

function throwIfCancelled() {
  if (cancelled) throw new Cancelled(cancelReason)
}

/**
 * A test-only stall, to exercise the path where cooperative cancellation
 * cannot work.
 *
 * Gated twice: `allowTestStall` must be set in workerData AND a positive
 * `stallMs` supplied. It busy-waits rather than sleeping, because a `setTimeout`
 * would yield to the event loop and the cancel message would arrive -- which is
 * exactly the situation this is meant NOT to be. It is a stand-in for a
 * pathological document, which Phase 0 was explicitly forbidden from creating.
 *
 * NOT A PRODUCTION CODE PATH. Nothing outside this directory imports this file.
 */
function testOnlyStall(ms) {
  if (!workerData?.allowTestStall || !(ms > 0)) return
  phase('test-stall-begin', { ms })
  const until = Date.now() + ms
  while (Date.now() < until) { /* deliberately unyielding */ }
  phase('test-stall-end')
}

async function main() {
  phase('worker-entry', { entryAt: T_ENTRY })
  memory('baseline')

  const { bytes, stallMs } = workerData
  let loadingTask = null
  let doc = null

  try {
    testOnlyStall(stallMs)
    throwIfCancelled()

    // Mirrors production's options exactly, including the two security ones.
    const mod = await import('pdfjs-dist/legacy/build/pdf.js')
    const pdfjs = mod.getDocument ? mod : mod.default
    phase('pdfjs-loaded')
    memory('after-pdfjs-load')

    throwIfCancelled()

    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      isEvalSupported: false,
      disableAutoFetch: true,
    })
    doc = await loadingTask.promise
    phase('document-loaded', { numPages: doc.numPages })
    memory('after-document-load')

    phase('extraction-started')
    const pageTexts = []
    let chars = 0

    for (let p = 1; p <= doc.numPages; p += 1) {
      // PAGE BOUNDARY YIELD. One guaranteed opportunity per page for a pending
      // `cancel` to be delivered, whatever the page's text layer looks like.
      // The check is the very next statement.
      await yieldToEventLoop()
      throwIfCancelled()
      const page = await doc.getPage(p)
      try {
        // Read the stream directly so cancellation lands between chunks.
        const reader = page.streamTextContent({ disableNormalization: false }).getReader()
        const parts = []
        let chunks = 0
        try {
          for (;;) {
            // IN-STREAM YIELD, every YIELD_EVERY_CHUNKS chunks. Placed at the
            // top of the iteration so the existing cancellation check below is
            // executed immediately after the yield, with nothing in between.
            if (chunks > 0 && chunks % YIELD_EVERY_CHUNKS === 0) await yieldToEventLoop()
            if (cancelled) {
              // Documented ReadableStream API. Tells pdfjs to stop producing.
              await reader.cancel(new Error('cancelled'))
              throw new Cancelled(cancelReason)
            }
            const { value, done } = await reader.read()
            if (done) break
            for (const item of value.items) {
              if (typeof item.str === 'string') parts.push(item.str)
            }
            chunks += 1
          }
        } finally {
          reader.releaseLock?.()
        }
        const text = parts.join(' ')
        chars += text.length
        pageTexts.push(text)
      } finally {
        // Documented: releases the page's own resources. Production never
        // calls this, which is one reason its memory is never returned early.
        page.cleanup()
      }
      if (p % 10 === 0) memory(`after-page-${p}`)
    }

    memory('peak-after-extraction')

    // C. THE LAST CHECK, BEFORE COMMITTING TO SUCCESS.
    //
    // Without it, a cancellation delivered during the final page is simply
    // dropped: the loop exits, `done` is posted, and the parent reports ok:true
    // for a run whose budget had already expired.
    //
    // NOTHING IS TRUNCATED AND NOTHING IS SILENT. There is no path here that
    // trims text -- the choice is the whole extraction or none of it. When a
    // cancel is pending the worker refuses explicitly, so the parent sees
    // ok:false with reason and errorName 'Cancelled' rather than a short
    // document presented as complete, and the phase below records that a
    // COMPLETE extraction was discarded, with counts only.
    if (cancelled) {
      phase('cancel-after-extraction', { pages: doc.numPages, chars })
      throw new Cancelled(cancelReason)
    }

    post({
      type: 'done',
      at: now(),
      numPages: doc.numPages,
      chars,
      // Joined here so the parent measures one transfer, not per-page chatter.
      text: pageTexts.join('\n'),
      // pdfjs reports pages with no text layer as an image-only scan.
      imageOnly: doc.numPages > 0 && chars === 0,
    })
  } catch (error) {
    post({
      type: 'error',
      at: now(),
      name: error?.name ?? 'Error',
      // Message only, never the object: a parser error can quote the document.
      message: String(error?.message ?? '').slice(0, 300),
      cancelled: error instanceof Cancelled,
    })
  } finally {
    // ---------------------------------------------------------------------
    // BOUNDED CLEANUP, AND AN HONEST REPORT OF IT.
    //
    // Still bounded, for the original reason: WorkerTransport.destroy() awaits
    // a Terminate round-trip that a stuck parse never answers, so the parent's
    // terminate has to remain the backstop.
    //
    // THREE THINGS CHANGED.
    //
    // 1. THE DEADLINE COMES FROM THE PARENT. It used to be a hard-coded
    //    1,000 ms, which could outlast the parent's own willingness to wait --
    //    the parent would terminate first and nothing would be gained. The
    //    parent now sends a deadline shorter than its own wait, so a cleanup
    //    that finishes on time is actually heard.
    //
    // 2. A FAILING doc.cleanup() NO LONGER SKIPS destroy(). The two calls used
    //    to sit in one async function, so a throw from the first abandoned the
    //    second -- the more important of the two, since it is what tears down
    //    the transport. Each is now attempted and recorded on its own.
    //
    // 3. THE REPORT DISTINGUISHES FINISHING FROM GIVING UP. `worker-finished`
    //    used to be emitted identically whether cleanup completed or the race
    //    timer expired, so it could not be used as evidence of anything. The
    //    race is no longer allowed to imply success: `settled` is set only by
    //    the cleanup path itself.
    //
    // STATUS WORDS ONLY. A failure records 'failed' and the error object is
    // discarded unread -- a parser error can quote the document it was parsing,
    // and no part of it belongs in a diagnostic.
    // ---------------------------------------------------------------------
    const cleanupDeadlineMs = Number.isFinite(workerData?.cleanupDeadlineMs)
      && workerData.cleanupDeadlineMs >= 0
      ? workerData.cleanupDeadlineMs
      : 450

    let docCleanup = 'absent'
    let taskDestroy = 'absent'

    const runCleanup = async () => {
      if (doc?.cleanup) {
        try { await doc.cleanup(); docCleanup = 'completed' } catch { docCleanup = 'failed' }
      }
      // Attempted regardless of how the line above went.
      if (loadingTask?.destroy) {
        try { await loadingTask.destroy(); taskDestroy = 'completed' } catch { taskDestroy = 'failed' }
      }
    }

    // `settled` is the only thing that may report completion. The timer
    // resolving the race does NOT set it, which is the whole point.
    let settledCleanup = false
    let cleanupTimer = null
    try {
      await Promise.race([
        runCleanup().then(() => { settledCleanup = true }),
        new Promise((resolve) => { cleanupTimer = setTimeout(resolve, cleanupDeadlineMs) }),
      ])
    } catch { /* runCleanup never rejects; belt and braces */ }
    clearTimeout(cleanupTimer)

    const failed = docCleanup === 'failed' || taskDestroy === 'failed'
    const cleanup = !settledCleanup ? 'timed-out' : failed ? 'failed' : 'completed'

    memory('after-cleanup')
    phase('worker-finished', { cleanup, docCleanup, taskDestroy, cleanupDeadlineMs })
  }
}

main().catch((error) => {
  post({ type: 'error', at: now(), name: 'Fatal', message: String(error?.message ?? '').slice(0, 300) })
})
