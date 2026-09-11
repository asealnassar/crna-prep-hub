/**
 * Getting readable text out of what someone uploaded, and nothing more.
 *
 * Three ways in -- a PDF, a Word document, or pasted text -- and one shape out.
 * After this module has run, NOTHING downstream knows or cares which it was,
 * which is what keeps the organiser and the verifier from growing per-format
 * branches.
 *
 * THE BYTES DO NOT SURVIVE THIS FILE. They are read, turned into lines, and
 * dropped. No copy is written anywhere: the locked decision is that originals
 * are not retained, so there is no bucket, no storage key and no deletion path
 * to get wrong. What persists is a fingerprint, which cannot be read back into
 * a document.
 */

import { createHash } from 'node:crypto'
import type { SourceFormat } from './upload.ts'

/**
 * A document reduced to numbered lines.
 *
 * Numbered because provenance needs somewhere to point: a mapped fact records
 * which line it came from, so "where did this come from?" has an answer the
 * applicant can check.
 */
export interface SourceDocument {
  readonly format: SourceFormat
  readonly lines: readonly string[]
  /** The lines rejoined. What the verifier checks a mapping against. */
  readonly text: string
  readonly fingerprint: string
}

/**
 * SHA-256 of the extracted text.
 *
 * Deliberately re-derived here rather than imported from
 * lib/gpa/transcriptEntitlement, which also carries a service-role client --
 * pulling that module into the import path would drag a service-role
 * construction into a route that must never have one. The algorithm is one
 * line of the standard library; the dependency would not have been.
 */
export function fingerprintOf(text: string): string {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * Lines, tidied but never rewritten.
 *
 * Runs of spaces collapse and empties go, because a PDF extractor emits plenty
 * of both. Nothing else is touched: the organiser has to be checkable against
 * this text, so anything altered here is something a legitimate mapping could
 * fail to match.
 */
export function linesOf(text: string): string[] {
  return String(text ?? '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line !== '')
}

export function sourceFromText(text: string, format: SourceFormat): SourceDocument {
  const lines = linesOf(text)
  const joined = lines.join('\n')
  return { format, lines, text: joined, fingerprint: fingerprintOf(joined) }
}

/**
 * A PDF's text, or a refusal.
 *
 * `imageOnly` is the extractor's own verdict and is trusted: a scan has pages
 * and no text layer, so there is genuinely nothing to import. Refusing beats
 * OCR, whose output would be approximate text handed to an organiser forbidden
 * to guess.
 */
export async function sourceFromPdf(
  bytes: Uint8Array
): Promise<{ ok: true; source: SourceDocument } | { ok: false; imageOnly: boolean }> {
  const { extractPdf } = await import('../../pdf/extract.ts')
  const result = await extractPdf(Buffer.from(bytes))
  if (result.imageOnly || result.totalLines === 0) {
    return { ok: false, imageOnly: true }
  }
  const text = result.pages.flatMap((page) => page.lines).join('\n')
  const source = sourceFromText(text, 'pdf')
  if (source.lines.length === 0) return { ok: false, imageOnly: true }
  return { ok: true, source }
}

/** A Word document's text. Styling is discarded; only the words matter. */
export async function sourceFromDocx(
  bytes: Uint8Array
): Promise<{ ok: true; source: SourceDocument } | { ok: false; imageOnly: false }> {
  const mammoth = await import('mammoth')
  const extract = (mammoth as unknown as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>
    default?: { extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }> }
  })
  const run = extract.extractRawText ?? extract.default?.extractRawText
  const { value } = await run({ buffer: Buffer.from(bytes) })
  const source = sourceFromText(value, 'docx')
  if (source.lines.length === 0) return { ok: false, imageOnly: false }
  return { ok: true, source }
}
