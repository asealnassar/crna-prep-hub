import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractDocument } from './extractDocument.ts'
import { createPdfCapacity } from './capacity.ts'
import { MAX_EXTRACTED_CHARS, MAX_SAVED_CHARS, MAX_UPLOAD_BYTES } from './limits.ts'

/**
 * One uploaded document in, its text or a typed refusal out.
 *
 * THESE TESTS SPAWN WORKERS AND PARSE PDFs. They reuse the committed synthetic
 * fixtures and build small documents in memory; no new fixture is generated and no
 * real applicant text appears anywhere.
 *
 * Every test that touches the PDF path passes its OWN capacity gate, so no test
 * can be affected by another's slot usage and none can fence the process gate.
 */

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures')
const STATEMENT_FIX = path.join(FIX, 'statement-worker')
const loadPdf = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(STATEMENT_FIX, name)))
const loadParentPdf = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(FIX, name)))
const txt = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

const SMALL_PDF = '01_statement_100kb_under_ceiling.pdf'
const MB4_PDF = '05_statement_4mb_over_ceiling.pdf'
const SCAN_PDF = '05_summit_edge_cases_scan_image_only.pdf'

/** A fresh gate per test, so slot state never leaks between them. */
const gate = () => createPdfCapacity()

/**
 * A real .docx, built in memory.
 *
 * Uses the `docx` package, which is ALREADY a production dependency and which
 * lib/resume/export/docx.test.ts already uses this way. Nothing is installed and
 * nothing is written to disk.
 */
async function makeDocx(paragraphs: readonly string[]): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, TextRun } = await import('docx')
  const doc = new Document({
    sections: [
      {
        children: paragraphs.map((text) => new Paragraph({ children: [new TextRun(text)] })),
      },
    ],
  })
  return new Uint8Array(await Packer.toBuffer(doc))
}

// ===================================================================
// Successful extraction, all three formats
// ===================================================================

test('document: a PDF extracts, reports pages, and is saveable when short enough', async () => {
  const r = await extractDocument(loadPdf(SMALL_PDF), { capacity: gate() })

  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.format, 'pdf')
  assert.equal(r.pages, 4)
  assert.ok(r.characters > 0)
  assert.equal(r.characters, r.text.length, 'characters must be the full string length')
  assert.equal(r.maxSavedCharacters, MAX_SAVED_CHARS)
  // 14k characters is under the save ceiling.
  assert.equal(r.saveable, r.characters <= MAX_SAVED_CHARS)
})

test('document: a DOCX extracts its text', async () => {
  const bytes = await makeDocx(['First paragraph of the statement.', 'Second paragraph.'])
  const r = await extractDocument(bytes, { capacity: gate() })

  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.format, 'docx')
  assert.ok(r.text.includes('First paragraph of the statement.'))
  assert.ok(r.text.includes('Second paragraph.'))
  // No page count for a Word document; it has no page structure here.
  assert.equal(r.pages, undefined)
})

test('document: DOCX BLANK LINES SURVIVE — paragraphs are not collapsed', async () => {
  // lib/resume/import/source.ts would have dropped the empty paragraph and
  // collapsed the whitespace. A statement's paragraph breaks are the applicant's.
  const bytes = await makeDocx(['Paragraph one.', '', 'Paragraph three.'])
  const r = await extractDocument(bytes, { capacity: gate() })

  assert.equal(r.ok, true)
  if (!r.ok) return
  const lines = r.text.split('\n')
  assert.ok(lines.length >= 3, `expected at least three lines, got ${lines.length}`)
  assert.ok(
    lines.some((l) => l.trim() === ''),
    'the empty paragraph was dropped',
  )
})

test('document: a TXT file extracts and PRESERVES PARAGRAPH BREAKS', async () => {
  const original = 'Opening paragraph.\n\nSecond paragraph.\n\n\nThird after two blanks.'
  const r = await extractDocument(txt(original), { capacity: gate() })

  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.format, 'txt')
  assert.equal(r.text, original, 'the text was altered')
  assert.ok(r.text.includes('\n\n\n'), 'consecutive blank lines were collapsed')
})

test('document: CRLF line endings are normalised, nothing else is', async () => {
  const r = await extractDocument(txt('One\r\n\r\nTwo\rThree'), { capacity: gate() })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.text, 'One\n\nTwo\nThree')
})

test('document: a large PDF comes back COMPLETE, then is refused for length', async () => {
  // The worker applies no ceiling; this layer refuses rather than truncating. The
  // count returned is what the applicant has to cut from.
  const r = await extractDocument(loadPdf(MB4_PDF), { capacity: gate() })

  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'text-too-long')
  assert.ok(
    r.characters !== undefined && r.characters > MAX_EXTRACTED_CHARS,
    `expected a count above ${MAX_EXTRACTED_CHARS}, got ${String(r.characters)}`,
  )
  // NOTHING WAS TRUNCATED, and no text rode along on the refusal.
  assert.equal('text' in r, false)
})

// ===================================================================
// File-size boundaries. 4,000,000 bytes, DECIMAL.
// ===================================================================

test('document: 4,000,001 bytes is refused as too-large', async () => {
  const r = await extractDocument(txt('a'.repeat(MAX_UPLOAD_BYTES + 1)), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'too-large')
})

test('document: exactly 4,000,000 bytes passes the SIZE gate', async () => {
  // It is then refused for LENGTH, which is the point: the size gate let it
  // through, so `too-large` is not what comes back.
  const r = await extractDocument(txt('a'.repeat(MAX_UPLOAD_BYTES)), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.notEqual(r.code, 'too-large', 'a file exactly at the limit must not be refused for size')
  assert.equal(r.code, 'text-too-long')
})

test('document: 3,999,999 bytes also passes the size gate', async () => {
  const r = await extractDocument(txt('a'.repeat(MAX_UPLOAD_BYTES - 1)), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.notEqual(r.code, 'too-large')
  assert.equal(r.code, 'text-too-long')
})

test('document: the limit is DECIMAL bytes, not binary — 4 MiB is refused', async () => {
  // 4 MiB is 4,194,304, which is 194,304 bytes ABOVE the approved limit. A binary
  // reading of "4 MB" would have accepted this.
  assert.ok(4 * 1024 * 1024 > MAX_UPLOAD_BYTES)
  const r = await extractDocument(txt('a'.repeat(4 * 1024 * 1024)), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'too-large')
})

test('document: an empty upload is refused before anything is parsed', async () => {
  const r = await extractDocument(new Uint8Array(0), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'empty-file')
})

// ===================================================================
// Character boundaries and save eligibility
// ===================================================================

test('document: exactly 20,000 characters is saveable', async () => {
  const r = await extractDocument(txt('a'.repeat(MAX_SAVED_CHARS)), { capacity: gate() })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.characters, 20_000)
  assert.equal(r.saveable, true)
})

test('document: 20,001 characters is returned but NOT saveable', async () => {
  // THE TEMPORARY-EDITOR BAND. Readable and editable now; not keepable yet.
  const r = await extractDocument(txt('a'.repeat(MAX_SAVED_CHARS + 1)), { capacity: gate() })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.characters, 20_001)
  assert.equal(r.saveable, false)
  assert.equal(r.maxSavedCharacters, 20_000)
  assert.equal(r.text.length, 20_001, 'the text was shortened instead of being flagged')
})

test('document: exactly 50,000 characters is still returned, and not saveable', async () => {
  const r = await extractDocument(txt('a'.repeat(MAX_EXTRACTED_CHARS)), { capacity: gate() })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.characters, 50_000)
  assert.equal(r.saveable, false)
})

test('document: 50,001 characters is REFUSED, never truncated', async () => {
  const r = await extractDocument(txt('a'.repeat(MAX_EXTRACTED_CHARS + 1)), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'text-too-long')
  assert.equal(r.characters, 50_001)
  assert.equal('text' in r, false, 'a refusal must not carry the text')
})

test('document: the ceiling counts UTF-16 code units, so surrogate pairs count twice', async () => {
  // 'ЁЯЫая╕П' style astral characters are ONE code point and TWO code units. A
  // limit measured in code points would let twice as much text through as the
  // editor and the save limit are sized for.
  const astral = '\u{1D54A}' // MATHEMATICAL DOUBLE-STRUCK CAPITAL S
  assert.equal(astral.length, 2, 'the fixture is not a surrogate pair')

  // 25,000 astral characters == 50,000 code units: exactly at the ceiling.
  const atCeiling = await extractDocument(txt(astral.repeat(25_000)), { capacity: gate() })
  assert.equal(atCeiling.ok, true)
  if (atCeiling.ok) {
    assert.equal(atCeiling.characters, 50_000)
    assert.equal(atCeiling.saveable, false)
  }

  // One more character is two more units: over.
  const overCeiling = await extractDocument(txt(astral.repeat(25_001)), { capacity: gate() })
  assert.equal(overCeiling.ok, false)
  if (!overCeiling.ok) {
    assert.equal(overCeiling.code, 'text-too-long')
    assert.equal(overCeiling.characters, 50_002)
  }
})

test('document: whitespace-only text is refused as empty, not returned as success', async () => {
  const r = await extractDocument(txt('   \n\n\t  \r\n '), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'empty-text')
})

// ===================================================================
// Refusals
// ===================================================================

test('document: an image-only PDF is refused as a scan', async () => {
  const r = await extractDocument(loadParentPdf(SCAN_PDF), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'image-only')
})

test('document: a truncated PDF is refused as malformed', async () => {
  const good = loadPdf(SMALL_PDF)
  const r = await extractDocument(good.slice(0, Math.floor(good.length / 2)), { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'malformed', `unexpected code: ${r.code}`)
})

test('document: an ARBITRARY ZIP is refused — a PK signature is not a Word document', async () => {
  // format.ts classifies this as `docx` from its signature alone. The refusal has
  // to come from mammoth failing to find a Word document inside it, which is the
  // observable behaviour this test pins.
  const arbitraryZip = new Uint8Array([
    0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...Buffer.from('this is not a word document at all', 'utf8'),
  ])
  const r = await extractDocument(arbitraryZip, { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'docx-unreadable', `unexpected code: ${r.code}`)
  // The parser's own message never rides along.
  assert.equal('text' in r, false)
})

test('document: a real zip that is not a .docx is refused the same way', async () => {
  // A structurally valid zip whose content is not WordprocessingML. Built from a
  // .docx and then corrupted inside, so the container is genuine.
  const real = await makeDocx(['Something.'])
  const corrupted = real.slice()
  // Overwrite well past the local header, inside the compressed payload.
  for (let i = 200; i < Math.min(600, corrupted.length); i += 1) corrupted[i] = 0x41
  const r = await extractDocument(corrupted, { capacity: gate() })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'docx-unreadable', `unexpected code: ${r.code}`)
})

test('document: undecodable and binary uploads are refused with their own codes', async () => {
  const malformedUtf8 = await extractDocument(new Uint8Array([0x48, 0x80, 0x81]), { capacity: gate() })
  assert.equal(malformedUtf8.ok, false)
  if (!malformedUtf8.ok) assert.equal(malformedUtf8.code, 'undecodable-text')

  const withNul = await extractDocument(
    new Uint8Array([...Buffer.from('text', 'utf8'), 0x00]),
    { capacity: gate() },
  )
  assert.equal(withNul.ok, false)
  if (!withNul.ok) assert.equal(withNul.code, 'binary-content')
})

test('document: NO refusal carries document text or internal diagnostics', async () => {
  const cases = await Promise.all([
    extractDocument(loadParentPdf(SCAN_PDF), { capacity: gate() }),
    extractDocument(txt('a'.repeat(MAX_EXTRACTED_CHARS + 1)), { capacity: gate() }),
    extractDocument(new Uint8Array([0x48, 0x80]), { capacity: gate() }),
  ])

  for (const r of cases) {
    assert.equal(r.ok, false)
    if (r.ok) continue
    // No text, and none of the worker's internals.
    for (const forbidden of ['text', 'timeline', 'memorySamples', 'errorMessage', 'plan', 'termination']) {
      assert.equal(forbidden in r, false, `${forbidden} leaked into a refusal`)
    }
    // `detail`, when present, is a short fixed word chosen in this codebase.
    if (r.detail !== undefined) {
      assert.ok(r.detail.length <= 40, `detail is too long to be a fixed word: ${r.detail.length}`)
      assert.doesNotMatch(r.detail, /\s{2,}/, 'detail looks like prose, not a code')
    }
  }
})

// ===================================================================
// Cancellation
// ===================================================================

test('document: a PDF extraction cancelled after it started is reported as cancelled', async () => {
  /*
    NO WALL-CLOCK BET. This test used to arm `setTimeout(abort, 20)` and rely on
    a 4MB extraction not finishing within 20ms. That is not a contract the
    product makes: the same fixture extracts COMPLETELY in about 500ms and is
    then refused for length, so whenever the timer lost the race the result was
    a perfectly correct `text-too-long` and the assertion on `code` failed --
    intermittently, and only ever under full-suite load.

    The abort is now ordered against the WORK rather than against a clock. The
    call is started, one macrotask is yielded so admission and worker spawn have
    happened, and the abort is then raised directly. requestStop() latches the
    outcome on the first stop it is given and extractInWorker's late-success
    gate rejects anything that arrives afterwards, so once the abort is raised
    the verdict is settled no matter how fast the worker is.

    Deterministic in-flight cancellation of a RUNNING, unyielding worker is
    covered in extractStatementPdf.test.ts using the stall hook, which this
    layer deliberately cannot reach.
  */
  const controller = new AbortController()
  const pending = extractDocument(loadPdf(MB4_PDF), {
    capacity: gate(),
    signal: controller.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()

  const r = await pending
  assert.equal(r.ok, false, 'a cancelled extraction must never be a success')
  if (r.ok) return
  assert.equal(r.code, 'cancelled')
  // No text may ride along on a cancellation, whatever the worker had read.
  assert.equal('text' in r, false)
})

test('document: an already-aborted signal is honoured', async () => {
  const r = await extractDocument(loadPdf(SMALL_PDF), {
    capacity: gate(),
    signal: AbortSignal.abort(),
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'cancelled')
})

// ===================================================================
// Capacity interaction
// ===================================================================

test('document: DOCX AND TXT NEVER OCCUPY THE PDF SLOT', async () => {
  // Neither spawns a worker or loads pdf.js, so taking the slot for them would
  // refuse a PDF upload in order to protect nothing.
  const shared = gate()

  const docx = await makeDocx(['A statement.'])
  const during: number[] = []

  const docxResult = await extractDocument(docx, { capacity: shared })
  during.push(shared.snapshot().active)
  const txtResult = await extractDocument(txt('A statement in plain text.'), { capacity: shared })
  during.push(shared.snapshot().active)

  assert.equal(docxResult.ok, true)
  assert.equal(txtResult.ok, true)
  assert.deepEqual(during, [0, 0], 'a non-PDF extraction took the PDF slot')
  assert.deepEqual(shared.snapshot(), { limit: 1, active: 0, available: 1, fenced: false })
})

test('document: a PDF returns its slot after a successful extraction', async () => {
  const shared = gate()
  const first = await extractDocument(loadPdf(SMALL_PDF), { capacity: shared })
  assert.equal(first.ok, true)
  assert.deepEqual(shared.snapshot(), { limit: 1, active: 0, available: 1, fenced: false })

  // Provable by using it again.
  const second = await extractDocument(loadPdf(SMALL_PDF), { capacity: shared })
  assert.equal(second.ok, true)
})

test('document: a PDF returns its slot after a REFUSED extraction', async () => {
  const shared = gate()
  const scan = await extractDocument(loadParentPdf(SCAN_PDF), { capacity: shared })
  assert.equal(scan.ok, false)
  // A scan is a clean worker exit, so the slot must come back.
  assert.equal(shared.snapshot().active, 0)
  assert.equal(shared.snapshot().fenced, false)
})

test('document: two simultaneous PDF requests — one runs, one is refused at capacity', async () => {
  const shared = gate()
  const [a, b] = await Promise.all([
    extractDocument(loadPdf(SMALL_PDF), { capacity: shared }),
    extractDocument(loadPdf(SMALL_PDF), { capacity: shared }),
  ])

  const refused = [a, b].filter((r) => !r.ok && r.code === 'pdf-capacity')
  const succeeded = [a, b].filter((r) => r.ok)
  assert.equal(refused.length, 1, 'expected exactly one capacity refusal')
  assert.equal(succeeded.length, 1, 'expected exactly one success')
  // The refusal says which kind of unavailability it was.
  const only = refused[0]
  if (!only.ok) assert.equal(only.detail, 'at-capacity')
  // And the gate is clean afterwards.
  assert.deepEqual(shared.snapshot(), { limit: 1, active: 0, available: 1, fenced: false })
})

test('document: concurrent DOCX and TXT requests are independent of each other', async () => {
  const shared = gate()
  const docx = await makeDocx(['Concurrent one.'])
  const results = await Promise.all([
    extractDocument(docx, { capacity: shared }),
    extractDocument(txt('Concurrent two.'), { capacity: shared }),
    extractDocument(txt('Concurrent three.'), { capacity: shared }),
  ])
  for (const [i, r] of results.entries()) assert.equal(r.ok, true, `request ${i} failed`)
  assert.equal(shared.snapshot().active, 0)
})

// ===================================================================
// UNEXPECTED EXTRACTOR EXCEPTIONS — the corrected contract
// ===================================================================

test('document: an unexpected extractor exception becomes a typed failure and FENCES', async () => {
  // THE CORRECTED CONTRACT, not a description of the old bug.
  //
  // extractDocument() documents that it resolves and does not reject. It used to
  // reject here, which would have surfaced as an unhandled 500 rather than a typed
  // refusal. It must now return `worker-failed`.
  //
  // AND THE GATE MUST STAY FENCED. Execution has entered extractStatementPdf(), and
  // the committed Phase 1 public interface offers NO evidence about whether a worker
  // was created: `workerExitConfirmed` exists only on a RESOLVED ExtractFailure and
  // is unreachable on a rejection. Neither the speed of the failure nor a guess
  // about where `new Worker()` sits inside that library is proof. So the lifecycle
  // is unknown, and unknown fences.
  //
  // This test deliberately does NOT assert release. Doing so would require knowing
  // Phase 1 internals, and narrowing it properly would require Phase 1 to report
  // whether a worker was started -- a change to a committed, verified file that was
  // not made.
  //
  // HOW THE THROW IS PROVOKED, AND WHY THE COUNT IS THREE.
  //
  // No ordinary input makes extractStatementPdf throw -- it returns failures as
  // values -- so a Proxy over real PDF bytes is used, throwing on a chosen
  // `byteLength` read. On the PDF path those reads happen in this order:
  //
  //   1  extractDocument's empty-file check
  //   2  extractDocument's size check
  //      (format detection reads .length and indices, never byteLength)
  //   3  inside extractInWorker: new ArrayBuffer(bytes.byteLength)
  //
  // Read 3 is inside extractStatementPdf, after the prologue and after admission,
  // and before `new Worker()`. Throwing there is what reaches the post-invocation
  // catch. Throwing on read 1 or 2 would instead hit extractDocument's own
  // backstop, which is a different case and is covered by the test below.
  //
  // THE RECEIVER MUST BE THE TARGET. `Reflect.get(target, prop, receiver)` with the
  // PROXY as receiver made the very first read fail with "Method get
  // TypedArray.prototype.byteLength called on incompatible receiver" -- a TypedArray
  // getter requires a receiver carrying the real internal slots, and a Proxy has
  // none. That is what broke this test in the first Group 2 run: the getter threw
  // before the counter could ever reach its threshold.
  //
  // Nothing like this can arrive from a route; it exists only to reach that path.
  const real = loadPdf(SMALL_PDF)
  let reads = 0
  const hostile = new Proxy(real, {
    get(target, prop) {
      if (prop === 'byteLength') {
        reads += 1
        if (reads >= 3) throw new Error('simulated extractor failure')
      }
      // The TARGET, not the proxy, so TypedArray getters see their own slots.
      return Reflect.get(target, prop, target)
    },
  }) as Uint8Array

  const shared = gate()
  const r = await extractDocument(hostile, { capacity: shared })

  // THE PROVOCATION LANDED WHERE IT WAS AIMED. Fewer than three reads would mean
  // the getter broke again; `extractor-threw` below is what proves it was the
  // extractor's read and not the preamble's.
  assert.ok(reads >= 3, `expected at least three byteLength reads, saw ${reads}`)

  // 1. IT RESOLVED. No rejection escaped.
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'worker-failed')
  assert.equal(r.detail, 'extractor-threw')
  // Nothing from the exception crossed the boundary.
  for (const forbidden of ['text', 'message', 'stack', 'errorMessage', 'timeline']) {
    assert.equal(forbidden in r, false, `${forbidden} leaked out of the exception path`)
  }

  // 2. FAIL CLOSED. The slot is not returned and the gate refuses by reason.
  const snap = shared.snapshot()
  assert.equal(snap.fenced, true, 'an unexplained extractor failure must fence')
  assert.equal(snap.active, 1, 'the slot must not be returned')
  const next = shared.tryAcquire()
  assert.equal(next.admitted, false)
  if (!next.admitted) assert.equal(next.reason, 'unconfirmed-worker')
})

test('document: a failure BEFORE the extractor is invoked does not fence', async () => {
  // THE ONE EXCEPTIONAL PATH WHOSE "no worker started" STATUS IS PROVABLE, and it is
  // provable from extractDocument's own control flow rather than from any knowledge
  // of Phase 1: the options are read in a prologue that runs BEFORE a slot is
  // acquired and before the extractor is called. A throw there cannot have started
  // anything because nothing had been called yet.
  //
  // `capacity` is read first and returns a real gate, so the gate is observable;
  // `signal` then throws. Before the correction this read happened inside the call
  // expression, so it fenced a process whose extractor had never been entered.
  const shared = gate()
  const hostileOptions = new Proxy(
    { capacity: shared } as { capacity: typeof shared; signal?: AbortSignal },
    {
      get(target, prop, receiver) {
        if (prop === 'signal') throw new Error('simulated pre-invocation failure')
        return Reflect.get(target, prop, receiver)
      },
    },
  )

  const r = await extractDocument(loadPdf(SMALL_PDF), hostileOptions)

  // Typed failure, not a rejection, and distinguishable from the post-invocation case.
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'worker-failed')
  assert.equal(r.detail, 'pre-admission-failure')

  // THE GATE IS UNTOUCHED: never acquired, so never fenced and nothing to release.
  assert.deepEqual(shared.snapshot(), { limit: 1, active: 0, available: 1, fenced: false })
  // And it still works.
  assert.equal(shared.tryAcquire().admitted, true)
})

test('document: a failure in the PREAMBLE is typed and consumes no capacity', async () => {
  // extractDocument's own entry path -- the size checks and format detection --
  // used to sit outside every catch, so an exotic input made the function reject
  // despite its documented "resolves; does not reject". This is the backstop.
  //
  // The throw is aimed at the FIRST byteLength read, which is the empty-file check,
  // before format detection and long before any capacity is acquired.
  const real = loadPdf(SMALL_PDF)
  const hostile = new Proxy(real, {
    get(target, prop) {
      if (prop === 'byteLength') throw new Error('simulated preamble failure')
      return Reflect.get(target, prop, target)
    },
  }) as Uint8Array

  const shared = gate()
  const r = await extractDocument(hostile, { capacity: shared })

  // Typed failure, not a rejection, and distinguishable from both other cases.
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'worker-failed')
  assert.equal(r.detail, 'pre-processing-failure')
  for (const forbidden of ['text', 'message', 'stack', 'errorMessage', 'timeline']) {
    assert.equal(forbidden in r, false, `${forbidden} leaked out of the preamble path`)
  }

  // NO CAPACITY WAS TOUCHED. tryAcquire() lives inside extractPdf(), which the
  // preamble never reached, so there is nothing to release and nothing to fence.
  assert.deepEqual(shared.snapshot(), { limit: 1, active: 0, available: 1, fenced: false })
  assert.equal(shared.tryAcquire().admitted, true)
})

test('document: the source shows the exception contract — catch, and a pessimistic default', () => {
  // The structural half, so the rules above are legible without provoking them.
  const source = readFileSync(fileURLToPath(new URL('./extractDocument.ts', import.meta.url)), 'utf8')
  const pdfBranch = source.slice(
    source.indexOf('async function extractPdf('),
    source.indexOf('export async function extractDocument'),
  )
  const code = pdfBranch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // The verdict starts pessimistic, so anything unexplained fences.
  assert.match(code, /verdict[^=]*=\s*'exit-unconfirmed'/)
  // There is now a catch around the extractor, so nothing rejects outward.
  assert.match(code, /\}\s*catch\s*\{/)
  assert.match(code, /finally\s*\{/)
  // The options are read before admission, which is what makes the pre-invocation
  // case provable. No options read may appear after the slot is taken.
  const afterAdmission = code.slice(code.indexOf('gate.tryAcquire()'))
  assert.doesNotMatch(afterAdmission, /options\./, 'an options read after admission is not provably pre-invocation')
  // The exception itself is never bound, so it cannot be logged or returned.
  assert.doesNotMatch(code, /catch\s*\(/, 'the catch must not bind the exception')

  // And the public entry path has its own backstop, so the non-throwing contract
  // covers the preamble too -- with no capacity read before the dispatch.
  const entry = source.slice(
    source.indexOf('export async function extractDocument'),
    source.indexOf('async function dispatchDocument'),
  )
  const entryCode = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(entryCode, /try\s*\{/)
  assert.match(entryCode, /\}\s*catch\s*\{/)
  assert.match(entryCode, /'pre-processing-failure'/)
  assert.doesNotMatch(entryCode, /catch\s*\(/, 'the backstop must not bind the exception')
  assert.doesNotMatch(entryCode, /tryAcquire|capacity/, 'the entry path must not touch capacity')
})
