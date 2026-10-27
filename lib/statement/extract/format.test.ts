import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { decodeUtf8Strict, detectStatementFormat } from './format.ts'

/**
 * Deciding what a file IS, from its bytes.
 *
 * PURE. Nothing spawns a worker or parses a document. The two real PDFs are read
 * only for their first few bytes.
 *
 * WHAT THIS FILE CANNOT SETTLE. A ZIP signature is not proof of a Word document,
 * and this module does not pretend otherwise -- it reports `docx` and leaves the
 * verdict to mammoth. The observable rejection of a non-Word zip therefore belongs
 * to extractDocument.test.ts, which is where mammoth runs.
 */

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures')
const STATEMENT_FIX = path.join(FIX, 'statement-worker')
const bytesOf = (p: string): Uint8Array => new Uint8Array(fs.readFileSync(p))
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

test('format: a real synthetic PDF is detected as pdf', () => {
  const real = bytesOf(path.join(STATEMENT_FIX, '01_statement_100kb_under_ceiling.pdf'))
  const verdict = detectStatementFormat(real)
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'pdf')
})

test('format: the %PDF- signature alone is what decides, not the rest of the file', () => {
  // Five bytes and nothing else. This is a signature test, not a validity test:
  // whether the document parses is pdf.js's answer, given later.
  const verdict = detectStatementFormat(utf8('%PDF-'))
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'pdf')
})

test('format: a truncated signature is NOT a PDF', () => {
  // Four bytes of the five. Falls through to the text path and, being printable,
  // is accepted as txt -- which is the honest answer for `%PDF`.
  const verdict = detectStatementFormat(utf8('%PDF'))
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'txt')
})

test('format: a zip local-file header is reported as docx', () => {
  const verdict = detectStatementFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'docx')
})

test('format: the empty and spanned zip variants are also reported as docx', () => {
  for (const third of [0x05, 0x07]) {
    const verdict = detectStatementFormat(new Uint8Array([0x50, 0x4b, third, 0x06]))
    assert.equal(verdict.ok, true, `PK ${third.toString(16)}`)
    if (verdict.ok) assert.equal(verdict.format, 'docx')
  }
})

test('format: A ZIP SIGNATURE IS NOT PROOF OF A WORD DOCUMENT', () => {
  // This is the limit of what signatures can tell you, stated as a test so nobody
  // later reads `format === 'docx'` as "this is a valid .docx".
  //
  // An arbitrary zip -- a photo archive, a jar, a .pages file -- carries the same
  // four bytes. It is classified `docx` here and REFUSED later, when mammoth
  // cannot find a Word document inside it. See extractDocument.test.ts.
  const arbitraryZip = new Uint8Array([
    0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...Buffer.from('not-a-word-document.bin', 'utf8'),
  ])
  const verdict = detectStatementFormat(arbitraryZip)
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'docx', 'classification is by signature only')
})

test('format: a misleading name or MIME type changes nothing — only bytes are read', () => {
  // detectStatementFormat takes bytes and nothing else. There is no parameter
  // through which a filename or a Content-Type could influence it, which is the
  // strongest form this guarantee can take.
  assert.equal(detectStatementFormat.length, 1)

  // A file a browser would happily call application/pdf, named statement.pdf:
  const zipPretendingToBePdf = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
  const asDocx = detectStatementFormat(zipPretendingToBePdf)
  assert.equal(asDocx.ok, true)
  if (asDocx.ok) assert.equal(asDocx.format, 'docx', 'a PK file is a zip, whatever it is called')

  // And the reverse: a .txt that is really a PDF.
  const pdfPretendingToBeTxt = utf8('%PDF-1.7\nsome objects')
  const asPdf = detectStatementFormat(pdfPretendingToBeTxt)
  assert.equal(asPdf.ok, true)
  if (asPdf.ok) assert.equal(asPdf.format, 'pdf')
})

test('format: plain UTF-8 prose is txt', () => {
  const verdict = detectStatementFormat(utf8('I want to become a nurse anesthetist.\n\nParagraph two.\n'))
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'txt')
})

test('format: a UTF-8 BOM is accepted and removed from the text', () => {
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('Hello.', 'utf8')])
  const verdict = detectStatementFormat(withBom)
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'txt')

  const decoded = decodeUtf8Strict(withBom)
  assert.equal(decoded.ok, true)
  if (decoded.ok) {
    assert.equal(decoded.text, 'Hello.')
    assert.equal(decoded.text.charCodeAt(0), 'H'.charCodeAt(0), 'the BOM was not stripped')
  }
})

test('format: only ONE leading BOM is stripped, and only at the start', () => {
  const twoBoms = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...Buffer.from('Hi', 'utf8')])
  const decoded = decodeUtf8Strict(twoBoms)
  assert.equal(decoded.ok, true)
  // The second survives, because it is content at that point, not an encoding mark.
  if (decoded.ok) assert.equal(decoded.text.charCodeAt(0), 0xfeff)
})

test('format: malformed UTF-8 is refused, not replaced with U+FFFD', () => {
  // A lone continuation byte. A non-fatal decoder would hand back a replacement
  // character and the applicant would see a wall of black diamonds.
  const verdict = detectStatementFormat(new Uint8Array([0x48, 0x69, 0x80, 0x81]))
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.code, 'undecodable-text')

  const decoded = decodeUtf8Strict(new Uint8Array([0xc3, 0x28]))
  assert.equal(decoded.ok, false)
  if (!decoded.ok) assert.equal(decoded.code, 'undecodable-text')
})

test('format: no U+FFFD is ever produced by a successful decode', () => {
  // The positive statement of the rule above: substitution cannot happen at all,
  // because the decoder is fatal. Anything that would need substituting is refused.
  const decoded = decodeUtf8Strict(utf8('Clean text, £ and é and 中文.'))
  assert.equal(decoded.ok, true)
  if (decoded.ok) assert.equal(decoded.text.includes('�'), false)
})

test('format: UTF-16 is refused rather than silently reinterpreted', () => {
  // UTF-16LE 'Hi' with a BOM. Its NUL bytes are caught first, which is the
  // clearest possible signal and needs no encoding sniffing.
  const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])
  const verdict = detectStatementFormat(utf16)
  assert.equal(verdict.ok, false)
  if (!verdict.ok) {
    assert.ok(
      verdict.code === 'binary-content' || verdict.code === 'undecodable-text',
      `UTF-16 must be refused, got ${verdict.code}`,
    )
  }
})

test('format: a single NUL byte is enough to refuse a file as binary', () => {
  const withNul = new Uint8Array([...Buffer.from('Looks like text', 'utf8'), 0x00])
  const verdict = detectStatementFormat(withNul)
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.code, 'binary-content')
})

test('format: a file thick with control characters is refused as binary', () => {
  // Decodes as valid UTF-8, but no personal statement contains this.
  const controls = new Uint8Array(200).fill(0x01)
  const verdict = detectStatementFormat(controls)
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.code, 'binary-content')
})

test('format: tab, newline and carriage return are NOT counted as binary', () => {
  // A statement's own structure must never be mistaken for binary content.
  const structured = utf8('Line one\r\n\tIndented\n\nBlank line above\r\n')
  const verdict = detectStatementFormat(structured)
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'txt')
})

test('format: one stray control character in a long document is tolerated', () => {
  // The threshold is a share, not a presence test: a single form feed in a long
  // essay is a quirk of somebody's word processor, not evidence of a binary.
  const body = 'a'.repeat(5_000)
  const verdict = detectStatementFormat(utf8(`${body}\f${body}`))
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'txt')
})

test('format: PARAGRAPH BREAKS SURVIVE DECODING', () => {
  // The decoder must not normalise whitespace. A personal statement's blank lines
  // are part of what the applicant wrote, and lib/resume/import/source.ts would
  // have removed them -- which is exactly why it is not used here.
  const original = 'First paragraph.\n\nSecond paragraph.\n\n\nThird after two blanks.'
  const decoded = decodeUtf8Strict(utf8(original))
  assert.equal(decoded.ok, true)
  if (decoded.ok) {
    assert.equal(decoded.text, original)
    assert.equal((decoded.text.match(/\n/g) ?? []).length, 5)
    assert.ok(decoded.text.includes('\n\n\n'), 'consecutive blank lines were collapsed')
  }
})

test('format: an empty file decodes to empty text rather than throwing', () => {
  const decoded = decodeUtf8Strict(new Uint8Array(0))
  assert.equal(decoded.ok, true)
  if (decoded.ok) assert.equal(decoded.text, '')
  // Classification succeeds; extractDocument is what refuses an empty upload.
  const verdict = detectStatementFormat(new Uint8Array(0))
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'txt')
})

test('format: signatures are checked before the text path', () => {
  // Order matters: a PDF's header bytes are printable ASCII, so a text-first
  // implementation would classify every PDF as txt.
  const pdfHeader = bytesOf(path.join(STATEMENT_FIX, '05_statement_4mb_over_ceiling.pdf')).slice(0, 64)
  const verdict = detectStatementFormat(pdfHeader)
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.format, 'pdf')
})
