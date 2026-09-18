'use client'

import { Eye, Pencil } from 'lucide-react'
import { showPane } from '@/lib/resume/studio/panes'
import type { PaneState } from '@/lib/resume/studio/panes'
import { SegmentedControl } from '../ui'

/**
 * Edit / Preview on a phone.
 *
 * Two segments rather than one toggling button: the applicant can see which
 * pane they are on without reading the label and working out whether it names
 * where they are or where they would go.
 */
export default function MobileToggle({
  state,
  onChange,
  className,
}: {
  state: PaneState
  onChange: (next: PaneState) => void
  className?: string
}) {
  return (
    <SegmentedControl
      label="Studio view"
      value={state.active}
      onChange={(pane) => onChange(showPane(state, pane))}
      className={className}
      options={[
        { value: 'edit', label: 'Edit', icon: Pencil },
        { value: 'preview', label: 'Preview', icon: Eye },
      ]}
    />
  )
}
