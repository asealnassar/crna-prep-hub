'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MAX_TITLE_CHARS } from '@/lib/statement/draft/validate'
import {
  NETWORK_FAILURE,
  NEW_DRAFT_ENDPOINT,
  canSubmitNewDraft,
  createOutcomeFrom,
  newDraftRequest,
} from '@/lib/statement/draft/library'

/**
 * New draft: a title, then the draft.
 *
 * THE TITLE COMES FIRST AND THE ROW IS CREATED IMMEDIATELY. The alternative --
 * open an editor and create the row on the first keystroke -- means an applicant
 * can type a paragraph into something that does not exist yet, and every failure
 * after that point is a lost paragraph. One POST, before there is anything to
 * lose, and the editor opens on a draft that is already saved.
 *
 * WIRING ONLY. What a title may be, what is sent, when Create may fire and what
 * a reader is told all live in lib/statement/draft/library.ts, which is pure and
 * unit-tested. This component holds the fields, the focus and the guard.
 *
 * NO maxLength ON THE INPUT, deliberately. It would stop typing at the limit and
 * silently shorten a pasted title, which is exactly what the rules say not to do.
 * A long title is REFUSED, visibly, with the count in front of the applicant.
 */
export default function NewDraftDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** False only after a create that may have left a draft behind. */
  const [retryable, setRetryable] = useState(true)

  /**
   * THE DUPLICATE GUARD, and the reason it is a ref rather than the `submitting`
   * state. A state update is asynchronous, so two clicks in one tick would both
   * read `submitting === false` and both POST. This is set synchronously, before
   * the first await, so the second click returns immediately.
   */
  const inFlight = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const messageId = useId()

  // Focus moves in on open and back to whatever opened it on close, so a
  // keyboard never lands behind the dialog or loses its place after it. Opening
  // also clears the last attempt: a fresh dialog, not a stale refusal.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    setTitle('')
    setMessage(null)
    setRetryable(true)
    setSubmitting(false)
    inFlight.current = false
    const timer = setTimeout(() => field.current?.focus(), 0)
    return () => {
      clearTimeout(timer)
      opener?.focus?.()
    }
  }, [open])

  /** The dialog does not close itself, and it cannot be closed mid-flight. */
  const dismiss = useCallback(() => {
    if (submitting) return
    onClose()
  }, [submitting, onClose])

  /** Tab stays inside the dialog: that is what makes it modal rather than a layer. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [dismiss]
  )

  const submit = useCallback(async () => {
    if (inFlight.current) return

    const request = newDraftRequest(title)
    if (!request.ok) {
      setMessage(request.message)
      field.current?.focus()
      return
    }
    if (!retryable) return

    inFlight.current = true
    setSubmitting(true)
    setMessage(null)

    try {
      const response = await fetch(NEW_DRAFT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      })
      // A body that is not JSON is not a reason to throw; the mapper treats an
      // unreadable 2xx as the one refusal that must not be retried.
      const body = await response.json().catch(() => null)
      const outcome = createOutcomeFrom({ status: response.status, body })

      if (outcome.type === 'created') {
        // NEITHER THE GUARD NOR THE BUSY STATE IS RELEASED, and the dialog does
        // not close. router.push is a soft navigation: this component stays
        // mounted until the new route lands, and a dialog that became
        // interactive again in the meantime could create a second draft.
        router.push(outcome.path)
        return
      }

      // The title is left exactly as typed, so a deliberate retry costs no
      // retyping. Nothing retries on its own -- a create is not idempotent.
      setMessage(outcome.message)
      setRetryable(outcome.retryable)
    } catch {
      setMessage(NETWORK_FAILURE.message)
      setRetryable(NETWORK_FAILURE.retryable)
    }

    inFlight.current = false
    setSubmitting(false)
  }, [title, retryable, router])

  if (!open) return null

  const trimmed = title.trim().length
  const canSubmit = canSubmitNewDraft({ title, submitting, retryable })

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto p-4 sm:p-6">
      <div
        aria-hidden="true"
        onClick={dismiss}
        className="fixed inset-0 bg-slate-900/40"
      />
      <div className="flex min-h-full items-start justify-center sm:items-center">
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          onKeyDown={onKeyDown}
          className="relative w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
        >
          <h2 id={headingId} className="text-base font-semibold text-slate-900">
            New draft
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Give it a title. You can change it later.
          </p>

          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <label htmlFor={`${headingId}-title`} className="mb-2 block text-sm font-medium text-gray-700">
              Title
            </label>
            <input
              ref={field}
              id={`${headingId}-title`}
              type="text"
              value={title}
              autoComplete="off"
              disabled={submitting}
              aria-invalid={message !== null}
              aria-describedby={message === null ? undefined : messageId}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Why I want to become a CRNA"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
            />

            <p className="mt-1.5 text-xs text-slate-500">
              {trimmed > MAX_TITLE_CHARS
                ? `${trimmed} characters. Use ${MAX_TITLE_CHARS} or fewer.`
                : `${trimmed}/${MAX_TITLE_CHARS}`}
            </p>

            {message !== null && (
              <p
                id={messageId}
                role="alert"
                className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                {message}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={dismiss}
                disabled={submitting}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Creating…' : 'Create draft'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
