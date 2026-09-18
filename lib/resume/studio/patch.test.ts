import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyPatch, applyPatches, addableSectionTypes } from './patch.ts'
import type { StudioPatch } from './patch.ts'
import { descriptorFor, blankEntry, listKeyFor } from './fields.ts'
import { createResume, findSection, renderableSections } from '../model/resume.ts'
import { createSection } from '../model/sections.ts'
import { SECTION_TYPES } from '../model/types.ts'
import type { ResumeSectionType, ResumeSectionV2, ResumeV2 } from '../model/types.ts'
import { planDocument, textOf } from '../document/plan.ts'

const NOW = '2026-09-10T12:00:00.000Z'
const LATER = '2026-09-10T13:00:00.000Z'
const CTX = { now: LATER }
const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

function base(types: readonly ResumeSectionType[] = ['summary', 'education']): ResumeV2 {
  const resume = createResume({
    id: U(1), userId: 'u1', title: 'Test',
    sectionIds: types.map((_, i) => U(100 + i)), now: NOW, sectionTypes: types,
  })
  return resume
}

const apply = (r: ResumeV2, ...patches: StudioPatch[]) => applyPatches(r, patches, CTX)

// -------------------------------------------------------- add / remove

test('adding a section appends it and bumps the revision', () => {
  const before = base()
  const after = apply(before, { op: 'section-add', sectionType: 'awards', sectionId: U(9) })
  assert.equal(after.sections.length, before.sections.length + 1)
  assert.equal(after.sections[after.sections.length - 1].type, 'awards')
  assert.equal(after.revision, before.revision + 1)
})

test('a newly added section is empty, so it does not render', () => {
  const after = apply(base(), { op: 'section-add', sectionType: 'awards', sectionId: U(9) })
  assert.equal(renderableSections(after).length, 0)
  assert.deepEqual(planDocument(after).blocks, [])
})

test('removing a section takes only that section', () => {
  const before = base(['summary', 'education', 'awards'])
  const target = before.sections[1].id
  const after = apply(before, { op: 'section-remove', sectionId: target })
  assert.deepEqual(after.sections.map((s) => s.id), [before.sections[0].id, before.sections[2].id])
})

test('removing a section that is not there changes nothing', () => {
  const before = base()
  assert.equal(apply(before, { op: 'section-remove', sectionId: U(999) }), before)
})

test('every section type can be added', () => {
  let resume = base([])
  for (const [i, type] of SECTION_TYPES.entries()) {
    resume = apply(resume, { op: 'section-add', sectionType: type, sectionId: U(200 + i) })
  }
  assert.deepEqual(resume.sections.map((s) => s.type), [...SECTION_TYPES])
})

test('the add menu stops offering a type once it is present, except custom', () => {
  const resume = base(['summary'])
  const offered = addableSectionTypes(resume)
  assert.equal(offered.includes('summary'), false)
  assert.equal(offered.includes('custom'), true)

  const withCustom = apply(resume, { op: 'section-add', sectionType: 'custom', sectionId: U(9) })
  assert.equal(addableSectionTypes(withCustom).includes('custom'), true, 'custom stays available')
})

// ------------------------------------------------------------ reorder

test('moving a section changes order and nothing else', () => {
  const before = base(['summary', 'education', 'awards'])
  const after = apply(before, { op: 'section-move', sectionId: before.sections[2].id, toIndex: 0 })
  assert.deepEqual(after.sections.map((s) => s.type), ['awards', 'summary', 'education'])
  assert.deepEqual(new Set(after.sections.map((s) => s.id)), new Set(before.sections.map((s) => s.id)))
})

test('a move past the end clamps rather than dropping the section', () => {
  const before = base(['summary', 'education'])
  const after = apply(before, { op: 'section-move', sectionId: before.sections[0].id, toIndex: 99 })
  assert.equal(after.sections.length, 2)
  assert.equal(after.sections[1].type, 'summary')
})

test('an explicit reorder is honoured', () => {
  const before = base(['summary', 'education', 'awards'])
  const reversed = [...before.sections].reverse().map((s) => s.id)
  const after = apply(before, { op: 'section-reorder', orderedIds: reversed })
  assert.deepEqual(after.sections.map((s) => s.id), reversed)
})

test('document order follows section order', () => {
  let resume = base(['summary', 'awards'])
  resume = apply(resume,
    { op: 'summary', sectionId: resume.sections[0].id, value: 'A summary.' },
    { op: 'entry-add', sectionId: resume.sections[1].id, entryId: U(50) },
    { op: 'field', sectionId: resume.sections[1].id, entryId: U(50), field: 'title', value: 'DAISY Award' })

  assert.deepEqual(planDocument(resume).blocks.map((b) => b.sectionType), ['summary', 'awards'])
  const flipped = apply(resume, { op: 'section-move', sectionId: resume.sections[1].id, toIndex: 0 })
  assert.deepEqual(planDocument(flipped).blocks.map((b) => b.sectionType), ['awards', 'summary'])
})

// --------------------------------------------------------------- hide

test('hiding keeps the data and removes it from the document', () => {
  let resume = base(['summary'])
  const id = resume.sections[0].id
  resume = apply(resume, { op: 'summary', sectionId: id, value: 'Six years in a medical ICU.' })
  assert.equal(planDocument(resume).blocks.length, 1)

  const hidden = apply(resume, { op: 'section-visible', sectionId: id, visible: false })
  assert.deepEqual(planDocument(hidden).blocks, [], 'hidden sections do not render')

  const shown = apply(hidden, { op: 'section-visible', sectionId: id, visible: true })
  assert.equal(textOf(planDocument(shown)).join(' ').includes('Six years in a medical ICU.'), true)
})

// ------------------------------------------------------------- fields

test('a text field is written through its descriptor', () => {
  let resume = base(['education'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'entry-add', sectionId, entryId: U(50) },
    { op: 'field', sectionId, entryId: U(50), field: 'institution', value: 'Rutgers University' })

  const printed = textOf(planDocument(resume)).join(' | ')
  assert.ok(printed.includes('Rutgers University'))
})

test('a field the descriptor does not declare is ignored', () => {
  let resume = base(['education'])
  const sectionId = resume.sections[0].id
  resume = apply(resume, { op: 'entry-add', sectionId, entryId: U(50) })
  const before = resume

  const after = apply(resume,
    { op: 'field', sectionId, entryId: U(50), field: 'user_id', value: 'someone-else' } as StudioPatch)
  assert.equal(after, before, 'an undeclared field must not be written')
})

test('every declared field of every section type can be written', () => {
  for (const type of SECTION_TYPES) {
    const descriptor = descriptorFor(type)
    if (descriptor.shape !== 'entries' || !descriptor.entry) continue

    let resume = base([type])
    const sectionId = resume.sections[0].id
    resume = apply(resume, { op: 'entry-add', sectionId, entryId: U(50) })

    for (const field of descriptor.entry.fields) {
      const value =
        field.kind === 'boolean' ? true
          : field.kind === 'daterange' ? { start: '2021-03', end: '2023-06', isCurrent: false }
            : field.kind === 'gpa' ? { raw: '3.85', showOnResume: true }
              : field.kind === 'date' ? '2021-03'
                : 'written'
      const after = apply(resume, { op: 'field', sectionId, entryId: U(50), field: field.name, value })
      assert.notEqual(after, resume, `${type}.${field.name} was not written`)
      resume = after
    }
  }
})

test('a GPA written through a patch defaults to hidden unless asked for', () => {
  let resume = base(['education'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'entry-add', sectionId, entryId: U(50) },
    { op: 'field', sectionId, entryId: U(50), field: 'institution', value: 'Rutgers' },
    { op: 'field', sectionId, entryId: U(50), field: 'overallGpa', value: { raw: '3.85' } })
  assert.equal(textOf(planDocument(resume)).join(' ').includes('3.85'), false)

  const shown = apply(resume,
    { op: 'field', sectionId, entryId: U(50), field: 'overallGpa', value: { raw: '3.85', showOnResume: true } })
  assert.equal(textOf(planDocument(shown)).join(' ').includes('GPA 3.85'), true)
})

test('editing authored text goes through the model, preserving provenance', () => {
  let resume = base(['awards'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'entry-add', sectionId, entryId: U(50) },
    { op: 'field', sectionId, entryId: U(50), field: 'detail', value: 'First words.' },
    { op: 'field', sectionId, entryId: U(50), field: 'detail', value: 'Second words.' })

  const section = findSection(resume, sectionId) as Extract<ResumeSectionV2, { type: 'awards' }>
  const detail = section.awards[0].detail

  assert.equal(detail.accepted, 'Second words.')
  assert.equal(detail.userSource, 'Second words.', 'the latest human text is what Restore My Text returns')
  assert.equal(detail.origin, 'user')
  assert.equal(detail.history[0].text, 'First words.', 'the previous text is recoverable')

  // An entry created blank in the Studio was, truthfully, originally blank. The
  // model locks `originalSource` at creation and no later edit may move it --
  // which is the Phase 1 correction working, not a defect. The consequence for
  // Phase 8: "Restore original" must be hidden when originalSource is empty,
  // because there it would erase rather than restore. `restoreUserText` is the
  // affordance that matters for text written here.
  assert.equal(detail.originalSource, '', 'blank at creation, and immutable after')
})

test('rewriting a field with the value it already holds is not an edit', () => {
  let resume = base(['education'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'entry-add', sectionId, entryId: U(50) },
    { op: 'field', sectionId, entryId: U(50), field: 'institution', value: 'Rutgers' })

  const again = apply(resume, { op: 'field', sectionId, entryId: U(50), field: 'institution', value: 'Rutgers' })
  assert.equal(again, resume, 'an identical write must not bump the revision')
  assert.equal(again.revision, resume.revision)
})

// ---------------------------------------------------------- entries

test('entries are added, moved and removed', () => {
  let resume = base(['certifications'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'entry-add', sectionId, entryId: U(50) },
    { op: 'entry-add', sectionId, entryId: U(51) },
    { op: 'field', sectionId, entryId: U(50), field: 'name', value: 'CCRN' },
    { op: 'field', sectionId, entryId: U(51), field: 'name', value: 'TNCC' })

  let block = planDocument(resume).blocks[0]
  assert.ok(block.kind === 'entries')
  if (block.kind === 'entries') assert.deepEqual(block.entries.map((e) => e.title), ['CCRN', 'TNCC'])

  resume = apply(resume, { op: 'entry-move', sectionId, entryId: U(51), toIndex: 0 })
  block = planDocument(resume).blocks[0]
  if (block.kind === 'entries') assert.deepEqual(block.entries.map((e) => e.title), ['TNCC', 'CCRN'])

  resume = apply(resume, { op: 'entry-remove', sectionId, entryId: U(51) })
  block = planDocument(resume).blocks[0]
  if (block.kind === 'entries') assert.deepEqual(block.entries.map((e) => e.title), ['CCRN'])
})

test('a blank entry declares every field its descriptor does', () => {
  for (const type of SECTION_TYPES) {
    const descriptor = descriptorFor(type)
    if (!descriptor.entry) continue
    const entry = blankEntry(type, 'x')
    for (const field of descriptor.entry.fields) {
      assert.ok(field.name in entry, `${type}.${field.name} missing from a blank entry`)
    }
    assert.equal(listKeyFor(type), descriptor.entry.listKey)
  }
})

// -------------------------------------------------- clinical positions

test('a position takes facts and bullets, and only bullets render', () => {
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'position-add', sectionId, positionId: U(60) },
    { op: 'position-fact', sectionId, positionId: U(60), field: 'employer', value: 'University Hospital' },
    { op: 'position-fact', sectionId, positionId: U(60), field: 'devices', value: ['Ventilator', 'CRRT'] },
    { op: 'position-fact', sectionId, positionId: U(60), field: 'chargeExperience', value: true },
    { op: 'bullet-add', sectionId, positionId: U(60) },
    { op: 'bullet-text', sectionId, positionId: U(60), index: 0, value: 'Titrated vasoactive infusions.' })

  const printed = textOf(planDocument(resume)).join(' | ')
  assert.ok(printed.includes('University Hospital'))
  assert.ok(printed.includes('Titrated vasoactive infusions.'))
  assert.equal(printed.includes('Ventilator'), false, 'grounding must not render')
  assert.equal(printed.includes('CRRT'), false, 'grounding must not render')
})

test('a fact the model does not have is refused', () => {
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  resume = apply(resume, { op: 'position-add', sectionId, positionId: U(60) })
  const after = apply(resume,
    { op: 'position-fact', sectionId, positionId: U(60), field: 'salary', value: '120000' } as StudioPatch)
  assert.equal(after, resume)
})

test('bullets are removed by index without disturbing their neighbours', () => {
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'position-add', sectionId, positionId: U(60) },
    { op: 'position-fact', sectionId, positionId: U(60), field: 'employer', value: 'UH' },
    { op: 'bullet-add', sectionId, positionId: U(60) },
    { op: 'bullet-add', sectionId, positionId: U(60) },
    { op: 'bullet-add', sectionId, positionId: U(60) },
    { op: 'bullet-text', sectionId, positionId: U(60), index: 0, value: 'One.' },
    { op: 'bullet-text', sectionId, positionId: U(60), index: 1, value: 'Two.' },
    { op: 'bullet-text', sectionId, positionId: U(60), index: 2, value: 'Three.' })

  resume = apply(resume, { op: 'bullet-remove', sectionId, positionId: U(60), index: 1 })
  const block = planDocument(resume).blocks[0]
  assert.ok(block.kind === 'entries')
  if (block.kind === 'entries') assert.deepEqual(block.entries[0].detail, ['One.', 'Three.'])
})

test('a bullet index out of range is a no-op, not a crash', () => {
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  resume = apply(resume, { op: 'position-add', sectionId, positionId: U(60) })
  for (const patch of [
    { op: 'bullet-remove', sectionId, positionId: U(60), index: 7 },
    { op: 'bullet-text', sectionId, positionId: U(60), index: 7, value: 'x' },
  ] as StudioPatch[]) {
    assert.equal(apply(resume, patch), resume, patch.op)
  }
})

// ---------------------------------------------------- resume-level

test('the template switches', () => {
  const after = apply(base(), { op: 'template', template: 'compact' })
  assert.equal(after.template, 'compact')
  assert.equal(apply(after, { op: 'template', template: 'compact' }), after, 'a no-op does not bump')
})

test('contact fields are written one at a time', () => {
  const after = apply(base(),
    { op: 'contact', field: 'fullName', value: 'Jane Doe' },
    { op: 'contact', field: 'credentials', value: 'BSN, RN, CCRN' })
  assert.equal(planDocument(after).name, 'Jane Doe, BSN, RN, CCRN')
})

test('a custom section can be titled', () => {
  let resume = base([])
  resume = apply(resume,
    { op: 'section-add', sectionType: 'custom', sectionId: U(9) },
    { op: 'section-heading', sectionId: U(9), value: 'Languages' },
    { op: 'entry-add', sectionId: U(9), entryId: U(50) },
    { op: 'field', sectionId: U(9), entryId: U(50), field: 'title', value: 'Spanish' })
  assert.equal(planDocument(resume).blocks[0].heading, 'Languages')
})

test('a section label overrides the heading and clears back to the default', () => {
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'position-add', sectionId, positionId: U(60) },
    { op: 'position-fact', sectionId, positionId: U(60), field: 'employer', value: 'UH' },
    { op: 'section-label', sectionId, label: 'ICU Experience' })
  assert.equal(planDocument(resume).blocks[0].heading, 'ICU Experience')

  const cleared = apply(resume, { op: 'section-label', sectionId, label: null })
  assert.notEqual(planDocument(cleared).blocks[0].heading, 'ICU Experience')
})

test('a heading keeps the spaces the applicant types', () => {
  // The trim ran on every keystroke, so the space between two words vanished as
  // it was typed: "Critical Care Experience" could only ever be saved as
  // "CriticalCareExperience", and nobody could see why.
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  for (const label of [
    'Critical', 'Critical ', 'Critical C', 'Critical Care', 'Critical Care ',
    'Critical Care Experience',
  ]) {
    resume = apply(resume, { op: 'section-label', sectionId, label })
  }
  assert.equal(resume.sections[0].label, 'Critical Care Experience')
})

test('a label that is only whitespace is no label', () => {
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  resume = apply(resume, { op: 'section-label', sectionId, label: '   ' })
  assert.equal(resume.sections[0].label, null)
})

test('a stray space at the end does not print', () => {
  // Stored as typed, trimmed when read: mid-word spaces survive and edge ones
  // never reach the page.
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'position-add', sectionId, positionId: U(60) },
    { op: 'position-fact', sectionId, positionId: U(60), field: 'employer', value: 'UH' },
    { op: 'section-label', sectionId, label: ' Critical Care Experience ' })
  assert.equal(planDocument(resume).blocks[0].heading, 'Critical Care Experience')
})

test('Education cannot be relabelled: the patch changes nothing', () => {
  // A programme reads the resume looking for the word "Education". Rows saved
  // before the heading was fixed still carry labels like "Academics", and they
  // are ignored rather than migrated away.
  const before = base(['education'])
  const sectionId = before.sections[0].id
  const after = apply(before, { op: 'section-label', sectionId, label: 'Academics' })
  assert.equal(after, before, 'the resume was rewritten for a heading that cannot change')
})

test('a Professional Summary cannot be relabelled: the patch changes nothing', () => {
  const before = base(['summary'])
  const sectionId = before.sections[0].id
  const after = apply(before, { op: 'section-label', sectionId, label: 'About Me' })
  assert.equal(after, before, 'the resume was rewritten for a heading that cannot change')
})

test('a stale editor sending a summary label still saves the summary text beside it', () => {
  // A tab opened before the heading was locked still shows the input. Its label
  // edit has to vanish without taking the rest of that save down with it.
  const before = base(['summary'])
  const sectionId = before.sections[0].id
  const after = apply(before,
    { op: 'section-label', sectionId, label: 'About Me' },
    { op: 'summary', sectionId, value: 'Six years in a medical ICU.' })

  assert.equal(after.sections[0].label, null, 'the label was written')
  assert.equal(planDocument(after).blocks[0].heading, 'Professional Summary')
  assert.ok(
    textOf(planDocument(after)).join(' ').includes('Six years in a medical ICU.'),
    'the summary text was lost'
  )
})

// ------------------------------------------------ the editor, as source

/**
 * There is no DOM runner, so the editor is checked as source -- the approach
 * ai/coverage.test.ts already takes with SectionEditor. Comments are stripped
 * first, so prose about the heading can never satisfy an assertion about code.
 */
function sectionCardCode(): string {
  const file = fileURLToPath(
    new URL('../../../app/resume-studio/components/studio/SectionCard.tsx', import.meta.url)
  )
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1
const HEADING_GATE = '{!hasFixedHeading(section.type) && ('

test('the heading editor is hidden, not disabled, for a fixed-heading section', () => {
  const card = sectionCardCode()
  assert.match(
    card, /import \{[^}]*\bhasFixedHeading\b[^}]*\} from '@\/lib\/resume\/model\/sections'/,
    'the gate must use the model rule, not a local copy of it'
  )

  const gate = card.indexOf(HEADING_GATE)
  const editor = card.indexOf('<SectionEditor')
  assert.ok(gate > 0, 'the heading editor is not gated on hasFixedHeading')
  assert.ok(editor > gate, 'the content editor should follow the gated heading controls')

  const gated = card.slice(gate, editor)
  for (const needle of ['Heading on the resume', "op: 'section-label'"]) {
    assert.equal(occurrences(card, needle), 1, `"${needle}" appears more than once, so a copy may be ungated`)
    assert.ok(gated.includes(needle), `"${needle}" is outside the gate`)
  }
  assert.equal(/\bdisabled\b/.test(gated), false, 'the heading editor is disabled rather than hidden')
})

test('the summary content editor is not swallowed by the heading gate', () => {
  // A misplaced closing paren-brace would hide the whole editor for a summary:
  // a fixed heading over a summary nobody can edit. The gate has closed before
  // the content editor exactly when the braces between the two balance.
  const card = sectionCardCode()
  const gate = card.indexOf(HEADING_GATE)
  const editor = card.indexOf('<SectionEditor')
  assert.ok(gate > 0 && editor > gate, 'no heading gate precedes the content editor')
  const between = card.slice(gate, editor)
  assert.equal(occurrences(between, '{'), occurrences(between, '}'), 'SectionEditor sits inside the heading gate')
})

// --------------------------------------------------------------- safety

// ------------------------------------------------ Modern column placement

test('a section can be moved to the sidebar and back to the default', () => {
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id

  resume = apply(resume, { op: 'section-column', sectionId, column: 'sidebar' })
  assert.equal(resume.sections[0].modernColumn, 'sidebar')

  resume = apply(resume, { op: 'section-column', sectionId, column: 'main' })
  assert.equal(resume.sections[0].modernColumn, 'main')

  // Cleared by removing the field: "the template decides" is what its absence
  // means, so a section moved and moved back must be indistinguishable from one
  // that was never touched.
  resume = apply(resume, { op: 'section-column', sectionId, column: null })
  assert.equal(resume.sections[0].modernColumn, undefined)
  assert.equal('modernColumn' in resume.sections[0], false, 'a cleared placement left a key behind')
})

test('moving a section between columns is an edit, so Strength goes stale', () => {
  // The same rule as a reorder: the revision moves, and a score computed for the
  // previous revision no longer describes this document.
  const before = base(['critical_care'])
  const sectionId = before.sections[0].id
  const after = apply(before, { op: 'section-column', sectionId, column: 'sidebar' })
  assert.ok(after.revision > before.revision, 'the revision did not move')
})

test('moving a section to the column it is already in changes nothing', () => {
  const before = apply(base(['critical_care']), {
    op: 'section-column', sectionId: base(['critical_care']).sections[0].id, column: 'sidebar',
  })
  const same = apply(before, { op: 'section-column', sectionId: before.sections[0].id, column: 'sidebar' })
  assert.equal(same, before, 'a no-op edit bumped the revision')
})

test('a placement changes where a section is drawn and nothing it says', () => {
  let resume = base(['critical_care'])
  const sectionId = resume.sections[0].id
  resume = apply(resume,
    { op: 'position-add', sectionId, positionId: U(60) },
    { op: 'position-fact', sectionId, positionId: U(60), field: 'employer', value: 'UH' })

  const before = textOf(planDocument(resume))
  const after = textOf(planDocument(apply(resume, { op: 'section-column', sectionId, column: 'sidebar' })))
  assert.deepEqual(after, before, 'a layout choice changed the content of the resume')
})

test('a patch for a section that no longer exists is a no-op', () => {
  const resume = base()
  const gone = U(777)
  const patches: StudioPatch[] = [
    { op: 'section-remove', sectionId: gone },
    { op: 'section-visible', sectionId: gone, visible: false },
    { op: 'section-label', sectionId: gone, label: 'x' },
    { op: 'section-column', sectionId: gone, column: 'sidebar' },
    { op: 'entry-add', sectionId: gone, entryId: U(50) },
    { op: 'entry-remove', sectionId: gone, entryId: U(50) },
    { op: 'field', sectionId: gone, entryId: U(50), field: 'title', value: 'x' },
    { op: 'position-add', sectionId: gone, positionId: U(60) },
    { op: 'bullet-add', sectionId: gone, positionId: U(60) },
  ]
  for (const patch of patches) assert.equal(apply(resume, patch), resume, patch.op)
})

test('applying patches never mutates the resume it was given', () => {
  const resume = base(['summary', 'education'])
  const snapshot = JSON.stringify(resume)
  apply(resume,
    { op: 'summary', sectionId: resume.sections[0].id, value: 'Changed.' },
    { op: 'entry-add', sectionId: resume.sections[1].id, entryId: U(50) },
    { op: 'section-move', sectionId: resume.sections[0].id, toIndex: 1 })
  assert.equal(JSON.stringify(resume), snapshot)
})

test('a run of patches is the same as applying them one at a time', () => {
  const resume = base(['summary', 'education'])
  const patches: StudioPatch[] = [
    { op: 'contact', field: 'fullName', value: 'Jane Doe' },
    { op: 'summary', sectionId: resume.sections[0].id, value: 'Words.' },
    { op: 'entry-add', sectionId: resume.sections[1].id, entryId: U(50) },
  ]
  const batched = applyPatches(resume, patches, CTX)
  const oneByOne = patches.reduce((r, p) => applyPatch(r, p, CTX), resume)
  assert.deepEqual(batched, oneByOne)
})

test('an empty run changes nothing', () => {
  const resume = base()
  assert.equal(applyPatches(resume, [], CTX), resume)
})
