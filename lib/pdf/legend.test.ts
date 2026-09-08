import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  pairsFromRow, detectLegendTables, legendCandidates, candidateById, describeCandidates,
} from './legend.ts'
import { extractPdf } from './extract.ts'

/** An env-supplied fixture path, but only when the file is actually there. */
function existing(p: string | undefined): string | undefined {
  return p && fs.existsSync(p) ? p : undefined
}

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures')
const load = (n: string) => fs.readFileSync(path.join(FIX, n))

// ------------------------------------------------------------- pair reading
test('D48: a legend row yields its grade/point pairs', () => {
  const p = pairsFromRow('C+ | - Intermediate grade | 2.50 | IN | - Incomplete')
  assert.equal(p.length, 1)
  assert.equal(p[0].symbol, 'C+')
  assert.equal(p[0].points, 2.5)
})

test('D48: both pairs on a two-up legend row are read', () => {
  const p = pairsFromRow('A | - Distinguished | 4.00 | F | - Failing | 0.00')
  assert.deepEqual(p.map(x => [x.symbol, x.points]), [['A', 4], ['F', 0]])
})

test('D48: a value is never captured across a neighbouring pair', () => {
  // B has no value printed; it must not borrow C+'s.
  const p = pairsFromRow('B | - Good | C+ | - Intermediate grade | 2.50')
  assert.deepEqual(p.map(x => x.symbol), ['C+'])
})

test('D48: credit values are not grade points', () => {
  // Credits print 4.0 or 3.000; grade points print exactly two decimals.
  assert.deepEqual(pairsFromRow('NURS 310 | Pathophysiology | 3.0 | A'), [])
  assert.deepEqual(pairsFromRow('BIOL 244 | Anatomy and Physiology I | 4.000 B-'), [])
  assert.deepEqual(pairsFromRow('FOUND NSG PRACTICE | 77 705 304 | NG | 4.0 | A'), [])
})

test('D48: totals rows are never legend rows', () => {
  for (const row of ['Ehrs: | 14.000 QPts: | 44.800',
                     'GPA-Hrs: | 14.000 GPA: | 3.200',
                     'DEGREE CREDITS EARNED: 78.0 | TERM AVG: 3.813']) {
    assert.deepEqual(pairsFromRow(row), [], row)
  }
})

test('D48: arbitrary documented symbols are preserved', () => {
  const p = pairsFromRow('EX | - Exceptional | 4.50 | S | - Satisfactory | 2.75')
  assert.deepEqual(p.map(x => [x.symbol, x.points]), [['EX', 4.5], ['S', 2.75]])
})

// ------------------------------------------------------------ real documents
const RUTGERS = existing(process.env.RUTGERS_TRANSCRIPT_PDF)
const MONTCLAIR = existing(process.env.MONTCLAIR_TRANSCRIPT_PDF)

test('D48: the Rutgers Standard table is extracted in full, every time',
  { skip: !RUTGERS }, async () => {
    const r = await extractPdf(fs.readFileSync(RUTGERS!))
    const tables = legendCandidates(r)
    const standard = tables.find(t => /A\.\s*Standard/i.test(t.caption ?? ''))
    assert.ok(standard, 'the Standard table is a candidate, identified by its own heading')
    assert.deepEqual(standard!.points, {
      A: 4.0, 'B+': 3.5, B: 3.0, 'C+': 2.5, C: 2.0, D: 1.0, F: 0.0,
    })
  })

test('D48: the five Rutgers tables stay separate, never merged',
  { skip: !RUTGERS }, async () => {
    const tables = legendCandidates(await extractPdf(fs.readFileSync(RUTGERS!)))
    assert.ok(tables.length >= 4, `expected several tables, got ${tables.length}`)
    const standard = tables.find(t => /A\.\s*Standard/i.test(t.caption ?? ''))!
    assert.equal(standard.points['B+'], 3.5)
    // The proof that nothing was merged: the same symbol carries different
    // values in different candidates. A merged map could only hold one.
    const bPlus = new Set(tables.map(t => t.points['B+']).filter(v => v !== undefined))
    assert.ok(bPlus.size >= 2, `B+ should differ between tables, saw ${[...bPlus]}`)
    assert.ok(bPlus.has(3.5) && bPlus.has(3.33))
    const cPlus = new Set(tables.map(t => t.points['C+']).filter(v => v !== undefined))
    assert.ok(cPlus.has(2.5) && cPlus.has(2.33), `C+ values seen: ${[...cPlus]}`)
  })

test('D48: extraction is byte-stable over repeated runs',
  { skip: !RUTGERS }, async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      seen.add(JSON.stringify(legendCandidates(await extractPdf(fs.readFileSync(RUTGERS!)))))
    }
    assert.equal(seen.size, 1, 'the same document yields the same tables every time')
  })

test('D48: Montclair prints no legend, so no table is detected',
  { skip: !MONTCLAIR }, async () => {
    const tables = legendCandidates(await extractPdf(fs.readFileSync(MONTCLAIR!)))
    assert.deepEqual(tables, [], 'no scale may be reverse-engineered from totals or GPAs')
  })

// ------------------------------------------------------------------ fixtures
test('D48: a rotated legend page is parsed correctly', async () => {
  const tables = legendCandidates(await extractPdf(load('06_rotated_grading_legend.pdf')))
  const standard = tables.find(t => /A\.\s*Standard/i.test(t.caption ?? ''))!
  assert.ok(standard)
  assert.deepEqual(standard.points, {
    A: 4.0, 'B+': 3.5, B: 3.0, 'C+': 2.5, C: 2.0, D: 1.0, F: 0.0,
  })
  assert.ok(tables.some(t => /School of Law/i.test(t.caption ?? '')), 'the second table survives')
})

test('D48: a conflicting legend keeps its own values', async () => {
  const a = legendCandidates(await extractPdf(load('06_rotated_grading_legend.pdf')))
  const b = legendCandidates(await extractPdf(load('07_rotated_conflicting_legend.pdf')))
  const std = (ts: any[]) => ts.find(t => /A\.\s*Standard/i.test(t.caption ?? ''))!
  assert.equal(std(a).points['B+'], 3.5)
  assert.equal(std(b).points['B+'], 3.3)
  assert.equal(std(a).points['C+'], 2.5)
  assert.equal(std(b).points['C+'], 2.3)
})

test('D48: coursework fixtures print no legend', async () => {
  for (const f of ['01_north_valley_basic.pdf', '02_harborview_last60_and_graduate.pdf',
                   '03_cedar_ridge_retakes.pdf', '04_multi_institution_transfer_bundle.pdf']) {
    assert.deepEqual(legendCandidates(await extractPdf(load(f))), [], f)
  }
})

test('D48: a partial table is reported as-is, never completed', async () => {
  const tables = detectLegendTables({
    numPages: 1, totalLines: 3, text: '', imageOnly: false,
    pages: [{ page: 1, lines: [], flatLines: [
      'A. Partial Scale',
      'A | - Distinguished | 4.00',
      'B | - Good | 3.00',
      'C | - Satisfactory | 2.00',
    ] }],
  })
  assert.equal(tables.length, 1)
  assert.deepEqual(Object.keys(tables[0].points).sort(), ['A', 'B', 'C'])
  assert.ok(!('B+' in tables[0].points), 'no symbol is invented to fill the gap')
})

// ------------------------------------------------------- applicability role
test('D48: a table is selected by id, and its values cannot be overwritten', async () => {
  const tables = legendCandidates(await extractPdf(load('06_rotated_grading_legend.pdf')))
  const std = tables.find(t => /A\.\s*Standard/i.test(t.caption ?? ''))!
  // What the analyzer returns is an id; resolution is deterministic lookup.
  const chosen = candidateById(tables, std.id)
  assert.ok(chosen)
  assert.deepEqual(chosen!.points, std.points)
  assert.equal(candidateById(tables, 'not-a-real-id'), null)
  assert.equal(candidateById(tables, null), null)
  // The description offered to the analyzer carries ids and headings.
  const text = describeCandidates(tables)
  assert.match(text, new RegExp(`id "${std.id}"`))
  assert.match(text, /C\+=2\.50/)
})
