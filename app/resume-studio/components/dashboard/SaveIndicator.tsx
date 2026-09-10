'use client'

import { describe } from '@/lib/resume/draft/autosave'
import type { AutosaveState } from '@/lib/resume/draft/autosave'

/**
 * What the save is actually doing.
 *
 * The words come from `describe()`, which reads confirmed state only. This
 * component cannot say "Saved" on its own initiative, which is the whole point:
 * V1's builder printed "Saved!" from a click handler that had discarded every
 * error it received.
 */
export default function SaveIndicator({
  state,
  onRetry,
  onReload,
}: {
  state: AutosaveState
  onRetry: () => void
  onReload: () => void
}) {
  const text = describe(state)
  if (!text) return null

  const tone =
    state.status === 'conflict' || state.status === 'failed'
      ? 'text-amber-200'
      : state.status === 'retrying'
        ? 'text-amber-200/80'
        : 'text-indigo-200'

  return (
    <p className={`text-xs ${tone} flex flex-wrap items-center gap-2`} role="status" aria-live="polite">
      <span>{text}</span>
      {state.status === 'failed' && (
        <button type="button" onClick={onRetry} className="underline hover:no-underline font-medium">
          Try again
        </button>
      )}
      {state.status === 'conflict' && (
        <button type="button" onClick={onReload} className="underline hover:no-underline font-medium">
          Reload
        </button>
      )}
    </p>
  )
}
