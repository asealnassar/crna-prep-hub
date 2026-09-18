import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultColumnFor, effectiveColumn, hasColumns, moveTargetIndex, otherColumn,
} from './columns.ts'
import { TEMPLATES } from '../document/templates.ts'
import { createSection } from '../model/sections.ts'
import { fromRows, toSavePayload } from '../repo/rows.ts'
import type { ResumeRow, SectionRow } from '../repo/rows.ts'
import { createResume } from '../model/resume.ts'
import type { ResumeSectionType, ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * Where a section is DRAWN.
 *
 * A layout choice, and only that. What order a section is READ in is decided by
 * `readingOrder` in the document layer, which ignores everything here.
 */

const NOW = '2026-09-10T12:00:00.000Z'
const section = (type: ResumeSectionType, over: Partial<ResumeSectionV2> = {}): ResumeSectionV2 =>
  ({ ...createSection(type, `sec-${type}`), ...over }) as ResumeSectionV2

// ------------------------------------------------------- which template

test('only the two-column template has columns at all', () => {
  assert.equal(hasColumns(TEMPLATES.modern), true)
  assert.equal(hasColumns(TEMPLATES.classic), false)
  assert.equal(hasColumns(TEMPLATES.compact), false)
})

test('a one-column template reports one column and offers no move', () => {
  for (const template of [TEMPLATES.classic, TEMPLATES.compact]) {
    assert.equal(effectiveColumn(template, section('education')), 'main', template.id)
    assert.equal(otherColumn(template, section('education')), null, template.id)
  }
})

// --------------------------------------------------- defaults stand

test('a section that has never been moved sits where the template says', () => {
  // Backward compatibility: every existing record carries no placement at all.
  for (const type of ['education', 'certifications', 'licensure', 'organizations', 'awards'] as const) {
    assert.equal(effectiveColumn(TEMPLATES.modern, section(type)), 'sidebar', type)
  }
  for (const type of ['summary', 'critical_care', 'shadowing', 'leadership', 'volunteer', 'quality_improvement'] as const) {
    assert.equal(effectiveColumn(TEMPLATES.modern, section(type)), 'main', type)
  }
})

test('the default is the template’s own list, not a second copy of it', () => {
  for (const type of TEMPLATES.modern.sidebarSections) {
    assert.equal(defaultColumnFor(TEMPLATES.modern, type), 'sidebar', type)
  }
})

// ------------------------------------------------ the applicant decides

test('a section moved to the sidebar is drawn in the sidebar', () => {
  const moved = section('critical_care', { modernColumn: 'sidebar' })
  assert.equal(effectiveColumn(TEMPLATES.modern, moved), 'sidebar')
  assert.equal(otherColumn(TEMPLATES.modern, moved), 'main', 'the move back is not offered')
})

test('a section moved to main is drawn in main', () => {
  const moved = section('certifications', { modernColumn: 'main' })
  assert.equal(effectiveColumn(TEMPLATES.modern, moved), 'main')
  assert.equal(otherColumn(TEMPLATES.modern, moved), 'sidebar')
})

test('Classic and Compact ignore a placement Modern wrote', () => {
  // The metadata rides along on the section; a single-column template has
  // nowhere to put it and must not act on it.
  const moved = section('certifications', { modernColumn: 'main' })
  for (const template of [TEMPLATES.classic, TEMPLATES.compact]) {
    assert.equal(effectiveColumn(template, moved), 'main', template.id)
    assert.equal(otherColumn(template, moved), null, template.id)
  }
})

// ------------------------------------------- up and down within a column

const modernSections: readonly ResumeSectionV2[] = [
  section('summary'),          // 0 main
  section('education'),        // 1 sidebar
  section('critical_care'),    // 2 main
  section('certifications'),   // 3 sidebar
  section('shadowing'),        // 4 main
]

test('up and down step past the neighbour in the same column', () => {
  // Swapping with a section drawn in the other column would rearrange the array
  // and change nothing on the page, which reads as a broken button.
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.modern, 2, 'up'), 0, 'main skipped past the sidebar')
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.modern, 2, 'down'), 4)
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.modern, 3, 'up'), 1, 'sidebar skipped past main')
})

test('the first and last of a column have nowhere to go', () => {
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.modern, 0, 'up'), null)
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.modern, 1, 'up'), null, 'the first sidebar section')
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.modern, 3, 'down'), null, 'the last sidebar section')
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.modern, 4, 'down'), null)
})

test('on a one-column template every section is a neighbour again', () => {
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.classic, 2, 'up'), 1)
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.classic, 0, 'up'), null)
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.classic, 4, 'down'), null)
})

test('a section that is not there is not moved', () => {
  assert.equal(moveTargetIndex(modernSections, TEMPLATES.modern, 99, 'up'), null)
})

// -------------------------------------------------------- it persists

/** A save and a read back, without a database. */
function roundTrip(resume: ResumeV2): ResumeV2 {
  const payload = toSavePayload(resume)
  const rows = payload.sections.map((s) => ({
    id: String(s.id), resume_id: resume.id, section_type: String(s.section_type),
    section_data: s.section_data, order_index: Number(s.order_index),
    visible: Boolean(s.visible), label: (s.label ?? null) as string | null,
  })) as SectionRow[]
  const row = {
    id: resume.id, user_id: resume.userId, title: resume.title, template_id: resume.template,
    created_at: NOW, updated_at: NOW, schema_version: 2, status: resume.status, revision: 1,
    strength_score: null, strength_computed_at: null, strength_revision: null,
  } as ResumeRow
  const read = fromRows(row, rows)
  assert.ok(read.resume, 'the resume did not survive the round trip')
  return read.resume!
}

test('a placement survives being saved and read back, with no new column', () => {
  const base = createResume({
    id: 'r1', userId: 'u1', title: 'T',
    sectionIds: Array.from({ length: 20 }, (_, i) => `s${i}`), now: NOW, template: 'modern',
  })
  const resume: ResumeV2 = {
    ...base,
    sections: [
      section('summary', { id: 'a', modernColumn: 'sidebar' }),
      section('certifications', { id: 'b', modernColumn: 'main' }),
      section('education', { id: 'c' }),
    ],
  }

  const back = roundTrip(resume)
  assert.equal(back.sections[0].modernColumn, 'sidebar', 'move to sidebar did not persist')
  assert.equal(back.sections[1].modernColumn, 'main', 'move to main did not persist')
  assert.equal(back.sections[2].modernColumn, undefined, 'an untouched section gained a placement')

  // It rides inside the section payload, so nothing in the row shape changed.
  const payload = toSavePayload(resume)
  const stored = payload.sections[0].section_data as Record<string, unknown>
  assert.equal(stored.modernColumn, 'sidebar')
  assert.deepEqual(
    Object.keys(payload.sections[0]).sort(),
    ['id', 'label', 'order_index', 'section_data', 'section_type', 'visible'],
    'the saved row grew a column'
  )
})

test('placement is remembered across a visit to a one-column template', () => {
  // Modern -> Classic -> Modern. The field lives on the section, not on the
  // template, so nothing has to be restored.
  const base = createResume({
    id: 'r1', userId: 'u1', title: 'T',
    sectionIds: Array.from({ length: 20 }, (_, i) => `s${i}`), now: NOW, template: 'modern',
  })
  const resume: ResumeV2 = {
    ...base, sections: [section('shadowing', { id: 'a', modernColumn: 'sidebar' })],
  }

  const asClassic = roundTrip({ ...resume, template: 'classic' })
  assert.equal(effectiveColumn(TEMPLATES.classic, asClassic.sections[0]), 'main', 'Classic acted on it')

  const backToModern = roundTrip({ ...asClassic, template: 'modern' })
  assert.equal(effectiveColumn(TEMPLATES.modern, backToModern.sections[0]), 'sidebar', 'the choice was forgotten')
})
