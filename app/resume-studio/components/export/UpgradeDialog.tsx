'use client'

import { useCallback, useEffect, useId, useRef } from 'react'
import { Check, X } from 'lucide-react'
import { ULTIMATE_RESUME_BENEFITS, UPGRADE_HREF } from '@/lib/resume/upgrade'
import { Button, IconButton, buttonClass, cx, floating, text } from '../ui'
import { useDismiss } from '../ui'

/**
 * What Ultimate adds, shown when a download is attempted without it.
 *
 * THE ANSWER MATTERS, NOT THE DISMISSAL. "Not now" is an answer: the applicant
 * has seen the finished resume, been told what unlocking it costs, and decided
 * not to today -- so the finished document locks from then on. Escape, the
 * close button and a press outside are not answers, and they change nothing.
 * `onClose` and `onNotNow` are separate props for exactly that reason, and the
 * distinction is tested.
 *
 * The benefits come from lib/resume/upgrade.ts, where each one names the rule
 * that makes it true. Nothing is claimed here that the product does not do.
 */
export default function UpgradeDialog({
  open,
  onNotNow,
  onClose,
}: {
  open: boolean
  /** The applicant answered. This is the only thing that locks the output. */
  onNotNow: () => void
  /** Escape, the X, or a press outside. Changes nothing about the resume. */
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const firstAction = useRef<HTMLAnchorElement>(null)
  const titleId = useId()

  useDismiss(open, [panel], onClose)

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
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
          className={cx('relative w-full max-w-md p-5', floating.popover)}
        >
          <div className="mb-4 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-slate-900">Upgrade to Ultimate</h2>
              <p className={cx('mt-1 text-sm leading-relaxed', text.secondary)}>
                Your resume is ready. Upgrade to Ultimate to download your finished resume.
              </p>
            </div>
            <IconButton icon={X} label="Close" size="sm" className="-mr-1" onClick={onClose} />
          </div>

          <ul className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            {ULTIMATE_RESUME_BENEFITS.map((benefit) => (
              <li key={benefit.gate} className="flex items-start gap-2.5 py-1 text-sm text-slate-700">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" aria-hidden="true" />
                {benefit.label}
              </li>
            ))}
          </ul>

          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="tertiary" onClick={onNotNow}>Not now</Button>
            <a ref={firstAction} href={UPGRADE_HREF} className={buttonClass('primary')}>
              Upgrade to Ultimate
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
