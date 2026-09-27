/**
 * The public surface of the statement PDF extractor.
 *
 * A route imports from HERE. `extractInWorker.ts` is reachable, but importing it
 * directly means opting into test-only controls and internal diagnostics, so
 * nothing in app/ should.
 *
 * Deliberately NOT re-exported: `extractInWorker`, `judgeSuccess`, `span`,
 * `peakHeap`, and every timeline/memory type. Tests import those from their own
 * modules by path.
 */

export {
  extractStatementPdf,
  type ExtractOutcome,
  type ExtractSuccess,
  type ExtractFailure,
  type ExtractFailureKind,
  type ExtractStatementPdfOptions,
} from './extractStatementPdf.ts'

export {
  MAX_UPLOAD_BYTES,
  MAX_EXTRACTED_CHARS,
  MAX_SAVED_CHARS,
  PRODUCTION_DEADLINE_MS,
} from './limits.ts'

export type { PdfjsCleanupStatus } from './extractInWorker.ts'
