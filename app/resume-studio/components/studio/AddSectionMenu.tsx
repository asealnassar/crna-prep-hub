'use client'

import { descriptorFor } from '@/lib/resume/studio/fields'
import { addableSectionTypes } from '@/lib/resume/studio/patch'
import type { ResumeV2 } from '@/lib/resume/model/types'
import type { ResumeSectionType } from '@/lib/resume/model/types'

/**
 * Adding a section.
 *
 * A <select> and a button rather than a custom dropdown: it is keyboard and
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
  const options = addableSectionTypes(resume)
  if (options.length === 0) return null

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-[12rem]">
        <label className="block text-xs font-semibold text-indigo-200 mb-1" htmlFor="add-section">
          Add a section
        </label>
        <select
          id="add-section"
          className="w-full bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
          value={value}
          onChange={(e) => onValueChange(e.target.value as ResumeSectionType | '')}
        >
          <option value="">Choose a section…</option>
          {options.map((type) => (
            <option key={type} value={type} className="text-gray-900">
              {descriptorFor(type).heading}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={value === ''}
        onClick={() => value && onAdd(value)}
        className="px-4 py-2 text-sm font-semibold rounded-lg bg-white text-indigo-900 hover:bg-indigo-50 transition disabled:opacity-50"
      >
        Add
      </button>
    </div>
  )
}
