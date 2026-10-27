/**
 * A DELIBERATELY INSUBORDINATE WORKER. TEST-ONLY. NOT A PDF WORKER.
 *
 * WHAT IT IS FOR. The parent's late-success rejection path -- the branch in
 * finish() that builds `{ ok: false, lateSuccessRejected: true, … }` and drops
 * the extracted text -- cannot be reached with the real worker. Once worker.mjs
 * receives a `cancel` it throws at its next checkpoint and posts an `error`,
 * never a late `done`. That is the cooperative-cancellation fix working, and it
 * is precisely why the rejection branch has never executed.
 *
 * So this stub does the one thing the real worker will not: it waits to be told
 * to stop, and then answers with SUCCESS anyway.
 *
 * WHAT IT IS NOT. It parses nothing. It loads no pdf.js, opens no file, touches
 * no network and adds no dependency. Its `pdfjs-loaded` and `document-loaded`
 * phases are CLAIMS, emitted only so the parent's timeline has the shape it
 * would normally have -- nothing behind them is real. It therefore says nothing
 * about pdf.js internal cleanup, and it is NOT evidence that a real PDF worker
 * would ever ignore cancellation. It exists to exercise the PARENT.
 *
 * NO SLEEPS, NO TIMERS, NO WORKLOAD. Every step is event-driven: the startup
 * phases are emitted synchronously on entry, and the `done` message is emitted
 * from the message handler the instant the parent's `cancel` arrives. There is
 * no window to miss and no duration to tune. The parent's own deadline decides
 * when that happens.
 */

import { parentPort, workerData } from 'node:worker_threads'

/** The worker clock convention, identical to worker.mjs. */
const now = () => performance.timeOrigin + performance.now()

const post = (msg) => parentPort.postMessage(msg)
const phase = (name, extra = {}) => post({ type: 'phase', phase: name, at: now(), ...extra })

/**
 * Fictional text, invented for this test and nothing else.
 *
 * THE SENTINEL IS LOAD-BEARING. `SIMULATED-LATE-WORKER-FICTIONAL-TEXT` is
 * asserted-absent by lateSuccess.test.mjs, from both the returned result and the
 * serialised timeline. If this string changes, that assertion silently stops
 * proving anything -- so keep the sentinel even if the surrounding prose changes.
 */
const FICTIONAL_TEXT = [
  'SIMULATED-LATE-WORKER-FICTIONAL-TEXT. This passage was written by a test stub',
  'and describes no real person, no real hospital and no real patient encounter.',
  'It exists so the parent has something to refuse, and refusing it must leave no',
  'trace of these words anywhere in the result or the timeline.',
].join(' ')

const FICTIONAL_PAGES = 2

// Announce the same startup shape a real worker would, so the parent's timeline
// is comparable. Synchronous: no waiting, no timers.
phase('worker-entry', { entryAt: now() })
phase('pdfjs-loaded')
phase('document-loaded', { numPages: FICTIONAL_PAGES })
phase('extraction-started')

// Confirm the buffer arrived, by LENGTH only. The bytes are never read, never
// parsed and never echoed back.
phase('simulated-input-received', { bytes: workerData?.bytes?.byteLength ?? 0 })

parentPort.on('message', (msg) => {
  if (msg?.type !== 'cancel') return

  // Same acknowledgement the real worker emits, so the parent can see the cancel
  // was genuinely delivered rather than lost. Reason only -- and the parent's
  // reason is a short control string ('deadline' / 'aborted'), never content.
  phase('cancel-received', { reason: typeof msg.reason === 'string' ? msg.reason : 'cancelled' })

  // THE INSUBORDINATION, marked so a reader of the timeline can see it was
  // deliberate rather than a bug in the stub.
  phase('simulated-insubordinate-done')

  // A real, valid production stamp on the worker's own clock -- taken NOW, which
  // is necessarily after the parent's deadline fired, because that deadline is
  // what triggered the cancel we are answering.
  post({
    type: 'done',
    at: now(),
    numPages: FICTIONAL_PAGES,
    chars: FICTIONAL_TEXT.length,
    text: FICTIONAL_TEXT,
    imageOnly: false,
  })
})
