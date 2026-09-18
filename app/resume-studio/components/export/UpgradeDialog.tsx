'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { ULTIMATE_RESUME_BENEFITS, UPGRADE_HREF } from '@/lib/resume/upgrade'
import { upgradeAfterLock } from '@/lib/resume/studio/outputLock'
import { Button, IconButton, cx, floating, text } from '../ui'
import { useDismiss } from '../ui'

/**
 * What Ultimate adds, shown when a download is attempted without it.
 *
 * THE ANSWER MATTERS, NOT THE DISMISSAL. Both buttons are answers: the
 * applicant has seen the finished resume and been told what unlocking it
 * costs, so "Not now" and "Upgrade to Ultimate" alike lock the finished
 * document from then on. Escape, the close button and a press outside are not
 * answers, and they change nothing. `onClose` is a separate prop from the two
 * answers for exactly that reason, and the distinction is tested.
 *
 * THE UPGRADE CONTROL IS A BUTTON, NOT A LINK, and that is the fix for a real
 * bypass. As an <a href> it navigated the moment it was pressed, so the lock
 * was still sitting in the save queue when the page unloaded -- press Upgrade,
 * think better of paying, come back, and the finished resume was readable. A
 * link also carries middle-click and cmd-click, which reach /pricing without
 * running any handler at all, so there is deliberately no href here that could
 * skip the answer. The ordering rule itself is upgradeAfterLock().
 *
 * The benefits come from lib/resume/upgrade.ts, where each one names the rule
 * that makes it true. Nothing is claimed here that the product does not do.
 */
export default function UpgradeDialog({
  open,
  onNotNow,
  onUpgrade,
  onClose,
}: {
  open: boolean
  /** The applicant answered. Locks the finished output, and stays on the page. */
  onNotNow: () => void
  /**
   * The applicant answered by upgrading. Resolves true once the output lock has
   * reached the server -- only then does this dialog leave for the pricing
   * page. Absent means there is nothing to wait for.
   */
  onUpgrade?: () => Promise<boolean>
  /** Escape, the X, or a press outside. Changes nothing about the resume. */
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const firstAction = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  /** Saving the answer before leaving. Not a download and not a payment. */
  const [leaving, setLeaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useDismiss(open, [panel], onClose)

  useEffect(() => {
    if (open) return
    setLeaving(false)
    setFailed(false)
  }, [open])

  const upgrade = useCallback(async () => {
    if (leaving) return
    setFailed(false)
    setLeaving(true)
    const outcome = await upgradeAfterLock({
      lock: async () => (await onUpgrade?.()) ?? true,
      navigate: () => window.location.assign(UPGRADE_HREF),
    })
    if (outcome === 'not-saved') {
      setLeaving(false)
      setFailed(true)
    }
  }, [leaving, onUpgrade])

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
            {failed && (
              <p role="alert" className="mr-auto text-xs leading-snug text-amber-800">
                Could not save your answer. Check your connection and try again.
              </p>
            )}
            <Button variant="tertiary" onClick={onNotNow} disabled={leaving}>Not now</Button>
            <Button
              ref={firstAction}
              variant="primary"
              onClick={() => void upgrade()}
              disabled={leaving}
              aria-busy={leaving}
            >
              {leaving ? 'One moment...' : 'Upgrade to Ultimate'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
