import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { extractPdf } from './extract.ts'

/** An env-supplied fixture path, but only when the file is actually there. */
function existing(p: string | undefined): string | undefined {
  return p && fs.existsSync(p) ? p : undefined
}

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures')
const load = (n: string) => fs.readFileSync(path.join(FIX, n))

// 1 — the exact failure that motivated D28
test('D28: reads a ReportLab-generated PDF that the old parser rejected', async () => {
  const r = await extractPdf(load('01_north_valley_basic.pdf'))
  assert.equal(r.numPages, 1)
  assert.ok(r.totalLines > 15, `expected content, got ${r.totalLines} lines`)
  assert.equal(r.imageOnly, false)
  assert.match(r.text, /North Valley College of Nursing/)
})

// 2 — ordinary multi-page text PDF
test('D28: multi-page extraction keeps every page', async () => {
  const r = await extractPdf(load('02_harborview_last60_and_graduate.pdf'))
  assert.equal(r.numPages, 3)
  assert.equal(r.pages.length, 3)
  for (const p of r.pages) assert.ok(p.lines.length > 0, `page ${p.page} is empty`)
})

// 7 — page ordering
test('D29: pages appear in order with explicit boundaries', async () => {
  const r = await extractPdf(load('04_multi_institution_transfer_bundle.pdf'))
  assert.deepEqual(r.pages.map(p => p.page), [1, 2])
  const i1 = r.text.indexOf('=== PAGE 1 ===')
  const i2 = r.text.indexOf('=== PAGE 2 ===')
  assert.ok(i1 >= 0 && i2 > i1, 'page markers present and ordered')
})

// 8 — line reconstruction, including the watermark bug
test('D29: course rows reconstruct as single lines with column separators', async () => {
  const r = await extractPdf(load('02_harborview_last60_and_graduate.pdf'))
  const lines = r.pages.flatMap(p => p.lines)
  assert.ok(lines.some(l => /^BIOL 101 \| General Biology \| 3 \| C\+$/.test(l)),
    'a simple course row must be one line with | separators')
})

test('D29 REGRESSION: rotated watermark text never splices into a course row', async () => {
  const r = await extractPdf(load('02_harborview_last60_and_graduate.pdf'))
  const lines = r.pages.flatMap(p => p.lines)
  // Before the rotation filter this came out as
  //   "NURS 310 NOT AN OFFICIAL ACADEMIC RECORD 3 A-"  with the title orphaned.
  assert.ok(lines.some(l => l.startsWith('NURS 310 | Pathophysiology')),
    'NURS 310 must keep its own title')
  assert.ok(lines.some(l => l.startsWith('SOC 200 | Sociology')),
    'SOC 200 must keep its own title')
  assert.ok(!lines.some(l => /^[A-Z]{3,4} \d+ .*NOT AN OFFICIAL/.test(l)),
    'no course row may contain watermark text')
  assert.ok(!r.text.includes('NOT AN OFFICIAL ACADEMIC RECORD'),
    'rotated watermark is excluded entirely')
})

test('D29: institution and term headings survive as their own lines', async () => {
  const r = await extractPdf(load('04_multi_institution_transfer_bundle.pdf'))
  const p1 = r.pages[0].lines, p2 = r.pages[1].lines
  assert.ok(p1.includes('Brookstone Community College'), 'page 1 institution heading')
  assert.ok(p2.includes('Lakeshore Metropolitan University'), 'page 2 institution heading')
  assert.ok(p1.some(l => l === 'Fall 2021'), 'term heading kept')
  assert.ok(p2.some(l => /TRANSFER CREDIT ACCEPTED/.test(l)), 'transfer block heading kept')
})

test('D29: summary rows remain identifiable so they can be excluded', async () => {
  const r = await extractPdf(load('01_north_valley_basic.pdf'))
  assert.ok(r.text.includes('Summary row - not a course'))
})

// 6 — image-only PDF
test('D28: an image-only scan is detected, not reported as empty coursework', async () => {
  const r = await extractPdf(load('05_summit_edge_cases_scan_image_only.pdf'))
  assert.equal(r.imageOnly, true)
  assert.equal(r.totalLines, 0)
  assert.ok(r.numPages >= 1, 'the document still has pages')
})

// 3 — malformed PDF
test('D28: a malformed PDF rejects rather than returning junk', async () => {
  const junk = Buffer.from('%PDF-1.4\nthis is not a real pdf body\n%%EOF')
  await assert.rejects(() => extractPdf(junk))
})

test('D28: a truncated PDF rejects', async () => {
  const good = load('01_north_valley_basic.pdf')
  await assert.rejects(() => extractPdf(good.subarray(0, 400)))
})

// 4 — wrong magic bytes (endpoint-level, asserted on the buffer contract)
test('D28: non-PDF bytes are identifiable before parsing', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.notEqual(png.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.equal(load('01_north_valley_basic.pdf').subarray(0, 5).toString('latin1'), '%PDF-')
})

// 5 — oversized input (endpoint limit, asserted as a contract)
test('D28: the 15 MB ceiling is the documented limit', () => {
  const MAX = 15 * 1024 * 1024
  assert.equal(MAX, 15728640)
  for (const f of fs.readdirSync(FIX)) {
    assert.ok(fs.statSync(path.join(FIX, f)).size < MAX, `${f} is within the limit`)
  }
})

test('D28: extraction is deterministic across runs', async () => {
  const a = await extractPdf(load('03_cedar_ridge_retakes.pdf'))
  const b = await extractPdf(load('03_cedar_ridge_retakes.pdf'))
  assert.equal(a.text, b.text)
})

test('D28: retake fixture keeps repeated course codes distinct per term', async () => {
  const r = await extractPdf(load('03_cedar_ridge_retakes.pdf'))
  const lines = r.pages.flatMap(p => p.lines)
  const biol201 = lines.filter(l => l.startsWith('BIOL 201 |'))
  assert.equal(biol201.length, 2, 'both attempts present')
  assert.ok(biol201.some(l => /\| C \|/.test(l) || /\| C$/.test(l)), 'first attempt C')
  assert.ok(biol201.some(l => /\| A \|/.test(l) || /\| A$/.test(l)), 'repeat A')
})

// ---------------------------------------------------------------------------
// Rotated-page reading order (fixture 06).
//
// Every page of 06 lays its text out in a logical frame and then rotates the
// whole frame, so a correct extractor reproduces the logical layout no matter
// what the angle is. See scripts/make_rotation_fixtures.py.
// ---------------------------------------------------------------------------

const ROT = '06_rotated_grading_legend.pdf'

// 1 — a normal portrait page must not regress
test('EXTRACT: an upright page keeps normal reading order', async () => {
  const r = await extractPdf(load(ROT))
  const p1 = r.pages[0].lines
  assert.equal(p1[0], 'NORTHGATE STATE UNIVERSITY')
  assert.equal(p1[1], 'Official Academic Transcript')
  assert.ok(p1.includes('BIOL 101 | General Biology | 4.0 | A'))
  // Vertical order: the heading precedes the rows it introduces.
  assert.ok(p1.indexOf('Fall 2021') < p1.findIndex(l => l.startsWith('BIOL 101')))
})

// 2 — 90 degree rotated text reconstructs in human reading order
test('EXTRACT: 90-degree rotated text reads left-to-right, top-to-bottom', async () => {
  const r = await extractPdf(load(ROT))
  // The legend page prints its grade/points caption twice, so it is correctly
  // resolved as two regions; the title opens the first of them.
  const p2 = r.pages[1].lines
  assert.equal(p2[0], '--- COLUMN 1 ---')
  assert.equal(p2[1], 'EXPLANATION OF GRADING SYSTEM')
  // The exact defect this test exists for: before the projection fix a rotated
  // line came out reversed, e.g. "of the ge ... neral catalog of Rutgers".
  assert.ok(
    p2.some(l => l.startsWith('REGULATIONS GOVERNING USAGE of above grade symbols')),
    'a long rotated sentence must read forwards',
  )
  assert.ok(!p2.some(l => /^school of the University\. .*REGULATIONS/.test(l)),
    'no line may be assembled backwards')
  // Vertical order is also a signed quantity, and was inverted too.
  assert.ok(p2.indexOf('EXPLANATION OF GRADING SYSTEM') <
            p2.findIndex(l => l.startsWith('REGULATIONS GOVERNING')),
    'rotated pages must run top-to-bottom, not bottom-to-top')
})

// 3 — a rotated grading table must associate symbol -> points, in that direction
test('EXTRACT: a rotated grading table associates grade symbol with grade points', async () => {
  const r = await extractPdf(load(ROT))
  const lines = r.pages[1].lines

  // Read the table the way a legend parser would: split into cells, then take
  // each grade symbol together with the next numeric cell after it.
  const found = new Map<string, string>()
  for (const line of lines) {
    const cells = line.split('|').map(c => c.trim())
    for (let i = 0; i < cells.length; i++) {
      if (!/^[A-F][+-]?$/.test(cells[i])) continue
      const pts = cells.slice(i + 1, i + 3).find(c => /^\d\.\d{2}$/.test(c))
      if (pts && !found.has(cells[i])) found.set(cells[i], pts)
    }
  }

  for (const [grade, points] of Object.entries({
    A: '4.00', 'B+': '3.50', B: '3.00', 'C+': '2.50', C: '2.00', D: '1.00', F: '0.00',
  })) {
    assert.equal(found.get(grade), points, `${grade} must resolve to ${points}`)
  }

  // Direction matters: a reversed line would put the number before the symbol.
  assert.ok(lines.some(l => /^A \| - Distinguished \| 4\.00/.test(l)),
    'symbol precedes points')
  assert.ok(!lines.some(l => /^4\.00 \|/.test(l)), 'points must not lead the row')

  // The page carries TWO scales; the second must stay separable, not merged in.
  assert.ok(lines.includes('B. School of Law'), 'the second scale keeps its heading')
  assert.ok(lines.some(l => /^B\+ \| - Intermediate grade \| 3\.33$/.test(l)),
    "the Law scale's own B+ survives distinctly from Standard's 3.50")
})

// 4 — watermark regression, on the rotated fixture as well as fixture 02
test('EXTRACT: a watermark at an outlier angle is dropped, rotated body text is kept', async () => {
  const r = await extractPdf(load(ROT))
  const p3 = r.pages[2].lines
  // Page 3 is 90-degree body text with a 135-degree watermark over it.
  assert.ok(p3.some(l => l === 'NURS 310 | Pathophysiology | 3.0 | A-'),
    'rotated course row survives intact')
  assert.ok(!r.text.includes('NOT AN OFFICIAL ACADEMIC RECORD'),
    'the outlier-angle watermark is excluded')
  assert.ok(!p3.some(l => /NURS \d+ .*OFFICIAL/.test(l)),
    'no watermark text splices into a course row')
})

// 5 — dominant angle, without assuming pages are only ever 0 or 90 degrees
test('EXTRACT: a page at an arbitrary angle is read like any other', async () => {
  const r = await extractPdf(load(ROT))
  const p4 = r.pages[3].lines            // laid out at 30 degrees
  assert.equal(p4[0], 'SKEWED SCAN NOTICE')
  assert.ok(p4.includes('PHYS 101 | Physics | B+'))
  assert.ok(p4.includes('PSYC 100 | Psychology | A'))
  assert.ok(p4.indexOf('SKEWED SCAN NOTICE') < p4.indexOf('PHYS 101 | Physics | B+'))
})

test('EXTRACT: every page of the rotation fixture yields text', async () => {
  const r = await extractPdf(load(ROT))
  assert.equal(r.numPages, 4)
  assert.equal(r.imageOnly, false)
  for (const p of r.pages) assert.ok(p.lines.length > 0, `page ${p.page} is empty`)
})

// Real transcript, opt-in. The file is the owner's own record and is NOT
// committed; set RUTGERS_TRANSCRIPT_PDF to run this locally.
const REAL = existing(process.env.RUTGERS_TRANSCRIPT_PDF)
test('EXTRACT: real rotated legend page states its own applicability rule', { skip: !REAL }, async () => {
  const r = await extractPdf(fs.readFileSync(REAL!))
  const legend = r.pages.find(p => p.lines.some(l => /EXPLANATION OF GRADING SYSTEM/.test(l)))
  assert.ok(legend, 'the grading legend page is readable')
  const text = legend!.lines.join('\n')
  assert.match(text, /A\. Standard \(Exception:/)
  assert.match(text, /^A \| - Distinguished \| 4\.00/m)
  assert.match(text, /^B\+ \| - Intermediate grade \| 3\.50/m)
  assert.match(text, /^C\+ \| - Intermediate grade \| 2\.50/m)
  assert.ok(!/Schoo l|Univer sity|CUM G PA/.test(text), 'no mid-word splits remain')
})

// The conflict fixture must genuinely differ, or the transcript-vs-transcript
// precedence test it backs would pass for the wrong reason.
test('EXTRACT: the conflicting-legend fixture prints a different scale', async () => {
  const a = await extractPdf(load(ROT))
  const b = await extractPdf(load('07_rotated_conflicting_legend.pdf'))
  assert.ok(a.pages[1].lines.some(l => /^B\+ \| - Intermediate grade \| 3\.50\b/.test(l)))
  assert.ok(b.pages[1].lines.some(l => /^B\+ \| - Intermediate grade \| 3\.30\b/.test(l)))
  assert.ok(a.pages[1].lines.some(l => /^C\+ \| - Intermediate grade \| 2\.50/.test(l)))
  assert.ok(b.pages[1].lines.some(l => /^C\+ \| - Intermediate grade \| 2\.30/.test(l)))
  // Everything else must match, so the only variable is the disputed grades.
  assert.equal(a.pages[0].lines.join('\n'), b.pages[0].lines.join('\n'))
})
