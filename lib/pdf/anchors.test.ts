import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  anchorFromLine, courseAnchors, courseAnchorsFromText, matchAnchors,
} from './anchors.ts'
import { extractPdf } from './extract.ts'

/** An env-supplied fixture path, but only when the file is actually there. */
function existing(p: string | undefined): string | undefined {
  return p && fs.existsSync(p) ? p : undefined
}

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures')
const load = (n: string) => fs.readFileSync(path.join(FIX, n))

const A = (line: string) => anchorFromLine(line, 1, 0)

// ------------------------------------------------- what counts as a course row
test('D47: a row with a code, a title and credits is an anchor', () => {
  const a = A('BIOL 244 | Anatomy and Physiology I | 4.000 B-')!
  assert.ok(a)
  assert.equal(a.credits, 4)
  assert.equal(a.grade, 'B-')
})

test('D47: a row printed with NO grade is still a valid anchor', () => {
  // The exact rows that vanished: a transfer entry carrying no grade token.
  const dp = A('DEVELOPMENTAL PSYCH | 77 705 229 | 3.0')!
  assert.ok(dp, 'a gradeless transfer row must be inventoried')
  assert.equal(dp.grade, undefined)
  assert.equal(dp.credits, 3)
  assert.ok(A('NUTRITION | 77 705 255 | 3.0'))
})

test('D47: a numeric catalog number is recognised', () => {
  assert.equal(A('CULTURE, LIFE&HLTH | 77 705 202 | NA | 3.0 | B')!.code, '77 705 202')
  assert.equal(A('ANATOMY AND PHYSIOLOGY I | TR T77 AP1 | 4.0')!.code, 'TR T77 AP1')
})

// -------------------------------------------------------- false anchors
test('D47: headers, totals, legends and metadata are never anchors', () => {
  for (const line of [
    'TITLE | SCH DEPT CRS SUP SEC CRED PR GRADE',
    'SUBJ NO. | COURSE TITLE | CRED GRD | R',
    'Ehrs: | 14.000 QPts: | 44.800',
    'GPA-Hrs: | 14.000 GPA: | 3.200',
    'INSTITUTION | Ehrs: | 131.000 QPts: | 448.900',
    'DEGREE CREDITS EARNED: 78.0 | TERM AVG: 3.813 CUMULATIVE AVG: 3.813',
    'TOTAL TRANSFER CREDITS: | 62.0',
    '******************** CONTINUED ON NEXT COLUMN *******************',
    'Institution Information continued:',
    'EXPLANATION OF GRADING SYSTEM',
    'A | - Distinguished | 4.00 | F | - Failing | 0.00',
    'C+ | - Intermediate grade | 2.50 | IN | - Incomplete',
    'Grade Points | Grade Points',
    'MAJOR: NURSING',
    'College : Education and Human Services',
    'Degree Awarded Bachelor of Science 22-MAY-2020',
    'RECORD OF: A STUDENT NAME',
    'STUDENT NUMBER: 199000807',
    'RECORD DATE: 11/25/24 | PAGE: 1',
    '--- COLUMN 2 ---',
    '=== PAGE 2 ===',
    '_________________________________________________________________',
  ]) {
    assert.equal(A(line), null, `should not anchor: ${line}`)
  }
})

test('D47: a decimal credit beats a bare integer earlier on the row', () => {
  // "TITLE | CODE | 10 | 3.0 | A" -- the 10 is a section number. Taking the
  // first plausible number sized this row at 10 credits and it then failed to
  // match its own extracted course.
  const a = anchorFromLine('LDRSHP&MGMT NSG-SD | 25 705 425 | 10 | 3.0 | A', 1, 0)!
  assert.equal(a.credits, 3)
  // With no decimal anywhere on the row, a bare integer is still accepted.
  assert.equal(anchorFromLine('BIOL 101 | General Biology | 3 | A', 1, 0)!.credits, 3)
})

test('D47: a bare number is not a credit value', () => {
  assert.equal(A('Fall | 2017'), null)
  assert.equal(A('Spring 2020 | 75'), null)
})

// ------------------------------------------------------------------- matching
const anchors = [
  A('DEVELOPMENTAL PSYCH | 77 705 229 | 3.0')!,
  A('NUTRITION | 77 705 255 | 3.0')!,
  A('PATHOPHYSIOLOGY | 77 705 245 | NA | 3.0 | A')!,
]
const row = (courseCode: string, name: string, credits: number) => ({ courseCode, name, credits })

test('D47: a correct extraction reconciles structurally', () => {
  const m = matchAnchors(anchors, [
    row('77 705 229', 'Developmental Psych', 3),
    row('77 705 255', 'Nutrition', 3),
    row('77 705 245', 'Pathophysiology', 3),
  ])
  assert.equal(m.unmatched.length, 0)
  assert.equal(m.matched.length, 3)
})

test('D47: harmless formatting differences still match', () => {
  const m = matchAnchors(anchors, [
    row('77:705:229', 'developmental   psych', 3.0),
    row('77-705-255', 'NUTRITION', 3),
    row('77 705 245', 'Pathophysiology', 3),
  ])
  assert.equal(m.unmatched.length, 0)
})

// --------------------------------------------- the failures that must retry
test('D47 FAIL CASE 1: fewer rows than the document prints is a mismatch', () => {
  const m = matchAnchors(anchors, [row('77 705 245', 'Pathophysiology', 3)])
  assert.equal(m.unmatched.length, 2)
  assert.deepEqual(m.unmatched.map(a => a.title).sort(),
    ['DEVELOPMENTAL PSYCH', 'NUTRITION'])
})

test('D47 FAIL CASE 2: the right ROW COUNT with the wrong rows is still a mismatch', () => {
  // Three rows returned, but two are courses the document never printed.
  const m = matchAnchors(anchors, [
    row('77 705 245', 'Pathophysiology', 3),
    row('99 999 111', 'Invented Course A', 3),
    row('99 999 222', 'Invented Course B', 3),
  ])
  assert.equal(m.unmatched.length, 2, 'row count alone proves nothing')
  assert.equal(m.unanchoredRows, 2, 'and the invented rows are visible as unanchored')
})

test('D47 FAIL CASE 3: a duplicated row cannot satisfy a different anchor', () => {
  const m = matchAnchors(anchors, [
    row('77 705 245', 'Pathophysiology', 3),
    row('77 705 245', 'Pathophysiology', 3),
    row('77 705 245', 'Pathophysiology', 3),
  ])
  assert.equal(m.unmatched.length, 2, 'one anchor is satisfied once, never three times')
})

test('D47 FAIL CASE 4: two IDENTICAL wrong extractions are both rejected', () => {
  // The reason agreement between AI runs is not evidence: both runs here drop
  // the same two rows and agree perfectly with each other.
  const wrong = [row('77 705 245', 'Pathophysiology', 3)]
  const first = matchAnchors(anchors, wrong)
  const second = matchAnchors(anchors, [...wrong])
  assert.deepEqual(first.unmatched.map(a => a.key), second.unmatched.map(a => a.key))
  assert.equal(first.unmatched.length, 2)
  assert.equal(second.unmatched.length, 2, 'agreeing with itself does not make it right')
})

test('D47: a title-only resemblance never satisfies an anchor', () => {
  // Same title, different credits: a real different course, not a match.
  const m = matchAnchors(anchors, [row('77 705 229', 'Developmental Psych', 4)])
  assert.equal(m.unmatched.length, 3)
})

// ------------------------------------------------------- real documents
const RUTGERS = existing(process.env.RUTGERS_TRANSCRIPT_PDF)
const MONTCLAIR = existing(process.env.MONTCLAIR_TRANSCRIPT_PDF)

test('D47: the Rutgers inventory holds every printed course row',
  { skip: !RUTGERS }, async () => {
    const r = await extractPdf(fs.readFileSync(RUTGERS!))
    const a = courseAnchors(r)
    assert.equal(a.length, 27, 'the document prints 27 course rows')
    for (const title of ['DEVELOPMENTAL PSYCH', 'NUTRITION']) {
      const hit = a.find(x => x.title.toUpperCase().startsWith(title))
      assert.ok(hit, `${title} must be inventoried`)
      assert.equal(hit!.grade, undefined, 'and it prints no grade')
    }
    // The transfer block and the institutional block are separate regions.
    assert.ok(a.some(x => x.region === 1) && a.some(x => x.region === 2))
    // Same text, same inventory: the payload path agrees with the page path.
    assert.deepEqual(courseAnchorsFromText(r.text).map(x => x.key), a.map(x => x.key))
  })

test('D47: this is what the missing-row failure looks like',
  { skip: !RUTGERS }, async () => {
    const r = await extractPdf(fs.readFileSync(RUTGERS!))
    const a = courseAnchors(r)
    // Reproduce the observed bad run: the transfer block was dropped entirely,
    // leaving only the institutional coursework. Those rows are the ones whose
    // catalog number carries the transfer prefix, plus the two gradeless rows
    // that sit inside the same block without one.
    const isTransferRow = (x: { code: string; title: string }) =>
      /\bTR\b/.test(x.code) || /DEVELOPMENTAL PSYCH|NUTRITION/i.test(x.title)
    const institutionalOnly = a.filter(x => !isTransferRow(x))
      .map(x => ({ courseCode: x.code, name: x.title, credits: x.credits }))
    assert.equal(institutionalOnly.length, 16, 'the bad run returned 16 rows')
    const m = matchAnchors(a, institutionalOnly)
    assert.equal(m.unmatched.length, 11, 'the eleven transfer rows are detected as missing')
    assert.equal(m.unanchoredRows, 0, 'nothing invented -- purely an omission')
  })

test('D47: the Montclair inventory holds every printed course row',
  { skip: !MONTCLAIR }, async () => {
    const r = await extractPdf(fs.readFileSync(MONTCLAIR!))
    assert.equal(courseAnchors(r).length, 45)
  })

test('D47: an inventory never demands more rows than a fixture contains', async () => {
  for (const [f, max] of [['01_north_valley_basic.pdf', 8],
                          ['02_harborview_last60_and_graduate.pdf', 27],
                          ['03_cedar_ridge_retakes.pdf', 12],
                          ['04_multi_institution_transfer_bundle.pdf', 22]] as const) {
    const a = courseAnchors(await extractPdf(load(f)))
    assert.ok(a.length > 0, `${f} yields an inventory`)
    assert.ok(a.length <= max, `${f}: ${a.length} anchors must not exceed ${max} real rows`)
  }
})

test('D47: the inventory is deterministic', async () => {
  const one = courseAnchors(await extractPdf(load('03_cedar_ridge_retakes.pdf')))
  const two = courseAnchors(await extractPdf(load('03_cedar_ridge_retakes.pdf')))
  assert.deepEqual(one, two)
})

// ------------------------------------- quality-points column (Student B1 bug)
// A transcript that prints a POINTS column beside the credits fuses the credit
// value with its grade ("3.0 A") and leaves the points standing alone
// ("12.00"). Reading the first bare decimal sized every graded row by its grade
// points, so 17 of 21 anchors matched nothing and the import was reported as
// incomplete even though all 22 rows had been read correctly.
test('D47: the credit column is read, never the quality-points column', () => {
  const a = A('ENG 101 | English Composition I | 3.0 A | 12.00')!
  assert.ok(a, 'the row is still an anchor')
  assert.equal(a.credits, 3, 'credits, not the 12.00 quality points')
  assert.equal(a.grade, 'A')
})

test('D47: every shape of the points column is sized by its credits', () => {
  for (const [line, credits, grade] of [
    ['BIO 201 | Anatomy & Physiology I | 4.0 A- | 14.80', 4, 'A-'],
    ['PSY 101 | General Psychology | 3.0 B+ | 9.90', 3, 'B+'],
    ['MAT 110 | College Algebra | 3.0 B- | 8.10', 3, 'B-'],
    ['CHM 101 | General Chemistry I | 4.0 F | 0.00', 4, 'F'],
    ['MIC 210 | Microbiology | 4.0 A | 16.00', 4, 'A'],
  ] as const) {
    const a = A(line)!
    assert.equal(a.credits, credits, line)
    assert.equal(a.grade, grade, line)
  }
})

test('D47: credits and grade in separate cells still beat the points column', () => {
  // The credit value sits immediately before the grade; points come after it.
  const a = A('ENG 101 | English Composition I | 3.0 | A | 12.00')!
  assert.equal(a.credits, 3)
  assert.equal(a.grade, 'A')
})

test('D47: a section number still loses to the credit value', () => {
  // The earlier fix must survive: "TITLE | CODE | 10 | 3.0 | A" is 3 credits
  // in section 10, and a credit-hour prefix is not a grade.
  const a = A('LDRSHP&MGMT NSG-SD | 25 705 425 | 10 | 3.0 | A')!
  assert.equal(a.credits, 3)
  const prefixed = A('HEALTH ASSESSMENT | 77 705 306 | NC | 3.0 | A')!
  assert.equal(prefixed.credits, 3)
  assert.equal(prefixed.grade, 'A', 'the grade is A; NC is the credit-hour prefix')
})

test('D47: rows with no points column are unchanged', () => {
  assert.equal(A('ART 100 | Art Appreciation | 3.0 P')!.credits, 3)
  assert.equal(A('HIS 110 | World History | 3.0 WD')!.grade, 'WD')
  assert.equal(A('PED 110 | Lifetime Fitness | 2.0 P')!.credits, 2)
})

test('D47: a number followed by something that is not a grade is not credits', () => {
  // "3.0 XY" is not a credit/grade pair, so it cannot claim the credit column.
  const a = anchorFromLine('ENG 101 | English Composition I | 3.0 XY | 12.00', 1, 0)
  assert.ok(a === null || a.credits === 12, 'no invented credit value')
})

// ------------------------------- a course row flattened onto a marker's line
test('D47: a course row sharing a line with a marker is still inventoried', () => {
  const a = A('******** CONTINUED ON NEXT COLUMN ******** | MAT 210 | Applied Statistics | 3.0 A | 12.00')!
  assert.ok(a, 'a flattened two-column page must not hide a course row')
  assert.equal(a.code, 'MAT 210')
  assert.equal(a.credits, 3)
  assert.equal(a.grade, 'A')
})

test('D47: recovery never invents a row out of structure alone', () => {
  for (const line of [
    '******** CONTINUED ON NEXT COLUMN ********',
    '******** CONTINUED ON PAGE 2 ********',
    'COURSE | TITLE | CR | GR | PTS | Term GPA-Hrs: 11.0 QPts: 41.20 Term GPA: 3.745',
    'Term GPA-Hrs: 13.0 QPts: 42.00 Term GPA: 3.231',
    'INSTITUTION Ehrs | 65.000 QPts | 214.200',
    'GPA-Hrs | 60.000 GPA | 3.570',
    '******** CONTINUED ON NEXT COLUMN ******** | FALL 2021',
  ]) {
    assert.equal(A(line), null, line)
  }
})

// ------------------------------------------- the two-column repeated fixture
const TWO_COL = '08_two_column_repeated_course.pdf'

/**
 * Every course row the fixture prints, with the term it belongs to.
 *
 * This mirrors, row for row, a real staggered two-column transcript: six
 * terms split across two columns whose table headers do not share a baseline.
 * The term is the point of the test -- a page that reads as one stream gives
 * every right-column course the left column's term heading, which is wrong in
 * a way that course counts and GPA totals cannot reveal.
 */
const FIXTURE_ROWS: [string, string, number, string, string][] = [
  // code, title, credits, grade, term
  ['ENG 101', 'English Composition I', 3, 'A', 'Fall 2019'],
  ['PSY 101', 'General Psychology', 3, 'B+', 'Fall 2019'],
  ['BIO 101', 'General Biology', 4, 'B', 'Fall 2019'],
  ['MAT 110', 'College Algebra', 3, 'B-', 'Fall 2019'],
  ['CHM 101', 'General Chemistry I', 4, 'F', 'Spring 2020'],
  ['SOC 101', 'Introduction to Sociology', 3, 'A', 'Spring 2020'],
  ['ENG 102', 'English Composition II', 3, 'B+', 'Spring 2020'],
  ['MAT 120', 'Statistics', 3, 'B', 'Spring 2020'],
  ['CHM 101', 'General Chemistry I', 4, 'A', 'Summer 2020'],
  ['PED 110', 'Lifetime Fitness', 2, 'P', 'Summer 2020'],
  ['BIO 201', 'Anatomy and Physiology I', 4, 'A-', 'Fall 2020'],
  ['BIO 202', 'Anatomy and Physiology II', 4, 'B+', 'Fall 2020'],
  ['NTR 150', 'Human Nutrition', 3, 'A', 'Fall 2020'],
  ['COM 101', 'Interpersonal Communication', 3, 'A-', 'Fall 2020'],
  ['MIC 210', 'Microbiology', 4, 'A', 'Spring 2021'],
  ['CHM 205', 'Organic and Biological Chemistry', 4, 'B+', 'Spring 2021'],
  ['PSY 230', 'Developmental Psychology', 3, 'A', 'Spring 2021'],
  ['ART 100', 'Art Appreciation', 3, 'P', 'Spring 2021'],
  ['HIS 110', 'World History', 3, 'WD', 'Spring 2021'],
  ['PHI 220', 'Health Care Ethics', 3, 'A-', 'Fall 2021'],
  ['MAT 210', 'Applied Statistics', 3, 'A', 'Fall 2021'],
  ['HLT 200', 'Health Promotion', 3, 'B+', 'Fall 2021'],
]

const IMPORT_ROWS = FIXTURE_ROWS.map(([courseCode, name, credits]) =>
  ({ courseCode, name, credits }))

const TERM_HEADING = /^(FALL|SPRING|SUMMER|WINTER)\s+((?:19|20)\d\d)$/i

/**
 * Walks the reconstructed reading order the way a reader does: a course takes
 * the last term heading seen IN ITS OWN region, and a region change resets
 * that context. This is the guarantee the analyzer depends on -- if the text
 * cannot be read this way, no amount of prompting can recover the term.
 */
function termsByRegion(lines: readonly string[]): { code: string; grade?: string; term: string | null }[] {
  const active = new Map<number, string | null>()
  let region = 0
  const out: { code: string; grade?: string; term: string | null }[] = []
  for (const line of lines) {
    const col = line.match(/^-{3}\s*COLUMN\s+(\d+)/i)
    if (col) { region = Number(col[1]); continue }
    const heading = line.trim().match(TERM_HEADING)
    if (heading) {
      const [, season, year] = heading
      active.set(region, `${season[0].toUpperCase()}${season.slice(1).toLowerCase()} ${year}`)
      continue
    }
    const a = anchorFromLine(line, 1, region)
    if (a) out.push({ code: a.code, grade: a.grade, term: active.get(region) ?? null })
  }
  return out
}

test('D45: a staggered two-column page is split into its two regions', async () => {
  const r = await extractPdf(load(TWO_COL))
  const page = r.pages[0]
  assert.equal(page.layout.confidence, 'two-column',
    'headers that do not share a baseline are still two headers')
  assert.ok(page.layout.signals.includes('repeated-header'))
  assert.ok(page.lines.some(l => /^--- COLUMN 1/.test(l)))
  assert.ok(page.lines.some(l => /^--- COLUMN 2/.test(l)))
  // Unsplit, the two columns interleave -- which is the bug this prevents.
  assert.ok(page.flatLines.some(l => /ENG 101[\s\S]*$/.test(l)))
})

test('D45: all 22 rows land under their own column’s term', async () => {
  const r = await extractPdf(load(TWO_COL))
  const got = termsByRegion(r.pages[0].lines)
  assert.equal(got.length, FIXTURE_ROWS.length, 'every printed row is read')
  const expected = FIXTURE_ROWS.map(([code, , , grade, term]) => `${code} ${grade} -> ${term}`)
  const actual = got.map(g => `${g.code} ${g.grade} -> ${g.term}`)
  assert.deepEqual([...actual].sort(), [...expected].sort())
})

test('D45: term context does not leak from one column into the other', async () => {
  const r = await extractPdf(load(TWO_COL))
  const got = termsByRegion(r.pages[0].lines)
  // Every right-column term must appear, and none of its courses may carry a
  // left-column term. This is the exact failure: BIO 201 read as Fall 2019.
  const byCode = new Map(got.map(g => [`${g.code}|${g.grade}`, g.term]))
  assert.equal(byCode.get('BIO 201|A-'), 'Fall 2020', 'not the left column’s Fall 2019')
  assert.equal(byCode.get('ENG 101|A'), 'Fall 2019')
  const rightTerms = new Set(['Fall 2020', 'Spring 2021', 'Fall 2021'])
  const leftTerms = new Set(['Fall 2019', 'Spring 2020', 'Summer 2020'])
  for (const [code, , , grade, term] of FIXTURE_ROWS) {
    const actual = byCode.get(`${code}|${grade}`)
    assert.equal(actual, term, `${code} ${grade}`)
    assert.ok((rightTerms.has(term) ? rightTerms : leftTerms).has(actual!), code)
  }
  assert.equal([...new Set(got.map(g => g.term))].length, 6, 'all six terms are distinct')
})

test('D45: each column keeps its own active term independently', async () => {
  // The structural claim: two regions each carry their own term context, so a
  // heading in one never becomes the context for a course in the other.
  const lines = [
    '--- COLUMN 1 ---',
    'FALL 2019',
    'ENG 101 | English Composition I | 3.0 A | 12.00',
    '--- COLUMN 2 ---',
    'FALL 2020',
    'BIO 201 | Anatomy and Physiology I | 4.0 A- | 14.80',
    '--- COLUMN 1 ---',
    'SPRING 2020',
    'CHM 101 | General Chemistry I | 4.0 F | 0.00',
  ]
  assert.deepEqual(termsByRegion(lines), [
    { code: 'ENG 101', grade: 'A', term: 'Fall 2019' },
    { code: 'BIO 201', grade: 'A-', term: 'Fall 2020' },
    { code: 'CHM 101', grade: 'F', term: 'Spring 2020' },
  ])
})

test('D45: a page read as ONE stream is exactly what corrupts the terms', async () => {
  // The negative control, on the same document: flattened, the right column's
  // courses fall under the left column's headings.
  const r = await extractPdf(load(TWO_COL))
  const flat = termsByRegion(r.pages[0].flatLines)
  const bio201 = flat.find(g => g.code === 'BIO 201')!
  assert.equal(bio201.term, 'Fall 2019',
    'unsplit, the right column inherits the left column’s term -- the reported bug')
  // And the split reading of the same page does not.
  const split = termsByRegion(r.pages[0].lines)
  assert.equal(split.find(g => g.code === 'BIO 201')!.term, 'Fall 2020')
})

test('D47: the two-column points-column fixture yields every row, sized correctly', async () => {
  const anchors = courseAnchorsFromText((await extractPdf(load(TWO_COL))).text)
  assert.equal(anchors.length, FIXTURE_ROWS.length, 'one anchor per printed course row')
  assert.ok(anchors.every(a => a.credits <= 4), anchors.map(a => `${a.code}=${a.credits}`).join(' '))
  assert.deepEqual(
    [...anchors].sort((x, y) => x.code.localeCompare(y.code)).map(a => `${a.code}:${a.credits}`),
    [...FIXTURE_ROWS].sort((x, y) => x[0].localeCompare(y[0])).map(r => `${r[0]}:${r[2]}`))
})

test('D47: no false "rows could not be read" on a correct import', async () => {
  const anchors = courseAnchorsFromText((await extractPdf(load(TWO_COL))).text)
  const m = matchAnchors(anchors, IMPORT_ROWS)
  assert.equal(m.unmatched.length, 0, 'nothing may be reported missing')
  assert.equal(m.matched.length, anchors.length)
  assert.equal(m.unanchoredRows, 0)
})

test('D47: both attempts of the repeated course stay distinct', async () => {
  const anchors = courseAnchorsFromText((await extractPdf(load(TWO_COL))).text)
  const repeats = anchors.filter(a => a.code === 'CHM 101')
  assert.equal(repeats.length, 2, 'the repeat is not deduplicated away')
  assert.deepEqual(repeats.map(a => a.credits), [4, 4])
  assert.deepEqual(repeats.map(a => a.grade).sort(), ['A', 'F'])
  const one = matchAnchors(anchors, IMPORT_ROWS.filter(r => r.courseCode !== 'CHM 101')
    .concat([{ courseCode: 'CHM 101', name: 'General Chemistry I', credits: 4 }]))
  assert.equal(one.unmatched.length, 1, 'importing one attempt leaves one anchor unmatched')
  assert.equal(one.unmatched[0].code, 'CHM 101')
})

test('D47: P and WD rows are represented, with their credits and terms', async () => {
  const r = await extractPdf(load(TWO_COL))
  const anchors = courseAnchorsFromText(r.text)
  const p = anchors.filter(a => a.grade === 'P')
  assert.equal(p.length, 2)
  assert.deepEqual(p.map(a => a.credits).sort(), [2, 3])
  const wd = anchors.find(a => a.grade === 'WD')!
  assert.equal(wd.credits, 3)
  const terms = new Map(termsByRegion(r.pages[0].lines).map(g => [g.code, g.term]))
  assert.equal(terms.get('PED 110'), 'Summer 2020')
  assert.equal(terms.get('ART 100'), 'Spring 2021')
  assert.equal(terms.get('HIS 110'), 'Spring 2021')
})

test('D47: genuinely missing coursework is still reported', async () => {
  const anchors = courseAnchorsFromText((await extractPdf(load(TWO_COL))).text)
  const short = IMPORT_ROWS.slice(0, IMPORT_ROWS.length - 3)
  const m = matchAnchors(anchors, short)
  assert.equal(m.unmatched.length, 3, 'three dropped rows, three unmatched anchors')
  assert.deepEqual(m.unmatched.map(a => a.code).sort(), ['HLT 200', 'MAT 210', 'PHI 220'])
})
