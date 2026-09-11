/**
 * What may be uploaded, decided before a byte is parsed.
 *
 * Reuses the hardening `app/api/parse-pdf` already proved in production: the
 * format is decided from the file's own SIGNATURE, not from its MIME type or
 * its name, because both are supplied by whoever is uploading. A .pdf that
 * begins with `PK` is a zip, whatever the browser called it.
 *
 * Pure and synchronous, so every refusal is unit-tested without a request.
 */

export type SourceFormat = 'pdf' | 'docx' | 'paste'

/** V1's proven cap. A resume is a few hundred kilobytes; this is generous. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

/** Pasted text ceiling. One live V1 summary is 4,214 characters; a whole
 *  resume is a few thousand more. This clears a long one by a wide margin. */
export const MAX_PASTE_CHARS = 200_000

export type UploadRefusal =
  | 'empty-file'
  | 'too-large'
  | 'unrecognised-format'
  | 'empty-text'
  | 'text-too-long'

export type UploadCheck =
  | { readonly ok: true; readonly format: SourceFormat }
  | { readonly ok: false; readonly code: UploadRefusal; readonly message: string }

const REFUSALS: Record<UploadRefusal, string> = {
  'empty-file': 'That file is empty.',
  'too-large': 'That file is larger than 15 MB. Resumes are usually well under one.',
  'unrecognised-format':
    'That does not look like a PDF or a Word document. Upload a .pdf or .docx, or paste your resume text instead.',
  'empty-text': 'There is nothing to import yet.',
  'text-too-long': 'That is longer than a resume. Paste just the resume text.',
}

function refuse(code: UploadRefusal): UploadCheck {
  return { ok: false, code, message: REFUSALS[code] }
}

/**
 * The format a file actually is.
 *
 * `%PDF-` for PDF; `PK\x03\x04` for the zip container every .docx is. A DOCX is
 * distinguished from any other zip further down, when unzipping it fails --
 * which is the honest place to find out, rather than guessing from a name.
 */
export function detectFormat(bytes: Uint8Array): SourceFormat | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
      bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'pdf'
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return 'docx'
  }
  return null
}

export function checkUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.length === 0) return refuse('empty-file')
  if (bytes.length > MAX_UPLOAD_BYTES) return refuse('too-large')
  const format = detectFormat(bytes)
  if (!format) return refuse('unrecognised-format')
  return { ok: true, format }
}

export function checkPaste(text: string): UploadCheck {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return refuse('empty-text')
  if (trimmed.length > MAX_PASTE_CHARS) return refuse('text-too-long')
  return { ok: true, format: 'paste' }
}

/**
 * A scanned PDF has pages and no text layer, so there is nothing to import.
 *
 * Refused rather than guessed at. OCR would turn a picture of a resume into
 * approximate text, and approximate text fed to an organiser forbidden to guess
 * is a contradiction -- so the applicant is told plainly and offered the paste
 * box instead.
 */
export const IMAGE_ONLY_CODE = 'image-only-pdf'
export const IMAGE_ONLY_MESSAGE =
  'This PDF is a scan — it holds a picture of your resume rather than text, so there is nothing to read out of it. Paste your resume text instead, or upload the file you originally wrote it in.'
