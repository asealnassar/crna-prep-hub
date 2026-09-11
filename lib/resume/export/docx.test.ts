import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { docxContentLines, docxFilename, docxFromResume } from './docx.ts'
import { planDocument, textOf } from '../document/plan.ts'
import { TEMPLATES } from '../document/templates.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * DOCX carries the same resume as the PDF, in the same order, with different
 * styling. The round trip proves it: generate the file, read it back with the
 * same library the import path uses, and compare against the plan.
 */

const NOW = '2026-09-11T09:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

function sample(): ResumeV2 {
  const base = createResume({ id: 'r1', userId: 'u1', title: 'Duke application', sectionIds: ids(20), now: NOW })
  return {
    ...base,
    contact: {
      ...emptyContact(), fullName: 'Jordan Ellery', credentials: 'BSN, RN, CCRN',
      email: 'jordan.ellery@example.test', phone: '555-0142', city: 'Newark', state: 'NJ',
    },
    sections: [
      { ...createSection('summary', 'sm'), text: createAuthoredText('Critical care nurse of six years.') } as ResumeSectionV2,
      {
        ...createSection('education', 'ed'),
        entries: [{
          id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
          location: 'Newark, NJ', graduationDate: resumeDateFromParts(2019, 5),
          overallGpa: parseGpa('3.85', true), scienceGpa: parseGpa(''), honors: 'Cum laude',
        }],
      } as ResumeSectionV2,
      {
        ...createSection('critical_care', 'cc'),
        positions: [{
          ...createClinicalPosition('p1', {
            employer: 'University Hospital', role: 'Registered Nurse', unit: 'Medical ICU',
            location: 'Newark, NJ',
            dates: { start: resumeDateFromParts(2021, 3), end: { kind: 'absent' }, isCurrent: true },
          }),
          bullets: [
            createBullet('Titrated vasoactive infusions for unstable patients.'),
            createBullet('Precepted four new graduate nurses.'),
          ],
        }],
      } as ResumeSectionV2,
      {
        ...createSection('licensure', 'lic'),
        licenses: [{
          id: 'l1', licenseType: 'RN', state: 'NJ', identifier: '26NR12345600',
          isCompact: true, expires: resumeDateFromParts(2027, 5),
        }],
      } as ResumeSectionV2,
    ],
  }
}

async function docxText(resume: ResumeV2, template?: string): Promise<string> {
  const buffer = await docxFromResume(resume, template)
  const mammoth = await import('mammoth')
  const run = (mammoth as unknown as {
    extractRawText: (i: { buffer: Buffer }) => Promise<{ value: string }>
    default?: { extractRawText: (i: { buffer: Buffer }) => Promise<{ value: string }> }
  })
  const extract = run.extractRawText ?? run.default!.extractRawText
  const { value } = await extract({ buffer })
  return value
}

// --------------------------------------------------------- the file

test('the generated file is a real .docx', async () => {
  const buffer = await docxFromResume(sample())
  assert.ok(buffer.length > 1000, 'suspiciously small')
  // Every .docx is a zip.
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
})

test('the download is named after the applicant', () => {
  assert.equal(docxFilename(sample()), 'jordan-ellery-resume.docx')
  const odd = { ...sample(), contact: { ...emptyContact(), fullName: '../../etc/passwd' }, title: '' }
  const name = docxFilename(odd)
  assert.match(name, /^[a-z0-9-]+-resume\.docx$/)
  assert.equal(name.includes('/'), false)
})

// ------------------------------------------------- the same content

test('round trip: what the plan says is what the Word file says', async () => {
  const resume = sample()
  const text = await docxText(resume)
  for (const expected of textOf(planDocument(resume))) {
    assert.ok(text.includes(expected), `the Word file is missing: "${expected}"`)
  }
})

test('PDF and DOCX carry the same content', async () => {
  // The PDF path renders the shared document; this asserts the DOCX path draws
  // on the same plan rather than a second idea of what a resume says.
  const resume = sample()
  const fromPlan = textOf(planDocument(resume))
  const fromDocx = docxContentLines(resume)
  for (const line of fromPlan) {
    assert.ok(
      fromDocx.some((candidate) => candidate.includes(line)),
      `content in the PDF but not the DOCX: "${line}"`
    )
  }
})

test('the content order is the reading order, for both formats', async () => {
  const text = await docxText(sample(), 'modern')
  const sequence = ['Jordan Ellery', 'Critical care nurse of six years', 'Rutgers University', 'University Hospital']
  let cursor = -1
  for (const marker of sequence) {
    const at = text.indexOf(marker, cursor + 1)
    assert.ok(at > cursor, `"${marker}" is out of order in the Word file`)
    cursor = at
  }
})

test('a withheld GPA is absent from the Word file too', async () => {
  const resume = sample()
  const hidden = {
    ...resume,
    sections: resume.sections.map((s) =>
      s.type !== 'education' ? s : ({
        ...s,
        entries: s.entries.map((e) => ({ ...e, overallGpa: { ...e.overallGpa, showOnResume: false } })),
      } as ResumeSectionV2)),
  }
  assert.equal((await docxText(hidden)).includes('3.85'), false)
  assert.ok((await docxText(resume)).includes('GPA 3.85'), 'a shown GPA is missing')
})

test('a hidden section is absent from the Word file', async () => {
  const resume = sample()
  const hidden = {
    ...resume,
    sections: resume.sections.map((s) => (s.type === 'licensure' ? { ...s, visible: false } : s)),
  }
  const text = await docxText(hidden)
  assert.equal(text.includes('26NR12345600'), false)
  assert.ok(text.includes('University Hospital'), 'the rest of the resume is missing')
})

test('every template produces a file with the same content', async () => {
  const resume = sample()
  for (const template of Object.values(TEMPLATES)) {
    const text = await docxText(resume, template.id)
    for (const expected of ['Jordan Ellery', 'University Hospital', 'Rutgers University']) {
      assert.ok(text.includes(expected), `${template.id} lost "${expected}"`)
    }
  }
})

test('an empty resume produces a valid file rather than failing', async () => {
  const blank = createResume({ id: 'r', userId: 'u', title: 'Empty', sectionIds: ids(20), now: NOW })
  const buffer = await docxFromResume(blank)
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
})

// ------------------------------------------------- ATS structure

test('the document uses no tables, text boxes or columns', () => {
  // The four constructs that turn a Word resume into scrambled text on the far
  // side of a parser.
  const source = readFileSync(fileURLToPath(new URL('./docx.ts', import.meta.url)), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const forbidden of ['Table', 'TextBox', 'Column', 'Header(', 'Footer(']) {
    assert.equal(code.includes(forbidden), false, `the DOCX uses ${forbidden}`)
  }
})

test('bullets are real Word list items, not typed hyphens', () => {
  const source = readFileSync(fileURLToPath(new URL('./docx.ts', import.meta.url)), 'utf8')
  assert.match(source, /bullet:\s*\{\s*level:\s*0\s*\}/)
})

test('there is no second source of resume content', () => {
  const source = readFileSync(fileURLToPath(new URL('./docx.ts', import.meta.url)), 'utf8')
  assert.ok(source.includes('planDocument'), 'the DOCX builds its own content')
  assert.ok(source.includes('readingOrder'), 'the DOCX picks its own order')
})
