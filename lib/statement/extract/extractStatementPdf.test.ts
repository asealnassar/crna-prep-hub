import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { extractStatementPdf } from './extractStatementPdf.ts'
import { extractInWorker } from './extractInWorker.ts'
import { MAX_EXTRACTED_CHARS, PRODUCTION_DEADLINE_MS } from './limits.ts'

/**
 * PARITY WITH THE PROTOTYPE, through the application-facing interface.
 *
 * These tests LAUNCH WORKERS AND PARSE PDFs. They reuse the committed synthetic
 * fixtures; nothing new is generated.
 *
 * WHAT IS NOT COVERED HERE, and cannot be with what the repository holds:
 *
 *   PASSWORD-PROTECTED PDFs. No encrypted fixture exists among the 13 committed
 *   PDFs -- none contains an /Encrypt dictionary -- so the 'password' failure kind
 *   and its PasswordException mapping are UNTESTED. An unmapped parser error falls
 *   through to 'malformed', so an encrypted document is still refused rather than
 *   reported as success; but the specific classification is unproven. Creating an
 *   encrypted fixture is a separate authorised step.
 *
 *   THE END-TO-END LATE-RESULT REJECTION SHAPE. The decision is covered
 *   exhaustively in judgeSuccess.test.ts. Reaching the rejection branch through a
 *   real extraction needs a worker that deliberately disobeys `cancel`, which would
 *   mean putting a test-only stub .mjs inside this production directory. Not done
 *   without a decision.
 */

const STATEMENT_FIX = path.join(process.cwd(), 'lib/pdf/fixtures/statement-worker')
const PARENT_FIX = path.join(process.cwd(), 'lib/pdf/fixtures')

const loadStatement = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(STATEMENT_FIX, name)))
const loadParent = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(PARENT_FIX, name)))

const SMALL = '01_statement_100kb_under_ceiling.pdf'
const MB4 = '05_statement_4mb_over_ceiling.pdf'
const SCAN = '05_summit_edge_cases_scan_image_only.pdf'

// Generous, because these assertions are about behaviour and not about speed. The
// budget's own ceiling still applies: planBudget clamps anything larger.
const ROOMY_MS = PRODUCTION_DEADLINE_MS

test('extract: a small statement PDF extracts successfully', async () => {
  const r = await extractStatementPdf(loadStatement(SMALL), { deadlineMs: ROOMY_MS })

  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.numPages, 4)
  assert.ok(r.chars > 0, 'no characters extracted')
  // THE TWO COUNTS ARE DIFFERENT AND BOTH ARE REPORTED. Pages are joined with a
  // newline, so the full string is longer than the content count by the separators.
  assert.equal(r.textLength, r.text.length)
  assert.equal(r.textLength, r.chars + r.numPages - 1)
  assert.ok(r.textLength > r.chars, 'page separators are missing from textLength')
  assert.equal(r.withinBudget, true)
  assert.ok(r.elapsedMs > 0 && r.elapsedMs <= PRODUCTION_DEADLINE_MS)
})

test('extract: pdf.js cleanup completes and worker exit is confirmed, separately', async () => {
  // Through the INTERNAL layer, because these are the two facts the app-facing
  // result deliberately summarises: it reports pdfjsCleanup, and it turns an
  // unconfirmed exit into a failure rather than exposing the termination object.
  const r = await extractInWorker(loadStatement(SMALL), { deadlineMs: ROOMY_MS })

  assert.equal(r.ok, true)
  // pdf.js teardown.
  assert.equal(r.pdfjsCleanup, 'completed')
  assert.equal(r.pdfjsCleanupDetail?.docCleanup, 'completed')
  assert.equal(r.pdfjsCleanupDetail?.taskDestroy, 'completed')
  // THE THREAD BEING GONE IS A DIFFERENT FACT, confirmed independently.
  assert.equal(r.termination.state, 'exited')
  assert.equal(r.termination.cleanupConfirmed, true)
  assert.ok(Number.isFinite(r.termination.confirmedAt))
  assert.equal(r.terminateError, null)
  // Its own worker: one spawn, one termination.
  assert.equal(r.timeline.filter((m) => m.name === 'parent:spawn-requested').length, 1)
  assert.equal(r.timeline.filter((m) => m.name === 'parent:terminated').length, 1)
})

test('extract: an oversized document is returned WHOLE, not truncated', async () => {
  const r = await extractStatementPdf(loadStatement(MB4), { deadlineMs: ROOMY_MS })

  assert.equal(r.ok, true)
  if (!r.ok) return
  // THE POINT OF THIS TEST. The worker applies no application ceiling, so a
  // document far past the approved limit comes back complete. Enforcing the limit
  // is the route's job, and it must REJECT rather than slice.
  assert.ok(
    r.chars > MAX_EXTRACTED_CHARS,
    `expected more than ${MAX_EXTRACTED_CHARS} characters, got ${r.chars}`,
  )
  assert.equal(r.numPages, 144)
  // No slicing anywhere: the join invariant holds exactly at this size.
  assert.equal(r.textLength, r.chars + r.numPages - 1)
  assert.equal(r.text.length, r.textLength)
  assert.equal(r.withinBudget, true)
})

test('extract: an image-only scan is a typed refusal, not empty success', async () => {
  const r = await extractStatementPdf(loadParent(SCAN), { deadlineMs: ROOMY_MS })

  assert.equal(r.ok, false)
  if (r.ok) return
  // 'ok: true, text: ""' would make "cannot read this" indistinguishable from
  // "this document is blank".
  assert.equal(r.kind, 'image-only')
  assert.equal(r.detail, 'no-text-layer')
  assert.equal(r.workerExitConfirmed, true)
})

test('extract: malformed bytes are refused with a typed failure', async () => {
  // Built IN MEMORY from a committed fixture. No new fixture file is created.
  const good = loadStatement(SMALL)
  const broken = good.slice(0, Math.floor(good.length / 2))

  const r = await extractStatementPdf(broken, { deadlineMs: ROOMY_MS })

  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.kind, 'malformed', `unexpected kind: ${r.kind} (${r.detail})`)
  // The worker must still have been cleaned up after a parse failure.
  assert.equal(r.workerExitConfirmed, true)
})

test('extract: bytes that are not a PDF at all are refused', async () => {
  const notPdf = new Uint8Array(Buffer.from('this is plainly not a PDF document', 'utf8'))

  const r = await extractStatementPdf(notPdf, { deadlineMs: ROOMY_MS })

  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.kind, 'malformed')
  assert.equal(r.workerExitConfirmed, true)
})

test('extract: no failure result carries document text or parser text', async () => {
  const r = await extractStatementPdf(loadParent(SCAN), { deadlineMs: ROOMY_MS })

  assert.equal(r.ok, false)
  if (r.ok) return
  // A failure has no `text` field at all, and its `detail` is a word this module
  // chose -- not a parser message, which can quote the document.
  assert.equal('text' in r, false)
  assert.equal('errorMessage' in r, false)
  assert.equal('timeline' in r, false)
  assert.equal('memorySamples' in r, false)
  // Everything in a failure is safe to log. A fixed, short vocabulary only.
  assert.ok(/^[a-z-]+$/.test(r.kind), `kind is not a plain word: ${r.kind}`)
  assert.ok(/^[a-z-]+$/.test(r.detail), `detail is not a plain word: ${r.detail}`)
  assert.ok(r.detail.length <= 40)
})

test('extract: an aborted extraction is reported as cancelled', async () => {
  const controller = new AbortController()
  // Abort while the large document is still being read.
  const timer = setTimeout(() => controller.abort(), 20)
  try {
    const r = await extractStatementPdf(loadStatement(MB4), {
      deadlineMs: ROOMY_MS,
      signal: controller.signal,
    })

    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.kind, 'cancelled')
    assert.equal(r.detail, 'caller-aborted')
    // Cancellation must still end in a confirmed exit.
    assert.equal(r.workerExitConfirmed, true)
    assert.equal(r.withinBudget, true)
  } finally {
    clearTimeout(timer)
  }
})

test('extract: an already-aborted signal is honoured before any work', async () => {
  const r = await extractStatementPdf(loadStatement(SMALL), {
    deadlineMs: ROOMY_MS,
    signal: AbortSignal.abort(),
  })

  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.kind, 'cancelled')
  assert.equal(r.workerExitConfirmed, true)
})

test('extract: the total budget is enforced', async () => {
  // Far too short for a 144-page document. The deadline fires, cooperative
  // cancellation runs, and the operation still answers inside its own budget.
  const r = await extractStatementPdf(loadStatement(MB4), { deadlineMs: 120 })

  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.kind, 'deadline')
  assert.equal(r.withinBudget, true, `overran its budget: ${r.elapsedMs} ms`)
  assert.ok(r.elapsedMs <= 120 + 50, `elapsed ${r.elapsedMs} ms is far past a 120 ms budget`)
  assert.equal(r.workerExitConfirmed, true)
})

test('extract: the caller keeps its buffer, and can extract from it twice', async () => {
  const bytes = loadStatement(SMALL)
  const lengthBefore = bytes.byteLength
  const firstByte = bytes[0]

  const first = await extractStatementPdf(bytes, { deadlineMs: ROOMY_MS })
  assert.equal(first.ok, true)

  // THE CALLER'S ARRAY IS NOT DETACHED. The bytes are copied before transfer, so a
  // route that retries, or reads its own input again, still has it.
  assert.equal(bytes.byteLength, lengthBefore, 'caller array was detached')
  assert.equal(bytes.buffer.byteLength, lengthBefore, 'caller ArrayBuffer was detached')
  assert.equal(bytes[0], firstByte, 'caller bytes were altered')

  // Provable by using it again and getting the same answer.
  const second = await extractStatementPdf(bytes, { deadlineMs: ROOMY_MS })
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return
  assert.equal(second.chars, first.chars)
  assert.equal(second.numPages, first.numPages)
})

test('extract: concurrent extractions are independent', async () => {
  const results = await Promise.all([
    extractStatementPdf(loadStatement(SMALL), { deadlineMs: ROOMY_MS }),
    extractStatementPdf(loadStatement(SMALL), { deadlineMs: ROOMY_MS }),
    extractStatementPdf(loadStatement(SMALL), { deadlineMs: ROOMY_MS }),
  ])

  for (const [i, r] of results.entries()) {
    assert.equal(r.ok, true, `worker ${i} did not succeed`)
    if (!r.ok) continue
    assert.equal(r.numPages, 4, `worker ${i} page count`)
    assert.equal(r.chars, (results[0] as { chars: number }).chars, `worker ${i} char count`)
  }
})

test('extract: cancelling one extraction does not disturb a concurrent one', async () => {
  const victim = new AbortController()
  const timer = setTimeout(() => victim.abort(), 15)
  try {
    const [cancelled, survivor] = await Promise.all([
      extractStatementPdf(loadStatement(MB4), { deadlineMs: ROOMY_MS, signal: victim.signal }),
      extractStatementPdf(loadStatement(SMALL), { deadlineMs: ROOMY_MS }),
    ])

    assert.equal(cancelled.ok, false)
    if (!cancelled.ok) assert.equal(cancelled.kind, 'cancelled')
    // THE NEIGHBOUR IS UNTOUCHED. One call's termination closes over its own
    // handle; there is no registry to look the wrong one up in.
    assert.equal(survivor.ok, true, 'the concurrent extraction was disturbed')
    if (survivor.ok) assert.equal(survivor.numPages, 4)
  } finally {
    clearTimeout(timer)
  }
})

test('extract: an over-ceiling deadline is clamped, never honoured as given', async () => {
  const r = await extractInWorker(loadStatement(SMALL), { deadlineMs: 10 * PRODUCTION_DEADLINE_MS })
  assert.equal(r.plan.budgetMs, PRODUCTION_DEADLINE_MS)
  assert.equal(r.plan.clampedFromMs, 10 * PRODUCTION_DEADLINE_MS)
  assert.equal(r.ok, true)
})
