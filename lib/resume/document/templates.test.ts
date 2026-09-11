import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEMPLATES, TEMPLATE_LIST, splitPlan, templateFor } from './templates.ts'
import type { TemplateDefinition } from './templates.ts'
import { planDocument } from './plan.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createSection, createBullet, createClinicalPosition } from '../model/sections.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { SECTION_TYPES } from '../model/types.ts'
import type { ResumeSectionType, ResumeSectionV2, ResumeV2 } from '../model/types.ts'

const NOW = '2026-09-10T12:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

/**
 * Minimal but non-empty for every type. Coverage here is about placement, not
 * about content — plan.test.ts already proves each type maps correctly.
 */
function stub(type: ResumeSectionType): ResumeSectionV2 {
  const base = createSection(type, `sec-${type}`)
  const text = createAuthoredText('Something worth printing.')
  const range = { start: { kind: 'absent' } as const, end: { kind: 'absent' } as const, isCurrent: false }
  switch (type) {
    case 'summary': return { ...base, text } as ResumeSectionV2
    case 'education': return { ...base, entries: [{ id: 'e', degree: 'BSN', field: '', institution: 'Rutgers', location: '', graduationDate: { kind: 'absent' }, overallGpa: { raw: '', value: null, showOnResume: false }, scienceGpa: { raw: '', value: null, showOnResume: false }, honors: '' }] } as ResumeSectionV2
    case 'critical_care':
    case 'other_clinical': {
      const p = createClinicalPosition('p', { employer: 'University Hospital' })
      return { ...base, positions: [{ ...p, bullets: [createBullet('Did the work.')] }] } as ResumeSectionV2
    }
    case 'licensure': return { ...base, licenses: [{ id: 'l', licenseType: 'RN', state: 'NJ', identifier: '', isCompact: false, expires: { kind: 'absent' } }] } as ResumeSectionV2
    case 'certifications': return { ...base, certifications: [{ id: 'c', name: 'CCRN', issuer: 'AACN', identifier: '', earned: { kind: 'absent' }, expires: { kind: 'absent' } }] } as ResumeSectionV2
    case 'shadowing': return { ...base, experiences: [{ id: 'sh', providerName: 'A. Nurse', credential: 'CRNA', setting: '', facility: '', hours: '', dates: range, reflection: text }] } as ResumeSectionV2
    case 'leadership': return { ...base, entries: [{ id: 'ld', role: 'Charge Nurse', organization: '', dates: range, detail: text }] } as ResumeSectionV2
    case 'quality_improvement':
    case 'research': return { ...base, entries: [{ id: 'pr', title: 'A project', role: '', organization: '', dates: range, detail: text }] } as ResumeSectionV2
    case 'organizations': return { ...base, memberships: [{ id: 'm', organization: 'AACN', role: '', dates: range }] } as ResumeSectionV2
    case 'awards': return { ...base, awards: [{ id: 'aw', title: 'DAISY Award', issuer: '', awarded: { kind: 'absent' }, detail: text }] } as ResumeSectionV2
    case 'volunteer': return { ...base, entries: [{ id: 'v', role: 'Volunteer', organization: '', dates: range, detail: text }] } as ResumeSectionV2
    case 'publications': return { ...base, entries: [{ id: 'pb', title: 'A poster', venue: '', kind: '', date: { kind: 'absent' }, citation: text }] } as ResumeSectionV2
    case 'custom': return { ...base, heading: 'Languages', entries: [{ id: 'cu', title: 'Spanish', detail: text }] } as ResumeSectionV2
  }
}

function fullResume(): ResumeV2 {
  const base = createResume({ id: 'r', userId: 'u', title: 'T', sectionIds: ids(20), now: NOW })
  return {
    ...base,
    contact: { ...emptyContact(), fullName: 'Jane Doe' },
    sections: SECTION_TYPES.map(stub),
  }
}

/** The axes that make a template a different document, not a different colour. */
const STRUCTURAL: (keyof TemplateDefinition)[] = [
  'layout', 'headerAlign', 'headingStyle', 'entryLayout', 'density',
]

// ------------------------------------------------------------ registry

test('the three locked templates are the three that exist', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['classic', 'compact', 'modern'])
  assert.equal(TEMPLATE_LIST.length, 3)
})

test('each template’s id matches its key, so a lookup can never mislabel', () => {
  for (const [key, def] of Object.entries(TEMPLATES)) assert.equal(def.id, key)
})

test('every template is fully specified', () => {
  for (const t of TEMPLATE_LIST) {
    for (const field of STRUCTURAL) assert.ok(t[field], `${t.id} is missing ${String(field)}`)
    assert.notEqual(t.name.trim(), '', `${t.id} has no name`)
    assert.notEqual(t.summary.trim(), '', `${t.id} has no summary`)
    assert.ok(t.tokens.bodyPt > 0 && t.tokens.namePt > t.tokens.bodyPt, `${t.id} tokens`)
    assert.notEqual(t.tokens.fontStack.trim(), '', `${t.id} has no font stack`)
  }
})

test('an unknown or missing template id falls back rather than blanking the page', () => {
  for (const id of [null, undefined, '', 'creative', 'ats-optimized', '__proto__', 'toString']) {
    assert.equal(templateFor(id as string).id, 'classic', String(id))
  }
  assert.equal(templateFor('modern').id, 'modern')
})

// ------------------------------------------- structurally different

test('no two templates differ only in tokens', () => {
  for (const a of TEMPLATE_LIST) {
    for (const b of TEMPLATE_LIST) {
      if (a.id >= b.id) continue
      const differences = STRUCTURAL.filter((f) => a[f] !== b[f])
      assert.ok(
        differences.length >= 2,
        `${a.id} and ${b.id} differ on only ${differences.length} structural axis (${differences.join(', ')})`
      )
    }
  }
})

test('the set genuinely includes a second column and a single column', () => {
  const layouts = new Set(TEMPLATE_LIST.map((t) => t.layout))
  assert.ok(layouts.has('sidebar'), 'no template uses a sidebar')
  assert.ok(layouts.has('single-column'), 'no template is single column')
})

test('the three heading styles are all distinct', () => {
  assert.equal(new Set(TEMPLATE_LIST.map((t) => t.headingStyle)).size, 3)
})

test('density is reflected in the tokens, not only named', () => {
  const byDensity = Object.fromEntries(TEMPLATE_LIST.map((t) => [t.density, t.tokens]))
  assert.ok(byDensity.tight.sectionGapPt < byDensity.normal.sectionGapPt)
  assert.ok(byDensity.normal.sectionGapPt < byDensity.roomy.sectionGapPt)
  assert.ok(byDensity.tight.bodyPt < byDensity.roomy.bodyPt)
})

test('a sidebar template names only real section types', () => {
  const known = new Set<string>(SECTION_TYPES)
  for (const t of TEMPLATE_LIST) {
    for (const type of t.sidebarSections) {
      assert.ok(known.has(type), `${t.id} sidebars an unknown section type: ${type}`)
    }
  }
})

test('a single-column template names no sidebar sections', () => {
  for (const t of TEMPLATE_LIST) {
    if (t.layout === 'single-column') assert.deepEqual(t.sidebarSections, [], t.id)
  }
})

// --------------------------------- all three render every section type

test('every template places every section type — nothing is ever dropped', () => {
  const plan = planDocument(fullResume())
  assert.equal(plan.blocks.length, SECTION_TYPES.length, 'the fixture must cover every type')

  for (const template of TEMPLATE_LIST) {
    const { main, sidebar } = splitPlan(plan, template)
    const placed = [...main, ...sidebar].map((b) => b.sectionType).sort()
    assert.deepEqual(placed, [...SECTION_TYPES].sort(), `${template.id} lost or duplicated a section`)
  }
})

test('no block is placed in both columns', () => {
  const plan = planDocument(fullResume())
  for (const template of TEMPLATE_LIST) {
    const { main, sidebar } = splitPlan(plan, template)
    const mainIds = new Set(main.map((b) => b.sectionId))
    for (const block of sidebar) {
      assert.equal(mainIds.has(block.sectionId), false, `${template.id} duplicated ${block.sectionType}`)
    }
    assert.equal(main.length + sidebar.length, plan.blocks.length, template.id)
  }
})

test('a single-column template puts everything in the main column', () => {
  const plan = planDocument(fullResume())
  for (const template of TEMPLATE_LIST) {
    if (template.layout !== 'single-column') continue
    const { main, sidebar } = splitPlan(plan, template)
    assert.deepEqual(sidebar, [], template.id)
    assert.equal(main.length, plan.blocks.length, template.id)
  }
})

test('the sidebar template actually moves content out of the main column', () => {
  const plan = planDocument(fullResume())
  const modern = TEMPLATES.modern
  const { main, sidebar } = splitPlan(plan, modern)
  assert.ok(sidebar.length > 0, 'a sidebar layout with an empty sidebar is single-column in disguise')
  assert.ok(main.length > 0)
  assert.deepEqual(sidebar.map((b) => b.sectionType).sort(), [...modern.sidebarSections].sort())
})

test('splitting preserves the applicant’s order within each column', () => {
  const plan = planDocument(fullResume())
  for (const template of TEMPLATE_LIST) {
    const { main, sidebar } = splitPlan(plan, template)
    for (const column of [main, sidebar]) {
      const positions = column.map((b) => plan.blocks.findIndex((x) => x.sectionId === b.sectionId))
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `${template.id} reordered a column`)
    }
  }
})

test('splitting an empty document is safe for every template', () => {
  const empty = planDocument(createResume({ id: 'r', userId: 'u', title: 'T', sectionIds: ids(20), now: NOW }))
  for (const t of TEMPLATE_LIST) {
    assert.deepEqual(splitPlan(empty, t), { main: [], sidebar: [] }, t.id)
  }
})

test('splitting does not mutate the plan', () => {
  const plan = planDocument(fullResume())
  const before = JSON.stringify(plan)
  for (const t of TEMPLATE_LIST) splitPlan(plan, t)
  assert.equal(JSON.stringify(plan), before)
})
