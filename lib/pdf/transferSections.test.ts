import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  detectTransferBlocks, applyTransferSections, originFromHeading,
} from './transferSections.ts'
import { extractPdf } from './extract.ts'

/** An env-supplied fixture path, but only when the file is actually there. */
function existing(p: string | undefined): string | undefined {
  return p && fs.existsSync(p) ? p : undefined
}

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures')
const load = (n: string) => fs.readFileSync(path.join(FIX, n))

/** The Lakeshore transfer section, exactly as the extractor reconstructs it. */
const LAKESHORE = [
  'LAKESHORE UNIVERSITY',
  'Degree: Bachelor of Science in Nursing | College: College of Nursing',
  'TRANSFER CREDIT ACCEPTED FROM PINE VALLEY COMMUNITY COLLEGE',
  'COURSE | TRANSFER COURSE TITLE | CRED | GRADE',
  'ENG 101 | English Composition I | 3.0 | TR',
  'NTR 150 | Human Nutrition | 3.0',
  'PSY 230 | Developmental Psychology | 3.0',
  'PHI 220 | Health Care Ethics | 3.0 | TR',
  'TOTAL TRANSFER CREDITS ACCEPTED: 34.0',
  'INSTITUTION CREDIT',
  'SPRING 2022',
  'COURSE | TITLE | CR | GR | PTS',
  'NURS 201 | Foundations of Nursing Practice | 4.0 | A | 16.00',
  'NURS 205 | Health Assessment | 3.0 | B+ | 10.50',
].join('\n')

const row = (courseCode: string, name: string, credits: number, over: any = {}) =>
  ({ courseCode, name, credits, recordType: 'coursework', term: '', year: '', ...over })

// ------------------------------------------------------------- block reading
test('D51: a transfer block starts at its heading and holds its rows', () => {
  const blocks = detectTransferBlocks(LAKESHORE)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].heading, 'TRANSFER CREDIT ACCEPTED FROM PINE VALLEY COMMUNITY COLLEGE')
  assert.deepEqual(blocks[0].rows.map(r => r.code), ['ENG 101', 'NTR 150', 'PSY 230', 'PHI 220'])
})

test('D51: the originating school comes from the heading', () => {
  assert.equal(detectTransferBlocks(LAKESHORE)[0].originName, 'PINE VALLEY COMMUNITY COLLEGE')
  assert.equal(originFromHeading('TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE'), 'RIVERSIDE COLLEGE')
  assert.equal(originFromHeading('TRANSFER CREDIT ACCEPTED'), null, 'nothing is invented')
  assert.equal(originFromHeading('TRANSFER COURSES'), null)
})

test('D51: the table header inside a block is structure, not a new block', () => {
  // "COURSE | TRANSFER COURSE TITLE" contains the word transfer.
  const blocks = detectTransferBlocks(LAKESHORE)
  assert.equal(blocks.length, 1, 'the column header must not open a second block')
  assert.equal(blocks[0].originName, 'PINE VALLEY COMMUNITY COLLEGE')
})

test('D51: the block ends at the structural boundary the document prints', () => {
  const rows = detectTransferBlocks(LAKESHORE)[0].rows.map(r => r.code)
  assert.ok(!rows.includes('NURS 201'), 'institution coursework is outside the block')
  assert.ok(!rows.includes('NURS 205'))
  assert.equal(rows.length, 4)
})

test('D51: a page or column change ends a block', () => {
  const text = [
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'ENG 101 | English Composition I | 3.0 | TR',
    '--- COLUMN 2 ---',
    'BIO 101 | General Biology | 4.0 | TR',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0].rows.map(r => r.code), ['ENG 101'],
    'a reading stream that ended cannot still be inside a section')
})

test('D51: a bare term heading does not end a block', () => {
  // One real transcript dates each accepted row by the term it was taken.
  const text = [
    'TRANSFER COURSES',
    'MONTCLAIR STATE UNIVERSITY',
    'Spring 2017',
    'ANATOMY AND PHYSIOLOGY I | TR T77 AP1 | 4.0',
    'Summer 2017',
    'ANATOMY & PHYSIOLOGY II | TR T77 AP2 | 4.0',
    'TOTAL TRANSFER CREDITS: | 62.0',
    'Summer 2020 SCHOOL OF NURSING - NEW BRUNSWICK (UG)',
    'FOUND NSG PRACTICE | 77 705 304 | NG | 4.0 | A',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].rows.length, 2, 'both dated transfer rows are inside')
  assert.ok(!blocks[0].rows.some(r => /FOUND NSG/.test(r.title)), 'and the school’s own row is not')
})

test('D52: a letter grade NEVER ends a transfer block', () => {
  // A receiving school may print the original letter grade on accepted credit.
  // The row is still a notation, and the grade is still just a preserved value.
  const text = [
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'BIO 201 | Anatomy and Physiology I | 4.0 | A',
    'CHM 101 | General Chemistry | 4.0 | B+',
    'ENG 101 | English Composition | 3.0 | A-',
    'PSY 101 | Introduction to Psychology | 3.0 | C',
    'TOTAL TRANSFER CREDITS ACCEPTED: 14.0',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].rows.length, 4, 'no grade value cuts the block short')
  assert.deepEqual(blocks[0].rows.map(r => r.grade), ['A', 'B+', 'A-', 'C'])
})

test('D52: A-graded notations are converted, with the grade preserved', () => {
  const text = [
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'BIO 201 | Anatomy and Physiology I | 4.0 | A',
    'CHM 101 | General Chemistry | 4.0 | B+',
    'TOTAL TRANSFER CREDITS ACCEPTED: 8.0',
  ].join('\n')
  const out = applyTransferSections([
    row('BIO 201', 'Anatomy and Physiology I', 4, { grade: 'A' }),
    row('CHM 101', 'General Chemistry', 4, { grade: 'B+' }),
  ], text)
  assert.ok(out.courses.every(c => c.recordType === 'transfer_notation'))
  assert.deepEqual(out.courses.map((c: any) => c.grade), ['A', 'B+'], 'exactly as printed')
  assert.deepEqual(out.courses.map(c => c.transferredFromName),
    ['RIVERSIDE COLLEGE', 'RIVERSIDE COLLEGE'])
})

test('D52: an explicit institution-coursework heading ends the block', () => {
  // This is what keeps real graded coursework out -- a heading, not a grade.
  const text = [
    'TRANSFER CREDIT ACCEPTED',
    'BIOL 111 | Anatomy and Physiology I | 4.0 | TR',
    'INSTITUTIONAL COURSEWORK',
    'NURS 301 | Adult Health Nursing I | 4.0 | A',
    'NURS 310 | Pathophysiology | 3.0 | A-',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks[0].rows.length, 1)
  assert.deepEqual(blocks[0].rows.map(r => r.code), ['BIOL 111'])
})

test('D52: an explicit transfer total ends the block', () => {
  const text = [
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'BIO 201 | Anatomy and Physiology I | 4.0 | A',
    'TOTAL TRANSFER CREDITS ACCEPTED: 4.0',
    'FALL 2023',
    'NURS 301 | Adult Health Nursing I | 4.0 | A',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0].rows.map(r => r.code), ['BIO 201'])
})

// ------------------------------------------------------- region continuation
test('D52: a block continues into the next column when the table does', () => {
  // The transfer table's own header, printed again at the top of the next
  // column, is the document saying the same table carries on.
  const text = [
    '--- COLUMN 1 ---',
    'TITLE | SCH DEPT CRS SUP SEC CRED PR GRADE',
    'TRANSFER COURSES',
    'ANATOMY AND PHYSIOLOGY I | TR T77 AP1 | 4.0',
    '--- COLUMN 2 ---',
    'TITLE | SCH DEPT CRS SUP SEC CRED PR GRADE',
    'MICROBIOLOGY | TR T77 MIC | 3.0',
    'TOTAL TRANSFER CREDITS: | 62.0',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1, 'one section, not two')
  assert.equal(blocks[0].rows.length, 2)
  assert.ok(blocks[0].rows.some(r => /MICROBIOLOGY/.test(r.title)), 'the second column’s row is inside')
})

test('D52: a block continues onto the next page when the table does', () => {
  const text = [
    '=== PAGE 1 ===',
    'COURSE | TITLE | CRED | GRADE',
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'BIO 201 | Anatomy and Physiology I | 4.0 | TR',
    '=== PAGE 2 ===',
    'COURSE | TITLE | CRED | GRADE',
    'CHM 101 | General Chemistry | 4.0 | TR',
    'TOTAL TRANSFER CREDITS ACCEPTED: 8.0',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0].rows.map(r => r.code), ['BIO 201', 'CHM 101'])
  assert.equal(blocks[0].originName, 'RIVERSIDE COLLEGE', 'the origin travels with it')
})

test('D52: a continuation notice also carries the context', () => {
  const text = [
    '--- COLUMN 1 ---',
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'BIO 201 | Anatomy and Physiology I | 4.0 | TR',
    '******** CONTINUED ON NEXT COLUMN ********',
    '--- COLUMN 2 ---',
    '******** CONTINUED ********',
    'CHM 101 | General Chemistry | 4.0 | TR',
    'TOTAL TRANSFER CREDITS ACCEPTED: 8.0',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].rows.length, 2)
})

test('D52: an unrelated next column inherits nothing', () => {
  const text = [
    '--- COLUMN 1 ---',
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'BIO 201 | Anatomy and Physiology I | 4.0 | TR',
    '--- COLUMN 2 ---',
    'INSTITUTION CREDIT',
    'FALL 2023',
    'NURS 301 | Adult Health Nursing I | 4.0 | A',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0].rows.map(r => r.code), ['BIO 201'])
})

test('D52: a column that simply starts with coursework inherits nothing', () => {
  // Silence is not evidence. Without a header, a notice or the section's own
  // total, the context does not travel.
  const text = [
    '--- COLUMN 1 ---',
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'BIO 201 | Anatomy and Physiology I | 4.0 | TR',
    '--- COLUMN 2 ---',
    'NURS 301 | Adult Health Nursing I | 4.0 | A',
    'NURS 310 | Pathophysiology | 3.0 | A-',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0].rows.map(r => r.code), ['BIO 201'])
})

test('D51: the word "transfer" outside a block converts nothing', () => {
  const text = [
    'INSTITUTION CREDIT',
    'FALL 2022',
    'Transfer-credit notation is administrative and carries no grade points.',
    'NURS 301 | Adult Health Nursing I | 4.0 | A',
  ].join('\n')
  assert.deepEqual(detectTransferBlocks(text), [], 'a sentence about transfers is not a section')
  const out = applyTransferSections([row('NURS 301', 'Adult Health Nursing I', 4)], text)
  assert.equal(out.courses[0].recordType, 'coursework')
  assert.equal(out.converted.length, 0)
})

test('D51: several blocks each keep their own originating school', () => {
  const text = [
    'TRANSFER CREDIT ACCEPTED FROM RIVERSIDE COLLEGE',
    'ENG 101 | English Composition I | 3.0 | TR',
    'TOTAL TRANSFER CREDITS ACCEPTED: 3.0',
    'TRANSFER CREDIT ACCEPTED FROM HARBOR COMMUNITY COLLEGE',
    'BIO 101 | General Biology | 4.0 | TR',
    'TOTAL TRANSFER CREDITS ACCEPTED: 4.0',
  ].join('\n')
  const blocks = detectTransferBlocks(text)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks.map(b => b.originName), ['RIVERSIDE COLLEGE', 'HARBOR COMMUNITY COLLEGE'])

  const out = applyTransferSections([
    row('ENG 101', 'English Composition I', 3),
    row('BIO 101', 'General Biology', 4),
  ], text)
  assert.deepEqual(out.courses.map(c => c.transferredFromName),
    ['RIVERSIDE COLLEGE', 'HARBOR COMMUNITY COLLEGE'])
})

// ------------------------------------------------------- applying the context
test('D51: a TR row inside a block is a notation', () => {
  const out = applyTransferSections([row('ENG 101', 'English Composition I', 3, { grade: 'TR' })], LAKESHORE)
  assert.equal(out.courses[0].recordType, 'transfer_notation')
})

test('D51: a BLANK-GRADE row inside a block is a notation too', () => {
  const out = applyTransferSections([
    row('NTR 150', 'Human Nutrition', 3, { grade: '' }),
    row('PSY 230', 'Developmental Psychology', 3, { grade: '' }),
  ], LAKESHORE)
  assert.ok(out.courses.every(c => c.recordType === 'transfer_notation'))
  assert.equal(out.converted.length, 2, 'both were reclassified by the structure')
})

test('D51: the printed grade is preserved exactly, blank stays blank', () => {
  const out = applyTransferSections([
    row('ENG 101', 'English Composition I', 3, { grade: 'TR' }),
    row('NTR 150', 'Human Nutrition', 3, { grade: '' }),
    row('PSY 230', 'Developmental Psychology', 3, { grade: '' }),
  ], LAKESHORE)
  assert.deepEqual(out.courses.map((c: any) => c.grade), ['TR', '', ''],
    'no TR is invented for a row that prints none')
})

test('D51: the originating school is inherited by every row in the block', () => {
  const out = applyTransferSections([
    row('ENG 101', 'English Composition I', 3, { grade: 'TR' }),
    row('NTR 150', 'Human Nutrition', 3, { grade: '' }),
  ], LAKESHORE)
  assert.deepEqual(out.courses.map(c => c.transferredFromName),
    ['PINE VALLEY COMMUNITY COLLEGE', 'PINE VALLEY COMMUNITY COLLEGE'])
})

test('D51: an origin the model already supplied is not overwritten', () => {
  const out = applyTransferSections([
    row('ENG 101', 'English Composition I', 3,
      { grade: 'TR', recordType: 'transfer_notation', transferredFromName: 'Pine Valley CC' }),
  ], LAKESHORE)
  assert.equal(out.courses[0].transferredFromName, 'Pine Valley CC')
  assert.equal(out.converted.length, 0)
})

test('D51: structure beats the model’s record type', () => {
  // The reported bug, exactly: the model called both blank-grade rows ordinary
  // coursework on one run and transfer notation on the next.
  const asCoursework = applyTransferSections([
    row('NTR 150', 'Human Nutrition', 3, { grade: '', recordType: 'coursework' }),
  ], LAKESHORE)
  const asNotation = applyTransferSections([
    row('NTR 150', 'Human Nutrition', 3, { grade: '', recordType: 'transfer_notation' }),
  ], LAKESHORE)
  assert.equal(asCoursework.courses[0].recordType, 'transfer_notation')
  assert.equal(asNotation.courses[0].recordType, 'transfer_notation')
  assert.deepEqual(asCoursework.courses[0].transferredFromName, asNotation.courses[0].transferredFromName)
})

test('D51: a row just after the block stays ordinary coursework', () => {
  const out = applyTransferSections([
    row('ENG 101', 'English Composition I', 3, { grade: 'TR' }),
    row('NURS 201', 'Foundations of Nursing Practice', 4, { grade: 'A', term: 'Spring', year: '2022' }),
    row('NURS 205', 'Health Assessment', 3, { grade: 'B+', term: 'Spring', year: '2022' }),
  ], LAKESHORE)
  assert.equal(out.courses[0].recordType, 'transfer_notation')
  assert.equal(out.courses[1].recordType, 'coursework')
  assert.equal(out.courses[2].recordType, 'coursework')
})

test('D51: one block row cannot convert two extracted rows', () => {
  // The same course accepted as transfer credit AND taken at the school.
  const out = applyTransferSections([
    row('ENG 101', 'English Composition I', 3, { grade: 'TR' }),
    row('ENG 101', 'English Composition I', 3, { grade: 'A', term: 'Fall', year: '2022' }),
  ], LAKESHORE)
  assert.equal(out.courses.filter(c => c.recordType === 'transfer_notation').length, 1)
  assert.equal(out.courses[1].recordType, 'coursework', 'the dated attempt is left alone')
})

test('D51: a document with no transfer block is untouched', () => {
  const rows = [row('NURS 301', 'Adult Health Nursing I', 4, { grade: 'A' })]
  const out = applyTransferSections(rows, 'INSTITUTION CREDIT\nFALL 2022\nNURS 301 | x | 4.0 | A')
  assert.deepEqual(out.courses, rows)
  assert.equal(out.converted.length, 0)
})

// ------------------------------------------------------------- real documents
const B2 = existing(process.env.STUDENT_B2_TRANSCRIPT_PDF)
const RUTGERS = existing(process.env.RUTGERS_TRANSCRIPT_PDF)
const MONTCLAIR = existing(process.env.MONTCLAIR_TRANSCRIPT_PDF)

test('D51: Student B2 prints exactly one transfer block of 10 rows',
  { skip: !B2 }, async () => {
    const r = await extractPdf(fs.readFileSync(B2!))
    const blocks = detectTransferBlocks(r.text)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].rows.length, 10)
    assert.equal(blocks[0].originName, 'PINE VALLEY COMMUNITY COLLEGE')
    const blank = blocks[0].rows.filter(x => !x.grade)
    assert.deepEqual(blank.map(x => x.code).sort(), ['NTR 150', 'PSY 230'])
    assert.equal(blocks[0].rows.filter(x => x.grade === 'TR').length, 8)
  })

test('D51: Student B2 always yields 10 notations, whatever the model said',
  { skip: !B2 }, async () => {
    const r = await extractPdf(fs.readFileSync(B2!))
    const printed = detectTransferBlocks(r.text)[0].rows
    // The worst case: the model called every transfer row ordinary coursework.
    const worstCase = printed.map(x =>
      row(x.code, x.title, x.credits, { grade: x.grade ?? '' }))
    const out = applyTransferSections(worstCase, r.text)
    assert.equal(out.courses.filter(c => c.recordType === 'transfer_notation').length, 10)
    assert.equal(out.courses.filter(c => c.transferredFromName === 'PINE VALLEY COMMUNITY COLLEGE').length, 10)
    assert.deepEqual(
      out.courses.filter((c: any) => c.courseCode === 'NTR 150' || c.courseCode === 'PSY 230')
        .map((c: any) => [c.recordType, c.grade]),
      [['transfer_notation', ''], ['transfer_notation', '']])
  })

test('D51: no transfer block is found where none is printed',
  { skip: !MONTCLAIR }, async () => {
    const r = await extractPdf(fs.readFileSync(MONTCLAIR!))
    assert.deepEqual(detectTransferBlocks(r.text), [])
  })

test('D52: Rutgers yields all 11 transfer rows deterministically',
  { skip: !RUTGERS }, async () => {
    const r = await extractPdf(fs.readFileSync(RUTGERS!))
    const blocks = detectTransferBlocks(r.text)
    assert.equal(blocks.length, 1, 'one section, spanning both columns')
    assert.equal(blocks[0].rows.length, 11, 'including the row in the second column')
    assert.ok(blocks[0].rows.some(x => /^MICROBIOLOGY$/i.test(x.title)),
      'the row that used to be left to the model')
    // Its own graded nursing coursework, which follows the transfer total, is
    // not swallowed.
    assert.ok(!blocks[0].rows.some(x => /FOUND NSG|LDRSHP|HEALTH ASSESSMENT|NURS/i.test(x.title)))
  })

test('D52: Rutgers is deterministic whatever the model said',
  { skip: !RUTGERS }, async () => {
    const r = await extractPdf(fs.readFileSync(RUTGERS!))
    const printed = detectTransferBlocks(r.text)[0].rows
    const worstCase = printed.map(x => row(x.code, x.title, x.credits, { grade: x.grade ?? '' }))
    const out = applyTransferSections(worstCase, r.text)
    assert.equal(out.courses.filter(c => c.recordType === 'transfer_notation').length, 11)
  })

test('D51: coursework fixtures print no transfer block', async () => {
  for (const f of ['01_north_valley_basic.pdf', '02_harborview_last60_and_graduate.pdf',
                   '03_cedar_ridge_retakes.pdf', '08_two_column_repeated_course.pdf']) {
    assert.deepEqual(detectTransferBlocks((await extractPdf(load(f))).text), [], f)
  }
})

test('D52: the bundle’s graded coursework stays out on the heading alone', async () => {
  // No letter-grade rule is involved: the block ends at "INSTITUTIONAL
  // COURSEWORK", which is what the document prints between the two sections.
  const r = await extractPdf(load('04_multi_institution_transfer_bundle.pdf'))
  const blocks = detectTransferBlocks(r.text)
  assert.equal(blocks.length, 1)
  assert.ok(!blocks[0].rows.some(x => /^NURS/.test(x.code)),
    'eight real graded nursing courses must stay outside the block')
  const graded = ['NURS 301', 'NURS 310', 'NURS 320', 'NURS 330']
    .map(code => row(code, code, 4, { grade: 'A' }))
  const out = applyTransferSections(graded, r.text)
  assert.ok(out.courses.every(c => c.recordType === 'coursework'))
  assert.equal(out.converted.length, 0)
})
