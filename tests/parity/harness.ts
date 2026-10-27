import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  ALL_FONT_FACES, ARIMO_STACK, STUDIO_STACK, studioFontFaceCss, type FontFace,
} from '../../lib/statement/layout/fonts.ts'
import {
  contentBox, linesPerPage, resolveGeometry, type PageGeometry,
} from '../../lib/statement/layout/geometry.ts'
import type { Constraints } from '../../lib/statement/requirements/constraints.ts'

/**
 * The page harness the Chromium/WebKit parity spec measures.
 *
 * ---------------------------------------------------------------------------
 * NO SERVER, NO SESSION, NO NETWORK
 * ---------------------------------------------------------------------------
 * The whole document is one string handed to page.setContent(), with the real
 * woff2 files inlined as data URIs. That is deliberate: a parity spec that
 * needed a dev server and an authenticated admin session would be a spec that
 * stopped running the first time either broke, which is exactly when a
 * pagination regression is most likely to slip through.
 *
 * THE CSS IS THE APP'S OWN. The @font-face blocks come from
 * studioFontFaceCss() and the box from resolveGeometry()/contentBox(), so this
 * cannot drift into testing a private copy of the layout rules. Only the src
 * descriptor is swapped, because /fonts/... needs a server and a data URI does
 * not.
 */

/**
 * The repository root, found by walking up from the working directory.
 *
 * NOT import.meta.url: this package is not `"type": "module"`, so Playwright
 * transpiles the spec to CJS and import.meta is a syntax error there. Not a
 * bare process.cwd() either, so running the spec from a subdirectory still
 * finds the fonts instead of failing with a confusing ENOENT.
 */
function repoRoot(): string {
  let dir = process.cwd()
  for (let up = 0; up < 6; up += 1) {
    if (existsSync(resolve(dir, 'public/fonts'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('parity harness: could not locate public/fonts from ' + process.cwd())
}
const ROOT = repoRoot()

const fontCache = new Map<string, string>()
function dataUri(face: FontFace): string {
  const cached = fontCache.get(face.file)
  if (cached !== undefined) return cached
  const bytes = readFileSync(resolve(ROOT, 'public/fonts', face.file))
  const uri = `url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2')`
  fontCache.set(face.file, uri)
  return uri
}

/** The pangram every width measurement uses, so the numbers are comparable. */
export const PANGRAM = 'Sphinx of black quartz, judge my vow — 0123456789'

/**
 * A paragraph with bold runs inside it, long enough to wrap several times.
 *
 * REPRESENTATIVE RATHER THAN SYNTHETIC: bold mid-sentence is what an applicant
 * actually produces, and it is where a synthesised face would change the
 * advance widths and move every following wrap.
 */
export const BOLD_PARAGRAPH =
  'During a night shift in the surgical intensive care unit I noticed my patient '
  + '<strong>guarding her abdomen</strong> while her chart recorded stable vitals. I '
  + 'escalated to the intensivist <strong>twice</strong> before a scan confirmed an '
  + 'internal bleed, and she reached theatre within the hour. That night taught me '
  + 'that a number on a monitor is <strong>a claim rather than a conclusion</strong>, '
  + 'and that advocacy belongs to the anaesthetic role as much as any technical skill.'

/**
 * A body sized to land a line boundary near the foot of page one, so an
 * off-by-one in line height or wrapping changes which page the last line is on.
 */
export const PAGE_BREAK_BODY = Array.from({ length: 72 }, (_, i) =>
  `Line ${i + 1} of the page-break fixture carries enough words to fill the measure exactly once.`,
).join(' ')

export interface HarnessSpec {
  readonly label: string
  readonly constraints: Constraints | null
  readonly stack: string
  readonly bodyHtml: string
}

export function geometryFor(constraints: Constraints | null): PageGeometry {
  return resolveGeometry(constraints)
}

/**
 * One page surface, built from the geometry the app would have used.
 *
 * `font-synthesis: none` and the zeroed paragraph box are copied from
 * PaginatedEditor's own style block; `#probe-synth` declares a family with ONLY
 * a 400 face so a refused synthesis is observable as a width, not inferred.
 */
export function harnessHtml(spec: HarnessSpec): string {
  const geometry = geometryFor(spec.constraints)
  const box = contentBox(geometry)
  const faces = studioFontFaceCss(dataUri, ALL_FONT_FACES)
  const regularOnly = studioFontFaceCss(
    dataUri,
    ALL_FONT_FACES
      .filter((face) => face.family === "'Tinos'" && face.weight === 400)
      .map((face) => ({ ...face, family: "'SynthProbe'" })),
  )
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${faces}
${regularOnly}
html, body { margin: 0; padding: 0; background: #fff; }
.statement-page-surface {
  --page-width: ${geometry.paperWidthIn.value}in;
  --page-margin: ${geometry.marginsIn.value}in;
  --page-content-width: ${box.widthPt / 72}in;
  --page-content-height: ${box.heightPt / 72}in;
  --page-font-size: ${geometry.fontSizePt.value}pt;
  --page-line-height: ${geometry.lineHeightPt}pt;
  --page-indent: ${geometry.firstLineIndentIn.value}in;
}
.statement-page-sheet {
  width: var(--page-width);
  padding: var(--page-margin);
  box-sizing: border-box;
  background: #fff;
}
.statement-page-content {
  font-family: ${spec.stack};
  font-size: var(--page-font-size);
  line-height: var(--page-line-height);
  color: #0f172a;
  text-size-adjust: none;
  -webkit-text-size-adjust: none;
  font-kerning: normal;
  text-rendering: optimizeLegibility;
  font-synthesis: none;
  -webkit-font-synthesis: none;
}
.statement-page-content strong, .statement-page-content b { font-weight: 700; }
.statement-page-content p {
  margin: 0; padding: 0;
  text-indent: var(--page-indent);
  min-height: var(--page-line-height);
}
#measure { width: var(--page-content-width); }
.probe { white-space: nowrap; display: inline-block; }
#probe-synth, #probe-synth-bold { font-family: 'SynthProbe', serif; }
</style></head>
<body>
<div class="statement-page-surface">
  <div class="statement-page-sheet">
    <div class="statement-page-content" id="measure">${spec.bodyHtml}</div>
  </div>
  <div class="statement-page-content">
    <span class="probe" id="probe-tinos" style="font-family: ${STUDIO_STACK}; font-weight: 400">${PANGRAM}</span>
    <span class="probe" id="probe-tinos-bold" style="font-family: ${STUDIO_STACK}; font-weight: 700">${PANGRAM}</span>
    <span class="probe" id="probe-arimo" style="font-family: ${ARIMO_STACK}; font-weight: 400">${PANGRAM}</span>
    <span class="probe" id="probe-arimo-bold" style="font-family: ${ARIMO_STACK}; font-weight: 700">${PANGRAM}</span>
    <span class="probe" id="probe-synth" style="font-weight: 400">${PANGRAM}</span>
    <span class="probe" id="probe-synth-bold" style="font-weight: 700">${PANGRAM}</span>
  </div>
</div>
</body></html>`
}

/** Rounded to 3 decimals: enough to catch a real difference, not float noise. */
export const round3 = (n: number) => Math.round(n * 1000) / 1000

export interface Measurement {
  readonly engineMarker: string
  readonly fontSynthesis: string
  readonly contentWidthPx: number
  readonly contentHeightPx: number
  readonly lineHeightPx: number
  readonly fontSizePx: number
  readonly textIndentPx: number
  readonly bodyHeightPx: number
  readonly bodyLines: number
  readonly probes: Readonly<Record<string, number>>
  readonly expected: {
    readonly lineHeightPt: number
    readonly linesPerPage: number
    readonly contentWidthPt: number
    readonly contentHeightPt: number
    readonly firstLineIndentIn: number
  }
}

export function expectedFor(constraints: Constraints | null) {
  const geometry = geometryFor(constraints)
  const box = contentBox(geometry)
  return {
    lineHeightPt: geometry.lineHeightPt,
    linesPerPage: linesPerPage(geometry),
    contentWidthPt: box.widthPt,
    contentHeightPt: box.heightPt,
    firstLineIndentIn: geometry.firstLineIndentIn.value,
  }
}
