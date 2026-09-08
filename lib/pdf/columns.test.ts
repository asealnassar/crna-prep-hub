import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { detectColumns, type PlacedItem } from './columns.ts'
import { extractPdf } from './extract.ts'

/** An env-supplied fixture path, but only when the file is actually there. */
function existing(p: string | undefined): string | undefined {
  return p && fs.existsSync(p) ? p : undefined
}

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures')
const load = (n: string) => fs.readFileSync(path.join(FIX, n))

const I = (along: number, across: number, text: string, width = text.length * 5): PlacedItem =>
  ({ along, across, width, text })

/** A single-column table: every row is one record spread across fields. */
function tableRows(n: number): PlacedItem[] {
  const out: PlacedItem[] = []
  for (let r = 0; r < n; r++) {
    const y = 700 - r * 18
    out.push(I(72, y, `BIOL ${100 + r}`), I(160, y, 'General Biology'),
      I(330, y, '3.000'), I(380, y, 'A'))
  }
  return out
}

/** Two independent streams that merely share y-coordinates. */
function twoColumns(n: number): PlacedItem[] {
  const out: PlacedItem[] = []
  for (let r = 0; r < n; r++) {
    const y = 700 - r * 18
    out.push(I(20, y, `LEFT ${r}`), I(90, y, 'Left course title'))
    out.push(I(314, y, `RIGHT ${r}`), I(384, y, 'Right course title'))
  }
  return out
}

// ------------------------------------------------------------- single column
test('D45: a wide-field single-column table is NOT split', () => {
  const r = detectColumns(tableRows(14))
  assert.notEqual(r.confidence, 'two-column')
  assert.equal(r.gutter, undefined, 'no gutter means no split')
})

test('D45: a page with too little text is left alone', () => {
  assert.equal(detectColumns(tableRows(3)).confidence, 'single-column')
})

test('D45: uniform table fields still never produce a split', () => {
  // Perfectly aligned fields give a clean vertical band, but with nothing
  // structural agreeing the page must stay unsplit.
  const r = detectColumns(tableRows(20))
  assert.equal(r.gutter, undefined)
})

// --------------------------------------------------------------- two column
test('D45: a repeated table header marks a two-column page', () => {
  const items = twoColumns(12)
  const y = 730
  // The same header printed once per column.
  for (const x of [20, 314]) {
    items.push(I(x, y, 'SUBJ'), I(x + 40, y, 'COURSE TITLE'), I(x + 130, y, 'CRED'))
  }
  const r = detectColumns(items)
  assert.equal(r.confidence, 'two-column')
  assert.ok(r.signals.includes('repeated-header'))
  assert.ok(Math.abs(r.gutter! - 314) < 2, `gutter ${r.gutter}`)
})

test('D45: paired continuation notices mark a two-column page', () => {
  const items = twoColumns(12)
  items.push(I(20, 40, 'CONTINUED ON NEXT COLUMN'), I(314, 40, 'CONTINUED ON PAGE 2'))
  const r = detectColumns(items)
  assert.equal(r.confidence, 'two-column')
  assert.ok(r.signals.includes('paired-continuation'))
  assert.ok(Math.abs(r.gutter! - 314) < 2)
})

test('D45: one continuation notice is not evidence of two columns', () => {
  const items = twoColumns(12)
  items.push(I(20, 40, 'CONTINUED ON PAGE 2'))
  assert.notEqual(detectColumns(items).confidence, 'two-column')
})

test('D45: repeated rule characters cannot pose as a column header', () => {
  const items = tableRows(14)
  const y = 60
  for (let k = 0; k < 8; k++) items.push(I(40 + k * 30, y, '-'))
  const r = detectColumns(items)
  assert.notEqual(r.confidence, 'two-column', 'a legend of dashes is not a header')
  assert.equal(r.gutter, undefined)
})

// ---------------------------------------------------------------- ambiguous
test('D45: signals that disagree leave the page unsplit, not guessed', () => {
  const items = twoColumns(12)
  // Header says the second column starts at 314...
  for (const x of [20, 314]) {
    items.push(I(x, 730, 'SUBJ'), I(x + 40, 730, 'COURSE TITLE'), I(x + 130, 730, 'CRED'))
  }
  // ...while the continuation notices point somewhere else entirely.
  items.push(I(20, 40, 'CONTINUED ON NEXT COLUMN'), I(180, 40, 'CONTINUED ON PAGE 2'))
  const r = detectColumns(items)
  assert.equal(r.confidence, 'ambiguous')
  assert.equal(r.gutter, undefined, 'an ambiguous page is never split')
})

test('D45: geometry alone never splits a page', () => {
  // A clean wide gutter, but nothing structural agreeing with it.
  const items: PlacedItem[] = []
  for (let r = 0; r < 14; r++) {
    const y = 700 - r * 18
    items.push(I(20, y, 'left text here'), I(360, y, 'right text here'))
  }
  const r = detectColumns(items)
  assert.notEqual(r.confidence, 'two-column')
})

// ------------------------------------------------------- real documents
test('D45: coursework fixtures stay single-column', async () => {
  for (const f of ['01_north_valley_basic.pdf', '02_harborview_last60_and_graduate.pdf',
                   '03_cedar_ridge_retakes.pdf', '04_multi_institution_transfer_bundle.pdf']) {
    const r = await extractPdf(load(f))
    for (const p of r.pages) {
      assert.equal(p.layout?.confidence, 'single-column', `${f} page ${p.page}`)
      assert.ok(!p.lines.some(l => l.startsWith('--- COLUMN')), `${f} page ${p.page} was split`)
    }
  }
})

test('D45: a legend page printing its caption twice resolves into regions', async () => {
  // Only the legend page: its "Grade | Points" caption is printed once per
  // block, which is the same evidence a two-column coursework page gives.
  for (const f of ['06_rotated_grading_legend.pdf', '07_rotated_conflicting_legend.pdf']) {
    const r = await extractPdf(load(f))
    assert.deepEqual(r.pages.map(p => p.layout?.confidence),
      ['single-column', 'two-column', 'single-column', 'single-column'], f)
    // The point of splitting: the Standard table becomes one clean vertical
    // list instead of rows merged with an unrelated block.
    const p2 = r.pages[1].lines
    const cut = p2.indexOf('--- COLUMN 2 ---')
    const table = p2.slice(0, cut)
    for (const row of ['A | - Distinguished | 4.00', 'B | - Good | 3.00',
                       'C | - Satisfactory | 2.00', 'D | - Poor | 1.00']) {
      assert.ok(table.includes(row), `${f}: ${row}`)
    }
  }
})

test('D45: layout detection is deterministic', async () => {
  const a = await extractPdf(load('04_multi_institution_transfer_bundle.pdf'))
  const b = await extractPdf(load('04_multi_institution_transfer_bundle.pdf'))
  assert.deepEqual(a.pages.map(p => p.layout), b.pages.map(p => p.layout))
})

// The owner's own transcript is not committed; set the env var to run this.
const MONTCLAIR = existing(process.env.MONTCLAIR_TRANSCRIPT_PDF)
test('D45: Montclair pages resolve per page, not per document',
  { skip: !MONTCLAIR }, async () => {
    const r = await extractPdf(fs.readFileSync(MONTCLAIR!))
    assert.deepEqual(r.pages.map(p => p.layout?.confidence),
      ['two-column', 'two-column', 'single-column'],
      'the totals page must not be split just because the coursework pages were')
  })

test('D45: the Spring 2017 courses follow their own heading in one stream',
  { skip: !MONTCLAIR }, async () => {
    const r = await extractPdf(fs.readFileSync(MONTCLAIR!))
    const p1 = r.pages[0].lines
    const c2 = p1.indexOf('--- COLUMN 2 ---')
    assert.ok(c2 > 0, 'page 1 is split into streams')
    // The heading ends column 1, the courses open column 2, and the document
    // marks the join. Before the fix the courses sat ~40 lines ABOVE it.
    const spring = p1.findIndex(l => /^SPRING 2017$/.test(l))
    assert.ok(spring > 0 && spring < c2, 'SPRING 2017 closes column 1')
    assert.ok(p1.slice(spring, c2).some(l => /CONTINUED ON NEXT COLUMN/.test(l)))
    const biol = p1.findIndex(l => l.startsWith('BIOL 244'))
    assert.ok(biol > c2, 'BIOL 244 opens column 2, after the marker')
    for (const code of ['BIOL 244', 'CMST 101', 'HIST 110', 'MATH 109', 'PSYC 101']) {
      assert.ok(p1.slice(c2).some(l => l.startsWith(code)), `${code} is in column 2`)
    }
  })

// D46 / Rutgers layout: the two halves of a repeated header are frequently
// tokenized differently by the PDF encoder, so the comparison must be on text.
test('D45: a repeated header is found even when the columns tokenize differently', () => {
  const items = twoColumns(12)
  const y = 730
  // Left prints "SUP SEC" as one run; right prints "SUP" and "SEC" separately.
  items.push(I(20, y, 'TITLE'), I(70, y, 'CRED'), I(110, y, 'SUP SEC'), I(170, y, 'GRADE'))
  items.push(I(314, y, 'TITLE'), I(364, y, 'CRED'), I(404, y, 'SUP'), I(430, y, 'SEC'), I(464, y, 'GRADE'))
  const r = detectColumns(items)
  assert.equal(r.confidence, 'two-column')
  assert.ok(r.signals.includes('repeated-header'))
})

test('D45: a short repeated token is not a header', () => {
  const items = tableRows(14)
  items.push(I(40, 60, 'AB'), I(300, 60, 'AB'))
  assert.notEqual(detectColumns(items).confidence, 'two-column')
})

test('D45: structural evidence decides, geometry only refines the position', () => {
  const items = twoColumns(14)
  const y = 730
  // The header label sits well to the right of where its column's text starts,
  // as on a real transcript. The cut must land on the real boundary, not the
  // label, or every row gets sliced in half.
  items.push(I(20, y, 'TITLE'), I(90, y, 'COURSE'), I(160, y, 'CREDITS'))
  items.push(I(380, y, 'TITLE'), I(450, y, 'COURSE'), I(520, y, 'CREDITS'))
  const r = detectColumns(items)
  assert.equal(r.confidence, 'two-column')
  assert.ok(r.gutter! <= 380, `cut ${r.gutter} must not sit right of the column start`)
})

const RUTGERS = existing(process.env.RUTGERS_TRANSCRIPT_PDF)
test('D45: the Rutgers transfer section reconstructs as its own stream',
  { skip: !RUTGERS }, async () => {
    const r = await extractPdf(fs.readFileSync(RUTGERS!))
    assert.equal(r.pages[0].layout?.confidence, 'two-column')
    const p1 = r.pages[0].lines
    const c2 = p1.indexOf('--- COLUMN 2 ---')
    const col1 = p1.slice(0, c2)
    // The transfer block, its originating schools, and the two rows that carry
    // no TR marker of their own all sit in one stream together.
    assert.ok(col1.some(l => /^TRANSFER COURSES$/.test(l)))
    assert.ok(col1.some(l => /MONTCLAIR STATE UNIVERSITY/.test(l)))
    assert.ok(col1.some(l => /HUDSON CO CMTY COLLEGE/.test(l)))
    for (const row of ['DEVELOPMENTAL PSYCH', 'NUTRITION', 'STATISTICS',
                       'GENERAL CHEMISTRY II', 'MICROBIOLOGY LAB']) {
      assert.ok(col1.some(l => l.startsWith(row)), `${row} is inside the transfer stream`)
    }
    // Institutional coursework is in the other stream, not spliced into these.
    assert.ok(!col1.some(l => /PATHOPHYSIOLOGY|FOUND NSG PRACTICE/.test(l)),
      'nursing coursework must not leak into the transfer stream')
  })
