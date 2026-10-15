/**
 * One uploaded document in, its text or a typed refusal out.
 *
 * This is where the three formats meet the approved limits. It is deliberately
 * separate from the route so every decision below is testable without an HTTP
 * request, a session or a multipart body.
 *
 * WHAT IT DOES NOT DO: authenticate, read a session, touch the usage ledger, call
 * a model, save anything, or write to disk. The bytes are read, turned into text,
 * and dropped.
 *
 * NOTHING IS TRUNCATED. Text over the approved ceiling is REFUSED. An applicant
 * who pasted their dissertation gets told the number to cut to, not a silently
 * shortened essay they might submit believing it complete.
 */

import { extractStatementPdf } from './extractStatementPdf.ts'
import { detectStatementFormat, decodeUtf8Strict, type StatementFormat } from './format.ts'
import { pdfCapacity, type PdfCapacity } from './capacity.ts'
import { MAX_EXTRACTED_CHARS, MAX_UPLOAD_BYTES, maxSavedChars } from './limits.ts'

/**
 * Every way this can refuse. One code per thing a caller might need to say
 * differently; none of them collapsed into a generic failure.
 */
export type DocumentRefusal =
  // Before extraction
  | 'empty-file'
  | 'too-large'
  | 'unrecognised-format'
  | 'binary-content'
  | 'undecodable-text'
  // During extraction
  | 'pdf-capacity'
  | 'deadline'
  | 'cancelled'
  | 'image-only'
  | 'password'
  | 'malformed'
  | 'worker-failed'
  | 'termination-unconfirmed'
  | 'docx-unreadable'
  // After extraction
  | 'empty-text'
  | 'text-too-long'

export interface DocumentText {
  readonly ok: true
  readonly format: StatementFormat
  /** The complete extracted text. Never truncated. */
  readonly text: string
  /** UTF-16 code units, which is what every limit in this codebase counts. */
  readonly characters: number
  /**
   * Whether this text may be SAVED as a statement, or only edited for now.
   *
   * REPORTED, NOT ENFORCED HERE. There is no saving endpoint yet. A document of
   * 20,001-50,000 characters comes back with `saveable: false` so the editor can
   * show it and say what has to happen before it can be kept.
   */
  readonly saveable: boolean
  readonly maxSavedCharacters: number
  /** PDF only. Absent for DOCX and TXT, which have no page structure here. */
  readonly pages?: number
}

export interface DocumentRefused {
  readonly ok: false
  readonly code: DocumentRefusal
  /**
   * How many characters the document actually held, when that is the reason it
   * was refused. The text itself is never carried on a refusal.
   */
  readonly characters?: number
  /**
   * A short, fixed word for diagnostics. Chosen in this codebase, never taken
   * from a parser, so it can never quote the document.
   */
  readonly detail?: string
}

export type DocumentOutcome = DocumentText | DocumentRefused

export interface ExtractDocumentOptions {
  /** Wired to the request, so a dropped connection can stop a PDF extraction. */
  signal?: AbortSignal
  /** Injectable so tests can use an isolated gate. Defaults to the process one. */
  capacity?: PdfCapacity
}

/** Maps the PDF library's failure kinds onto this module's vocabulary. */
const PDF_REFUSALS: Record<string, DocumentRefusal> = {
  deadline: 'deadline',
  cancelled: 'cancelled',
  'image-only': 'image-only',
  password: 'password',
  malformed: 'malformed',
  'worker-failed': 'worker-failed',
  'termination-unconfirmed': 'termination-unconfirmed',
}

/**
 * The ceiling, applied identically to all three formats.
 *
 * MEASURED ON THE FULL RETURNED STRING, not on a PDF's content-character count.
 * The two differ by the page separators, and what the applicant will see and edit
 * is the full string -- so that is what the limit has to be about. Using `chars`
 * here would let a long PDF slip past by the width of its page count.
 */
function finish(format: StatementFormat, text: string, pages?: number): DocumentOutcome {
  const characters = text.length

  // An empty result is not a success. For a PDF the library has already reported
  // `image-only` when a scan produced nothing; this catches a document that is
  // genuinely blank, and a .txt or .docx of whitespace.
  if (text.trim().length === 0) return { ok: false, code: 'empty-text', characters }

  if (characters > MAX_EXTRACTED_CHARS) {
    // REFUSED, NOT TRUNCATED. The count is returned so the caller can say how
    // much has to go.
    return { ok: false, code: 'text-too-long', characters }
  }

  return {
    ok: true,
    format,
    text,
    characters,
    saveable: characters <= maxSavedChars(),
    maxSavedCharacters: maxSavedChars(),
    ...(pages === undefined ? {} : { pages }),
  }
}

/** DOCX text, via the dependency the resume importer already uses. */
async function extractDocx(bytes: Uint8Array): Promise<DocumentOutcome> {
  let raw: string
  try {
    // Same dynamic-import shape as lib/resume/import/source.ts, for the same
    // reason: mammoth is CommonJS and its export lands on `.default` under ESM.
    const mammoth = await import('mammoth')
    const mod = mammoth as unknown as {
      extractRawText?: (input: { buffer: Buffer }) => Promise<{ value: string }>
      default?: { extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }> }
    }
    const run = mod.extractRawText ?? mod.default?.extractRawText
    if (!run) return { ok: false, code: 'docx-unreadable', detail: 'mammoth-unavailable' }

    // IN MEMORY. A Buffer view over the bytes already in hand; no temporary file
    // is created and the document is not stored anywhere.
    const result = await run({ buffer: Buffer.from(bytes) })
    raw = result.value
  } catch {
    // The error object is dropped unread. A document parser's message can quote
    // the document it failed on.
    return { ok: false, code: 'docx-unreadable', detail: 'parse-failed' }
  }

  // NOT sourceFromText() from the resume importer. That collapses runs of
  // whitespace and drops blank lines, which is right for a resume being mined for
  // facts and wrong for a personal statement, whose paragraph breaks are part of
  // what the applicant wrote. Only the line endings are normalised here.
  return finish('docx', raw.replace(/\r\n|\r/g, '\n'))
}

/** A PDF, through the verified worker library, holding one capacity slot. */
async function extractPdf(
  bytes: Uint8Array,
  options: ExtractDocumentOptions,
): Promise<DocumentOutcome> {
  // ---------------------------------------------------------------------------
  // THE PROLOGUE, AND WHY IT IS SEPARATE.
  //
  // Everything this function needs from `options` is read HERE, before a slot is
  // acquired and before the extractor is invoked. That placement is the whole
  // point: a throw in this block holds no capacity and cannot have started
  // anything, so there is nothing to fence and nothing to release. It is the only
  // exceptional path in this branch whose "no worker was started" status is
  // provable, and it is provable from THIS function's control flow rather than
  // from any assumption about the library's internals.
  //
  // Previously `options.signal` was read inside the call expression, below the
  // try. A hostile or exotic options object therefore threw with a slot held and
  // fenced the process, although the extractor had never been entered.
  // ---------------------------------------------------------------------------
  let gate: PdfCapacity
  let signal: AbortSignal | undefined
  try {
    gate = options.capacity ?? pdfCapacity
    signal = options.signal
  } catch {
    // No slot was taken, so no capacity disposition is required at all. The
    // exception object is dropped unread.
    return { ok: false, code: 'worker-failed', detail: 'pre-admission-failure' }
  }

  // ADMISSION. Nothing awaits between the check and the increment inside
  // tryAcquire(), which is what makes it atomic here.
  const admission = gate.tryAcquire()
  if (!admission.admitted) {
    return { ok: false, code: 'pdf-capacity', detail: admission.reason }
  }

  // The verdict decides whether the slot may be handed back. PESSIMISTIC BY
  // DEFAULT: from this line on, anything that goes wrong is treated as "worker
  // state unknown" until something proves otherwise.
  let verdict: 'exit-confirmed' | 'exit-unconfirmed' = 'exit-unconfirmed'
  try {
    const result = await extractStatementPdf(bytes, { signal })

    if (result.ok) {
      // A SUCCESS ALWAYS IMPLIES A CONFIRMED EXIT. extractStatementPdf converts an
      // unconfirmed termination into a `termination-unconfirmed` failure before it
      // can return success, so there is no success path with a live worker.
      //
      // Set BEFORE finish() runs, so a fault in this layer's own formatting cannot
      // fence a process whose worker demonstrably exited.
      verdict = 'exit-confirmed'
      return finish('pdf', result.text, result.numPages)
    }

    // On a failure the library states plainly whether the thread was confirmed
    // gone. That, and only that, decides whether the slot comes back.
    verdict = result.workerExitConfirmed ? 'exit-confirmed' : 'exit-unconfirmed'
    return {
      ok: false,
      code: PDF_REFUSALS[result.kind] ?? 'malformed',
      // A fixed word from the library, safe to log; never parser text.
      detail: result.detail,
    }
  } catch {
    // ---------------------------------------------------------------------
    // AN UNEXPECTED REJECTION FROM THE EXTRACTOR. TWO THINGS HAPPEN HERE.
    //
    // 1. IT BECOMES A VALUE. extractDocument() documents that it resolves and
    //    does not reject, and without this catch it did reject -- which would have
    //    surfaced as an unhandled 500 from the route rather than a typed refusal.
    //    The exception is dropped unread: a parser error can quote the document it
    //    failed on, so no message, stack or object crosses this boundary.
    //
    // 2. THE GATE STAYS FENCED. `verdict` is left at 'exit-unconfirmed'.
    //
    //    WHY THERE IS NO CHOICE ABOUT THIS. Execution has entered
    //    extractStatementPdf(). Its public contract is "resolves; does not
    //    reject", so a rejection is by definition outside it, and NOTHING in that
    //    contract says whether a worker was created: `workerExitConfirmed` lives
    //    only on a RESOLVED ExtractFailure and is unreachable here. Neither the
    //    speed of the failure, nor its type, nor a guess about where `new Worker()`
    //    sits inside the library is evidence. So the honest state is "unknown",
    //    and unknown fences.
    //
    //    WHAT IT COSTS: this process refuses every later PDF upload with 503 until
    //    the platform recycles it. That is accepted deliberately -- releasing a
    //    slot beside a thread that may still hold somebody's document is worse.
    //    Narrowing this would require the Phase 1 library to report whether a
    //    worker was started, which is a change to a committed, verified file and
    //    was not made.
    // ---------------------------------------------------------------------
    return { ok: false, code: 'worker-failed', detail: 'extractor-threw' }
  } finally {
    // Released only after the extraction lifecycle has completed -- this runs
    // after `extractStatementPdf` has settled, which is itself after its own
    // bounded termination has returned.
    admission.slot.release(verdict)
  }
}

/**
 * Extract the text of one uploaded document.
 *
 * Resolves; it does not reject. Every refusal is a value.
 *
 * @param bytes the whole upload, in memory. Never a path. Still readable after.
 */
export async function extractDocument(
  bytes: Uint8Array,
  options: ExtractDocumentOptions = {},
): Promise<DocumentOutcome> {
  // ---------------------------------------------------------------------------
  // THE BACKSTOP FOR THE WHOLE ENTRY PATH.
  //
  // "Resolves; it does not reject" has to be true of this function, not merely of
  // its PDF branch. Its own preamble reads `bytes.byteLength` and calls
  // detectStatementFormat() before any per-format logic runs, and those were
  // outside every catch -- so an exotic input could make extractDocument() reject,
  // which the route does not handle and which would surface as an unhandled 500
  // rather than a typed refusal. Group 2 reached exactly that, from a test Proxy.
  //
  // WHAT REACHES THIS CATCH. Only what the inner handlers do not already cover:
  // the preamble's own operations, and the DOCX/TXT branches' decoding. The PDF
  // branch catches its own faults and returns values, so its capacity decisions
  // are made before control ever arrives here -- this backstop cannot override
  // them, and in particular it cannot un-fence a gate the PDF branch fenced.
  //
  // NO CAPACITY IS INVOLVED. `gate.tryAcquire()` lives inside extractPdf(), which
  // is only reached from the dispatch below, after format detection has already
  // succeeded. A preamble failure therefore holds no slot and there is nothing to
  // release or to fence -- provable from this function's control flow, not from
  // any assumption about the worker.
  //
  // The exception is not bound, so no message, stack or object can be read,
  // returned or logged.
  // ---------------------------------------------------------------------------
  try {
    return await dispatchDocument(bytes, options)
  } catch {
    return { ok: false, code: 'worker-failed', detail: 'pre-processing-failure' }
  }
}

/** The entry path's actual work. Guarded by extractDocument() above. */
async function dispatchDocument(
  bytes: Uint8Array,
  options: ExtractDocumentOptions,
): Promise<DocumentOutcome> {
  if (bytes.byteLength === 0) return { ok: false, code: 'empty-file' }

  // THE AUTHORITATIVE SIZE CHECK, on the bytes that actually arrived. Any
  // Content-Length guard upstream is an optimisation, not this.
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, code: 'too-large', detail: String(bytes.byteLength) }
  }

  const verdict = detectStatementFormat(bytes)
  if (!verdict.ok) return { ok: false, code: verdict.code }

  switch (verdict.format) {
    case 'pdf':
      return extractPdf(bytes, options)
    case 'docx':
      return extractDocx(bytes)
    case 'txt': {
      // detectStatementFormat already decoded this successfully to classify it;
      // decoding again keeps this function honest about where the text comes from
      // rather than passing a value through the classifier's return type.
      const decoded = decodeUtf8Strict(bytes)
      if (!decoded.ok) return { ok: false, code: decoded.code }
      return finish('txt', decoded.text.replace(/\r\n|\r/g, '\n'))
    }
  }
}
