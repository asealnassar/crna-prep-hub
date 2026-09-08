'use client'

/**
 * Where should this transcript go?
 *
 * This replaced a browser confirm() whose two options were "OK" and "Cancel",
 * with a legend underneath explaining which product decision each one stood
 * for. Two real choices deserve two real buttons, and cancelling the upload
 * should not be spelled the same way as choosing one of them.
 *
 * D47: the second option no longer pours the transcript into the analysis that
 * happens to be open. It creates a new combined analysis and leaves the open
 * one exactly as it was, so neither choice can cost the user work they already
 * have. The copy says so before the click, not after.
 */

import { useEffect, useRef } from 'react'
import { FilePlus2, Layers, X } from 'lucide-react'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from './workspace'
import { shortenAnalysisName, type UploadDestination } from '@/lib/gpa/uploadDestination'

export type { UploadDestination } from '@/lib/gpa/uploadDestination'

export function DestinationModal({
  analysisName, onChoose,
}: {
  analysisName: string | null | undefined
  onChoose: (choice: UploadDestination) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const firstAction = useRef<HTMLButtonElement>(null)
  /** Whichever control opened this, so focus can go back where it came from. */
  const opener = useRef<HTMLElement | null>(null)
  /** One decision only: a double click must not fire two imports. */
  const decided = useRef(false)

  const choose = (choice: UploadDestination) => {
    if (decided.current) return
    decided.current = true
    onChoose(choice)
  }

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null
    firstAction.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        choose('cancel')          // Escape cancels; it never picks a destination
        return
      }
      if (e.key !== 'Tab') return
      // Focus stays inside the dialog while it is open.
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

  const shortName = shortenAnalysisName(analysisName)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      // A click on the backdrop is not a product choice, so it cancels.
      onMouseDown={e => { if (e.target === e.currentTarget) choose('cancel') }}>
      <div ref={panel} role="dialog" aria-modal="true"
        aria-labelledby="dest-title" aria-describedby="dest-desc"
        className="w-full max-w-lg rounded-t-2xl border border-slate-200 bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="dest-title" className="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
              How would you like to use this transcript?
            </h2>
            <p id="dest-desc" className="mt-1 text-sm text-slate-500">
              Either way a new analysis is created. “{shortName}” will remain unchanged.
            </p>
          </div>
          <button onClick={() => choose('cancel')} aria-label="Cancel upload"
            className={`${BTN_GHOST} -mr-1 -mt-1 h-8 w-8 shrink-0 !px-0`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-5 space-y-3">
          <button ref={firstAction} onClick={() => choose('separate')}
            className={`${BTN_PRIMARY} w-full !justify-start !px-4 !py-3.5 text-left`}>
            <FilePlus2 className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block font-semibold">Analyze Separately</span>
              <span className="block text-xs font-normal text-white/80">
                Create a new analysis from this transcript on its own.
              </span>
            </span>
          </button>

          <button onClick={() => choose('combine')}
            className={`${BTN_SECONDARY} w-full !justify-start !px-4 !py-3.5 text-left`}>
            <Layers className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate font-semibold">Combine with “{shortName}”</span>
              <span className="block text-xs font-normal text-slate-500">
                Creates a new combined analysis. “{shortName}” will remain unchanged.
              </span>
            </span>
          </button>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-3 text-center">
          <button onClick={() => choose('cancel')}
            className={`${BTN_GHOST} !text-sm`}>
            Cancel Upload
          </button>
        </div>
      </div>
    </div>
  )
}
