'use client'

import { showPane } from '@/lib/resume/studio/panes'
import type { PaneState } from '@/lib/resume/studio/panes'

/**
 * Edit / Preview on a phone.
 *
 * Two radio-style buttons rather than one toggling button: the applicant can
 * see which pane they are on without reading the label and working out whether
 * it names where they are or where they would go.
 */
export default function MobileToggle({
  state,
  onChange,
}: {
  state: PaneState
  onChange: (next: PaneState) => void
}) {
  return (
    <div className="flex rounded-xl border border-white/25 bg-white/10 p-1" role="tablist" aria-label="Studio view">
      {(['edit', 'preview'] as const).map((pane) => {
        const active = state.active === pane
        return (
          <button
            key={pane}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(showPane(state, pane))}
            className={`flex-1 px-4 py-1.5 text-sm font-semibold rounded-lg transition ${
              active ? 'bg-white text-indigo-900' : 'text-indigo-100 hover:bg-white/10'
            }`}
          >
            {pane === 'edit' ? 'Edit' : 'Preview'}
          </button>
        )
      })}
    </div>
  )
}
