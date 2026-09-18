'use client'

import { CircleCheck, TriangleAlert } from 'lucide-react'
import { describe } from '@/lib/resume/draft/autosave'
import type { AutosaveState } from '@/lib/resume/draft/autosave'
import { cx } from '../ui'

/**
 * What the save is actually doing.
 *
 * The words come from `describe()`, which reads confirmed state only. This
 * component cannot say "Saved" on its own initiative, which is the whole point:
 * V1's builder printed "Saved!" from a click handler that had discarded every
 * error it received. The check mark appears only beside the confirmed saved
 * state, and every icon sits beside the words that explain it.
 */
export default function SaveIndicator({
  state,
  onRetry,
  onReload,
  size = 'sm',
}: {
  state: AutosaveState
  onRetry: () => void
  onReload: () => void
  /** `xs` sits under a title in the phone toolbar. */
  size?: 'sm' | 'xs'
}) {
  const text = describe(state)
  if (!text) return null

  const problem = state.status === 'conflict' || state.status === 'failed'
  const warning = problem || state.status === 'retrying'
  const tone = problem ? 'text-amber-800' : state.status === 'retrying' ? 'text-amber-700' : 'text-slate-500'
  const glyph = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'

  return (
    <p
      className={cx('flex flex-wrap items-center gap-x-2 gap-y-0.5', size === 'xs' ? 'text-[11px] font-medium' : 'text-xs', tone)}
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex items-center gap-1">
        {state.status === 'saved' && <CircleCheck className={cx(glyph, 'text-emerald-600')} aria-hidden="true" />}
        {warning && <TriangleAlert className={glyph} aria-hidden="true" />}
        {text}
      </span>
      {state.status === 'failed' && (
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2 hover:no-underline">
          Try again
        </button>
      )}
      {state.status === 'conflict' && (
        <button type="button" onClick={onReload} className="font-medium underline underline-offset-2 hover:no-underline">
          Reload
        </button>
      )}
    </p>
  )
}
