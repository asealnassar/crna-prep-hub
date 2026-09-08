'use client'

/**
 * D60 — the Free/Premium transcript allowance is spent.
 *
 * The wording is taken from the ENTITLEMENT, never from what the user
 * currently holds. They may well have deleted the analysis this transcript
 * produced, and deleting it does not give the transcript back -- so "you
 * already have one transcript" would be false, and telling them to delete
 * something to make room would send them to destroy their own work for
 * nothing.
 *
 * Upgrading goes through the existing pricing page. There is no second billing
 * path here.
 */

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { Sparkles, X } from 'lucide-react'
import { BTN_GHOST, BTN_PRIMARY } from './workspace'

export function TranscriptLimitModal({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const firstAction = useRef<HTMLAnchorElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null
    firstAction.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key !== 'Tab') return
      const focusable = panel.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }

    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      opener.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={panel} role="dialog" aria-modal="true"
        aria-labelledby="transcript-limit-title" aria-describedby="transcript-limit-desc"
        className="w-full max-w-lg rounded-t-2xl border border-slate-200 bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="transcript-limit-title"
              className="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
              Multiple transcripts are available with Ultimate
            </h2>
            <p id="transcript-limit-desc" className="mt-2 text-sm text-slate-600">
              You’ve already used your transcript analysis. Upgrade to Ultimate to analyze
              additional transcripts and combine coursework from multiple schools.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className={`${BTN_GHOST} -mr-1 -mt-1 h-8 w-8 shrink-0 !px-0`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* Said plainly, because the alternative reading -- "add courses by hand
            is gone too" -- is the reason people abandon the page here. */}
        <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          Everything else stays available on your plan: add and edit courses by hand, set
          categories, credits, schools, grading scales and policies.
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <Link ref={firstAction} href="/pricing"
            className={`${BTN_PRIMARY} w-full justify-center sm:w-auto`}>
            <Sparkles className="h-4 w-4" aria-hidden />Upgrade to Ultimate
          </Link>
          <button onClick={onClose} className={`${BTN_GHOST} w-full justify-center sm:w-auto`}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
