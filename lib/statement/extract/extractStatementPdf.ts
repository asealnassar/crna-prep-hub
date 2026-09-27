/**
 * THE INTERFACE A ROUTE CALLS. One PDF in, text or a typed refusal out.
 *
 * WHAT THIS LAYER IS FOR. extractInWorker.ts is the verified machinery, and it
 * carries things a request handler must not have: a `stallMs` busy-wait, a
 * `__testWorkerUrl` worker override, full timelines, worker memory samples, and
 * parser error messages that can quote the document being parsed. This module is
 * the narrow door. It takes three production inputs and returns a discriminated
 * union with no internal diagnostics in it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - No character ceiling. The worker returns the COMPLETE text and so does this.
 *     The approved 50,000-character limit is the route's to enforce, by REJECTING,
 *     never by truncating. `MAX_EXTRACTED_CHARS` in limits.ts is there to be read.
 *   - No upload-size check. `MAX_UPLOAD_BYTES` must be applied before a byte is
 *     buffered, which is a thing only the route can do, from Content-Length.
 *   - No format dispatch. PDF only. DOCX and TXT are a separate, unapproved step.
 *   - No concurrency limit. Each call spawns its own worker; nothing here caps how
 *     many. A cap is a separately approved integration decision.
 *   - No logging, of anything. See NEVER LOG below.
 *   - No authentication, entitlement or usage accounting.
 *
 * NEVER LOG. `failure.detail` exists so a route can branch, and it is a fixed set
 * of words this module chooses -- not parser text. The parser's own message is
 * dropped here and never reaches the caller, because an error raised while parsing
 * a personal statement can quote that statement. If a route wants to log anything
 * about a failure, `kind` and `detail` are the only two values it may use. The
 * extracted text, the document bytes and the parser's error object must never
 * appear in a log line.
 *
 * THE CALLER'S BUFFER SURVIVES. The bytes are copied before transfer, so the
 * `Uint8Array` a route passes in is still readable afterwards.
 */

import {
  extractInWorker,
  type PdfjsCleanupStatus,
  type WorkerResult,
} from './extractInWorker.ts'
import { PRODUCTION_DEADLINE_MS } from './limits.ts'

/**
 * Why an extraction did not produce text.
 *
 * EVERY ONE OF THESE IS A DIFFERENT THING FOR A ROUTE TO SAY, which is why they
 * are not collapsed into one 'failed':
 *
 *   deadline      the 45,000 ms total budget expired      -> 504
 *   cancelled     the caller aborted, e.g. navigation     -> no response needed
 *   image-only    a scan with no text layer; no OCR       -> 422, explain
 *   password      the document is encrypted               -> 422, explain
 *   malformed     not a readable PDF                      -> 422, explain
 *   worker-failed the worker itself failed to run         -> 500
 *   termination-unconfirmed
 *                 text may exist but the worker could not be confirmed gone.
 *                 Treated as a FAILURE on purpose: see below.
 */
export type ExtractFailureKind =
  | 'deadline'
  | 'cancelled'
  | 'image-only'
  | 'password'
  | 'malformed'
  | 'worker-failed'
  | 'termination-unconfirmed'

export interface ExtractSuccess {
  readonly ok: true
  /** The COMPLETE extracted text. Unbounded; the route decides eligibility. */
  readonly text: string
  /** Content characters. NOT text.length, which also counts page separators. */
  readonly chars: number
  /** text.length === chars + numPages - 1. Provided so nobody has to re-derive it. */
  readonly textLength: number
  readonly numPages: number
  /** How long the whole operation took, against the budget. */
  readonly elapsedMs: number
  readonly withinBudget: boolean
  /** pdf.js teardown. Distinct from worker exit, which is confirmed separately. */
  readonly pdfjsCleanup: PdfjsCleanupStatus
}

export interface ExtractFailure {
  readonly ok: false
  readonly kind: ExtractFailureKind
  /**
   * A short, fixed word chosen by THIS module, safe to log and safe to branch on.
   * Never parser text, never document content.
   */
  readonly detail: string
  readonly elapsedMs: number
  readonly withinBudget: boolean
  readonly pdfjsCleanup: PdfjsCleanupStatus
  /**
   * True when the worker thread could not be confirmed gone. A route should treat
   * this as serious regardless of `kind`.
   */
  readonly workerExitConfirmed: boolean
  /**
   * Counts only, when a result arrived too late and was thrown away. The text is
   * never carried; that is the whole point of the late-result gate.
   */
  readonly rejectedChars?: number
  readonly rejectedNumPages?: number
}

export type ExtractOutcome = ExtractSuccess | ExtractFailure

export interface ExtractStatementPdfOptions {
  /**
   * TOTAL budget for the whole operation. Defaults to, and is capped at, the
   * approved PRODUCTION_DEADLINE_MS. It cannot be disabled.
   */
  deadlineMs?: number
  /** Abort the extraction -- a closed browser, a cancelled request. */
  signal?: AbortSignal
}

/** pdf.js error names that mean the document is encrypted. */
const PASSWORD_ERROR_NAMES = new Set(['PasswordException'])

/**
 * pdf.js error names that mean the bytes are not a document this parser can read.
 *
 * NOT VERIFIED AGAINST A FIXTURE. These names are taken from pdfjs-dist's public
 * error classes; no committed fixture exercises them, so the MAPPING is untested
 * even though the fallback below is safe. A name that is not listed lands on
 * 'malformed' anyway, so an unmapped parser error is still refused rather than
 * reported as success -- it just carries a less specific `detail`.
 */
const MALFORMED_ERROR_NAMES = new Set([
  'InvalidPDFException',
  'MissingPDFException',
  'UnexpectedResponseException',
  'FormatError',
])

function classifyFailure(result: Extract<WorkerResult, { ok: false }>): {
  kind: ExtractFailureKind
  detail: string
} {
  // A recorded stop beats an error name: if the budget expired, that is the fact
  // the route needs, whatever the parser said on its way out.
  if (result.reason === 'deadline') {
    return {
      kind: 'deadline',
      detail: result.lateSuccessRejected ? 'result-arrived-after-deadline' : 'budget-expired',
    }
  }
  if (result.reason === 'aborted' || result.reason === 'cancelled') {
    return { kind: 'cancelled', detail: 'caller-aborted' }
  }
  if (result.reason === 'worker-error' || result.reason === 'exited') {
    return { kind: 'worker-failed', detail: `worker-${result.reason}` }
  }

  const name = result.errorName ?? ''
  if (PASSWORD_ERROR_NAMES.has(name)) return { kind: 'password', detail: 'encrypted' }
  if (MALFORMED_ERROR_NAMES.has(name)) return { kind: 'malformed', detail: 'unreadable-pdf' }

  // Unknown parser error. Refused, with a `detail` that says only that -- the
  // parser's own message is dropped and is not carried into the result.
  return { kind: 'malformed', detail: 'parser-error' }
}

/**
 * Extract the text of one PDF in a dedicated worker.
 *
 * Resolves; it does not reject. Every failure is a value.
 *
 * @param bytes the PDF, in memory. Never a path. Still readable when this returns.
 */
export async function extractStatementPdf(
  bytes: Uint8Array,
  options: ExtractStatementPdfOptions = {},
): Promise<ExtractOutcome> {
  const result = await extractInWorker(bytes, {
    // Only these two cross over. No stall, no worker override, no grace override,
    // no resourceLimits -- a route has no business setting any of them.
    deadlineMs: options.deadlineMs ?? PRODUCTION_DEADLINE_MS,
    signal: options.signal,
  })

  const common = {
    elapsedMs: result.elapsedMs,
    withinBudget: result.withinBudget,
    pdfjsCleanup: result.pdfjsCleanup,
  }

  if (!result.ok) {
    const { kind, detail } = classifyFailure(result)
    return {
      ok: false,
      kind,
      detail,
      ...common,
      workerExitConfirmed: result.termination.cleanupConfirmed,
      ...(result.rejectedChars === undefined ? {} : { rejectedChars: result.rejectedChars }),
      ...(result.rejectedNumPages === undefined
        ? {}
        : { rejectedNumPages: result.rejectedNumPages }),
    }
  }

  // A SCAN IS NOT A SUCCESS. The worker reports `imageOnly` when a document has
  // pages but no text layer, and returns an empty string with it. Handing a route
  // `ok: true, text: ''` would make "we cannot read this" indistinguishable from
  // "this document is blank", and the route would have to re-derive the difference.
  if (result.imageOnly) {
    return {
      ok: false,
      kind: 'image-only',
      detail: 'no-text-layer',
      ...common,
      workerExitConfirmed: result.termination.cleanupConfirmed,
    }
  }

  // AN UNCONFIRMED WORKER EXIT IS REPORTED AS A FAILURE, even though text exists.
  //
  // This is a deliberate choice and it is the one place this layer is stricter than
  // extractInWorker.ts. A thread that `terminate()` could not confirm dead may
  // still be running, still holding the document, inside a process that is about to
  // serve somebody else. Returning the text would make that invisible to the route.
  // The counts are carried so a route can log that text existed, without the text.
  if (!result.termination.cleanupConfirmed) {
    return {
      ok: false,
      kind: 'termination-unconfirmed',
      detail: `termination-${result.termination.state}`,
      ...common,
      workerExitConfirmed: false,
      rejectedChars: result.chars,
      rejectedNumPages: result.numPages,
    }
  }

  return {
    ok: true,
    text: result.text,
    chars: result.chars,
    textLength: result.text.length,
    numPages: result.numPages,
    ...common,
  }
}
