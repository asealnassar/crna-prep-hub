import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PAGE_CONTENT_HEIGHT_PX, PAGE_CONTENT_WIDTH_PX, PAGE_FLOW_GAP_PX, PAGE_HEIGHT_PX, PAGE_MARGIN_PX,
  PAGE_WIDTH_PX, PRINT_BODY_MARGIN_PX,
  describePageSpan, pageCountFromFlowWidth, pageOffsetPx, pageSpanFromDocumentHeight,
  pageSpanFromPageCount, pageSpanNotice,
} from './pages.ts'

/**
 * One page, or more -- known before the download.
 *
 * The rule is here; that it matches a printed PDF on both sides of the page
 * boundary is proved in lib/resume/export/pdf.test.ts.
 */

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const preview = () => source('../../../app/resume-studio/components/studio/PreviewPane.tsx')
const menu = () => source('../../../app/resume-studio/components/export/ExportMenu.tsx')

test('the page box is the one the stylesheet prints', () => {
  // US Letter at 96px per inch, half-inch margins -- the same numbers as @page
  // and .rd-page in document.css. A second idea of the page size here would let
  // the claim drift from the file.
  assert.equal(PAGE_HEIGHT_PX, 11 * 96)
  assert.equal(PAGE_MARGIN_PX, 0.5 * 96)
  assert.equal(PAGE_CONTENT_HEIGHT_PX, PAGE_HEIGHT_PX - 96)
})

test('a document that fills exactly one page box is one page', () => {
  assert.equal(pageSpanFromDocumentHeight(PAGE_HEIGHT_PX), 'single')
  assert.equal(pageSpanFromDocumentHeight(600), 'single')
})

test('any measurable overflow is multi-page, however small', () => {
  // A line that overflows by half a pixel still prints on a second page, so
  // there is no tolerance to hide behind: only floating-point noise is ignored.
  assert.equal(pageSpanFromDocumentHeight(PAGE_HEIGHT_PX + 0.5), 'multi')
  assert.equal(pageSpanFromDocumentHeight(PAGE_HEIGHT_PX + 1), 'multi')
  assert.equal(pageSpanFromDocumentHeight(PAGE_HEIGHT_PX * 3), 'multi')
  assert.equal(pageSpanFromDocumentHeight(PAGE_HEIGHT_PX + 0.005), 'single', 'float noise became a page')
})

test('no measurement means no claim', () => {
  for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(pageSpanFromDocumentHeight(height), null, String(height))
  }
})

// ------------------------------------------------ the paginated flow

test('the preview page is the printed page, body margin included', () => {
  assert.equal(PAGE_WIDTH_PX, 8.5 * 96)
  assert.equal(PAGE_CONTENT_WIDTH_PX, PAGE_WIDTH_PX - 96)
  // Measured from the PDF: the export keeps Chromium's default body margin, so
  // printed text starts 8px inside the page margin. The preview must as well.
  assert.equal(PRINT_BODY_MARGIN_PX, 8)
})

test('a flow of N page columns is N pages', () => {
  for (const n of [1, 2, 3, 7]) {
    const width = n * PAGE_CONTENT_WIDTH_PX + (n - 1) * PAGE_FLOW_GAP_PX
    assert.equal(pageCountFromFlowWidth(width), n, `${n} columns`)
  }
  assert.equal(pageCountFromFlowWidth(PAGE_CONTENT_WIDTH_PX + 0.4), 1, 'sub-pixel overflow became a page')
  for (const width of [0, -1, Number.NaN]) assert.equal(pageCountFromFlowWidth(width), null, String(width))
})

test('each sheet shifts the flow exactly one page pitch further', () => {
  const pitch = PAGE_CONTENT_WIDTH_PX + PAGE_FLOW_GAP_PX
  assert.equal(pageOffsetPx(0), 0)
  assert.equal(pageOffsetPx(1), pitch)
  assert.equal(pageOffsetPx(3), 3 * pitch)
})

test('the status is derived from the sheets drawn, so the two cannot disagree', () => {
  assert.equal(pageSpanFromPageCount(1), 'single')
  assert.equal(pageSpanFromPageCount(2), 'multi')
  assert.equal(pageSpanFromPageCount(5), 'multi')
  for (const pages of [null, 0, Number.NaN]) assert.equal(pageSpanFromPageCount(pages), null, String(pages))
})

test('the wording is exactly one page, or multi-page -- never a count', () => {
  assert.equal(describePageSpan('single'), '1 page')
  assert.equal(describePageSpan('multi'), 'Multi-page')
  // A 2, 3 or 4 here would be a number the measurement cannot vouch for:
  // break-inside rules move whole entries between pages.
  assert.equal(/[2-9]/.test(describePageSpan('multi')), false)
})

test('one page says nothing; more than one says so, and asks for nothing', () => {
  assert.equal(pageSpanNotice('single'), null)
  assert.equal(pageSpanNotice(null), null)
  assert.equal(pageSpanNotice('multi'), 'This resume will export across multiple pages.')
  for (const word of ['shorten', 'reduce', 'too long', 'trim', 'warning', 'error']) {
    assert.equal(pageSpanNotice('multi')!.toLowerCase().includes(word), false, `the notice nags about "${word}"`)
  }
})

// ------------------------------------------- measured, never generated

test('deciding the page span asks nobody — no request, no PDF, no model', () => {
  const module = readFileSync(fileURLToPath(new URL('./pages.ts', import.meta.url)), 'utf8')
  for (const forbidden of ['fetch(', 'import(', '/api/', 'puppeteer', 'exportResumePdf']) {
    assert.equal(module.includes(forbidden), false, `pages.ts reaches for ${forbidden}`)
  }
  assert.equal(/^import /m.test(module), false, 'pages.ts is pure and should import nothing')
})

test('the preview counts the pages the browser laid out', () => {
  const code = preview()
  assert.match(code, /pageCountFromFlowWidth\(flow\.current\.scrollWidth\)/, 'the pages are not measured from the flow')
  assert.match(code, /pageSpanFromPageCount\(pages\)/, 'the status is not derived from the sheets drawn')
  assert.match(code, /<PaginatedDocument/, 'the preview does not draw pages')
  for (const forbidden of ['fetch(', '/api/resume-v2/export', 'exportResumePdf']) {
    assert.equal(code.includes(forbidden), false, `the preview calls ${forbidden} to draw pages`)
  }
})

test('the status still says one page or multi-page, never a count', () => {
  // Page NUMBERS appear on the sheets, which are the browser's own pages and are
  // held to the PDF in lib/resume/studio/studioPreview.test.ts. The toolbar
  // status and the download menu stay a one-or-more claim.
  assert.match(preview(), /describePageSpan\(span\)/)
  for (const code of [preview(), menu()]) {
    assert.equal(/describePageCount|pageCountNotice/.test(code), false, 'an exact-count status is wired up')
  }
})

test('the download menu says 1 page or multi-page for the PDF, and nothing for Word', () => {
  const code = menu()
  assert.match(code, /format === 'pdf' && pageSpan/)
  assert.match(code, /`PDF · \$\{describePageSpan\(pageSpan\)\}`/)
  // Display only: the request still carries an id and nothing else.
  assert.match(code, /JSON\.stringify\(\{ id: resumeId \}\)/)
})
