'use client'

import { CONTACT_FIELDS } from '@/lib/resume/studio/patch'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import { TEMPLATE_LIST } from '@/lib/resume/document/templates'
import type { ResumeSectionType, ResumeV2 } from '@/lib/resume/model/types'
import AddSectionMenu from './AddSectionMenu'
import SectionCard from './SectionCard'

const CONTACT_LABELS: Record<string, string> = {
  fullName: 'Full name', credentials: 'Credentials', email: 'Email', phone: 'Phone',
  city: 'City', state: 'State', linkedin: 'LinkedIn', website: 'Website',
}

const INPUT =
  'w-full bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-300'

/**
 * The left-hand side: the whole document, editable.
 *
 * Sections render in the applicant's own order and the DOM follows it, so the
 * editor reads in the same sequence as the resume it produces.
 */
export default function EditorPane({
  resume,
  openSections,
  pendingType,
  newId,
  emit,
  onToggleSection,
  onPendingTypeChange,
}: {
  resume: ResumeV2
  openSections: ReadonlySet<string>
  pendingType: ResumeSectionType | ''
  newId: () => string
  emit: (patch: StudioPatch) => void
  onToggleSection: (id: string) => void
  onPendingTypeChange: (type: ResumeSectionType | '') => void
}) {
  return (
    <div className="space-y-6">
      <section className="border border-white/20 bg-white/5 rounded-2xl p-4">
        <h2 className="text-white font-semibold mb-3">Your details</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {CONTACT_FIELDS.map((field) => (
            <div key={field}>
              <label className="block text-xs font-semibold text-indigo-200 mb-1" htmlFor={`c-${field}`}>
                {CONTACT_LABELS[field]}
              </label>
              <input
                id={`c-${field}`}
                className={INPUT}
                value={resume.contact[field]}
                onChange={(e) => emit({ op: 'contact', field, value: e.target.value })}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="border border-white/20 bg-white/5 rounded-2xl p-4">
        <h2 className="text-white font-semibold mb-3">Template</h2>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Template">
          {TEMPLATE_LIST.map((template) => {
            const active = resume.template === template.id
            return (
              <button
                key={template.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => emit({ op: 'template', template: template.id })}
                className={`text-left rounded-xl border p-3 transition ${
                  active ? 'border-white bg-white/15' : 'border-white/20 hover:bg-white/10'
                }`}
              >
                <span className="block text-white font-semibold text-sm">{template.name}</span>
                <span className="block text-indigo-200 text-xs mt-1">{template.summary}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-white font-semibold">Sections</h2>
        {resume.sections.map((section, index) => (
          <SectionCard
            key={section.id}
            section={section}
            index={index}
            count={resume.sections.length}
            open={openSections.has(section.id)}
            newId={newId}
            emit={emit}
            onToggleOpen={() => onToggleSection(section.id)}
          />
        ))}
      </section>

      <AddSectionMenu
        resume={resume}
        value={pendingType}
        onValueChange={onPendingTypeChange}
        onAdd={(type) => {
          emit({ op: 'section-add', sectionType: type, sectionId: newId() })
          onPendingTypeChange('')
        }}
      />
    </div>
  )
}
