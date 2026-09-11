'use client'

import { descriptorFor } from '@/lib/resume/studio/fields'
import type { ResumeSectionV2 } from '@/lib/resume/model/types'
import type { StudioPatch, FieldValue } from '@/lib/resume/studio/patch'
import FieldInput from './FieldInput'

/**
 * The editor for one section, chosen by the descriptor's shape.
 *
 * Eleven of the fifteen section types are a list of entries with typed fields,
 * so they share this one form and differ only in the descriptor that drives it.
 * The two shapes that are genuinely different say so: a professional summary is
 * one block of prose, and a clinical position carries grounding facts that must
 * never render alongside bullets that must.
 */

const BTN = 'px-2.5 py-1 text-xs font-semibold rounded-lg border border-white/25 text-white hover:bg-white/10 transition'
const DANGER = 'px-2.5 py-1 text-xs font-semibold rounded-lg text-red-200 hover:bg-red-500/15 transition'

export default function SectionEditor({
  section,
  newId,
  emit,
}: {
  section: ResumeSectionV2
  newId: () => string
  emit: (patch: StudioPatch) => void
}) {
  const descriptor = descriptorFor(section.type)

  if (descriptor.shape === 'prose' && section.type === 'summary') {
    return (
      <div>
        <label className="block text-xs font-semibold text-indigo-200 mb-1" htmlFor={`sum-${section.id}`}>
          Professional summary
        </label>
        <textarea
          id={`sum-${section.id}`}
          className="w-full bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white min-h-[7rem] focus:outline-none focus:ring-2 focus:ring-indigo-300"
          value={section.text.accepted}
          placeholder="Three or four sentences on who you are as a critical-care nurse."
          onChange={(e) => emit({ op: 'summary', sectionId: section.id, value: e.target.value })}
        />
      </div>
    )
  }

  if (section.type === 'critical_care' || section.type === 'other_clinical') {
    return <PositionsEditor section={section} newId={newId} emit={emit} />
  }

  const entry = descriptor.entry
  if (!entry) return null
  const list = (section as unknown as Record<string, Record<string, unknown>[]>)[entry.listKey] ?? []

  return (
    <div className="space-y-4">
      {list.map((item, index) => (
        <fieldset key={String(item.id)} className="border border-white/15 rounded-xl p-3">
          <legend className="px-1 text-xs text-indigo-300">
            {entry.noun} {index + 1}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {entry.fields.map((field) => (
              <div key={field.name} className={field.kind === 'authored' ? 'sm:col-span-2' : ''}>
                <FieldInput
                  descriptor={field}
                  id={`f-${section.id}-${String(item.id)}-${field.name}`}
                  value={item[field.name]}
                  onChange={(value: FieldValue) =>
                    emit({
                      op: 'field', sectionId: section.id, entryId: String(item.id),
                      field: field.name, value,
                    })
                  }
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <button
              type="button" className={BTN} disabled={index === 0}
              onClick={() => emit({ op: 'entry-move', sectionId: section.id, entryId: String(item.id), toIndex: index - 1 })}
            >
              Move up
            </button>
            <button
              type="button" className={BTN} disabled={index === list.length - 1}
              onClick={() => emit({ op: 'entry-move', sectionId: section.id, entryId: String(item.id), toIndex: index + 1 })}
            >
              Move down
            </button>
            <button
              type="button" className={DANGER}
              onClick={() => emit({ op: 'entry-remove', sectionId: section.id, entryId: String(item.id) })}
            >
              Remove
            </button>
          </div>
        </fieldset>
      ))}

      <button
        type="button"
        className="px-3 py-1.5 text-sm font-semibold rounded-lg border border-white/30 text-white hover:bg-white/10 transition"
        onClick={() => emit({ op: 'entry-add', sectionId: section.id, entryId: newId() })}
      >
        Add {entry.noun}
      </button>
    </div>
  )
}

/**
 * Clinical positions: the facts that ground an AI proposal, and the bullets
 * that actually render.
 *
 * The two are visibly separated and labelled, because V1 printed the fact
 * checkboxes onto the resume whenever bullets were missing and applicants had
 * no way to know that would happen.
 */
function PositionsEditor({
  section,
  newId,
  emit,
}: {
  section: Extract<ResumeSectionV2, { type: 'critical_care' | 'other_clinical' }>
  newId: () => string
  emit: (patch: StudioPatch) => void
}) {
  const TEXT_FACTS: [string, string][] = [
    ['employer', 'Employer'], ['location', 'Location'], ['role', 'Role'],
    ['unit', 'Unit'], ['unitType', 'Unit type'], ['acuity', 'Acuity'],
  ]

  return (
    <div className="space-y-4">
      {section.positions.map((position, index) => (
        <fieldset key={position.id} className="border border-white/15 rounded-xl p-3">
          <legend className="px-1 text-xs text-indigo-300">Position {index + 1}</legend>

          <div className="grid gap-3 sm:grid-cols-2">
            {TEXT_FACTS.map(([name, label]) => (
              <div key={name}>
                <label className="block text-xs font-semibold text-indigo-200 mb-1" htmlFor={`p-${position.id}-${name}`}>
                  {label}
                </label>
                <input
                  id={`p-${position.id}-${name}`}
                  className="w-full bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  value={String((position.facts as unknown as Record<string, unknown>)[name] ?? '')}
                  onChange={(e) =>
                    emit({ op: 'position-fact', sectionId: section.id, positionId: position.id, field: name, value: e.target.value })
                  }
                />
              </div>
            ))}
          </div>

          <div className="mt-3">
            <FieldInput
              descriptor={{ name: 'dates', label: 'Dates', kind: 'daterange' }}
              id={`p-${position.id}-dates`}
              value={position.facts.dates}
              onChange={(value) =>
                emit({ op: 'position-fact', sectionId: section.id, positionId: position.id, field: 'dates', value })
              }
            />
          </div>

          <p className="mt-4 text-xs text-indigo-300">
            These bullets are what appears on your resume. Everything above is context.
          </p>
          <ul className="mt-2 space-y-2">
            {position.bullets.map((bullet, i) => (
              <li key={`${position.id}-b${i}`} className="flex gap-2">
                <label className="sr-only" htmlFor={`b-${position.id}-${i}`}>Bullet {i + 1}</label>
                <textarea
                  id={`b-${position.id}-${i}`}
                  className="flex-1 bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white min-h-[3rem] focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  value={bullet.accepted}
                  onChange={(e) =>
                    emit({ op: 'bullet-text', sectionId: section.id, positionId: position.id, index: i, value: e.target.value })
                  }
                />
                <button
                  type="button" className={DANGER}
                  onClick={() => emit({ op: 'bullet-remove', sectionId: section.id, positionId: position.id, index: i })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2 mt-3">
            <button
              type="button" className={BTN}
              onClick={() => emit({ op: 'bullet-add', sectionId: section.id, positionId: position.id })}
            >
              Add bullet
            </button>
            <button
              type="button" className={DANGER}
              onClick={() => emit({ op: 'position-remove', sectionId: section.id, positionId: position.id })}
            >
              Remove position
            </button>
          </div>
        </fieldset>
      ))}

      <button
        type="button"
        className="px-3 py-1.5 text-sm font-semibold rounded-lg border border-white/30 text-white hover:bg-white/10 transition"
        onClick={() => emit({ op: 'position-add', sectionId: section.id, positionId: newId() })}
      >
        Add position
      </button>
    </div>
  )
}
