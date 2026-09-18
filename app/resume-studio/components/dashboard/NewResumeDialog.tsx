'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, FileUp, PenLine, X } from 'lucide-react'
import { Button, IconButton, cx, floating, focusRing, text } from '../ui'
import { useDismiss } from '../ui'
import UploadTile from '../import/UploadTile'

/**
 * How would you like to start?
 *
 * ONE ENTRY POINT, TWO ANSWERS. The dashboard used to offer "New resume" beside
 * a separate Import column, which asked the applicant to understand the
 * difference between a button and a panel before they had done anything. Both
 * are the same intention -- I want a resume -- so both live behind the same
 * control, and the choice is made after the intention rather than before it.
 *
 * Nothing about importing changes here. Choosing "Upload existing resume"
 * reveals the same UploadTile, which runs the same analyse-review-create
 * workflow with the same refusals and the same limits.
 */
export default function NewResumeDialog({
  open,
  busy,
  onClose,
  onStartFromScratch,
  onImported,
}: {
  open: boolean
  /** A blank resume is being created. */
  busy?: boolean
  onClose: () => void
  onStartFromScratch: () => void
  onImported: () => void
}) {
  const [step, setStep] = useState<'choice' | 'upload'>('choice')
  /** A review needs far more room than a two-option menu. */
  const [wide, setWide] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const firstAction = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useDismiss(open, [panel], onClose)

  // Focus moves in on open and back to whatever opened it on close, so a
  // keyboard never lands behind the dialog or loses its place after it.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    setStep('choice')
    setWide(false)
    const timer = setTimeout(() => firstAction.current?.focus(), 0)
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

  if (!open) return null

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
          className={cx('relative w-full p-5', floating.popover, wide ? 'max-w-3xl' : 'max-w-md')}
        >
          <div className="mb-4 flex items-start gap-2">
            {step === 'upload' && (
              <IconButton
                icon={ArrowLeft}
                label="Back to the start options"
                size="sm"
                className="-ml-1 mt-0.5"
                onClick={() => setStep('choice')}
              />
            )}
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-slate-900">New resume</h2>
              <p className={cx('mt-0.5 text-sm', text.secondary)}>
                {step === 'choice'
                  ? 'How would you like to start?'
                  : 'We read the text and show you everything before anything is created.'}
              </p>
            </div>
            <IconButton icon={X} label="Close" size="sm" className="-mr-1" onClick={onClose} />
          </div>

          {step === 'choice' ? (
            <div className="grid gap-2.5">
              <Choice
                ref={firstAction}
                icon={PenLine}
                title="Start from scratch"
                description="A blank resume, saved as you go."
                disabled={busy}
                busyLabel={busy ? 'Creating…' : undefined}
                onClick={onStartFromScratch}
              />
              <Choice
                icon={FileUp}
                title="Upload existing resume"
                description="Bring a PDF or Word file, or paste the text."
                onClick={() => setStep('upload')}
              />
            </div>
          ) : (
            <UploadTile onImported={onImported} onExpandedChange={setWide} />
          )}
        </div>
      </div>
    </div>
  )
}

/** One of the two ways to begin: a whole card is the target, not a small button. */
const Choice = function Choice({
  ref,
  icon: Icon,
  title,
  description,
  disabled,
  busyLabel,
  onClick,
}: {
  ref?: React.Ref<HTMLButtonElement>
  icon: typeof PenLine
  title: string
  description: string
  disabled?: boolean
  busyLabel?: string
  onClick: () => void
}) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex w-full items-start gap-3 rounded-xl border border-slate-200 p-3.5 text-left transition-colors',
        'hover:border-violet-300 hover:bg-violet-50/40 disabled:cursor-not-allowed disabled:opacity-60',
        focusRing
      )}
    >
      <span aria-hidden="true" className="mt-0.5 rounded-lg bg-slate-100 p-2 text-slate-700">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-900">{busyLabel ?? title}</span>
        <span className={cx('mt-0.5 block text-xs', text.secondary)}>{description}</span>
      </span>
    </button>
  )
}
