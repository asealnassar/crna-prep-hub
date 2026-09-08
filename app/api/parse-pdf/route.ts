import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import {
  documentFingerprint, transcriptAccess, TRANSCRIPT_ALLOWANCE_CODE,
} from '@/lib/gpa/transcriptEntitlement'
import { extractPdf } from '@/lib/pdf/extract'
import { legendCandidates } from '@/lib/pdf/legend'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Transcripts are large but not unbounded. 15 MB covers a scanned 20-pager. */
const MAX_BYTES = 15 * 1024 * 1024
/** Never hang the request on a pathological document. */
const PARSE_TIMEOUT_MS = 45_000
const MAX_TEXT_CHARS = 200_000

export async function POST(request: Request): Promise<NextResponse> {
  // D60: transcript parsing is no longer Ultimate-only. Free and Premium get
  // ONE successful transcript per account, ever, and the entitlement is
  // decided from the server-side ledger -- never from the browser, and never
  // from how many analyses the user currently holds. The eligibility check
  // itself is below, once the document has been read: it is hash-aware, so
  // re-sending the SAME transcript after a failure is not a second transcript.
  const auth = await authenticateRequest()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const formData = await request.formData()
    const file = formData.get('file')

    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'File is empty' }, { status: 400 })
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: 'File is too large. The limit is 15 MB.' },
        { status: 413 }
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    // Trust the bytes, not the declared MIME type or the filename.
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return NextResponse.json({ error: 'That file is not a PDF.' }, { status: 415 })
    }

    // D28: pdfjs-dist replaces pdfreader/pdf2json, which failed with
    // "bad XRef entry" on valid ReportLab-generated PDFs.
    // D29: page and line structure is preserved rather than flattened.
    const result = await Promise.race([
      extractPdf(buffer),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), PARSE_TIMEOUT_MS)),
    ])

    if (result.imageOnly) {
      // Explicit, not silently "no coursework found".
      return NextResponse.json(
        {
          error: 'Image-only/scanned transcript detected — OCR support required.',
          imageOnly: true,
          numPages: result.numPages,
        },
        { status: 422 }
      )
    }

    if (!result.text.trim()) {
      return NextResponse.json(
        { error: 'No text could be read from that PDF.' },
        { status: 422 }
      )
    }

    const text = result.text.slice(0, MAX_TEXT_CHARS)

    // Entitlement, on the exact text this response returns, so the fingerprint
    // matches the one /api/analyze-transcript reserves against. Nothing is
    // reserved here -- reading a PDF is not analyzing a transcript, and a user
    // who never gets past this point has spent nothing.
    const access = await transcriptAccess(auth.userId, documentFingerprint(text))
    if (!access.allowed) {
      return NextResponse.json(
        access.reason === 'allowance-used'
          ? { error: 'You have already used your transcript analysis.',
              code: TRANSCRIPT_ALLOWANCE_CODE }
          : { error: 'Transcript analysis is unavailable right now.' },
        { status: access.reason === 'allowance-used' ? 403 : 503 }
      )
    }

    return NextResponse.json({
      text,
      numPages: result.numPages,
      totalLines: result.totalLines,
      // D48: grading tables read straight from the document. The analyzer is
      // asked which one applies; it never retypes these numbers.
      legendTables: legendCandidates(result).map(t => ({
        id: t.id, caption: t.caption, page: t.page,
        points: t.points, evidence: t.evidence.slice(0, 12),
      })),
    })
  } catch (error: any) {
    // Log detail server-side; return a generic message. No parser stack
    // traces or library internals reach the client.
    console.error('PDF extraction failed:', error?.message)
    const timedOut = error?.message === 'timeout'
    return NextResponse.json(
      { error: timedOut ? 'The PDF took too long to read. Try a smaller file.' : 'Could not read that PDF.' },
      { status: timedOut ? 504 : 500 }
    )
  }
}
