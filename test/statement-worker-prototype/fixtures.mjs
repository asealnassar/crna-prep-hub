/**
 * The Phase 0 fixtures, with the facts the generator reported.
 *
 * TWO DIFFERENT NUMBERS, AND THE DIFFERENCE MATTERS.
 *
 *   chars               what the generator PLACED. A fact about the PDF, exact.
 *   estimatedExtracted  what the worker is expected to RETURN, i.e. the length
 *                       of `r.text`. Not the same number, and not a fact.
 *
 * Conflating the two is what broke the boundary fixture. It was built to place
 * 48,906 characters, that was recorded as if it were the extracted length, and
 * it actually extracted 53,706 -- above the 50,000 ceiling the fixture existed
 * to sit below. It could not do its job, and nothing caught it, because the
 * only check was a 25% drift tolerance.
 *
 * WHERE estimatedExtracted COMES FROM, per fixture:
 *
 *   small     MEASURED in Phase 1B Stage 1 (r.chars 14,320, 4 pages).
 *   boundary  ESTIMATED. Rebuilt; never extracted. See the note below.
 *   mb1/2/4   PROJECTED from the measured per-page figure. Never extracted.
 *
 * The measured relationship is 3,580 extracted characters per full 48-line
 * page, which reproduces both Stage 1 measurements to the character. Pages are
 * joined with a newline, so r.text.length === r.chars + pages - 1.
 *
 * THE BOUNDARY FIXTURE IS AN ESTIMATE UNTIL EXTRACTION CONFIRMS IT. Whole pages
 * step 3,580 at a time and step straight over the target band -- 13 pages
 * extract ~46,556 and 14 extract ~50,138, which is already over the ceiling --
 * so it needs a partial final page of 26 lines. How the per-page overhead
 * distributes across the lines of a page was NOT measured, so that page's share
 * is apportioned pro rata. Charging it nothing gives ~48,352; charging it a
 * whole page's worth gives ~48,672. Both ends stay inside the 48,000-49,000
 * target and well under the ceiling, but the figure below is a prediction and
 * textBoundary.test.mjs is what will confirm or refute it.
 *
 * `role` is the extraction-eligibility verdict, and it is not the same
 * question as "did extraction work". A 4 MB document extracts perfectly well
 * and is still ineligible to become an essay. Keeping the two apart is the
 * point of textBoundary.test.mjs.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIR = new URL('../../lib/pdf/fixtures/statement-worker/', import.meta.url)

export const FIXTURES = [
  { key: 'small',    file: '01_statement_100kb_under_ceiling.pdf', bytes:  108951, pages:   4, chars:  13040, estimatedExtracted:  14323, estimateBasis: 'measured',  role: 'UNDER' },
  { key: 'boundary', file: '02_statement_at_text_ceiling.pdf',     bytes:  368264, pages:  14, chars:  44179, estimatedExtracted:  48525, estimateBasis: 'estimated', role: 'AT'    },
  { key: 'mb1',      file: '03_statement_1mb_over_ceiling.pdf',    bytes: 1005228, pages:  37, chars: 120648, estimatedExtracted: 132524, estimateBasis: 'projected', role: 'OVER'  },
  { key: 'mb2',      file: '04_statement_2mb_over_ceiling.pdf',    bytes: 2010254, pages:  74, chars: 241305, estimatedExtracted: 265058, estimateBasis: 'projected', role: 'OVER'  },
  { key: 'mb4',      file: '05_statement_4mb_over_ceiling.pdf',    bytes: 3911780, pages: 144, chars: 469620, estimatedExtracted: 515843, estimateBasis: 'projected', role: 'OVER'  },
]

export const byKey = (key) => {
  const f = FIXTURES.find((x) => x.key === key)
  if (!f) throw new Error(`no fixture "${key}"`)
  return f
}

/** Reads a fixture into memory. Nothing in this prototype takes a path. */
export const load = (key) => new Uint8Array(readFileSync(fileURLToPath(new URL(byKey(key).file, DIR))))

/** The eight correctness fixtures live one directory up; used for the scan case. */
export const loadParent = (name) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../lib/pdf/fixtures/${name}`, import.meta.url))))
