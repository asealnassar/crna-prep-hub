import { expect, test, chromium, webkit, type Browser } from '@playwright/test'
import {
  BOLD_PARAGRAPH, PAGE_BREAK_BODY, PANGRAM, expectedFor, harnessHtml, round3,
  type HarnessSpec, type Measurement,
} from './harness.ts'
import { ARIMO_STACK, STUDIO_STACK } from '../../lib/statement/layout/fonts.ts'
import type { Constraints } from '../../lib/statement/requirements/constraints.ts'

/**
 * Chromium/WebKit pagination parity.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The Studio promises an applicant that the page count it shows is the page
 * count their school will see. That promise rests on two engines wrapping the
 * same text at the same places, and Safari is not optional for this audience.
 * A difference of one line height anywhere in here moves a page boundary, and
 * a moved boundary is a statement that silently breaks a stated limit.
 *
 * WHAT IS ASSERTED, AND IN WHICH DIRECTION. Each engine is measured
 * independently and then two things are checked: that the engines produced
 * IDENTICAL numbers, and that those numbers match what the geometry module
 * predicted. Agreement alone would pass if both engines were wrong together;
 * matching the prediction alone would not prove Safari agrees.
 *
 * NO SERVER AND NO SESSION -- see harness.ts. The spec launches both engines
 * itself rather than running twice under projects, because the comparison is
 * the point and a comparison needs both results in one place.
 */

const ENGINES = { chromium, webkit } as const
type EngineName = keyof typeof ENGINES

const DOUBLE_SPACED: Constraints = { pages: { spacing: 'double' } } as unknown as Constraints
const APA: Constraints = { formatProfile: 'apa-7' } as unknown as Constraints

const CASES: readonly HarnessSpec[] = [
  { label: 'normal page geometry, Tinos', constraints: null, stack: STUDIO_STACK, bodyHtml: `<p>${BOLD_PARAGRAPH}</p>` },
  { label: 'normal page geometry, Arimo', constraints: null, stack: ARIMO_STACK, bodyHtml: `<p>${BOLD_PARAGRAPH}</p>` },
  { label: 'double-spacing geometry', constraints: DOUBLE_SPACED, stack: STUDIO_STACK, bodyHtml: `<p>${BOLD_PARAGRAPH}</p>` },
  { label: 'APA half-inch first-line indent', constraints: APA, stack: STUDIO_STACK, bodyHtml: `<p>${BOLD_PARAGRAPH}</p>` },
  { label: 'representative bold wrapping', constraints: null, stack: STUDIO_STACK, bodyHtml: `<p>${BOLD_PARAGRAPH}</p><p>${BOLD_PARAGRAPH}</p>` },
  { label: 'page-break-sensitive fixture', constraints: null, stack: STUDIO_STACK, bodyHtml: `<p>${PAGE_BREAK_BODY}</p>` },
]

/** Launches both engines once and measures every case in each. */
async function measureAll(): Promise<Record<EngineName, Measurement[]>> {
  const out = {} as Record<EngineName, Measurement[]>
  for (const name of Object.keys(ENGINES) as EngineName[]) {
    let browser: Browser | null = null
    try {
      browser = await ENGINES[name].launch()
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 })
      const page = await context.newPage()
      const results: Measurement[] = []
      for (const spec of CASES) {
        await page.setContent(harnessHtml(spec), { waitUntil: 'load' })
        // The fallback's metrics must never reach a measurement.
        await page.evaluate(() => document.fonts.ready)
        results.push(await page.evaluate(() => {
          const px = (v: string) => Math.round(parseFloat(v) * 1000) / 1000
          const content = document.getElementById('measure') as HTMLElement
          const style = getComputedStyle(content)
          const paragraph = content.querySelector('p') as HTMLElement
          const lineHeightPx = px(style.lineHeight)
          const probe = (id: string) => {
            const el = document.getElementById(id)
            return el ? Math.round(el.getBoundingClientRect().width * 1000) / 1000 : -1
          }
          return {
            // Which engine actually rendered this. Without it, "both engines
            // agree" would pass if the harness launched one engine twice.
            engineMarker: navigator.userAgent.includes('Chrome') ? 'blink' : 'webkit',
            fontSynthesis: (style as unknown as Record<string, string>).fontSynthesis ?? 'unsupported',
            contentWidthPx: Math.round(content.getBoundingClientRect().width * 1000) / 1000,
            contentHeightPx: Math.round(content.getBoundingClientRect().height * 1000) / 1000,
            lineHeightPx,
            fontSizePx: px(style.fontSize),
            textIndentPx: px(getComputedStyle(paragraph).textIndent),
            bodyHeightPx: Math.round(paragraph.getBoundingClientRect().height * 1000) / 1000,
            bodyLines: Math.round(paragraph.getBoundingClientRect().height / lineHeightPx),
            probes: {
              tinos: probe('probe-tinos'),
              tinosBold: probe('probe-tinos-bold'),
              arimo: probe('probe-arimo'),
              arimoBold: probe('probe-arimo-bold'),
              synthRegular: probe('probe-synth'),
              synthBold: probe('probe-synth-bold'),
            },
          } as unknown as Measurement
        }))
      }
      out[name] = results
      await context.close()
    } finally {
      await browser?.close()
    }
  }
  return out
}

let measured: Record<EngineName, Measurement[]>

test.beforeAll(async () => {
  test.setTimeout(180_000)
  measured = await measureAll()
})

test.describe('Chromium and WebKit lay the statement page out identically', () => {
  for (const [index, spec] of CASES.entries()) {
    test(`${spec.label}: both engines agree exactly`, () => {
      const { engineMarker: markerA, ...a } = measured.chromium[index]
      const { engineMarker: markerB, ...b } = measured.webkit[index]
      // The marker is the one field that MUST differ -- it proves two engines
      // were measured. Everything else is compared as a whole object, so a new
      // field cannot be added without being covered.
      expect(markerA, 'chromium must be Blink').toBe('blink')
      expect(markerB, 'webkit must not be Blink').toBe('webkit')
      expect(b, spec.label).toEqual(a)
    })

    test(`${spec.label}: matches the geometry module's prediction`, () => {
      const expected = expectedFor(spec.constraints)
      for (const engine of ['chromium', 'webkit'] as const) {
        const m = measured[engine][index]
        // 1pt = 96/72 px, and the box is specified in inches, so these are exact.
        expect(round3(m.lineHeightPx), `${engine} line height`).toBe(round3(expected.lineHeightPt * (96 / 72)))
        expect(round3(m.contentWidthPx), `${engine} content width`).toBe(round3(expected.contentWidthPt * (96 / 72)))
        expect(round3(m.textIndentPx), `${engine} first-line indent`).toBe(round3(expected.firstLineIndentIn * 96))
      }
    })
  }

  test('every bundled face renders as its own face, in both engines', () => {
    for (const engine of ['chromium', 'webkit'] as const) {
      const p = measured[engine][0].probes
      // A real bold face is wider than its regular at the same size; equal
      // widths would mean the bold file never loaded.
      expect(p.tinosBold, `${engine} Tinos bold`).toBeGreaterThan(p.tinos)
      expect(p.arimoBold, `${engine} Arimo bold`).toBeGreaterThan(p.arimo)
      // Tinos and Arimo are different designs, so they must not measure alike.
      expect(p.arimo, `${engine} Arimo vs Tinos`).not.toBe(p.tinos)
    }
  })

  test('font-synthesis is refused on the measured surface, in both engines', () => {
    // ASSERTED ON THE COMPUTED STYLE, not inferred from a width. The first
    // version of this test rendered a family with only a 400 face and asserted
    // that bold did not get wider -- but removing the declaration entirely did
    // not change that width in either engine, so the test could not fail and
    // proved nothing. The computed value is the claim, and it does fail when
    // the declaration goes.
    for (const engine of ['chromium', 'webkit'] as const) {
      for (const [index, spec] of CASES.entries()) {
        expect(measured[engine][index].fontSynthesis, `${engine} / ${spec.label}`).toBe('none')
      }
    }
  })

  test('a bold run uses the real bold face rather than a smear', () => {
    // The companion to the declaration above: a genuinely different face is
    // what makes a refused synthesis safe, so both weights must be present and
    // must measure differently.
    for (const engine of ['chromium', 'webkit'] as const) {
      const p = measured[engine][0].probes
      expect(p.tinosBold - p.tinos, `${engine} Tinos bold delta`).toBeGreaterThan(1)
      expect(p.arimoBold - p.arimo, `${engine} Arimo bold delta`).toBeGreaterThan(1)
    }
  })

  test('the probe widths themselves are identical across engines', () => {
    expect(measured.webkit[0].probes).toEqual(measured.chromium[0].probes)
    expect(PANGRAM.length).toBeGreaterThan(20)
  })

  test('every line box is a whole CSS pixel, which is WHY the engines agree', () => {
    // snapToPixelPt() exists for this: fontMetrics.ts records that an explicit
    // 36.7969px came back as 36.7969 in Chromium and 36.0000 in WebKit, while a
    // whole 37px came back as 37 in both. Integrality is the parity mechanism,
    // so it is asserted directly rather than taken on trust.
    for (const engine of ['chromium', 'webkit'] as const) {
      for (const [index, spec] of CASES.entries()) {
        const px = measured[engine][index].lineHeightPx
        expect(Number.isInteger(px), `${engine} / ${spec.label} line height ${px}`).toBe(true)
      }
    }
  })

  test('double spacing is twice single, to within the pixel each is snapped to', () => {
    // NOT EXACTLY TWICE, and that is correct: single and double are each
    // rounded to a whole pixel independently, so doubling can land one pixel
    // either side. Asserting exact doubling would be asserting a bug.
    const single = expectedFor(null).lineHeightPt
    const double = expectedFor(DOUBLE_SPACED).lineHeightPt
    expect(Math.abs(double - single * 2)).toBeLessThanOrEqual(72 / 96)
    for (const engine of ['chromium', 'webkit'] as const) {
      const singlePx = measured[engine][0].lineHeightPx
      const doublePx = measured[engine][2].lineHeightPx
      expect(doublePx, `${engine} double spacing`).toBeGreaterThan(singlePx)
      expect(Math.abs(doublePx - singlePx * 2), `${engine} double spacing`).toBeLessThanOrEqual(1)
    }
  })

  test('a 1.5-page allowance is one page plus half the next, in both engines', () => {
    const geometryCases = [null, DOUBLE_SPACED] as const
    for (const constraints of geometryCases) {
      const expected = expectedFor(constraints)
      const onePage = expected.contentHeightPt
      // The fractional allowance is the thing Boston College's limit rests on.
      expect(round3(onePage * 1.5)).toBe(round3(onePage + onePage / 2))
    }
    for (const engine of ['chromium', 'webkit'] as const) {
      const m = measured[engine][5]
      const pageHeightPx = expectedFor(null).contentHeightPt * (96 / 72)
      // The fixture is sized to exceed one page but not two, so the page a
      // boundary falls on is engine-visible rather than theoretical.
      expect(m.bodyHeightPx, `${engine} fixture height`).toBeGreaterThan(pageHeightPx)
      expect(m.bodyHeightPx, `${engine} fixture height`).toBeLessThan(pageHeightPx * 2)
    }
  })

  test('the APA indent is half an inch and only on the first line', () => {
    for (const engine of ['chromium', 'webkit'] as const) {
      expect(round3(measured[engine][3].textIndentPx), `${engine} APA indent`).toBe(48)
      expect(round3(measured[engine][0].textIndentPx), `${engine} default indent`).toBe(0)
    }
  })

  test('bold wrapping produces the same number of lines in both engines', () => {
    const a = measured.chromium[4]
    const b = measured.webkit[4]
    expect(b.bodyLines).toBe(a.bodyLines)
    expect(a.bodyLines).toBeGreaterThan(1)
    expect(round3(b.bodyHeightPx)).toBe(round3(a.bodyHeightPx))
  })

  test('the page-break fixture breaks on the same line in both engines', () => {
    const a = measured.chromium[5]
    const b = measured.webkit[5]
    expect(b.bodyLines).toBe(a.bodyLines)
    const linesOnPageOne = expectedFor(null).linesPerPage
    expect(a.bodyLines).toBeGreaterThan(linesOnPageOne)
    expect(round3(b.bodyHeightPx)).toBe(round3(a.bodyHeightPx))
  })
})
