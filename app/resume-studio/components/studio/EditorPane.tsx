'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { CONTACT_FIELDS } from '@/lib/resume/studio/patch'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import { moveTargetIndex } from '@/lib/resume/studio/columns'
import { templateFor } from '@/lib/resume/document/templates'
import { isImportReviewSection } from '@/lib/resume/model/importReview'
import type { ResumeSectionType, ResumeV2 } from '@/lib/resume/model/types'
import { Card, TextField, cx, focusRing, text } from '../ui'
import AddSectionMenu from './AddSectionMenu'
import ImportReviewPanel from './ImportReviewPanel'
import SectionCard from './SectionCard'

const CONTACT_LABELS: Record<string, string> = {
  fullName: 'Full name', credentials: 'Credentials', email: 'Email', phone: 'Phone',
  city: 'City', state: 'State', linkedin: 'LinkedIn', website: 'Website',
}

const CONTACT_PLACEHOLDERS: Record<string, string> = {
  credentials: 'BSN, RN, CCRN',
  website: 'Optional',
}

/**
 * The editing side: the whole document, editable.
 *
 * Sections render in the applicant's own order and the DOM follows it, so the
 * editor reads in the same sequence as the resume it produces. The template
 * choice lives above the preview, beside the page it changes.
 */
export default function EditorPane({
  resume,
  openSections,
  pendingType,
  newId,
  emit,
  unsaved,
  onFlush,
  onToggleSection,
  onPendingTypeChange,
  compact = false,
}: {
  resume: ResumeV2
  openSections: ReadonlySet<string>
  pendingType: ResumeSectionType | ''
  newId: () => string
  emit: (patch: StudioPatch) => void
  /** Edits are queued or in flight. An AI request must wait for them. */
  unsaved: boolean
  /** Saves the queue now rather than at the end of the debounce. */
  onFlush: () => void
  onToggleSection: (id: string) => void
  onPendingTypeChange: (type: ResumeSectionType | '') => void
  /** Phone layout. Presentation only. */
  compact?: boolean
}) {
  // Open on a desktop and folded on a phone, until the applicant chooses.
  const [detailsChoice, setDetailsChoice] = useState<boolean | null>(null)
  const detailsOpen = detailsChoice ?? !compact
  // Up and down move a section past its neighbour in the SAME column: on a
  // two-column template, swapping with something drawn in the other column
  // would rearrange the array and change nothing anyone can see.
  const template = templateFor(resume.template)
  const who = [resume.contact.fullName, resume.contact.credentials].filter(Boolean).join(', ')
  // What an import could not place is its own panel, not a section card: it is
  // not part of the resume, and moving a real section past it would change
  // nothing anyone can see.
  const sections = resume.sections.filter((section) => !isImportReviewSection(section))
  const absoluteIndex = (target: number | null) =>
    target === null ? null : resume.sections.indexOf(sections[target])

  return (
    <div className="space-y-3">
      <ImportReviewPanel resume={resume} newId={newId} emit={emit} onFlush={onFlush} compact={compact} />

      <Card as="section" aria-label="Your details">
        <button
          type="button"
          onClick={() => setDetailsChoice(!detailsOpen)}
          aria-expanded={detailsOpen}
          aria-controls="your-details"
          className={cx('flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left', focusRing)}
        >
          <ChevronRight className={cx('h-4 w-4 shrink-0 text-slate-400 transition-transform', detailsOpen && 'rotate-90')} aria-hidden="true" />
          <span className={text.heading}>Your details</span>
          {!detailsOpen && who && <span className={cx('truncate text-xs', text.muted)}>{who}</span>}
        </button>
        {detailsOpen && (
          <div id="your-details" className="grid gap-3 border-t border-slate-100 px-4 pb-4 pt-3.5 sm:grid-cols-2">
            {CONTACT_FIELDS.map((field) => (
              <TextField
                key={field}
                id={`c-${field}`}
                label={CONTACT_LABELS[field]}
                value={resume.contact[field]}
                placeholder={CONTACT_PLACEHOLDERS[field]}
                onChange={(e) => emit({ op: 'contact', field, value: e.target.value })}
              />
            ))}
          </div>
        )}
      </Card>

      {sections.map((section, index) => (
        <SectionCard
          key={section.id}
          section={section}
          resumeId={resume.id}
          template={template}
          moveUpTo={absoluteIndex(moveTargetIndex(sections, template, index, 'up'))}
          moveDownTo={absoluteIndex(moveTargetIndex(sections, template, index, 'down'))}
          open={openSections.has(section.id)}
          newId={newId}
          emit={emit}
          unsaved={unsaved}
          onFlush={onFlush}
          onToggleOpen={() => onToggleSection(section.id)}
          compact={compact}
        />
      ))}

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
