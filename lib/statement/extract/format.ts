/**
 * What kind of document was uploaded, decided from its BYTES.
 *
 * NOT FROM THE FILENAME, AND NOT FROM THE MIME TYPE. Both are supplied by
 * whoever is uploading. A file called `statement.pdf` that begins with `PK` is a
 * zip, and a browser will happily label anything `application/pdf`.
 *
 * WHY THIS IS NOT lib/resume/import/upload.ts. That module already proved this
 * technique in production and its signature checks are reproduced here on
 * purpose. What it cannot do for statements: its ceiling is 15 MB rather than the
 * approved 4,000,000 bytes, its third format is `paste` rather than an uploaded
 * `.txt`, and it has no text-decoding policy at all. Importing it and then
 * overriding two thirds of it would be less clear than restating the signatures,
 * and changing it is out of scope -- resume import depends on its current
 * behaviour.
 *
 * Pure and synchronous. Every refusal is decidable without a request.
 */

export type StatementFormat = 'pdf' | 'docx' | 'txt'

export type FormatRefusal =
  /** Nothing recognisable: not a PDF, not a zip, and not decodable as text. */
  | 'unrecognised-format'
  /** Decodes, but carries bytes no personal statement contains. */
  | 'binary-content'
  /** Not valid UTF-8. */
  | 'undecodable-text'

export type FormatVerdict =
  | { readonly ok: true; readonly format: StatementFormat }
  | { readonly ok: false; readonly code: FormatRefusal }

/** `%PDF-` */
function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d
  )
}

/**
 * `PK\x03\x04`, the local-file header every .docx starts with.
 *
 * 0x05 and 0x07 are also accepted, matching lib/resume/import/upload.ts: they are
 * the empty and spanned-archive variants. A zip that is not a Word document is
 * only discovered when mammoth fails to read it, which is the honest place to
 * find out rather than guessing from a name.
 */
function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  )
}

/**
 * THE UTF-8 POLICY, stated rather than implied.
 *
 *   - Strict. `fatal: true` throws on a malformed sequence instead of
 *     substituting U+FFFD. Substitution is how a mis-encoded document becomes a
 *     wall of replacement characters in somebody's editor, and that is worse than
 *     a clear refusal.
 *   - EXACTLY ONE leading UTF-8 BOM is removed, by this module and not by the
 *     decoder. `ignoreBOM: true` stops the decoder removing one as well; a second
 *     BOM, or a U+FEFF anywhere else, is content and is kept. Windows editors add
 *     one; they do not add two.
 *   - UTF-16 and other encodings are REFUSED, not converted. A .txt with a UTF-16
 *     BOM is rejected as undecodable rather than silently reinterpreted.
 *   - NUL bytes are refused. No personal statement contains one, and their
 *     presence is the clearest single signal that the upload is not text.
 *   - Other C0 control characters are counted: tab, newline and carriage return
 *     are normal, the rest are not, and a file with more than a trace of them is
 *     refused as binary.
 *
 * Nothing here truncates, normalises whitespace or drops blank lines. A personal
 * statement's paragraph breaks are part of what the applicant wrote.
 */
const BINARY_CONTROL_SHARE = 0.01

export type DecodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: Extract<FormatRefusal, 'binary-content' | 'undecodable-text'> }

export function decodeUtf8Strict(bytes: Uint8Array): DecodeResult {
  // A NUL byte settles it before any decoding is attempted.
  if (bytes.includes(0x00)) return { ok: false, code: 'binary-content' }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { ok: false, code: 'undecodable-text' }
  }

  // EXACTLY ONE LEADING BOM, and this line is the only thing that removes it.
  //
  // `ignoreBOM: true` above is what makes that true. Without it the decoder strips
  // a leading BOM itself, on top of this check -- so a file beginning with two of
  // them lost both, and a document whose genuine first character is a visible
  // U+FEFF lost it silently. Group 1 caught that.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  // Count control characters that are not tab (09), newline (0A) or return (0D).
  let control = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control += 1
    else if (code === 0x7f) control += 1
  }
  if (text.length > 0 && control / text.length > BINARY_CONTROL_SHARE) {
    return { ok: false, code: 'binary-content' }
  }

  return { ok: true, text }
}

/**
 * The format, from the bytes.
 *
 * ORDER MATTERS. The two signatures are checked first, because a PDF and a zip
 * are both byte sequences that a permissive text decoder might partially accept.
 * Only what is neither is considered as text.
 */
export function detectStatementFormat(bytes: Uint8Array): FormatVerdict {
  if (looksLikePdf(bytes)) return { ok: true, format: 'pdf' }
  if (looksLikeZip(bytes)) return { ok: true, format: 'docx' }

  const decoded = decodeUtf8Strict(bytes)
  if (!decoded.ok) {
    // An undecodable or binary file is reported as what it is, so the caller can
    // say something more useful than "unsupported".
    return { ok: false, code: decoded.code }
  }
  return { ok: true, format: 'txt' }
}
