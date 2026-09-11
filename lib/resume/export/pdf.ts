/**
 * PDF export: the shared renderer, printed by a real browser.
 *
 * THERE IS NO SECOND RENDERER. This module renders the SAME ResumeDocument the
 * Studio preview mounts, to HTML, and hands that HTML to headless Chromium.
 * Same markup, same stylesheet, same engine -- so the preview and the download
 * cannot drift, which is the defect that defined V1's builder. Nothing here
 * knows what a resume looks like; it knows how to print one.
 *
 * WHY THIS IS TESTABLE, AND WHY THAT MATTERED. Browser print would have been
 * free and equally faithful, but the output goes to the user, never to code, so
 * no regression test is possible. Here the output is a buffer: generate it,
 * extract the text with the pdfjs pipeline this repo already owns, and assert
 * content, order and page breaks. That round trip is the strongest regression
 * net this feature can have, and it is the reason for the dependency.
 *
 * CHROMIUM COMES FROM TWO PLACES. On Vercel (linux) it is the binary shipped by
 * @sparticuz/chromium, which fits comfortably under Fluid Compute's 5 GB. On a
 * developer's machine that binary will not run, so a local Chrome is used
 * instead. PDF_CHROMIUM_PATH overrides both.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement } from 'react'
import ResumeDocument from '../../../components/resume-document/ResumeDocument.tsx'
import { FONT_FACES, fontFaceCss, woff2DataUri } from '../document/fonts.ts'
import { templateFor } from '../document/templates.ts'
import type { TemplateDefinition } from '../document/templates.ts'
import type { ResumeV2 } from '../model/types.ts'

/** Minimal Puppeteer surface, so this module does not depend on its types. */
export interface PdfBrowser {
  newPage(): Promise<PdfPage>
  close(): Promise<void>
}
interface PdfPage {
  setContent(html: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>
  emulateMediaType(type: string): Promise<void>
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>
  pdf(options: Record<string, unknown>): Promise<Uint8Array>
  close(): Promise<void>
}

/** Where a local Chrome usually lives. Only consulted off Linux. */
const LOCAL_CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/**
 * A complete HTML document for one resume.
 *
 * The stylesheet travels inside the markup -- ResumeDocument inlines it -- so
 * this string needs no bundler, no network and no asset server. That is what
 * lets Chromium be handed the document directly and what lets a test assert on
 * it without a browser at all.
 */
/**
 * The @font-face block with the font files inlined.
 *
 * Read from `public/fonts` -- the same files the preview links to -- so the two
 * cannot drift. Inlined rather than linked because Chromium receives an HTML
 * string with no origin, and because an export that fetches nothing over the
 * network cannot be made to fetch something.
 *
 * Cached for the life of the process: the files never change at runtime, and
 * re-reading 100 KB per export would be pure waste on a warm function.
 */
let embeddedFontCss: string | null = null

export async function embeddedFonts(): Promise<string> {
  if (embeddedFontCss) return embeddedFontCss

  const dir = join(process.cwd(), 'public', 'fonts')
  // Every shipped face, so a Latin Extended name renders in the resume's own
  // typeface in the PDF exactly as it does in the preview. Reading the list
  // rather than naming files here means a subset added to FONT_FACES is
  // embedded without touching this function.
  const entries = await Promise.all(
    FONT_FACES.map(async (face) => [face.file, woff2DataUri(await readFile(join(dir, face.file)))] as const)
  )
  const byFile = new Map(entries)

  embeddedFontCss = fontFaceCss((face) => {
    const uri = byFile.get(face.file)
    if (!uri) throw new Error(`Font file missing from public/fonts: ${face.file}`)
    return uri
  })
  return embeddedFontCss
}

export async function documentHtml(
  resume: ResumeV2,
  template?: string | TemplateDefinition
): Promise<string> {
  const definition = typeof template === 'object' && template !== null
    ? template
    : templateFor(template ?? resume.template)

  // Imported at call time, not at the top of the file. Next refuses a static
  // `react-dom/server` import inside App Router code -- rightly, because in
  // almost every case the answer is to return a Server Component instead. This
  // is the case where it is not: Chromium needs the document as a STRING, and
  // no Server Component path produces one. Deferring the import states that
  // this is a server-only render rather than sneaking past the check.
  const { renderToStaticMarkup } = await import('react-dom/server')

  const body = renderToStaticMarkup(
    createElement(ResumeDocument, {
      resume,
      template: definition,
      includeStyles: true,
      fontCss: await embeddedFonts(),
    })
  )

  // `title` becomes the PDF's document title in most viewers.
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(resume.title || 'Resume')}</title>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * The filename the download arrives with.
 *
 * Browser print could not set this at all. Derived from the applicant's name
 * rather than the resume's internal title, because "Duke application.pdf" in a
 * programme's inbox says nothing about who sent it.
 */
export function pdfFilename(resume: ResumeV2): string {
  const base = (resume.contact.fullName || resume.title || 'resume')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'resume'}-resume.pdf`
}

export class ChromiumUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChromiumUnavailableError'
  }
}

/** The executable to drive, or an error naming why there is none. */
export async function resolveExecutablePath(): Promise<string> {
  const override = process.env.PDF_CHROMIUM_PATH
  if (override) {
    if (!existsSync(override)) {
      throw new ChromiumUnavailableError(`PDF_CHROMIUM_PATH does not exist: ${override}`)
    }
    return override
  }

  if (process.platform === 'linux') {
    const chromium = (await import('@sparticuz/chromium')).default
    return await chromium.executablePath()
  }

  const found = LOCAL_CHROME.find((path) => existsSync(path))
  if (found) return found
  throw new ChromiumUnavailableError(
    'No local Chrome found. Install Chrome or set PDF_CHROMIUM_PATH.'
  )
}

async function launchArgs(): Promise<{ args: string[]; headless: boolean }> {
  if (process.platform === 'linux') {
    const chromium = (await import('@sparticuz/chromium')).default
    return { args: chromium.args, headless: true }
  }
  // A developer's Chrome needs none of the Lambda sandbox flags.
  return { args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true }
}

/**
 * Starts a browser. The caller closes it.
 *
 * Exposed separately so a test suite -- or a future warm path -- can launch
 * once and print many documents. Launching is the expensive part; a page is
 * cheap.
 */
export async function launchBrowser(): Promise<PdfBrowser> {
  const [{ default: puppeteer }, executablePath, { args, headless }] = await Promise.all([
    import('puppeteer-core'),
    resolveExecutablePath(),
    launchArgs(),
  ])
  return (await puppeteer.launch({ args, executablePath, headless })) as unknown as PdfBrowser
}

export interface RenderOptions {
  /** Reuse an open browser instead of launching one. */
  readonly browser?: PdfBrowser
  /** How long the page may take to settle. */
  readonly timeoutMs?: number
}

/**
 * HTML in, PDF bytes out.
 *
 * `preferCSSPageSize` is what makes the stylesheet authoritative: the page box,
 * the margins and the break rules in document.css decide the layout, not
 * options passed here. Anything else would be a second place where page
 * geometry is defined, and the two would eventually disagree.
 */
export async function renderPdf(html: string, options: RenderOptions = {}): Promise<Buffer> {
  const ownBrowser = options.browser ? null : await launchBrowser()
  const browser = options.browser ?? ownBrowser!
  const page = await browser.newPage()

  try {
    await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs ?? 30_000 })
    // The print stylesheet is the one that matters; @media print zeroes the
    // screen padding so the @page margin is not applied twice.
    await page.emulateMediaType('print')
    // Without this the page can be captured while a face is still loading, and
    // the PDF quietly comes out in the fallback font. The data URIs resolve
    // almost instantly; this makes "almost" into "definitely".
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const bytes = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    })
    return Buffer.from(bytes)
  } finally {
    await page.close()
    if (ownBrowser) await ownBrowser.close()
  }
}

/** The whole path: canonical resume to PDF bytes. */
export async function exportResumePdf(
  resume: ResumeV2,
  options: RenderOptions & { template?: string } = {}
): Promise<Buffer> {
  return renderPdf(await documentHtml(resume, options.template), options)
}
