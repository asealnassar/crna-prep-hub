import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SECTION_TYPES, DEFAULT_TEMPLATE, addSection, attachStrength, createResume,
  findSection, isStrengthStale, moveSection, removeSection, renderableSections,
  reorderSections, replaceSection, sectionsOfType, setSectionVisibility, setStatus,
  setTemplate, setTitle,
} from './resume.ts'
import { createSection } from './sections.ts'
import { createAuthoredText } from './authoredText.ts'
import type { ResumeSectionV2, ResumeV2 } from './types.ts'

const NOW = '2026-09-10T10:00:00.000Z'
const LATER = '2026-09-10T11:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `sec-${i}`)

function newResume(): ResumeV2 {
  return createResume({
    id: 'r1', userId: 'u1', title: 'My Resume',
    sectionIds: ids(DEFAULT_SECTION_TYPES.length), now: NOW,
  })
}

test('a new resume is a draft with the default template and sections', () => {
  const r = newResume()
  assert.equal(r.schemaVersion, 2)
  assert.equal(r.status, 'draft')
  assert.equal(r.template, DEFAULT_TEMPLATE)
  assert.equal(r.revision, 1)
  assert.equal(r.sections.length, DEFAULT_SECTION_TYPES.length)
  assert.deepEqual(r.sections.map((s) => s.type), [...DEFAULT_SECTION_TYPES])
  assert.equal(r.strength, null)
  assert.equal(r.importedFrom, null)
})

test('only the three surviving templates are valid', () => {
  const r = newResume()
  for (const t of ['classic', 'modern', 'compact'] as const) {
    assert.equal(setTemplate(r, t, LATER).template, t)
  }
  // Creative and ATS-Optimized are retired; these would not compile:
  // setTemplate(r, 'creative', LATER)
  // setTemplate(r, 'ats', LATER)
})

test('a new resume renders nothing until it has content', () => {
  assert.deepEqual(renderableSections(newResume()), [], 'empty sections do not render')
})

test('creation is deterministic and refuses to guess ids', () => {
  const a = newResume(), b = newResume()
  assert.deepEqual(a.sections.map((s) => s.id), b.sections.map((s) => s.id))
  assert.throws(
    () => createResume({ id: 'r', userId: 'u', title: 't', sectionIds: ['only-one'], now: NOW }),
    /section ids/
  )
})

// ------------------------------------------------------------- ordering

test('array order is the display order', () => {
  const r = newResume()
  const originalOrder = r.sections.map((s) => s.id)
  const moved = moveSection(r, originalOrder[3], 0, LATER)
  assert.equal(moved.sections[0].id, originalOrder[3])
  assert.equal(moved.sections.length, r.sections.length, 'nothing lost')
  assert.equal(moved.revision, r.revision + 1)
})

test('moving out of range clamps instead of throwing', () => {
  const r = newResume()
  const last = r.sections[r.sections.length - 1].id
  assert.equal(moveSection(r, r.sections[0].id, 999, LATER).sections.at(-1)?.id, r.sections[0].id)
  assert.equal(moveSection(r, last, -5, LATER).sections[0].id, last)
})

test('moving an unknown section, or to its current place, is a no-op', () => {
  const r = newResume()
  assert.equal(moveSection(r, 'nope', 0, LATER), r)
  assert.equal(moveSection(r, r.sections[2].id, 2, LATER), r)
})

test('an explicit reorder never drops a section it was not told about', () => {
  const r = newResume()
  const partial = [r.sections[4].id, r.sections[1].id]
  const reordered = reorderSections(r, partial, LATER)
  assert.equal(reordered.sections.length, r.sections.length, 'omitted sections survive')
  assert.deepEqual(reordered.sections.slice(0, 2).map((s) => s.id), partial)
  const allIds = new Set(reordered.sections.map((s) => s.id))
  for (const s of r.sections) assert.ok(allIds.has(s.id), `${s.type} still present`)
})

test('a reorder naming unknown ids is tolerated', () => {
  const r = newResume()
  const reordered = reorderSections(r, ['ghost', r.sections[2].id, 'phantom'], LATER)
  assert.equal(reordered.sections.length, r.sections.length)
  assert.equal(reordered.sections[0].id, r.sections[2].id)
})

test('a no-op reorder does not bump the revision', () => {
  const r = newResume()
  assert.equal(reorderSections(r, r.sections.map((s) => s.id), LATER), r)
})

// ----------------------------------------------------------- visibility

test('hiding and showing preserves data and bumps the revision', () => {
  const r = newResume()
  const id = r.sections[0].id
  const hidden = setSectionVisibility(r, id, false, LATER)
  assert.equal(findSection(hidden, id)?.visible, false)
  assert.equal(hidden.revision, r.revision + 1)
  assert.equal(setSectionVisibility(hidden, id, false, LATER), hidden, 'no-op')
  assert.equal(findSection(setSectionVisibility(hidden, id, true, LATER), id)?.visible, true)
})

// ------------------------------------------------------ add / remove

test('sections can be added, including duplicates of a type', () => {
  const r = newResume()
  const withCustom = addSection(r, 'custom', 'c1', LATER, { heading: 'Military Service' })
  const second = addSection(withCustom, 'custom', 'c2', LATER, { heading: 'Languages' })
  assert.equal(sectionsOfType(second, 'custom').length, 2)
  assert.equal(second.sections.at(-1)?.id, 'c2', 'appended in order')
})

test('all fifteen types can be added to a resume', () => {
  let r = newResume()
  const already = new Set(r.sections.map((s) => s.type))
  let i = 0
  for (const type of ['other_clinical', 'quality_improvement', 'research',
    'organizations', 'awards', 'volunteer', 'publications', 'custom'] as const) {
    if (already.has(type)) continue
    r = addSection(r, type, `add-${i++}`, LATER)
  }
  assert.equal(new Set(r.sections.map((s) => s.type)).size, 15)
})

test('removing a section works and an unknown id is a no-op', () => {
  const r = newResume()
  const id = r.sections[1].id
  const removed = removeSection(r, id, LATER)
  assert.equal(removed.sections.length, r.sections.length - 1)
  assert.equal(findSection(removed, id), null)
  assert.equal(removeSection(r, 'nope', LATER), r)
})

test('replacing a section swaps content and bumps the revision', () => {
  const r = newResume()
  const summary = r.sections.find((s) => s.type === 'summary')!
  const filled: ResumeSectionV2 = { ...summary, text: createAuthoredText('hello') } as ResumeSectionV2
  const updated = replaceSection(r, filled, LATER)
  assert.equal(renderableSections(updated).length, 1, 'now it renders')
  assert.equal(updated.revision, r.revision + 1)
  assert.equal(replaceSection(r, createSection('summary', 'ghost'), LATER), r, 'unknown id is a no-op')
})

// ---------------------------------------------------------- metadata

test('title and status transport values without asserting rules', () => {
  const r = newResume()
  assert.equal(setTitle(r, '  Trimmed  ', LATER).title, 'Trimmed')
  assert.equal(setTitle(r, 'My Resume', LATER), r, 'no-op')
  const complete = setStatus(r, 'complete', LATER)
  assert.equal(complete.status, 'complete')
  assert.equal(setStatus(complete, 'complete', LATER), complete)
})

test('strength attaches and staleness follows the revision', () => {
  const r = newResume()
  assert.equal(isStrengthStale(r), true, 'no score yet is stale')
  const scored = attachStrength(r, { score: 72, computedAtRevision: r.revision, computedAt: NOW })
  assert.equal(isStrengthStale(scored), false)
  const edited = setTitle(scored, 'Changed', LATER)
  assert.equal(isStrengthStale(edited), true, 'editing invalidates the score')
  assert.equal(edited.strength?.score, 72, 'but the old score is still readable')
})

test('an import reference needs no file storage', () => {
  const r = createResume({
    id: 'r2', userId: 'u1', title: 'Imported',
    sectionIds: ids(DEFAULT_SECTION_TYPES.length), now: NOW,
    importedFrom: {
      importId: 'imp1', sourceFormat: 'pdf',
      documentFingerprint: 'sha256:abc', importedAt: NOW, originalRetained: false,
    },
  })
  assert.equal(r.importedFrom?.sourceFormat, 'pdf')
  assert.equal(r.importedFrom?.originalRetained, false, 'retention stays an open choice')
  assert.ok(!('storageKey' in (r.importedFrom as object)), 'no storage coupling')
})

test('nothing mutates the resume it was given', () => {
  const r = newResume()
  const snapshot = JSON.stringify(r)
  addSection(r, 'awards', 'a1', LATER)
  moveSection(r, r.sections[0].id, 3, LATER)
  setSectionVisibility(r, r.sections[0].id, false, LATER)
  removeSection(r, r.sections[0].id, LATER)
  setTemplate(r, 'modern', LATER)
  assert.equal(JSON.stringify(r), snapshot)
})
