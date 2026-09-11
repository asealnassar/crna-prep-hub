'use client'

import { headingFor } from '@/lib/resume/model/sections'
import type { ResumeSectionV2 } from '@/lib/resume/model/types'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import SectionEditor from '../sections/SectionEditor'

/**
 * One section in the editor: its heading, its controls and its fields.
 *
 * Reordering is Move up / Move down buttons rather than drag-and-drop. Drag is
 * the obvious gesture and the inaccessible one -- an applicant working by
 * keyboard, or on a phone where drag fights the scroll, can still reorder here.
 * "Full keyboard operation including reorder" is an acceptance criterion, and
 * buttons are how it is met rather than approximated.
 */
export default function SectionCard({
  section,
  index,
  count,
  open,
  newId,
  emit,
  onToggleOpen,
}: {
  section: ResumeSectionV2
  index: number
  count: number
  open: boolean
  newId: () => string
  emit: (patch: StudioPatch) => void
  onToggleOpen: () => void
}) {
  const heading = headingFor(section)
  const panelId = `panel-${section.id}`

  return (
    <div className={`border rounded-2xl ${section.visible ? 'border-white/20 bg-white/5' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex flex-wrap items-center gap-2 p-3">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex-1 min-w-0 text-left text-white font-semibold hover:underline truncate"
        >
          <span aria-hidden="true" className="inline-block w-4 text-indigo-300">{open ? '▾' : '▸'}</span>
          {heading}
          {!section.visible && <span className="ml-2 text-xs font-normal text-indigo-300">(hidden)</span>}
        </button>

        <button
          type="button"
          className="px-2 py-1 text-xs rounded-lg border border-white/25 text-white hover:bg-white/10 disabled:opacity-40"
          disabled={index === 0}
          aria-label={`Move ${heading} up`}
          onClick={() => emit({ op: 'section-move', sectionId: section.id, toIndex: index - 1 })}
        >
          ↑
        </button>
        <button
          type="button"
          className="px-2 py-1 text-xs rounded-lg border border-white/25 text-white hover:bg-white/10 disabled:opacity-40"
          disabled={index === count - 1}
          aria-label={`Move ${heading} down`}
          onClick={() => emit({ op: 'section-move', sectionId: section.id, toIndex: index + 1 })}
        >
          ↓
        </button>
        <button
          type="button"
          className="px-2.5 py-1 text-xs rounded-lg border border-white/25 text-white hover:bg-white/10"
          aria-pressed={!section.visible}
          onClick={() => emit({ op: 'section-visible', sectionId: section.id, visible: !section.visible })}
        >
          {section.visible ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          className="px-2.5 py-1 text-xs rounded-lg text-red-200 hover:bg-red-500/15"
          onClick={() => emit({ op: 'section-remove', sectionId: section.id })}
        >
          Remove
        </button>
      </div>

      {open && (
        <div id={panelId} className="px-3 pb-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-indigo-200 mb-1" htmlFor={`label-${section.id}`}>
                Heading on the resume
              </label>
              <input
                id={`label-${section.id}`}
                className="w-full bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
                value={section.label ?? ''}
                placeholder={heading}
                onChange={(e) => emit({ op: 'section-label', sectionId: section.id, label: e.target.value || null })}
              />
            </div>
            {section.type === 'custom' && (
              <div>
                <label className="block text-xs font-semibold text-indigo-200 mb-1" htmlFor={`heading-${section.id}`}>
                  Section name
                </label>
                <input
                  id={`heading-${section.id}`}
                  className="w-full bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  value={section.heading}
                  placeholder="Languages"
                  onChange={(e) => emit({ op: 'section-heading', sectionId: section.id, value: e.target.value })}
                />
              </div>
            )}
          </div>

          <SectionEditor section={section} newId={newId} emit={emit} />
        </div>
      )}
    </div>
  )
}
