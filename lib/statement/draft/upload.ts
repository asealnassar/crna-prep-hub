import { MAX_EXTRACTED_CHARS, MAX_UPLOAD_BYTES, maxSavedChars } from '../extract/limits.ts'

/**
 * Importing a document into the editor, with no React and no parsing in it.
 *
 * THE PARSER IS THE SERVER'S. app/api/statement/extract/route.ts reads the
 * bytes, decides the format from its signature and returns text; nothing here
 * duplicates any of that, and no PDF or DOCX is opened in the browser. What
 * lives here is the decisions the editor has to make around that call: whether a
 * chosen file is worth sending, whether a reply may be believed, whether a reply
 * that arrived late still applies, and what a person is told when it does not
 * work.
 *
 * THE COMMITTED CONTRACT, as read from the route rather than assumed:
 *
 *   POST /api/statement/extract, multipart/form-data, ONE File in field `file`.
 *   Nothing else -- no draft id, no title, no revision. It persists nothing.
 *
 *   200 -> { format, text, characters, saveable, maxSavedCharacters,
 *            maxCharacters, pages? }   with saveable = characters <= 20,000
 *
 *   refusals carry a fixed `code`:
 *     400 empty-file | malformed-upload | no-file | too-many-files
 *     401 unauthenticated          404 not-found (the Studio gate)
 *     413 too-large                415 unrecognised-format | binary-content |
 *                                      undecodable-text | not-multipart
 *     422 image-only | password | malformed | docx-unreadable | empty-text |
 *         text-too-long
 *     499 cancelled                500 worker-failed | termination-unconfirmed
 *     503 pdf-capacity             504 deadline
 *
 * BROWSER-SAFE: the one import is limits.ts, which is bare numbers.
 */

/** The endpoint and field the committed route actually expects. */
export const EXTRACT_ENDPOINT = '/api/statement/extract'
export const EXTRACT_FIELD = 'file'

/** What the file input offers, and what the precheck accepts. */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt'] as const
export const ACCEPT_ATTRIBUTE =
  '.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain'

/**
 * Everything the import can say. Controlled strings, chosen here.
 *
 * The server's own `error` field is never read. It can carry a parser's words, a
 * Postgres message, or -- if anything ever sits between the browser and the
 * route -- prose written by someone else. The mapping below keys on `status` and
 * on the route's own closed set of `code` values and looks the message up here.
 *
 * Where two codes have genuinely the same remedy they share ONE constant rather
 * than two identical strings; where the remedy differs, so does the wording.
 */
export const IMPORT_MESSAGES = {
  /** Client precheck. */
  noFile: 'Choose one file to import.',
  oneFile: 'Import one file at a time.',
  unsupported: 'Import a PDF, a Word document (.docx) or a text file (.txt).',
  tooLarge: `That file is larger than ${(MAX_UPLOAD_BYTES / 1_000_000).toFixed(0)} MB. Choose a smaller one.`,
  emptyFile: 'That file is empty.',

  /** The document was read, but there was nothing usable in it. */
  unrecognised: 'That does not look like a PDF, a Word document or a text file.',
  notText: 'That file does not contain readable text.',
  notUtf8: 'That text file is not valid UTF-8. Save it as UTF-8 and try again.',
  imageOnly:
    'That PDF is a scan — a picture of your statement rather than text, so there is nothing to read out of it. Paste the text instead, or import the file you wrote it in.',
  password: 'That PDF is password-protected. Remove the password and import it again.',
  corrupt: 'That PDF could not be read. Try re-saving it, or paste the text instead.',
  docxUnreadable:
    'That Word document could not be read. Try re-saving it as .docx, or paste the text instead.',
  empty: 'No text could be read from that document.',
  tooLongToRead: `That document is longer than ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} characters, which is more than this editor can take in at once.`,

  /** Conditions on this side of the document. */
  timeout: 'That document took too long to read. Try a shorter one, or paste the text instead.',
  busy: 'A lot of documents are being read right now. Please try again in a moment.',
  cancelled: 'That import was cancelled.',
  expired: 'Your session expired. Sign in again, then import the file.',
  unavailable: 'Importing is not available right now.',
  server: 'Something went wrong reading that document. Please try again.',
  network: 'Could not reach the server. Please try again.',
  unreadable: 'The server sent a reply this editor could not read. Your draft is unchanged.',

  /** The two refusals that are about the draft rather than the file. */
  stale:
    'Your draft changed while the file was being processed. The import was not applied. Choose the file again if you still want to replace the essay.',
  conflicted: 'Resolve the notice above before importing a file.',
} as const

/** The route's own codes, mapped to our own words. Nothing else may choose one. */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  'empty-file': IMPORT_MESSAGES.emptyFile,
  'too-large': IMPORT_MESSAGES.tooLarge,
  'unrecognised-format': IMPORT_MESSAGES.unrecognised,
  'binary-content': IMPORT_MESSAGES.notText,
  'undecodable-text': IMPORT_MESSAGES.notUtf8,
  'pdf-capacity': IMPORT_MESSAGES.busy,
  deadline: IMPORT_MESSAGES.timeout,
  cancelled: IMPORT_MESSAGES.cancelled,
  'image-only': IMPORT_MESSAGES.imageOnly,
  password: IMPORT_MESSAGES.password,
  malformed: IMPORT_MESSAGES.corrupt,
  'docx-unreadable': IMPORT_MESSAGES.docxUnreadable,
  'worker-failed': IMPORT_MESSAGES.server,
  'termination-unconfirmed': IMPORT_MESSAGES.server,
  'empty-text': IMPORT_MESSAGES.empty,
  'text-too-long': IMPORT_MESSAGES.tooLongToRead,
  unauthenticated: IMPORT_MESSAGES.expired,
  'not-found': IMPORT_MESSAGES.unavailable,
  'no-file': IMPORT_MESSAGES.noFile,
  'too-many-files': IMPORT_MESSAGES.oneFile,
  'not-multipart': IMPORT_MESSAGES.server,
  'malformed-upload': IMPORT_MESSAGES.server,
}

/** Just enough of a File to decide on, so nothing has to be read. */
export interface ChosenFile {
  readonly name: string
  readonly size: number
}

export type FileCheck =
  | { readonly ok: true; readonly extension: string }
  | { readonly ok: false; readonly message: string }

/**
 * Whether a chosen file is worth sending.
 *
 * FOR IMMEDIATE FEEDBACK ONLY. The server decides the format from the file's
 * BYTE SIGNATURE, which is the authoritative answer and the one that cannot be
 * fooled by a renamed file; this looks at the extension, which is all that is
 * available without reading the document. A file that passes here can still be
 * refused there, and that is correct.
 *
 * THE SIZE LIMIT IS 4,000,000 BYTES, DECIMAL. Not 4 MiB. Exactly the limit the
 * route enforces, read from the same constant, so the two cannot drift.
 */
export function checkUploadFile(file: ChosenFile | null | undefined): FileCheck {
  if (file === null || file === undefined) return { ok: false, message: IMPORT_MESSAGES.noFile }

  const name = typeof file.name === 'string' ? file.name : ''
  const dot = name.lastIndexOf('.')
  const extension = dot === -1 ? '' : name.slice(dot).toLowerCase()
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return { ok: false, message: IMPORT_MESSAGES.unsupported }
  }

  const size = file.size
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return { ok: false, message: IMPORT_MESSAGES.unsupported }
  }
  if (size <= 0) return { ok: false, message: IMPORT_MESSAGES.emptyFile }
  if (size > MAX_UPLOAD_BYTES) return { ok: false, message: IMPORT_MESSAGES.tooLarge }

  return { ok: true, extension }
}

/** An extracted document the editor is willing to believe. */
export interface ExtractedDocument {
  readonly format: 'pdf' | 'docx' | 'txt'
  readonly text: string
  readonly characters: number
  /** Recomputed here, not taken on trust. */
  readonly saveable: boolean
}

export type ImportOutcome =
  | { readonly ok: true; readonly document: ExtractedDocument }
  | { readonly ok: false; readonly message: string }

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

/**
 * The extraction response, accepted only if it is genuinely a usable document.
 *
 * A 2xx IS NOT ENOUGH. Applying this replaces an essay the applicant can see and
 * cannot get back, so every field the editor uses is checked:
 *
 *   format      one of the three the route can return
 *   text        a string, non-empty (an empty one would have been `empty-text`)
 *   characters  present and equal to text.length -- a body whose own count
 *               disagrees with its own text is not one to act on
 *   length      at most MAX_EXTRACTED_CHARS. The route refuses longer documents
 *               with `text-too-long`, so a 200 claiming more is malformed. It is
 *               REFUSED, never truncated.
 *   saveable    must agree with characters <= MAX_SAVED_CHARS, which is how the
 *               route computes it. The value used downstream is recomputed here
 *               regardless, so a lying flag cannot make an oversized import look
 *               saveable.
 */
export function importOutcomeFrom(input: { status: number; body: unknown }): ImportOutcome {
  const { status, body } = input

  if (status >= 200 && status < 300) {
    const format = field(body, 'format')
    const text = field(body, 'text')
    const characters = field(body, 'characters')
    const claimed = field(body, 'saveable')

    if (format !== 'pdf' && format !== 'docx' && format !== 'txt') {
      return { ok: false, message: IMPORT_MESSAGES.unreadable }
    }
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, message: IMPORT_MESSAGES.unreadable }
    }
    if (typeof characters !== 'number' || characters !== text.length) {
      return { ok: false, message: IMPORT_MESSAGES.unreadable }
    }
    if (text.length > MAX_EXTRACTED_CHARS) {
      return { ok: false, message: IMPORT_MESSAGES.unreadable }
    }
    const saveable = text.length <= maxSavedChars()
    if (typeof claimed !== 'boolean' || claimed !== saveable) {
      return { ok: false, message: IMPORT_MESSAGES.unreadable }
    }

    return { ok: true, document: { format, text, characters: text.length, saveable } }
  }

  const code = field(body, 'code')
  if (typeof code === 'string' && code in CODE_MESSAGES) {
    return { ok: false, message: CODE_MESSAGES[code] }
  }

  // An unrecognised refusal. The status is all that is trustworthy.
  if (status === 401) return { ok: false, message: IMPORT_MESSAGES.expired }
  if (status === 404) return { ok: false, message: IMPORT_MESSAGES.unavailable }
  if (status === 413) return { ok: false, message: IMPORT_MESSAGES.tooLarge }
  return { ok: false, message: IMPORT_MESSAGES.server }
}

/** The request never arrived, so nothing was read and nothing changed. */
export const IMPORT_NETWORK_FAILURE: ImportOutcome = {
  ok: false,
  message: IMPORT_MESSAGES.network,
}

/**
 * Whether an extraction that has just come back still applies.
 *
 * FULL STRING COMPARISON, not a length comparison. An applicant who typed the
 * same number of characters they deleted has still changed their essay, and an
 * import that overwrote that would be silent data loss.
 *
 * `essayAtStart` is captured when the upload begins. If the essay is still
 * exactly that, the extracted text is this document's replacement. If it is not,
 * the applicant has written something since, and their text wins -- the result is
 * discarded, not queued and not retried.
 */
export function mayApplyImport(input: { essayAtStart: string; currentEssay: string }): boolean {
  return input.currentEssay === input.essayAtStart
}

/** What to say about an import that landed, including one too long to save. */
export interface ImportNotice {
  readonly text: string
  readonly overLimit: boolean
}

/**
 * The words for a successful import.
 *
 * An import of 20,001-50,000 characters is an APPROVED NORMAL OUTCOME, not a
 * failure: the whole document is in the editor, nothing was cut, and the only
 * thing that cannot happen yet is saving it. So the notice says how long it is,
 * what the saved maximum is, exactly how much has to go, and that saving resumes
 * by itself once it does.
 */
export function importNoticeFor(document: ExtractedDocument): ImportNotice {
  const count = document.characters.toLocaleString('en-US')
  if (document.saveable) {
    return { text: `Imported — ${count} characters. Nothing was cut.`, overLimit: false }
  }
  const excess = (document.characters - maxSavedChars()).toLocaleString('en-US')
  return {
    text:
      `Imported — ${count} characters, and nothing was cut. A saved draft holds ` +
      `${maxSavedChars().toLocaleString('en-US')} characters, so this cannot be saved yet: ` +
      `trim ${excess} and saving resumes on its own.`,
    overLimit: true,
  }
}
