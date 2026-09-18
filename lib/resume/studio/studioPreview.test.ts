import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SectionCard from '../../../app/resume-studio/components/studio/SectionCard.tsx'
import PaginatedDocument from '../../../app/resume-studio/components/studio/PaginatedDocument.tsx'
import {
  ChromiumUnavailableError, embeddedFonts, exportResumePdf, launchBrowser, resolveExecutablePath,
} from '../export/pdf.ts'
import type { PdfBrowser } from '../export/pdf.ts'
import { TEMPLATES } from '../document/templates.ts'
import { PAGE_CONTENT_WIDTH_PX, PAGE_FLOW_GAP_PX, pageCountFromFlowWidth } from '../document/pages.ts'
import { moveTargetIndex } from './columns.ts'
import { applyPatches } from './patch.ts'
import type { StudioPatch } from './patch.ts'
import { parsePatches } from './parse.ts'
import { fromRows, toSavePayload } from '../repo/rows.ts'
import type { ResumeRow, SectionRow } from '../repo/rows.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import type { ResumeSectionV2, ResumeTemplate, ResumeV2 } from '../model/types.ts'

/**
 * The Studio preview, checked in a real browser.
 *
 * Two UAT failures: Modern's column control could not be found, and the preview
 * showed one long page when the PDF would have several. Both are asserted here
 * against what Chromium actually lays out and prints -- the real SectionCard,
 * the real PaginatedDocument, the real ResumeDocument and a real exported PDF --
 * because a source-level check is what let the first failure through.
 */

const NOW = '2026-09-17T12:00:00.000Z'
const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const squash = (value: string) => value.replace(/\s+/g, '')
const noop = () => {}

let browser: PdfBrowser | null = null
let unavailable: string | null = null
try {
  await resolveExecutablePath()
} catch (error) {
  unavailable = error instanceof ChromiumUnavailableError ? error.message : String(error)
}
const skip = unavailable ? `Chromium unavailable — ${unavailable}` : false

before(async () => {
  if (!unavailable) browser = await launchBrowser()
})
after(async () => {
  if (browser) await browser.close()
})

/** A page Chromium can lay out: the preview markup, and what the test wants measured. */
function htmlPage(markup: string, markers: readonly string[] = []): string {
  const config = JSON.stringify({ markers, pitch: PAGE_CONTENT_WIDTH_PX + PAGE_FLOW_GAP_PX })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0">`
    + `<script type="application/json" id="config">${config}</script>${markup}</body></html>`
}

async function previewMarkup(resume: ResumeV2, pages: number, template?: ResumeTemplate): Promise<string> {
  return renderToStaticMarkup(createElement(PaginatedDocument, {
    resume, template: template ?? resume.template, pages, scale: 1, fontCss: await embeddedFonts(),
  }))
}

// ===========================================================================
// 1. Modern column placement
// ===========================================================================

function studioResume(template: ResumeTemplate = 'modern'): ResumeV2 {
  const base = createResume({
    id: U(90), userId: 'u1', title: 'T', now: NOW, template,
    sectionIds: Array.from({ length: 20 }, (_, i) => U(100 + i)),
  })
  return {
    ...base,
    contact: { ...emptyContact(), fullName: 'Jordan Ellery' },
    sections: [
      { ...createSection('summary', U(1)), text: createAuthoredText('Critical care nurse with six years in a medical ICU.') } as ResumeSectionV2,
      { ...createSection('education', U(2)), entries: [{ id: U(20), degree: 'BSN', field: 'Nursing', institution: 'Rutgers University', location: 'Newark, NJ', graduationDate: resumeDateFromParts(2019, 5), overallGpa: parseGpa(''), scienceGpa: parseGpa(''), honors: '' }] } as ResumeSectionV2,
      { ...createSection('critical_care', U(3)), positions: [{ ...createClinicalPosition(U(30), { employer: 'University Hospital', role: 'Registered Nurse', unit: 'Medical ICU', dates: { start: resumeDateFromParts(2021, 3), end: { kind: 'absent' }, isCurrent: true } }), bullets: [createBullet('Managed vasoactive infusions for unstable patients.')] }] } as ResumeSectionV2,
      { ...createSection('licensure', U(4)), licenses: [{ id: U(40), licenseType: 'RN', state: 'NJ', identifier: '26NR12345600', isCompact: true, expires: resumeDateFromParts(2027, 5) }] } as ResumeSectionV2,
    ],
  }
}

type CardProps = Parameters<typeof SectionCard>[0]

function cardProps(resume: ResumeV2, index: number, over: Partial<CardProps> = {}): CardProps {
  const template = TEMPLATES[resume.template]
  return {
    section: resume.sections[index],
    resumeId: resume.id,
    template,
    moveUpTo: moveTargetIndex(resume.sections, template, index, 'up'),
    moveDownTo: moveTargetIndex(resume.sections, template, index, 'down'),
    open: false,
    newId: () => U(999),
    emit: noop,
    unsaved: false,
    onFlush: noop,
    onToggleOpen: noop,
    compact: false,
    ...over,
  }
}

const renderCard = (props: CardProps) => renderToStaticMarkup(createElement(SectionCard, props))

/** The element in a rendered tree whose own text or accessible name contains `text` and is clickable. */
function findClickable(node: unknown, text: string): { props: { onClick: () => void } } | null {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findClickable(child, text)
      if (found) return found
    }
    return null
  }
  const props = ((node as { props?: Record<string, unknown> }).props ?? {})
  const children = props.children
  const own = typeof children === 'string'
    ? children
    : Array.isArray(children) ? children.filter((c) => typeof c === 'string').join('') : ''
  const named = typeof props['aria-label'] === 'string' ? (props['aria-label'] as string) : ''
  if ((own.includes(text) || named.includes(text)) && typeof props.onClick === 'function') {
    return node as { props: { onClick: () => void } }
  }
  return findClickable(children, text)
}

/** Clicks the control on the real SectionCard and returns what it emitted. */
function click(props: CardProps, text: string): StudioPatch[] {
  const emitted: StudioPatch[] = []
  const tree = SectionCard({ ...props, emit: (patch: StudioPatch) => emitted.push(patch) })
  const control = findClickable(tree, text)
  assert.ok(control, `no clickable "${text}" on the ${props.section.type} card`)
  control!.props.onClick()
  return emitted
}

/** A save and a reload, through the same boundary and row mapping the Studio uses. */
function saveAndReload(resume: ResumeV2, patches: readonly StudioPatch[]): ResumeV2 {
  const typeOf = new Map(resume.sections.map((s) => [s.id, s.type] as const))
  const parsed = parsePatches(JSON.parse(JSON.stringify(patches)), (id) => typeOf.get(id) ?? null)
  assert.ok(parsed.ok, `the server refused the edit: ${parsed.ok ? '' : parsed.error}`)
  const saved = applyPatches(resume, parsed.ok ? parsed.patches : [], { now: NOW })

  const payload = toSavePayload(saved)
  const rows = payload.sections.map((s) => ({
    id: String(s.id), resume_id: saved.id, section_type: String(s.section_type), section_data: s.section_data,
    order_index: Number(s.order_index), visible: Boolean(s.visible), label: (s.label ?? null) as string | null,
  })) as SectionRow[]
  const row = {
    id: saved.id, user_id: saved.userId, title: saved.title, template_id: saved.template, created_at: NOW,
    updated_at: NOW, schema_version: 2, status: saved.status, revision: saved.revision,
    strength_score: null, strength_computed_at: null, strength_revision: null,
  } as ResumeRow
  const read = fromRows(row, rows)
  assert.ok(read.resume, 'the resume did not survive a reload')
  return read.resume!
}

/** Where Chromium draws Critical Care in the real paginated preview. */
async function criticalCarePlacement(resume: ResumeV2) {
  const page = await browser!.newPage()
  try {
    await page.setContent(htmlPage(await previewMarkup(resume, 1)), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    return await page.evaluate(() => {
      const cc = document.querySelector('[data-section-type="critical_care"]') as HTMLElement | null
      const main = document.querySelector('.rd-main') as HTMLElement | null
      const aside = document.querySelector('.rd-aside') as HTMLElement | null
      return {
        inAside: Boolean(cc?.closest('.rd-aside')),
        ccLeft: cc?.getBoundingClientRect().left ?? -1,
        mainLeft: main?.getBoundingClientRect().left ?? -1,
        asideLeft: aside?.getBoundingClientRect().left ?? -1,
      }
    })
  } finally {
    await page.close()
  }
}

test('1. every Modern section card shows a visible column control on the card itself', () => {
  const resume = studioResume('modern')
  for (let i = 0; i < resume.sections.length; i++) {
    const html = renderCard(cardProps(resume, i))
    const sidebarByDefault = TEMPLATES.modern.sidebarSections.includes(resume.sections[i].type)
    const expected = sidebarByDefault ? 'Move to main →' : '← Move to sidebar'
    assert.ok(html.includes(expected), `${resume.sections[i].type} shows no "${expected}"`)
    // Visible text on the card, not an item waiting inside a closed menu.
    assert.equal(html.includes('role="menuitem"'), false, 'the card rendered its menu open')
  }
})

test('1b. on a phone it is a named icon with a tooltip, still on the card', () => {
  const resume = studioResume('modern')
  const html = renderCard(cardProps(resume, 2, { compact: true }))
  assert.ok(html.includes('aria-label="Move Critical Care Experience to sidebar"'))
  assert.ok(html.includes('title="Move Critical Care Experience to sidebar"'))
})

test('2. Classic and Compact show no column control at all', () => {
  for (const template of ['classic', 'compact'] as const) {
    const resume = studioResume(template)
    for (let i = 0; i < resume.sections.length; i++) {
      for (const compact of [false, true]) {
        const html = renderCard(cardProps(resume, i, { compact }))
        for (const text of ['Move to sidebar', 'Move to main', 'to sidebar', 'to main']) {
          assert.equal(html.includes(text), false, `${template} ${resume.sections[i].type} offers "${text}"`)
        }
      }
    }
  }
})

test('3. clicking it moves the section into the other column in the real preview', { skip }, async () => {
  const resume = studioResume('modern')
  const before = await criticalCarePlacement(resume)
  assert.equal(before.inAside, false, 'Critical Care starts in the sidebar')

  const toSidebar = click(cardProps(resume, 2), 'Move to sidebar')
  assert.deepEqual(toSidebar, [{ op: 'section-column', sectionId: U(3), column: 'sidebar' }])
  const moved = applyPatches(resume, toSidebar, { now: NOW })
  assert.ok(moved.revision > resume.revision, 'a column move did not change the revision, so Strength would not go stale')

  const after = await criticalCarePlacement(moved)
  assert.ok(after.inAside, 'Critical Care is not drawn in the sidebar after the click')
  assert.ok(after.ccLeft < after.mainLeft, 'Critical Care is not visually left of the main column')

  // And back, from the control the moved card now shows.
  const toMain = click(cardProps(moved, 2), 'Move to main')
  const back = await criticalCarePlacement(applyPatches(moved, toMain, { now: NOW }))
  assert.equal(back.inAside, false, 'Move to main did not return it')
})

test('4. the placement survives save and reload, and a trip through Classic', { skip }, async () => {
  const resume = studioResume('modern')
  const reloaded = saveAndReload(resume, click(cardProps(resume, 2), 'Move to sidebar'))
  assert.equal(reloaded.sections[2].modernColumn, 'sidebar', 'the placement was not saved')
  assert.ok((await criticalCarePlacement(reloaded)).inAside, 'after reload it is drawn in main again')

  // Modern -> Classic -> Modern keeps it.
  const classic = saveAndReload(reloaded, [{ op: 'template', template: 'classic' }])
  assert.equal(renderCard(cardProps(classic, 2)).includes('Move to'), false, 'Classic offers a column control')
  const modernAgain = saveAndReload(classic, [{ op: 'template', template: 'modern' }])
  assert.ok((await criticalCarePlacement(modernAgain)).inAside, 'the placement was forgotten after Classic')
  assert.ok(renderCard(cardProps(modernAgain, 2)).includes('Move to main →'))

  // Up and down stay within the column it is now in: above it there, is Education.
  assert.equal(moveTargetIndex(modernAgain.sections, TEMPLATES.modern, 2, 'up'), 1)
})

// ===========================================================================
// 2. Pagination: the preview's pages are the PDF's pages
// ===========================================================================

const LENGTHS = [
  'coordinated care with the intensivist.',
  'titrated vasoactive infusions for a patient in septic shock while coordinating with the intensivist and pharmacy on escalation.',
  'managed a ventilated patient through proning, sedation interruption and a spontaneous breathing trial, documenting each step and escalating a desaturation early enough that the plan could change before the patient deteriorated further overnight.',
]
/** Bullets whose text runs to three lines or more: the ones a slice would show. */
const isLong = (index: number) => index % 3 === 2

function pagedResume(extra: number): ResumeV2 {
  const base = createResume({ id: 'r', userId: 'u', title: 'T', now: NOW, sectionIds: Array.from({ length: 20 }, (_, i) => `s${i}`) })
  return {
    ...base,
    contact: { ...emptyContact(), fullName: 'Jordan Ellery', credentials: 'BSN, RN, CCRN', email: 'j@example.test', city: 'Newark', state: 'NJ' },
    sections: [
      { ...createSection('summary', 'sm'), text: createAuthoredText('Critical care nurse with six years in a high-acuity medical ICU, caring for septic, cardiogenic and post-surgical patients.') } as ResumeSectionV2,
      { ...createSection('education', 'ed'), entries: [{ id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University', location: 'Newark, NJ', startDate: resumeDateFromParts(2015, 9), graduationDate: resumeDateFromParts(2019, 5), overallGpa: parseGpa('3.85', true), scienceGpa: parseGpa(''), honors: 'Cum laude' }] } as ResumeSectionV2,
      { ...createSection('critical_care', 'cc'), positions: [{ ...createClinicalPosition('p1', { employer: 'University Hospital', role: 'Registered Nurse', unit: 'Medical ICU', location: 'Newark, NJ', dates: { start: resumeDateFromParts(2021, 3), end: { kind: 'absent' }, isCurrent: true } }), bullets: Array.from({ length: extra }, (_, i) => createBullet(`Bullet ${i + 1}: ${LENGTHS[i % 3]} End${i + 1}.`)) }] } as ResumeSectionV2,
      { ...createSection('licensure', 'lic'), licenses: [{ id: 'l1', licenseType: 'RN', state: 'NJ', identifier: '26NR12345600', isCompact: true, expires: resumeDateFromParts(2027, 5) }] } as ResumeSectionV2,
      { ...createSection('certifications', 'cert'), certifications: [{ id: 'c1', name: 'CCRN', issuer: 'AACN', identifier: '', earned: resumeDateFromParts(2022, 1), expires: { kind: 'absent' } }] } as ResumeSectionV2,
    ],
  }
}

function markersFor(extra: number): string[] {
  return [
    'Criticalcarenursewithsix', 'RutgersUniversity',
    ...Array.from({ length: extra }, (_, i) => [`Bullet${i + 1}:`, `End${i + 1}.`]).flat(),
    '26NR12345600', 'AACN',
  ]
}

interface Layout {
  readonly pages: number
  /** Page index (from 0) of each marker, or -1 when it was not found. */
  readonly at: Readonly<Record<string, number>>
}

async function previewLayout(resume: ResumeV2, template: ResumeTemplate, markers: readonly string[]): Promise<Layout & { sheets: number }> {
  const page = await browser!.newPage()
  try {
    await page.setContent(htmlPage(await previewMarkup(resume, 1, template), markers), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const measured = await page.evaluate(() => {
      const config = JSON.parse(document.getElementById('config')!.textContent!) as { markers: string[]; pitch: number }
      const flow = document.querySelector('.rd-flow') as HTMLElement
      const flowLeft = flow.getBoundingClientRect().left
      const texts: Text[] = []
      const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        // Only text that is laid out. The inlined stylesheet is a text node
        // too, and its own comments can quote the very words being looked for.
        const tag = node.parentElement?.tagName
        if (tag !== 'STYLE' && tag !== 'SCRIPT') texts.push(node)
      }
      const at: Record<string, number> = {}
      for (const marker of config.markers) {
        at[marker] = -1
        for (const node of texts) {
          const raw = node.textContent ?? ''
          const index = raw.replace(/\s+/g, '').indexOf(marker)
          if (index < 0) continue
          let offset = 0
          let seen = 0
          while (offset < raw.length && seen < index) { if (!/\s/.test(raw[offset])) seen++; offset++ }
          while (offset < raw.length && /\s/.test(raw[offset])) offset++
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(node, Math.min(raw.length, offset + 1))
          const rect = range.getClientRects()[0]
          if (!rect) continue
          at[marker] = Math.floor((rect.left - flowLeft + 1) / config.pitch)
          break
        }
      }
      return { scrollWidth: flow.scrollWidth, at }
    })
    const pages = pageCountFromFlowWidth(measured.scrollWidth) ?? 0
    const sheets = ((await previewMarkup(resume, pages, template)).match(/data-sheet="/g) ?? []).length
    return { pages, sheets, at: measured.at }
  } finally {
    await page.close()
  }
}

/**
 * Which page of the real PDF each marker is printed on.
 *
 * Read from each page's own content stream, whitespace removed. Page membership
 * is the question, and a page's stream holds exactly the text drawn on it --
 * whereas `extractPdf` rebuilds lines from coordinates and splits detected
 * columns, which in Compact's heading gutter can separate the words of one
 * entry and lose a marker that is plainly on the page.
 */
async function pdfLayout(resume: ResumeV2, template: ResumeTemplate, markers: readonly string[]): Promise<Layout> {
  const bytes = await exportResumePdf(resume, { browser: browser!, template })
  const mod: any = await import('pdfjs-dist/legacy/build/pdf.js')
  const pdfjs: any = mod.getDocument ? mod : mod.default
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, disableAutoFetch: true,
  }).promise
  const texts: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    texts.push(squash((content.items as any[]).map((item) => (typeof item.str === 'string' ? item.str : '')).join('')))
  }
  const at: Record<string, number> = {}
  for (const marker of markers) at[marker] = texts.findIndex((text) => text.includes(marker))
  return { pages: doc.numPages, at }
}

interface ParityCase {
  readonly template: ResumeTemplate
  readonly extra: number
  readonly markers: readonly string[]
  readonly preview: Layout & { sheets: number }
  readonly pdf: Layout
}

let parity: Promise<ParityCase[]> | null = null

/** Every template at every size, laid out once and shared by the tests below. */
function parityCases(): Promise<ParityCase[]> {
  parity ??= (async () => {
    const cases: ParityCase[] = []
    for (const template of ['classic', 'modern', 'compact'] as const) {
      for (let extra = 0; extra <= 48; extra += 3) {
        const resume = pagedResume(extra)
        const markers = markersFor(extra)
        cases.push({
          template, extra, markers,
          preview: await previewLayout(resume, template, markers),
          pdf: await pdfLayout(resume, template, markers),
        })
      }
    }
    return cases
  })()
  return parity
}

test('5. a one-page resume is one visible sheet', { skip }, async () => {
  const cases = (await parityCases()).filter((c) => c.pdf.pages === 1)
  assert.ok(cases.length > 0, 'no fixture printed on one page')
  for (const c of cases) {
    assert.equal(c.preview.pages, 1, `${c.template}/${c.extra}`)
    assert.equal(c.preview.sheets, 1, `${c.template}/${c.extra} drew ${c.preview.sheets} sheets`)
  }

  const page = await browser!.newPage()
  try {
    await page.setContent(htmlPage(await previewMarkup(pagedResume(0), 1, 'classic')), { waitUntil: 'load' })
    const visible = await page.evaluate(() =>
      [...document.querySelectorAll('[data-sheet]')].filter((el) => (el as HTMLElement).offsetHeight > 0).length)
    assert.equal(visible, 1)
  } finally {
    await page.close()
  }
})

for (const [n, label] of [[2, '6. a two-page resume is two visible sheets'], [3, '7. a three-page resume is three visible sheets']] as const) {
  test(label, { skip }, async () => {
    const cases = (await parityCases()).filter((c) => c.pdf.pages === n)
    assert.ok(cases.length > 0, `no fixture printed on ${n} pages`)
    for (const c of cases) {
      assert.equal(c.preview.pages, n, `${c.template}/${c.extra}: the preview has ${c.preview.pages} pages, the PDF ${n}`)
      assert.equal(c.preview.sheets, n, `${c.template}/${c.extra} drew ${c.preview.sheets} sheets`)
    }

    const sample = cases[0]
    const page = await browser!.newPage()
    try {
      await page.setContent(htmlPage(await previewMarkup(pagedResume(sample.extra), n, sample.template)), { waitUntil: 'load' })
      const visible = await page.evaluate(() =>
        [...document.querySelectorAll('[data-sheet]')].filter((el) => (el as HTMLElement).offsetHeight > 0).length)
      assert.equal(visible, n, `${sample.template}/${sample.extra}: ${visible} sheets are visible`)
    } finally {
      await page.close()
    }
  })
}

test('8. content near a page boundary is on the same page in the preview and the PDF', { skip }, async () => {
  let boundaries = 0
  for (const c of await parityCases()) {
    assert.equal(c.preview.pages, c.pdf.pages, `${c.template}/${c.extra}: page count differs`)
    for (const marker of c.markers) {
      assert.notEqual(c.pdf.at[marker], -1, `${c.template}/${c.extra}: "${marker}" missing from the PDF`)
      assert.equal(
        c.preview.at[marker], c.pdf.at[marker],
        `${c.template}/${c.extra}: "${marker}" is on page ${c.preview.at[marker] + 1} in the preview and ${c.pdf.at[marker] + 1} in the PDF`
      )
    }
    // Count the places a page actually turns, so the test is known to have
    // exercised the boundary rather than only the middles of pages.
    for (let i = 1; i < c.markers.length; i++) {
      if (c.pdf.at[c.markers[i]] > c.pdf.at[c.markers[i - 1]]) boundaries++
    }
  }
  assert.ok(boundaries >= 20, `only ${boundaries} page boundaries were exercised`)
})

test('9. a long wrapped bullet is kept whole on one page, in both', { skip }, async () => {
  let longAtBoundary = 0
  for (const c of await parityCases()) {
    for (let i = 0; i < c.extra; i++) {
      const start = `Bullet${i + 1}:`
      const end = `End${i + 1}.`
      assert.equal(c.preview.at[start], c.preview.at[end], `${c.template}/${c.extra}: bullet ${i + 1} is sliced in the preview`)
      assert.equal(c.pdf.at[start], c.pdf.at[end], `${c.template}/${c.extra}: bullet ${i + 1} is sliced in the PDF`)
      assert.equal(c.preview.at[start], c.pdf.at[start], `${c.template}/${c.extra}: bullet ${i + 1} lands on different pages`)
      const previous = i === 0 ? 'RutgersUniversity' : `End${i}.`
      if (isLong(i) && c.pdf.at[start] > c.pdf.at[previous]) longAtBoundary++
    }
  }
  assert.ok(longAtBoundary > 0, 'no long bullet ever sat at a page boundary, so slicing was never tested')
})

test('10. switching template recalculates the pages', { skip }, async () => {
  const cases = await parityCases()
  const bySize = new Map<number, ParityCase[]>()
  for (const c of cases) bySize.set(c.extra, [...(bySize.get(c.extra) ?? []), c])
  const differing = [...bySize.values()].filter((group) => new Set(group.map((c) => c.pdf.pages)).size > 1)
  assert.ok(differing.length > 0, 'no fixture paginates differently between templates')
  for (const group of differing) {
    for (const c of group) {
      assert.equal(c.preview.pages, c.pdf.pages, `${c.template}/${c.extra}: preview ${c.preview.pages}, PDF ${c.pdf.pages}`)
    }
  }
})

test('11. drawing the pages requests nothing — no export, no API, no Chromium', () => {
  for (const path of [
    '../../../app/resume-studio/components/studio/PreviewPane.tsx',
    '../../../app/resume-studio/components/studio/PaginatedDocument.tsx',
  ]) {
    const code = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const forbidden of ['fetch(', '/api/', 'exportResumePdf', 'renderPdf', 'puppeteer', 'XMLHttpRequest']) {
      assert.equal(code.includes(forbidden), false, `${path} reaches for ${forbidden}`)
    }
  }
})
