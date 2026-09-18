import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LONG_HEADING_CHARS, TEMPLATES, TEMPLATE_LIST, isLongHeading, readingOrder,
  splitPlan, templateFor,
} from './templates.ts'
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

// ------------------------------------------------- reading order (ATS)

test('reading order carries every block exactly once', () => {
  const plan = planDocument(fullResume())
  for (const template of TEMPLATE_LIST) {
    const order = readingOrder(plan, template)
    assert.equal(order.length, plan.blocks.length, template.id)
    assert.deepEqual(
      order.map((b) => b.sectionId).sort(),
      plan.blocks.map((b) => b.sectionId).sort(),
      template.id
    )
  }
})

test('a single-column template reads in the applicant’s own order', () => {
  const plan = planDocument(fullResume())
  for (const template of TEMPLATE_LIST) {
    if (template.layout !== 'single-column') continue
    assert.deepEqual(
      readingOrder(plan, template).map((b) => b.sectionType),
      plan.blocks.map((b) => b.sectionType),
      template.id
    )
  }
})

test('a two-column resume still extracts as a resume, not as a list of licences', () => {
  const plan = planDocument(fullResume())
  const modern = TEMPLATES.modern
  const order = readingOrder(plan, modern)

  const sidebarTypes = new Set<string>(modern.sidebarSections)
  const firstSidebar = order.findIndex((b) => sidebarTypes.has(b.sectionType))
  const lastNarrative = order.map((b) => sidebarTypes.has(b.sectionType)).lastIndexOf(false)

  assert.ok(firstSidebar > 0, 'the document opens with a sidebar block')
  assert.ok(
    lastNarrative < firstSidebar,
    'narrative sections must all precede the credential sidebar in the DOM'
  )
  assert.equal(order[0].sectionType, 'summary', 'the first thing read should be who they are')
})

test('narrative order inside the main column is untouched by the split', () => {
  const plan = planDocument(fullResume())
  const modern = TEMPLATES.modern
  const sidebarTypes = new Set<string>(modern.sidebarSections)
  const expected = plan.blocks.filter((b) => !sidebarTypes.has(b.sectionType)).map((b) => b.sectionType)
  const actual = readingOrder(plan, modern)
    .filter((b) => !sidebarTypes.has(b.sectionType))
    .map((b) => b.sectionType)
  assert.deepEqual(actual, expected)
})

// ------------------------------------------------ what each one is for

test('Classic is the default, and puts dates opposite the title', () => {
  // A date is two words. Giving it a line of its own cost one line per entry,
  // which on a developed resume is most of a page.
  assert.equal(templateFor(undefined).id, 'classic')
  assert.equal(TEMPLATES.classic.entryLayout, 'opposed')
  assert.equal(TEMPLATES.classic.layout, 'single-column')
  assert.equal(TEMPLATES.classic.headerAlign, 'center')
  assert.equal(TEMPLATES.classic.headingStyle, 'ruled', 'Classic lost its ruled headings')
})

test('Modern sidebars what reads as a line and nothing that reads as prose', () => {
  const sidebar = new Set<string>(TEMPLATES.modern.sidebarSections)
  for (const short of ['education', 'certifications', 'licensure']) {
    assert.ok(sidebar.has(short), `${short} belongs in the sidebar`)
  }
  for (const narrative of [
    'summary', 'critical_care', 'other_clinical', 'shadowing', 'leadership',
    'volunteer', 'quality_improvement', 'research', 'publications', 'custom',
  ]) {
    assert.equal(sidebar.has(narrative), false, `${narrative} was squeezed into the narrow column`)
  }
})

test('the clinical narrative keeps the main column', () => {
  const plan = planDocument(fullResume())
  const { main, sidebar } = splitPlan(plan, TEMPLATES.modern)
  const inMain = new Set(main.map((b) => b.sectionType))
  for (const narrative of [
    'summary', 'critical_care', 'shadowing', 'leadership', 'volunteer', 'quality_improvement',
  ] as const) {
    assert.ok(inMain.has(narrative), `${narrative} left the main column`)
  }
  assert.ok(sidebar.length > 0, 'the sidebar is empty, so the layout is single-column in disguise')
})

test('the three templates stay three different documents', () => {
  // Compact is not Classic with smaller type: it keeps its own heading style
  // and its own density.
  assert.notEqual(TEMPLATES.compact.headingStyle, TEMPLATES.classic.headingStyle)
  assert.notEqual(TEMPLATES.compact.density, TEMPLATES.classic.density)
  assert.notEqual(TEMPLATES.modern.layout, TEMPLATES.classic.layout)
})

// --------------------------------------------------- long headings

test('a heading the compact gutter can hold stays in it', () => {
  for (const heading of [
    'Professional Summary', 'Critical Care Experience', 'Other Clinical Experience',
    'Volunteer & Community Service', 'Volunteer and Community Service',
    'Publications & Presentations', 'Professional Organizations',
  ]) {
    assert.equal(isLongHeading(heading), false, `${heading} (${heading.length}) would give up the gutter`)
  }
})

test('a heading no gutter can hold is recognised as one', () => {
  assert.equal(isLongHeading('Volunteer, Community Service and Outreach Leadership'), true)
  assert.equal(isLongHeading('x'.repeat(LONG_HEADING_CHARS + 1)), true)
  assert.equal(isLongHeading(`  ${'x'.repeat(LONG_HEADING_CHARS)}  `), false, 'trimmed length is what counts')
  assert.equal(isLongHeading(''), false)
})

// ------------------------------------- the applicant's own column choice

/** The same full resume, with one section moved out of its default column. */
function planWithPlacement(type: ResumeSectionType, column: 'sidebar' | 'main') {
  const resume = fullResume()
  return planDocument({
    ...resume,
    sections: resume.sections.map((s) => (s.type === type ? { ...s, modernColumn: column } as ResumeSectionV2 : s)),
  })
}

test('a section the applicant moved is drawn where they put it', () => {
  const plan = planWithPlacement('critical_care', 'sidebar')
  const { main, sidebar } = splitPlan(plan, TEMPLATES.modern)
  assert.ok(sidebar.some((b) => b.sectionType === 'critical_care'), 'the move was ignored')
  assert.equal(main.some((b) => b.sectionType === 'critical_care'), false, 'it is drawn twice')
})

test('a supporting section can be pulled into the main column', () => {
  const plan = planWithPlacement('certifications', 'main')
  const { main, sidebar } = splitPlan(plan, TEMPLATES.modern)
  assert.ok(main.some((b) => b.sectionType === 'certifications'))
  assert.equal(sidebar.some((b) => b.sectionType === 'certifications'), false)
})

test('a placement never loses or duplicates a section', () => {
  const plan = planWithPlacement('critical_care', 'sidebar')
  const { main, sidebar } = splitPlan(plan, TEMPLATES.modern)
  assert.equal(main.length + sidebar.length, plan.blocks.length)
  assert.deepEqual(
    [...main, ...sidebar].map((b) => b.sectionType).sort(),
    plan.blocks.map((b) => b.sectionType).sort()
  )
})

test('single-column templates ignore a placement entirely', () => {
  const plan = planWithPlacement('certifications', 'main')
  for (const template of [TEMPLATES.classic, TEMPLATES.compact]) {
    const { main, sidebar } = splitPlan(plan, template)
    assert.deepEqual(sidebar, [], template.id)
    assert.equal(main.length, plan.blocks.length, template.id)
  }
})

test('moving a section visually does not change the order it is read in', () => {
  // The locked ATS order: header, then summary and the narrative, then the
  // supporting sections. Someone who moves their clinical experience into the
  // sidebar for the look of it has not decided that a parser should read their
  // licences first.
  const normal = readingOrder(planDocument(fullResume()), TEMPLATES.modern).map((b) => b.sectionType)
  const moved = readingOrder(planWithPlacement('critical_care', 'sidebar'), TEMPLATES.modern)
    .map((b) => b.sectionType)

  assert.deepEqual(moved, normal, 'a layout choice reordered the document for a parser')
  assert.equal(moved[0], 'summary', 'the document no longer opens with who they are')
})

test('a supporting section pulled into main still reads after the narrative', () => {
  const order = readingOrder(planWithPlacement('certifications', 'main'), TEMPLATES.modern)
    .map((b) => b.sectionType)
  assert.ok(
    order.indexOf('certifications') > order.indexOf('critical_care'),
    'credentials climbed above the clinical narrative in reading order'
  )
})
