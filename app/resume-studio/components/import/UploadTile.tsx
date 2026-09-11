'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MAX_UPLOAD_BYTES } from '@/lib/resume/import/upload'
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

export default function UploadTile({ onImported }: { onImported?: () => void }) {
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
    <section className="border-2 border-dashed border-white/25 bg-white/5 rounded-2xl p-5">
      <h2 className="text-white font-semibold">Already have a resume?</h2>
      <p className="text-xs text-indigo-300 mt-1">
        Upload a PDF or Word file and we will sort it into sections for you to check.
        The file itself is not kept — we read the text and discard it.
      </p>

      {state.kind === 'refused' && (
        <p role="alert" className="mt-3 text-xs text-amber-200">{state.message}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="sr-only"
          id="import-file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) upload(file)
            e.target.value = ''
          }}
        />
        <label
          htmlFor="import-file"
          className={`px-4 py-2 text-sm font-semibold rounded-xl bg-white text-indigo-900 transition ${
            working ? 'opacity-60 pointer-events-none' : 'hover:bg-indigo-50 cursor-pointer'
          }`}
        >
          {working ? `Reading ${state.what}...` : 'Choose a file'}
        </label>

        <button
          type="button"
          disabled={working}
          onClick={() => setPasting((open) => !open)}
          className="px-4 py-2 text-sm font-semibold rounded-xl border border-white/30 text-white hover:bg-white/10 transition disabled:opacity-60"
        >
          {pasting ? 'Hide paste box' : 'Paste resume text'}
        </button>
      </div>

      {(pasting || (state.kind === 'refused' && state.offerPaste)) && (
        <div className="mt-4">
          <label className="block text-xs font-semibold text-indigo-200 mb-1" htmlFor="import-text">
            Paste your resume text
          </label>
          <textarea
            id="import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full min-h-[10rem] bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            placeholder="Select everything in your resume, copy it, and paste it here."
          />
          <button
            type="button"
            disabled={working || text.trim() === ''}
            onClick={() => void send({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text }),
            }, 'your text')}
            className="mt-2 px-4 py-2 text-sm font-semibold rounded-xl bg-white text-indigo-900 hover:bg-indigo-50 transition disabled:opacity-60"
          >
            Import this text
          </button>
        </div>
      )}
    </section>
  )
}
