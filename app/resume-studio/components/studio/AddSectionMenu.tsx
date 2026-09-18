'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { descriptorFor } from '@/lib/resume/studio/fields'
import { addableSectionTypes } from '@/lib/resume/studio/patch'
import type { ResumeV2 } from '@/lib/resume/model/types'
import type { ResumeSectionType } from '@/lib/resume/model/types'
import { Button, Card, SelectField, addActionClass } from '../ui'

/**
 * Adding a section.
 *
 * An obvious "Add section" control at the end of the editor, which opens a
 * <select> and a button rather than a custom dropdown: it is keyboard and
 * screen-reader operable for free, and on a phone it opens the native picker,
 * which is a better list of fifteen things than anything worth building here.
 */
export default function AddSectionMenu({
  resume,
  value,
  onValueChange,
  onAdd,
}: {
  resume: ResumeV2
  value: ResumeSectionType | ''
  onValueChange: (type: ResumeSectionType | '') => void
  onAdd: (type: ResumeSectionType) => void
}) {
  const [open, setOpen] = useState(false)
  const options = addableSectionTypes(resume)
  if (options.length === 0) return null

  if (!open) {
    return (
      <button type="button" className={addActionClass} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add section
      </button>
    )
  }

  return (
    <Card className="flex flex-wrap items-end gap-2 p-3">
      <SelectField
        id="add-section"
        label="Add a section"
        value={value}
        autoFocus
        className="min-w-[12rem] flex-1"
        onChange={(e) => onValueChange(e.target.value as ResumeSectionType | '')}
      >
        <option value="">Choose a section…</option>
        {options.map((type) => (
          <option key={type} value={type}>
            {descriptorFor(type).heading}
          </option>
        ))}
      </SelectField>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={value === ''}
          onClick={() => {
            if (!value) return
            onAdd(value)
            setOpen(false)
          }}
        >
          Add
        </Button>
        <Button
          variant="tertiary"
          onClick={() => {
            onValueChange('')
            setOpen(false)
          }}
        >
          Cancel
        </Button>
      </div>
    </Card>
  )
}
