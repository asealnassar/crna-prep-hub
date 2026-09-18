'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleCheck, ClipboardPaste, Lock, Upload } from 'lucide-react'
import { MAX_UPLOAD_BYTES } from '@/lib/resume/import/upload'
import { Button, Card, TextAreaField, buttonClass, cx, text as tokens } from '../ui'
import ImportReview from './ImportReview'
import type { ImportReviewData } from './ImportReview'

/**
 * Upload an existing resume, or paste it.
 *
 * The paste box is not a consolation prize. A scanned PDF holds a picture of a
 * resume, and no amount of OCR turns that into facts we would be willing to put
 * on someone's application — so the honest path is to say so and let them give
 * us the text directly. It is also the fastest route for anyone whose resume
 * lives in a format we do not read.
 *
 * NOTHING IS KEPT. The file is read on the server, turned into text, and
 * dropped. This component says so, because a person handing over their
 * employment history deserves to know what happens to it.
 */

const ENDPOINT = '/api/resume-v2/import'

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly what: string }
  | { readonly kind: 'refused'; readonly message: string; readonly offerPaste: boolean }
  /** Analysed, nothing created. The applicant decides from here. */
  | { readonly kind: 'reviewing'; readonly review: ImportReviewData }
  | { readonly kind: 'creating'; readonly review: ImportReviewData }

export default function UploadTile({
  onImported,
  onExpandedChange,
}: {
  onImported?: () => void
  /** True while the paste box or a review needs more room than a side column. Presentation only. */
  onExpandedChange?: (expanded: boolean) => void
}) {
  const router = useRouter()
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [pasting, setPasting] = useState(false)
  const [text, setText] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)

  const send = useCallback(async (init: RequestInit, what: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setState({ kind: 'working', what })
    try {
      const res = await fetch(ENDPOINT, init)
      const body = await res.json().catch(() => ({} as Record<string, unknown>))

      if (res.ok && body.duplicate && typeof body.resumeId === 'string') {
        router.push(`/resume-studio/${body.resumeId}`)
        return
      }
      if (res.ok && body.review) {
        // Analysed only. Nothing exists yet.
        setState({ kind: 'reviewing', review: body.review as ImportReviewData })
        return
      }

      const message = typeof body.message === 'string'
        ? body.message
        : res.status === 429
          ? 'Too many requests just now. Please try again shortly.'
          : 'That could not be imported.'
      // A scan, or a format we cannot read, is exactly when the paste box helps.
      setState({ kind: 'refused', message, offerPaste: res.status === 400 || res.status === 422 })
    } catch {
      setState({ kind: 'refused', message: 'Could not reach the server.', offerPaste: false })
    } finally {
      inFlight.current = false
    }
  }, [router, onImported])

  const upload = useCallback((file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      setState({ kind: 'refused', message: 'That file is larger than 15 MB.', offerPaste: true })
      return
    }
    const form = new FormData()
    form.append('file', file)
    void send({ method: 'POST', body: form }, file.name)
  }, [send])

  /**
   * Confirmation. Sends back the SANITISED plan the server returned, along with
   * the source text, so the server can trace it again without a second AI call.
   * Nothing was persisted to get here.
   */
  const create = useCallback(async (review: ImportReviewData) => {
    if (inFlight.current) return
    inFlight.current = true
    setState({ kind: 'creating', review })
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          importId: review.importId,
          sourceText: review.source.text,
          format: review.source.format,
          organised: review.organised,
        }),
      })
      const body = await res.json().catch(() => ({} as Record<string, unknown>))
      if (res.ok && typeof body.resumeId === 'string') {
        onImported?.()
        router.push(`/resume-studio/${body.resumeId}`)
        return
      }
      setState({
        kind: 'refused',
        message: typeof body.message === 'string' ? body.message : 'That could not be created.',
        offerPaste: false,
      })
    } catch {
      setState({ kind: 'refused', message: 'Could not reach the server.', offerPaste: false })
    } finally {
      inFlight.current = false
    }
  }, [router, onImported])

  const showPaste = pasting || (state.kind === 'refused' && state.offerPaste)
  const expanded = showPaste || state.kind === 'reviewing' || state.kind === 'creating'

  useEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  if (state.kind === 'reviewing' || state.kind === 'creating') {
    return (
      <ImportReview
        review={state.review}
        busy={state.kind === 'creating'}
        // Cancel creates nothing and uses no allowance: there is nothing to
        // undo, because nothing was made.
        onCancel={() => setState({ kind: 'idle' })}
        onCreate={() => void create(state.review)}
      />
    )
  }

  const working = state.kind === 'working'

  return (
    <Card tone="muted" className="p-3.5">
      <p className={cx('text-xs leading-relaxed', tokens.secondary)}>
        Start from a PDF or Word resume you already have.
      </p>

      {state.kind === 'refused' && (
        <p role="alert" className="mt-2 text-xs text-amber-800">{state.message}</p>
      )}

      <div className={cx('mt-3 gap-1.5', expanded ? 'flex flex-wrap' : 'flex flex-col')}>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="peer sr-only"
          id="import-file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) upload(file)
            e.target.value = ''
          }}
        />
        {/* The visible control for the hidden input, so it shows the input's keyboard focus. */}
        <label
          htmlFor="import-file"
          className={cx(
            buttonClass('secondary', 'sm'),
            'peer-focus-visible:ring-2 peer-focus-visible:ring-violet-600 peer-focus-visible:ring-offset-2',
            working ? 'pointer-events-none opacity-60' : 'cursor-pointer'
          )}
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          {working ? `Reading ${state.what}...` : 'Upload PDF or Word'}
        </label>

        <Button
          size="sm"
          variant="tertiary"
          icon={ClipboardPaste}
          disabled={working}
          onClick={() => setPasting((open) => !open)}
        >
          {pasting ? 'Hide paste box' : 'Paste resume text'}
        </Button>
      </div>

      {showPaste && (
        <div className="mt-3">
          <TextAreaField
            id="import-text"
            label="Paste your resume text"
            value={text}
            rows={8}
            onChange={(e) => setText(e.target.value)}
            placeholder="Select everything in your resume, copy it, and paste it here."
          />
          <Button
            size="sm"
            variant="primary"
            className="mt-2"
            disabled={working || text.trim() === ''}
            onClick={() => void send({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text }),
            }, 'your text')}
          >
            Import this text
          </Button>
        </div>
      )}

      <ul className={cx('mt-3 space-y-1.5 border-t border-slate-200 pt-2.5 text-[11px] leading-snug', tokens.secondary)}>
        <li className="flex gap-1.5">
          <Lock className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          The file itself is not kept — we read the text and discard it.
        </li>
        <li className="flex gap-1.5">
          <CircleCheck className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          You review everything before a resume is created.
        </li>
      </ul>
    </Card>
  )
}
