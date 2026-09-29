import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { extractDocument, type DocumentRefusal } from '@/lib/statement/extract/extractDocument'
import { MAX_EXTRACTED_CHARS, MAX_SAVED_CHARS, MAX_UPLOAD_BYTES } from '@/lib/statement/extract/limits'

/**
 * Turn one uploaded document into text. Nothing else.
 *
 * This endpoint READS a file and returns its words. It does not analyse a
 * statement, call a model, save an essay, touch the usage ledger or write a row.
 * `/api/analyze-statement` remains the only server surface that talks to OpenAI,
 * and it is unchanged: it still takes `{ statement }` as JSON. This route exists so
 * the future Studio V2 interface can offer "upload a PDF" without the analyzer
 * having to learn about files.
 *
 * ORDER OF GATES, cheapest first, matching /api/analyze-statement's own design:
 *
 *   1. AUTHENTICATION, before the body is touched.
 *   2. CONTENT TYPE, so a JSON caller is refused before multipart parsing.
 *   3. DECLARED SIZE, from Content-Length, before the body is buffered.
 *   4. MULTIPART, exactly one file, non-empty.
 *   5. MEASURED SIZE, on the bytes that actually arrived.
 *   6. FORMAT, from the file's signature -- never its name or MIME type.
 *   7. EXTRACTION, in memory, under the approved budget and capacity gate.
 *   8. THE CHARACTER CEILING, by refusing rather than truncating.
 *
 * WHAT AUTHENTICATION CAN AND CANNOT DO HERE. The session is verified before
 * anything reads or parses the body, so an unauthenticated upload costs this
 * application no parsing and no worker. It does NOT stop the platform from
 * accepting the bytes in the first place -- by the time a route handler runs, the
 * request has arrived. No application-level check can prevent that, and none here
 * claims to.
 *
 * NO ALLOWANCE IS CONSUMED, on any path. `recordStatementAttempt` is deliberately
 * not imported. Reading a document is not analysing a statement, and a person
 * whose upload is refused has spent nothing.
 *
 * NOTHING IS LOGGED THAT COULD QUOTE A STATEMENT. No extracted text, no uploaded
 * bytes, no parser error object, no exception. The only values that ever reach a
 * log line are the fixed refusal codes below.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Multipart overhead allowance for the EARLY Content-Length guard.
 *
 * A valid 4,000,000-byte file does not arrive as 4,000,000 bytes: multipart adds
 * a boundary, part headers, a filename and CRLFs, so the body is legitimately
 * larger than the file. Guarding on the file limit alone would refuse a
 * perfectly acceptable upload, so this guard sits above it by a wide margin.
 *
 * 64 KiB is far more than any realistic single-part envelope and far less than the
 * headroom that would let a genuinely oversized file through: the authoritative
 * check is the measured byte length in extractDocument(), which uses the approved
 * limit exactly. This one only avoids buffering an obviously hopeless request.
 */
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024
const MAX_DECLARED_BODY_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE

/** The wire shape on success. `text` is complete; nothing is truncated. */
interface ExtractResponse {
  readonly format: 'pdf' | 'docx' | 'txt'
  readonly text: string
  readonly characters: number
  /** False for 20,001-50,000 characters: editable now, not keepable yet. */
  readonly saveable: boolean
  readonly maxSavedCharacters: number
  readonly maxCharacters: number
  readonly pages?: number
}

/** What the client is told, per refusal. Stable codes; no parser text anywhere. */
const REFUSALS: Record<DocumentRefusal, { status: number; message: string }> = {
  'empty-file': { status: 400, message: 'That file is empty.' },
  'too-large': {
    status: 413,
    message: `That file is larger than ${(MAX_UPLOAD_BYTES / 1_000_000).toFixed(0)} MB. Please upload a smaller one.`,
  },
  'unrecognised-format': {
    status: 415,
    message: 'That does not look like a PDF, a Word document or a text file. Upload a .pdf, .docx or .txt.',
  },
  'binary-content': {
    status: 415,
    message: 'That file does not contain readable text. Upload a .pdf, .docx or .txt.',
  },
  'undecodable-text': {
    status: 415,
    message: 'That text file is not valid UTF-8. Save it as UTF-8 and try again.',
  },
  'pdf-capacity': {
    status: 503,
    message: "We're reading a lot of documents right now. Please try again in a moment.",
  },
  deadline: {
    status: 504,
    message: 'That document took too long to read. Try a shorter one, or paste the text instead.',
  },
  cancelled: { status: 499, message: 'That upload was cancelled.' },
  'image-only': {
    status: 422,
    message:
      'This PDF is a scan — it holds a picture of your statement rather than text, so there is nothing to read out of it. Paste your statement instead, or upload the file you wrote it in.',
  },
  password: {
    status: 422,
    message: 'That PDF is password-protected. Remove the password and upload it again.',
  },
  malformed: {
    status: 422,
    message: 'That PDF could not be read. Try re-saving it, or paste the text instead.',
  },
  'docx-unreadable': {
    status: 422,
    message: 'That Word document could not be read. Try re-saving it as .docx, or paste the text instead.',
  },
  'worker-failed': { status: 500, message: 'Something went wrong reading that document. Please try again.' },
  'termination-unconfirmed': {
    status: 500,
    message: 'Something went wrong reading that document. Please try again.',
  },
  'empty-text': {
    status: 422,
    message: 'No text could be read from that document.',
  },
  'text-too-long': {
    status: 422,
    message: `That is ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} characters at most; yours is longer. Shorten it and try again.`,
  },
}

/**
 * Refusals worth a server-side line, and the ONLY ones.
 *
 * A 4xx is the caller's document being unsuitable -- normal, frequent, and not an
 * operator's problem. These four are different: they mean this process failed, or
 * refused work it should have been able to do. `termination-unconfirmed` in
 * particular fences the process against further PDF extraction (see
 * capacity.ts), and an operator who cannot see that happen cannot act on it.
 */
const LOGGED: ReadonlySet<DocumentRefusal> = new Set<DocumentRefusal>([
  'worker-failed',
  'termination-unconfirmed',
  'pdf-capacity',
  'docx-unreadable',
])

function refuse(code: DocumentRefusal, characters?: number, detail?: string): NextResponse {
  const { status, message } = REFUSALS[code]
  if (LOGGED.has(code)) {
    // CODE AND DETAIL ONLY. Both are fixed words chosen in this codebase -- never
    // extracted text, never uploaded bytes, never a parser message or an
    // exception object, any of which could quote somebody's statement.
    console.error('statement extract: refused —', code, detail ?? '')
  }
  const body: Record<string, unknown> = { error: message, code }
  // A count, when the count is the reason. Never the text.
  if (characters !== undefined) {
    body.characters = characters
    body.maxCharacters = MAX_EXTRACTED_CHARS
  }
  const headers: Record<string, string> = {}
  // Capacity is a server condition, not the caller's fault, so it says when to
  // come back rather than asking them to slow down.
  if (code === 'pdf-capacity') headers['Retry-After'] = '2'
  return NextResponse.json(body, { status, headers })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. AUTHENTICATION, before the body is read or parsed.
  const auth = await authenticateRequest()
  if (!auth) {
    return NextResponse.json(
      { error: 'You must be signed in to upload a statement.', code: 'unauthenticated' },
      { status: 401 },
    )
  }

  // 2. CONTENT TYPE. `formData()` on a JSON body throws, and a thrown parse is a
  // worse answer than a clear one.
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Upload the file as multipart form data.', code: 'not-multipart' },
      { status: 415 },
    )
  }

  // 3. DECLARED SIZE, before buffering. An honest client states its size, so an
  // honestly oversized request is refused without reading it. A liar is not
  // trusted: a missing, malformed or understated header simply falls through to
  // the measured check, which is the real control.
  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d{1,19}$/.test(declared.trim())) {
    if (Number(declared.trim()) > MAX_DECLARED_BODY_BYTES) return refuse('too-large')
  }

  // 4. MULTIPART, exactly one file.
  const form = await request.formData().catch(() => null)
  if (!form) {
    return NextResponse.json(
      { error: 'That upload could not be read. Please try again.', code: 'malformed-upload' },
      { status: 400 },
    )
  }

  const files = form.getAll('file').filter((entry): entry is File => entry instanceof File)
  if (files.length === 0) {
    return NextResponse.json(
      { error: 'No file was uploaded.', code: 'no-file' },
      { status: 400 },
    )
  }
  if (files.length > 1) {
    // Refused rather than silently picking one. Which one would be a guess, and
    // the applicant would not know which of their documents was read.
    return NextResponse.json(
      { error: 'Upload one file at a time.', code: 'too-many-files' },
      { status: 400 },
    )
  }
  const file = files[0]
  if (file.size === 0) return refuse('empty-file')
  // The reported size, checked before the bytes are pulled into memory.
  if (file.size > MAX_UPLOAD_BYTES) return refuse('too-large')

  const bytes = new Uint8Array(await file.arrayBuffer())

  // 5-8. Measured size, format from the signature, extraction, and the ceiling.
  //
  // CANCELLATION IS WIRED, WITH A CAVEAT. `request.signal` aborts when the
  // platform tells us the connection is gone, and that reaches the PDF worker's
  // cooperative cancellation. Whether a browser navigating away actually produces
  // that abort on Vercel is UNVERIFIED -- it is a platform behaviour, not
  // something this code can guarantee. The 45,000 ms budget is what bounds the
  // work when no abort ever arrives, and it is what the guarantee rests on.
  const outcome = await extractDocument(bytes, { signal: request.signal })

  if (!outcome.ok) {
    // Fixed codes only. `outcome.detail` never reaches the CLIENT -- it is a
    // server-side diagnostic word and the client has `code` -- but it is passed to
    // refuse() so a logged server fault can say which one it was.
    return refuse(outcome.code, outcome.characters, outcome.detail)
  }

  const body: ExtractResponse = {
    format: outcome.format,
    text: outcome.text,
    characters: outcome.characters,
    saveable: outcome.saveable,
    maxSavedCharacters: MAX_SAVED_CHARS,
    maxCharacters: MAX_EXTRACTED_CHARS,
    ...(outcome.pages === undefined ? {} : { pages: outcome.pages }),
  }
  return NextResponse.json(body)
}
