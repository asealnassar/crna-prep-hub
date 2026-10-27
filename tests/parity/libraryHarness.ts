import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * A deterministic stand-in for the Statement Studio draft list, for measuring
 * mobile layout without an authenticated admin session.
 *
 * ---------------------------------------------------------------------------
 * WHY A HARNESS AND NOT THE REAL PAGE
 * ---------------------------------------------------------------------------
 * /statement-studio is admin-gated and answers 404 to anyone else, so driving
 * the real page needs the owner's own credentials. A layout regression does not
 * need an identity: it needs the markup, the classes and a viewport. The
 * markup below mirrors LibraryClient's card, and
 * libraryMarkup.test.ts PINS the real component against these class strings --
 * so if the component changes, that test fails and says the harness is stale
 * rather than this one quietly measuring something the product no longer does.
 *
 * THE CSS IS THE PROJECT'S OWN TAILWIND, generated through PostCSS from
 * tailwind.config.js against this exact markup. No CDN, no network, no
 * committed stylesheet to drift: the classes resolve to whatever the project
 * currently defines them as.
 */

function repoRoot(): string {
  let dir = process.cwd()
  for (let up = 0; up < 6; up += 1) {
    if (existsSync(resolve(dir, 'tailwind.config.js'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('library harness: could not locate tailwind.config.js from ' + process.cwd())
}

/**
 * The classes the real component carries, kept here as named constants so the
 * pin test can compare them to the component character for character.
 */
export const CARD_CLASSES = {
  /**
   * THE GRID THAT CAUSED WK-QA-003. Below `sm` there is no explicit column, so
   * the single implicit track is `auto`, whose minimum is the grid ITEM's
   * min-content -- and the title's `truncate` sets white-space: nowrap, making
   * min-content the full untruncated title. `grid-cols-1` resolves the track to
   * repeat(1, minmax(0, 1fr)), which is why sm: and xl: never had the problem.
   */
  list: 'mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3',
  listBeforeFix: 'mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-3',
  item: 'min-w-0',
  link: 'group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
  row: 'flex items-start gap-4',
  icon: 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 transition group-hover:bg-blue-600 group-hover:text-white',
  column: 'min-w-0 flex-1',
  title: 'block truncate text-base font-bold text-slate-900',
  meta: 'mt-1 block text-xs text-slate-500',
  action: 'mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-blue-700 transition group-hover:gap-2.5',
} as const

/** The outer shell the list sits in, copied from the page's own wrappers. */
const SHELL_OUTER = 'flex min-h-screen bg-slate-50'
const SHELL_MAIN = 'min-w-0 flex-1 transition-all duration-300 lg:ml-64 pt-16 lg:pt-0'
const SHELL_CONTAINER = 'mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10'

/**
 * The title variants a real library has to survive.
 *
 * The single long token is the one that matters most: it cannot be broken at a
 * space, so any layout that sizes to its content will overflow however wide the
 * viewport is.
 */
export const TITLE_VARIANTS: readonly { readonly label: string; readonly title: string }[] = [
  { label: 'short title', title: 'Draft' },
  { label: 'General Statement title', title: 'Why I want to become a CRNA' },
  { label: 'school-specific title', title: 'Bryan College of Health Sciences — Essay 1 — Why Bryan DNAP' },
  {
    label: 'long title with spaces',
    title: 'My personal statement for the nurse anesthesia programme at a university whose name runs on and on',
  },
  {
    label: 'very long single token',
    title: 'Pneumonoultramicroscopicsilicovolcanoconiosis-and-then-some-more-characters-with-no-spaces-at-all',
  },
  { label: 'title at the stored maximum', title: 'T'.repeat(200) },
]

export interface LibraryHarnessOptions {
  /** Defaults to the current component's classes; the spec also measures the pre-fix ones. */
  readonly listClasses?: string
  readonly itemClasses?: string
}

export async function libraryCss(html: string): Promise<string> {
  const root = repoRoot()
  /**
   * Required rather than imported, and typed by hand.
   *
   * The project is not `"type": "module"`, so this file is transpiled to CJS
   * and a static import of the PostCSS/Tailwind pair would be hoisted out of
   * the function. The hand-written shapes are the two calls actually used; the
   * packages' own types describe a namespace that is not callable this way.
   */
  type Processor = { process(css: string, opts: { from: undefined }): Promise<{ css: string }> }
  /* eslint-disable @typescript-eslint/no-require-imports */
  const postcss = require(resolve(root, 'node_modules/postcss')) as (plugins: unknown[]) => Processor
  const tailwind = require(resolve(root, 'node_modules/tailwindcss')) as (config: unknown) => unknown
  const config = require(resolve(root, 'tailwind.config.js')) as Record<string, unknown>
  /* eslint-enable @typescript-eslint/no-require-imports */
  const result = await postcss([
    tailwind({ ...config, content: [{ raw: html, extension: 'html' }] }),
  ]).process('@tailwind base;@tailwind utilities;', { from: undefined })
  return result.css
}

function cardHtml(title: string, options: LibraryHarnessOptions): string {
  const item = options.itemClasses ?? CARD_CLASSES.item
  return `<li class="${item}">
  <a href="#" class="${CARD_CLASSES.link}">
    <span class="${CARD_CLASSES.row}">
      <span aria-hidden="true" class="${CARD_CLASSES.icon}">
        <svg width="20" height="20" viewBox="0 0 20 20"><rect width="20" height="20" rx="3" fill="currentColor"/></svg>
      </span>
      <span class="${CARD_CLASSES.column}">
        <span class="${CARD_CLASSES.title}">${title}</span>
        <span class="${CARD_CLASSES.meta}">Edited 22 Oct<span aria-hidden="true" class="px-1 text-slate-300">&middot;</span>started 15 Oct</span>
      </span>
    </span>
    <span class="${CARD_CLASSES.action}">Continue writing
      <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 7h12" stroke="currentColor" stroke-width="2"/></svg>
    </span>
  </a>
</li>`
}

export async function libraryHarnessHtml(options: LibraryHarnessOptions = {}): Promise<string> {
  const list = options.listClasses ?? CARD_CLASSES.list
  const body = `<div class="${SHELL_OUTER}">
  <div class="${SHELL_MAIN}">
    <div class="${SHELL_CONTAINER}">
      <h1 class="text-2xl font-bold tracking-tight text-slate-900">Your drafts</h1>
      <ul class="${list}" id="draft-list">
${TITLE_VARIANTS.map((variant) => cardHtml(variant.title, options)).join('\n')}
      </ul>
    </div>
  </div>
</div>`
  const css = await libraryCss(body)
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head><body>${body}</body></html>`
}
