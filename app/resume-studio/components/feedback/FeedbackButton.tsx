'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { MessageSquare, X } from 'lucide-react'
import { createClient } from '@/lib/supabase-browser'
import {
  FEEDBACK_TYPES, MAX_FEEDBACK_LENGTH, checkFeedback, feedbackRow,
} from '@/lib/resume/feedback/submission'
import type { FeedbackSurface, FeedbackType } from '@/lib/resume/feedback/submission'
import { Button, IconButton, SelectField, TextAreaField, buttonClass, cx, floating, text } from '../ui'
import { useDismiss } from '../ui'

/**
 * "Feedback & suggestions", wherever the applicant happens to be.
 *
 * THE SAME PLACE EVERY OTHER REPORT GOES. Submitting writes one row to
 * `interview_feedback` -- the table V1's feedback page has always written, in
 * the same two columns -- so it arrives in the Analytics feedback list with
 * everything else. The tag at the head of the message is what marks it as
 * Resume Builder V2; see lib/resume/feedback/submission.ts.
 *
 * NOTHING FROM THE RESUME TRAVELS WITH IT. This component is handed a surface,
 * a template name and a tier. It cannot reach the document: no section, no
 * bullet, no contact detail is in scope here, and the message is what the
 * applicant typed.
 *
 * SECONDARY BY DESIGN. A quiet control next to the real actions -- the purple
 * is for making a resume, not for asking about one.
 */
export default function FeedbackButton({
  surface,
  tier,
  template,
  compact = false,
  className,
}: {
  surface: FeedbackSurface
  tier?: string | null
  /** The template on screen, when there is one. Never the resume itself. */
  template?: string | null
  /** Icon only, for a phone toolbar. */
  compact?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {compact ? (
        <IconButton
          icon={MessageSquare}
          label="Feedback & suggestions"
          className={className}
          onClick={() => setOpen(true)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cx(buttonClass('tertiary', 'sm'), className)}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          Feedback &amp; suggestions
        </button>
      )}
      <FeedbackDialog
        open={open}
        surface={surface}
        tier={tier}
        template={template}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

type Status = 'editing' | 'sending' | 'sent' | 'failed'

export function FeedbackDialog({
  open,
  surface,
  tier,
  template,
  onClose,
}: {
  open: boolean
  surface: FeedbackSurface
  tier?: string | null
  template?: string | null
  onClose: () => void
}) {
  const [type, setType] = useState<FeedbackType>('issue')
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<Status>('editing')
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const messageId = useId()

  useDismiss(open, [panel], onClose)

  // Focus moves in on open and back to whatever opened it on close, so a
  // keyboard never lands behind the dialog or loses its place after it.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    setType('issue')
    setMessage('')
    setStatus('editing')
    setError(null)
    const timer = setTimeout(() => panel.current?.querySelector('select')?.focus(), 0)
    return () => {
      clearTimeout(timer)
      opener?.focus?.()
    }
  }, [open])

  /** Tab stays inside the dialog: that is what makes it modal rather than a layer. */
  const trapTab = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !panel.current) return
    const focusable = panel.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  const send = async () => {
    // One request at a time: a second press while the first is in flight would
    // file the same report twice.
    if (status === 'sending') return
    const checked = checkFeedback(message)
    if (!checked.ok) {
      setError(checked.error)
      return
    }

    setStatus('sending')
    setError(null)
    try {
      const supabase = createClient()
      const { data } = await supabase.auth.getUser()
      const { error: failure } = await supabase
        .from('interview_feedback')
        .insert(feedbackRow({
          email: data.user?.email,
          type,
          message: checked.message,
          surface,
          template,
          tier,
        }))
      if (failure) throw new Error(failure.message)
      setStatus('sent')
    } catch {
      setStatus('failed')
      setError('That did not send. Please try again.')
    }
  }

  if (!open) return null

  const sending = status === 'sending'

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto p-4 sm:p-6">
      <div aria-hidden="true" className={cx('fixed inset-0', floating.scrim)} />
      <div className="flex min-h-full items-start justify-center sm:items-center">
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onKeyDown={trapTab}
          className={cx('relative w-full max-w-md p-5', floating.popover)}
        >
          <div className="mb-4 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-slate-900">
                Help us improve Resume Builder
              </h2>
              <p className={cx('mt-0.5 text-sm', text.secondary)}>
                {status === 'sent'
                  ? 'We read everything that comes through here.'
                  : 'What went wrong, or what would make this better?'}
              </p>
            </div>
            <IconButton icon={X} label="Close" size="sm" className="-mr-1" onClick={onClose} />
          </div>

          {status === 'sent' ? (
            <>
              <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
                Thanks — your feedback was sent.
              </p>
              <div className="mt-4 flex justify-end">
                <Button onClick={onClose}>Close</Button>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-3">
                <SelectField
                  id={`${titleId}-type`}
                  label="Type"
                  value={type}
                  disabled={sending}
                  onChange={(e) => setType(e.target.value as FeedbackType)}
                >
                  {FEEDBACK_TYPES.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </SelectField>

                <TextAreaField
                  id={messageId}
                  label="Message"
                  value={message}
                  rows={5}
                  maxLength={MAX_FEEDBACK_LENGTH}
                  disabled={sending}
                  placeholder="What happened, or what would you like to see?"
                  help="Please do not paste your resume — we only need what you want to tell us."
                  onChange={(e) => {
                    setMessage(e.target.value)
                    if (error) setError(null)
                  }}
                />
              </div>

              {error && (
                <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              )}

              <div className="mt-4 flex items-center justify-end gap-2">
                <Button variant="tertiary" disabled={sending} onClick={onClose}>Cancel</Button>
                <Button
                  onClick={send}
                  disabled={sending || message.trim() === ''}
                  aria-busy={sending}
                >
                  {sending ? 'Sending…' : 'Send feedback'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
