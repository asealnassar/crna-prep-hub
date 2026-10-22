import { expect, test, chromium, webkit, type Browser } from '@playwright/test'
import { CARD_CLASSES, TITLE_VARIANTS, libraryHarnessHtml } from './libraryHarness.ts'

/**
 * WK-QA-003 — the Statement Studio draft list must not make the PAGE scroll
 * sideways on a phone.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * The list is `grid ... sm:grid-cols-2 xl:grid-cols-3`. Below `sm` no explicit
 * column exists, so the one implicit track is `auto`, whose minimum is the grid
 * ITEM's min-content -- and the title's `truncate` sets white-space: nowrap,
 * making min-content the entire untruncated title. Measured at 375px before the
 * fix: documentElement.scrollWidth 2176, widest card 2160px, 42 elements past
 * the right edge, in BOTH engines.
 *
 * THIS IS NOT THE EDITOR'S SITUATION. The editor deliberately puts a fixed
 * 8.5in page inside `.statement-page-surface { overflow-x: auto }`, so the
 * paper pans within its own container while the document does not scroll. Here
 * the list's own overflow-x is `visible` and the DOCUMENT was scrolling, which
 * is the thing a reader cannot opt out of.
 *
 * WHAT IS ASSERTED. Both engines, at phone, tablet and desktop widths: the
 * document never needs horizontal scrolling, every card stays inside the
 * viewport, a long title truncates rather than stretching its card, and the
 * card's own controls stay reachable and unclipped. The last test re-measures
 * the PRE-FIX classes and requires them to overflow, so this file cannot pass
 * by measuring nothing.
 *
 * NO AUTHENTICATION. See libraryHarness.ts: the markup is mirrored from
 * LibraryClient and pinned to it by lib/statement/draft/libraryMarkup.test.ts,
 * and the CSS is generated from the project's own tailwind.config.js.
 */

const ENGINES = { chromium, webkit } as const
type EngineName = keyof typeof ENGINES

const WIDTHS = [
  { label: 'phone 375px', width: 375, height: 812, expectColumns: 1 },
  { label: 'tablet 768px', width: 768, height: 1024, expectColumns: 2 },
  { label: 'desktop 1280px', width: 1280, height: 900, expectColumns: 3 },
] as const

interface Shot {
  readonly viewport: number
  readonly docScrollWidth: number
  readonly bodyScrollWidth: number
  readonly listOverflowX: string
  readonly columns: number
  readonly cards: readonly { readonly right: number; readonly width: number; readonly height: number }[]
  readonly titles: readonly {
    readonly right: number
    readonly clientWidth: number
    readonly scrollWidth: number
    readonly truncated: boolean
    readonly text: string
  }[]
  readonly actions: readonly { readonly right: number; readonly width: number; readonly height: number }[]
  readonly pastEdge: number
}

/**
 * Read inside the page. Passed as a FUNCTION, not a template string: a string
 * is evaluated as an expression, so handing page.evaluate() the source of an
 * arrow function returned the function itself and every measurement came back
 * undefined while the keys around it looked correct.
 */
const measure = () => {
  const vw = window.innerWidth
  const list = document.getElementById('draft-list') as HTMLElement
  const box = (el: Element) => {
    const r = el.getBoundingClientRect()
    return { right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }
  }
  const cards = [...document.querySelectorAll('#draft-list > li')]
  return {
    viewport: vw,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    listOverflowX: getComputedStyle(list).overflowX,
    columns: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
    cards: cards.map(box),
    titles: cards.map((c) => {
      const t = c.querySelector('a > span > span:last-child > span:first-child') as HTMLElement
      const b = box(t)
      return {
        right: b.right, clientWidth: t.clientWidth, scrollWidth: t.scrollWidth,
        truncated: t.scrollWidth > t.clientWidth, text: (t.textContent || '').slice(0, 24),
      }
    }),
    actions: cards.map((c) => box(c.querySelector('a > span:last-child') as HTMLElement)),
    pastEdge: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > vw + 1).length,
  }
}

async function shoot(
  browser: Browser,
  html: string,
  size: { width: number; height: number },
): Promise<Shot> {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 })
  try {
    await page.setContent(html, { waitUntil: 'load' })
    await page.waitForTimeout(120)
    return (await page.evaluate(measure)) as Shot
  } finally {
    await page.close()
  }
}

interface Everything {
  readonly fixed: Record<EngineName, Record<string, Shot>>
  readonly unfixedAtPhone: Record<EngineName, Shot>
}

/**
 * Measured once, lazily, and MEMOISED rather than filled in by beforeAll.
 *
 * A beforeAll that assigns module state is not safe here: Playwright restarts
 * the worker around a failing test, the module is re-imported, and the tests
 * then read a fresh binding the re-run hook had not populated yet -- every
 * assertion failed on undefined while the hook was demonstrably succeeding. A
 * promise the tests await cannot be out of step with them.
 */
let pending: Promise<Everything> | null = null
const everything = (): Promise<Everything> => {
  pending ??= (async () => {
    const html = await libraryHarnessHtml()
    const before = await libraryHarnessHtml({
      listClasses: CARD_CLASSES.listBeforeFix,
      itemClasses: '',
    })
    const fixed = {} as Record<EngineName, Record<string, Shot>>
    const unfixedAtPhone = {} as Record<EngineName, Shot>
    for (const name of Object.keys(ENGINES) as EngineName[]) {
      let browser: Browser | null = null
      try {
        browser = await ENGINES[name].launch()
        const perWidth: Record<string, Shot> = {}
        for (const w of WIDTHS) {
          perWidth[w.label] = await shoot(browser, html, { width: w.width, height: w.height })
        }
        fixed[name] = perWidth
        unfixedAtPhone[name] = await shoot(browser, before, { width: 375, height: 812 })
      } finally {
        await browser?.close()
      }
    }
    return { fixed, unfixedAtPhone }
  })()
  return pending
}

test.describe('the draft library fits the viewport in Chromium and WebKit', () => {
  for (const w of WIDTHS) {
    for (const engine of ['chromium', 'webkit'] as const) {
      test(`${engine} at ${w.label}: the page needs no horizontal scrolling`, async () => {
        const { fixed } = await everything()
        const s = fixed[engine][w.label]
        expect(s.docScrollWidth, 'documentElement.scrollWidth').toBeLessThanOrEqual(s.viewport)
        expect(s.bodyScrollWidth, 'body.scrollWidth').toBeLessThanOrEqual(s.viewport)
        expect(s.pastEdge, 'elements past the right edge').toBe(0)
      })

      test(`${engine} at ${w.label}: every card stays inside the viewport`, async () => {
        const { fixed } = await everything()
        const s = fixed[engine][w.label]
        expect(s.cards.length).toBe(TITLE_VARIANTS.length)
        for (const [i, card] of s.cards.entries()) {
          expect(card.right, `card ${i} right edge`).toBeLessThanOrEqual(s.viewport)
          expect(card.width, `card ${i} width`).toBeGreaterThan(0)
          expect(card.height, `card ${i} height`).toBeGreaterThan(0)
        }
      })

      test(`${engine} at ${w.label}: a long title truncates instead of stretching its card`, async () => {
        const { fixed } = await everything()
        const s = fixed[engine][w.label]
        const widest = Math.max(...s.cards.map((c) => c.width))
        // Every card is the same track width, so no title is deciding it.
        for (const card of s.cards) expect(card.width).toBe(widest)
        // The two overflowing variants must be clipped, not accommodated.
        const longOnes = s.titles.filter((t) => /^Pneumono|^TTTTTTTT|^My personal/.test(t.text))
        expect(longOnes.length, 'long-title variants present').toBeGreaterThanOrEqual(2)
        for (const t of longOnes) {
          expect(t.truncated, `"${t.text}" must be truncated`).toBe(true)
          expect(t.right, `"${t.text}" right edge`).toBeLessThanOrEqual(s.viewport)
        }
      })

      test(`${engine} at ${w.label}: a truncated title still identifies the draft`, async () => {
        const { fixed } = await everything()
        const s = fixed[engine][w.label]
        // Clipping to a few pixels would satisfy "no overflow" and be useless.
        for (const t of s.titles) {
          expect(t.clientWidth, `"${t.text}" readable width`).toBeGreaterThan(120)
        }
      })

      test(`${engine} at ${w.label}: the card's control stays reachable and unclipped`, async () => {
        const { fixed } = await everything()
        const s = fixed[engine][w.label]
        for (const [i, action] of s.actions.entries()) {
          expect(action.width, `action ${i} width`).toBeGreaterThan(80)
          expect(action.height, `action ${i} height`).toBeGreaterThan(12)
          expect(action.right, `action ${i} right edge`).toBeLessThanOrEqual(s.viewport)
        }
      })
    }

    test(`both engines lay the library out identically at ${w.label}`, async () => {
      const { fixed } = await everything()
      expect(fixed.webkit[w.label].cards).toEqual(fixed.chromium[w.label].cards)
      expect(fixed.webkit[w.label].columns).toBe(fixed.chromium[w.label].columns)
      expect(fixed.webkit[w.label].docScrollWidth).toBe(fixed.chromium[w.label].docScrollWidth)
    })

    test(`the column count at ${w.label} is ${w.expectColumns}`, async () => {
      const { fixed } = await everything()
      // Desktop must not regress: grid-cols-1 is overridden by sm: and xl:,
      // so adding it may not collapse the wider layouts to a single column.
      for (const engine of ['chromium', 'webkit'] as const) {
        expect(fixed[engine][w.label].columns, engine).toBe(w.expectColumns)
      }
    })
  }

  test('the list is not an inner horizontal scroller, unlike the editor page', async () => {
    const { fixed } = await everything()
    // The editor's paper pans inside overflow-x: auto on purpose. The library
    // must simply fit, so a stray overflow-x here would be the wrong fix
    // silently passing the overflow assertions above.
    for (const engine of ['chromium', 'webkit'] as const) {
      for (const w of WIDTHS) {
        expect(fixed[engine][w.label].listOverflowX, `${engine} / ${w.label}`).toBe('visible')
      }
    }
  })

  test('THE PRE-FIX CLASSES STILL OVERFLOW, so this file can fail', async () => {
    const { fixed, unfixedAtPhone } = await everything()
    // Without this, every assertion above would pass on a page with no cards,
    // or if the harness silently stopped rendering the long titles.
    for (const engine of ['chromium', 'webkit'] as const) {
      const s = unfixedAtPhone[engine]
      expect(s.docScrollWidth, `${engine} pre-fix scrollWidth`).toBeGreaterThan(s.viewport)
      expect(s.pastEdge, `${engine} pre-fix elements past the edge`).toBeGreaterThan(0)
      // And the fixed measurement of the same content does not.
      expect(fixed[engine]['phone 375px'].docScrollWidth).toBeLessThanOrEqual(s.viewport)
    }
  })
})
