import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SECTION_HEADINGS, authoredTextsIn, createBullet, createClinicalPosition,
  createSection, dropBlankBullets, emptyGpa, hasFixedHeading, headingFor, isSectionEmpty,
  isSectionRenderable, normalizeMultiline, normalizeText, parseGpa,
} from './sections.ts'
import { SECTION_TYPES } from './types.ts'
import type { ResumeSectionType, ResumeSectionV2 } from './types.ts'
import { createAuthoredText } from './authoredText.ts'

/** Section construction, emptiness and normalisation. */

test('every section type can be created and carries its discriminator', () => {
  SECTION_TYPES.forEach((type, i) => {
    const section = createSection(type, `s${i}`)
    assert.equal(section.type, type, `discriminator for ${type}`)
    assert.equal(section.id, `s${i}`)
    assert.equal(section.visible, true)
    assert.equal(section.label, null)
  })
})

test('all fifteen locked section types exist', () => {
  assert.equal(SECTION_TYPES.length, 15)
  const expected: ResumeSectionType[] = [
    'summary', 'education', 'critical_care', 'other_clinical', 'licensure',
    'certifications', 'shadowing', 'leadership', 'quality_improvement',
    'research', 'organizations', 'awards', 'volunteer', 'publications', 'custom',
  ]
  assert.deepEqual([...SECTION_TYPES], expected)
})

test('a new section is genuinely empty — no seeded blank entry', () => {
  // The V1 defect this prevents: `bullet_points: ['']` was the initialiser,
  // which is why all 41 production positions carry a blank bullet.
  for (const type of SECTION_TYPES) {
    const section = createSection(type, 'x')
    assert.equal(isSectionEmpty(section), true, `${type} starts empty`)
  }
})

test('a created clinical position has no bullets at all', () => {
  const p = createClinicalPosition('p1')
  assert.deepEqual(p.bullets, [])
  assert.deepEqual(p.guided, [])
  assert.equal(p.facts.devices.length, 0)
  assert.equal(p.facts.employer, '', 'no invented clinical facts')
})

test('empty sections are not renderable but are not deleted', () => {
  const section = createSection('education', 'e1')
  assert.equal(isSectionRenderable(section), false)
  assert.equal(isSectionEmpty(section), true)
  // The section object still exists — removal is a product decision, not ours.
  assert.equal(section.type, 'education')
})

test('hidden sections keep their data and do not render', () => {
  const filled: ResumeSectionV2 = {
    ...createSection('summary', 's1'),
    text: createAuthoredText('real content'),
  }
  assert.equal(isSectionRenderable(filled), true)
  const hidden = { ...filled, visible: false }
  assert.equal(isSectionRenderable(hidden), false)
  assert.equal(isSectionEmpty(hidden), false, 'data survives being hidden')
})

test('headings default per type and are overridable', () => {
  const section = createSection('critical_care', 'c1')
  assert.equal(headingFor(section), 'Critical Care Experience')
  assert.equal(headingFor({ ...section, label: 'ICU Experience' }), 'ICU Experience')
  assert.equal(headingFor({ ...section, label: '   ' }), 'Critical Care Experience', 'blank falls back')
})

test('a custom section names itself, and label still wins', () => {
  const custom = createSection('custom', 'x1', { heading: 'Military Service' })
  assert.equal(headingFor(custom), 'Military Service')
  assert.equal(headingFor({ ...custom, label: 'Service' }), 'Service')
  assert.equal(headingFor(createSection('custom', 'x2')), SECTION_HEADINGS.custom)
})

test('the Professional Summary heading is fixed, whatever label is stored', () => {
  // A label saved before the heading was locked stays on the section. It is
  // ignored, not erased: the heading is decided without consulting it.
  for (const label of ['About Me', 'PROFILE', '  Summary of Qualifications  ', '   ', '']) {
    assert.equal(
      headingFor(createSection('summary', 's1', { label })), 'Professional Summary', JSON.stringify(label)
    )
  }
})

test('every other section type still takes its label', () => {
  // Filtered on the literal rather than on the rule itself, so a rule that
  // grew by mistake cannot quietly shrink the list this checks.
  for (const type of SECTION_TYPES.filter((t) => t !== 'summary')) {
    assert.equal(headingFor(createSection(type, 'x', { label: 'Renamed' })), 'Renamed', type)
  }
})

test('only the Professional Summary has a fixed heading, for now', () => {
  for (const type of SECTION_TYPES) assert.equal(hasFixedHeading(type), type === 'summary', type)
})

test('Leadership, Quality Improvement and Research are separate sections', () => {
  const types = SECTION_TYPES.filter((t) =>
    t === 'leadership' || t === 'quality_improvement' || t === 'research')
  assert.equal(types.length, 3, 'three distinct types, not one merged section')
  assert.equal(SECTION_HEADINGS.quality_improvement, 'Quality Improvement')
  assert.equal(SECTION_HEADINGS.research, 'Research')
})

// ------------------------------------------------------------------ GPA

test('a GPA keeps the applicant’s text even when it will not parse', () => {
  const odd = parseGpa('3.4/4.0')
  assert.equal(odd.raw, '3.4/4.0', 'text survives')
  assert.equal(odd.value, null, 'and is not guessed at')
  const good = parseGpa('3.85')
  assert.equal(good.value, 3.85)
  assert.equal(good.raw, '3.85')
})

test('implausible GPA values parse to null rather than being rejected', () => {
  for (const raw of ['9.9', '-1', 'A-', '']) {
    const gpa = parseGpa(raw)
    assert.equal(gpa.value, null, raw)
    assert.equal(gpa.raw, raw.trim())
  }
})

test('GPA visibility defaults to OFF — storing is not publishing', () => {
  // V1 printed whatever was stored with no control, so a science GPA someone
  // recorded for their own reference appeared on a submitted document.
  assert.equal(emptyGpa().showOnResume, false, 'a new GPA does not render')
  assert.equal(parseGpa('3.9').showOnResume, false, 'nor does one just entered')
  assert.equal(parseGpa('3.9', true).showOnResume, true, 'shown only when asked for')
})

test('a GPA that will not parse still defaults to hidden', () => {
  assert.equal(parseGpa('3.4/4.0').showOnResume, false)
  assert.equal(parseGpa('').showOnResume, false)
})

// ------------------------------------------------------------- text

test('normalisation tidies whitespace without touching length limits', () => {
  assert.equal(normalizeText('  a   b \n c  '), 'a b c')
  assert.equal(normalizeText(undefined), '')
  assert.equal(normalizeText(42), '')
  const long = 'x'.repeat(4214)
  assert.equal(normalizeText(long).length, 4214, 'never truncates')
})

test('multiline normalisation preserves paragraphs', () => {
  assert.equal(normalizeMultiline('a\n\n\n\nb'), 'a\n\nb')
  assert.equal(normalizeMultiline('a  \n  b'), 'a\n b')
})

test('blank bullets are dropped', () => {
  const bullets = [
    createBullet('real one'),
    createBullet(''),
    createBullet('   '),
    createBullet('\n\t'),
    createBullet('another real one'),
  ]
  const kept = dropBlankBullets(bullets)
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map((b) => b.accepted), ['real one', 'another real one'])
})

test('the exact V1 blank-bullet shape reduces to nothing', () => {
  // `bullet_points: ['']` — the initialiser behind all 41 production blanks.
  assert.deepEqual(dropBlankBullets([createBullet('')]), [])
})

// --------------------------------------------------- authored text walk

test('authored text is collected from every section that has any', () => {
  const summary: ResumeSectionV2 = {
    ...createSection('summary', 's1'), text: createAuthoredText('summary text'),
  }
  assert.equal(authoredTextsIn(summary).length, 1)

  const cc: ResumeSectionV2 = {
    ...createSection('critical_care', 'c1'),
    positions: [{
      ...createClinicalPosition('p1'),
      guided: [{ promptId: 'q1', answer: createAuthoredText('my answer') }],
      bullets: [createBullet('one'), createBullet('two')],
    }],
  }
  assert.equal(authoredTextsIn(cc).length, 3, 'guided answers count as authored text')
})

test('fact-only sections contribute no authored text', () => {
  for (const type of ['education', 'licensure', 'certifications', 'organizations'] as const) {
    assert.deepEqual(authoredTextsIn(createSection(type, 'x')), [], type)
  }
})

test('every section type is handled by the exhaustive switches', () => {
  // A new type added to the union without updating these fails to compile;
  // this asserts the runtime side too.
  for (const type of SECTION_TYPES) {
    const section = createSection(type, 'x')
    assert.doesNotThrow(() => isSectionEmpty(section), type)
    assert.doesNotThrow(() => authoredTextsIn(section), type)
    assert.doesNotThrow(() => headingFor(section), type)
  }
})
