import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DOCUMENT_CSS } from '../document/css.ts'
import { PREVIEW_WATERMARK, canExportPdf, needsPreviewWatermark } from '../entitlement.ts'

/**
 * The preview gate.
 *
 * Free and Premium see the whole resume -- not blurred, not truncated -- with a
 * mark across it. The mark has one job beyond saying what it says: it must
 * survive Ctrl+P, because Print → Save as PDF is the obvious way round an
 * export gate and a watermark that vanishes there would be worse than none.
 */

/** Comments stripped: the stylesheet's own prose mentions @media print and
 *  @media screen, and searching raw text finds the sentence, not the rule. */
const CSS = DOCUMENT_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

const DOCUMENT = readFileSync(
  fileURLToPath(new URL('../../../components/resume-document/ResumeDocument.tsx', import.meta.url)),
  'utf8'
)

test('the mark says exactly what was specified', () => {
  assert.equal(PREVIEW_WATERMARK, 'PREVIEW — UPGRADE TO ULTIMATE TO FINALIZE')
})

test('it is shown to every tier that cannot export, and to no other', () => {
  for (const tier of ['free', 'premium', 'ultimate', 'unknown']) {
    assert.equal(needsPreviewWatermark(tier), !canExportPdf(tier), tier)
  }
  assert.equal(needsPreviewWatermark('ultimate'), false, 'Ultimate sees a clean preview')
})

test('the stylesheet can draw it', () => {
  assert.match(DOCUMENT_CSS, /\.rd-watermark\s*\{/)
  assert.match(DOCUMENT_CSS, /pointer-events:\s*none/, 'the mark would intercept clicks')
  assert.match(DOCUMENT_CSS, /position:\s*absolute/)
})

test('it survives print, and is forced to', () => {
  const printBlock = CSS.slice(CSS.indexOf('@media print'))
  assert.ok(printBlock.includes('.rd-watermark'), 'print does not re-assert the mark')
  assert.match(printBlock, /display:\s*flex\s*!important/)
  assert.match(printBlock, /visibility:\s*visible\s*!important/)
  assert.match(printBlock, /opacity:\s*1\s*!important/)
  // Browsers drop "background" colour when printing unless told not to.
  assert.match(printBlock, /print-color-adjust:\s*exact/)
})

test('the base rule is not confined to screen', () => {
  // A rule inside @media screen would be gone the moment anyone printed.
  const beforeMedia = CSS.slice(0, CSS.indexOf('@media print'))
  assert.ok(beforeMedia.includes('.rd-watermark'), 'the mark is only defined for print')
  assert.equal(/@media\s+screen/.test(CSS), false, 'a screen-only rule would not print')
})

test('the document renders it only when asked, and hides it from screen readers', () => {
  assert.ok(DOCUMENT.includes('watermark'), 'the renderer takes no watermark')
  assert.match(DOCUMENT, /\{watermark && \(/, 'the mark is not conditional')
  assert.match(DOCUMENT, /aria-hidden="true"/, 'the mark is read aloud to screen readers')
  assert.match(DOCUMENT, /data-watermarked=/, 'nothing marks the root for styling')
})

test('the preview is marked, never reduced', () => {
  // The locked instruction: do not blur or truncate.
  for (const forbidden of ['filter:', 'blur(', 'slice(0,', 'truncate']) {
    assert.equal(
      DOCUMENT.includes(forbidden), false,
      `the renderer degrades the preview with "${forbidden}"`
    )
  }
  const watermarkCss = CSS.slice(CSS.indexOf('.rd-watermark'))
  assert.equal(watermarkCss.includes('blur('), false, 'the stylesheet blurs the preview')
})

test('the mark is repeated text, not a background image', () => {
  // A background image is the first thing a browser drops when printing.
  assert.equal(/background-image/.test(CSS), false)
  assert.match(DOCUMENT, /\.map\(\(row\) => \(/, 'the mark is not tiled across the page')
})
