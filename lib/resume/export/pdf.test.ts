import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ChromiumUnavailableError, documentHtml, exportResumePdf, launchBrowser,
  pdfFilename, resolveExecutablePath,
} from './pdf.ts'
import type { PdfBrowser } from './pdf.ts'
import { extractPdf } from '../../pdf/extract.ts'
import type { ExtractionResult } from '../../pdf/extract.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import { TEMPLATES } from '../document/templates.ts'
import { FONT_FACES, SANS_FAMILY, SERIF_FAMILY, webFontSrc } from '../document/fonts.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * The round trip: canonical resume -> shared renderer -> Chromium -> PDF ->
 * pdfjs -> text. This is the regression net that browser print could not have,
 * and the reason headless Chromium was chosen.
 *
 * The PDF-producing tests skip, rather than fail, when no Chromium is present:
 * a machine without Chrome should still be able to run the rest of the suite.
 */

const NOW = '2026-09-10T12:00:00.000Z'
const MAR_2021 = resumeDateFromParts(2021, 3)
const MAY_2019 = resumeDateFromParts(2019, 5)
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

function contact() {
  return {
    ...emptyContact(),
    fullName: 'Jordan Ellery', credentials: 'BSN, RN, CCRN',
    email: 'jordan.ellery@example.test', phone: '555-0142',
    city: 'Newark', state: 'NJ',
  }
}

/** A realistic single-page resume. */
function sampleResume(overrides: Partial<ResumeV2> = {}): ResumeV2 {
  const base = createResume({ id: 'r1', userId: 'u1', title: 'Duke application', sectionIds: ids(20), now: NOW })

  const summary = {
    ...createSection('summary', 'sec-summary'),
    text: createAuthoredText('Critical care nurse with six years in a high-acuity medical ICU.'),
  } as ResumeSectionV2

  const education = {
    ...createSection('education', 'sec-education'),
    entries: [{
      id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
      location: 'Newark, NJ', graduationDate: MAY_2019,
      overallGpa: parseGpa('3.85', true), scienceGpa: parseGpa('3.71', true), honors: 'Cum laude',
    }],
  } as ResumeSectionV2

  const position = createClinicalPosition('p1', {
    employer: 'University Hospital', role: 'Registered Nurse', unit: 'Medical ICU',
    location: 'Newark, NJ', dates: { start: MAR_2021, end: { kind: 'absent' }, isCurrent: true },
    devices: ['Ventilator', 'CRRT'], patientPopulations: ['Septic shock'],
  })
  const criticalCare = {
    ...createSection('critical_care', 'sec-cc'),
    positions: [{
      ...position,
      bullets: [
        createBullet('Managed vasoactive infusions for haemodynamically unstable patients.'),
        createBullet('Precepted four new graduate nurses through unit orientation.'),
      ],
    }],
  } as ResumeSectionV2

  const licensure = {
    ...createSection('licensure', 'sec-lic'),
    licenses: [{
      id: 'l1', licenseType: 'RN', state: 'NJ', identifier: '26NR12345600',
      isCompact: true, expires: resumeDateFromParts(2027, 5),
    }],
  } as ResumeSectionV2

  const certifications = {
    ...createSection('certifications', 'sec-cert'),
    certifications: [{
      id: 'c1', name: 'CCRN', issuer: 'AACN', identifier: '',
      earned: resumeDateFromParts(2022, 1), expires: resumeDateFromParts(2027, 1),
    }],
  } as ResumeSectionV2

  return {
    ...base,
    contact: contact(),
    sections: [summary, education, criticalCare, licensure, certifications],
    ...overrides,
  }
}

/** Long enough to need several pages: many positions, each with bullets. */
function longResume(): ResumeV2 {
  const base = sampleResume()
  const positions = Array.from({ length: 9 }, (_, i) =>
    ({
      ...createClinicalPosition(`p${i}`, {
        employer: `Hospital Number ${i + 1}`,
        role: 'Registered Nurse', unit: 'Medical ICU', location: 'Newark, NJ',
        dates: { start: MAR_2021, end: { kind: 'absent' }, isCurrent: false },
      }),
      bullets: Array.from({ length: 5 }, (_, b) =>
        createBullet(`Position ${i + 1} bullet ${b + 1}: sustained responsibility for critically ill patients across a twelve-hour shift, coordinating with the intensivist team.`)),
    })
  )
  const certs = Array.from({ length: 14 }, (_, i) => ({
    id: `c${i}`, name: `Certification ${i + 1}`, issuer: 'A Certifying Body',
    identifier: '', earned: resumeDateFromParts(2022, 1), expires: resumeDateFromParts(2027, 1),
  }))

  return {
    ...base,
    sections: base.sections.map((section) => {
      if (section.type === 'critical_care') return { ...section, positions } as ResumeSectionV2
      if (section.type === 'certifications') return { ...section, certifications: certs } as ResumeSectionV2
      if (section.type === 'summary') {
        return {
          ...section,
          text: createAuthoredText('A '.repeat(600).trim() + ' long professional summary.'),
        } as ResumeSectionV2
      }
      return section
    }),
  }
}

// ---------------------------------------------------------------------------
// The HTML half: no browser required
// ---------------------------------------------------------------------------

test('the export renders a complete, self-contained document', async () => {
  const html = await documentHtml(sampleResume())
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<html lang="en">/)
  assert.match(html, /<\/html>$/)
  // The stylesheet travels inside the markup: no bundler, no asset server.
  assert.ok(html.includes('<style'), 'no stylesheet inlined')
  assert.ok(html.includes('8.5in'), 'the page box is missing')
  assert.ok(html.includes('@page'), 'the print rules are missing')
})

test('the exported HTML is the shared renderer’s, not a second one', async () => {
  const html = await documentHtml(sampleResume())
  // Class names owned by components/resume-document.
  for (const marker of ['rd-root', 'rd-page', 'rd-section', 'rd-heading', 'rd-entry']) {
    assert.ok(html.includes(marker), `missing ${marker}: this is not the shared document`)
  }
})

test('every template produces its own structural attributes', async () => {
  for (const template of Object.values(TEMPLATES)) {
    const html = await documentHtml(sampleResume(), template.id)
    assert.ok(html.includes(`data-template="${template.id}"`), template.id)
    assert.ok(html.includes(`data-layout="${template.layout}"`), template.id)
    assert.ok(html.includes(`data-heading-style="${template.headingStyle}"`), template.id)
  }
})

test('a title with markup in it cannot break out of the document', async () => {
  const resume = sampleResume({ title: '</title><script>alert(1)</script>' })
  const html = await documentHtml(resume)
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.ok(html.includes('&lt;script&gt;'))
})

test('the download is named after the applicant, not the resume’s internal title', () => {
  assert.equal(pdfFilename(sampleResume()), 'jordan-ellery-resume.pdf')
  const noName = sampleResume({ contact: { ...emptyContact() }, title: 'Duke application' })
  assert.equal(pdfFilename(noName), 'duke-application-resume.pdf')
})

test('a filename is always safe and never empty', () => {
  const odd = sampleResume({ contact: { ...emptyContact(), fullName: '../../etc/passwd  ' }, title: '' })
  const name = pdfFilename(odd)
  assert.match(name, /^[a-z0-9-]+-resume\.pdf$/)
  assert.equal(name.includes('/'), false)
  assert.equal(name.includes('..'), false)
})

// ------------------------------------------------- Latin Extended names

/**
 * L-stroke, r-caron and s-comma: Polish, Czech and Romanian surnames, and the
 * characters that fall outside the latin subset. An applicant whose own name a
 * resume cannot set correctly is not a small defect.
 */
const LATIN_EXT_NAME = '\u0141ukasz \u0158ezn\u00ed\u010dek-Ionescu'
const LATIN_EXT_PROSE = 'Worked with \u0141ukasz, \u0158ezn\u00ed\u010dek and \u0218tef\u0103nescu on the \u0219oc protocol.'

function latinExtResume(): ResumeV2 {
  const resume = sampleResume({ contact: { ...contact(), fullName: LATIN_EXT_NAME } })
  return {
    ...resume,
    sections: resume.sections.map((s) =>
      s.type !== 'summary' ? s : ({ ...s, text: createAuthoredText(LATIN_EXT_PROSE) } as ResumeSectionV2)),
  }
}

test('the preview links the shipped fonts, including latin-ext', async () => {
  // The preview path: ResumeDocument with no fontCss prop, as the Studio mounts
  // it. It must reference the files this project ships, never a system face.
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const { default: ResumeDocument } = await import('../../../components/resume-document/ResumeDocument.tsx')

  const markup = renderToStaticMarkup(
    createElement(ResumeDocument, { resume: latinExtResume(), template: TEMPLATES.modern })
  )

  for (const face of FONT_FACES) {
    assert.ok(markup.includes(webFontSrc(face)), `the preview does not link ${face.file}`)
  }
  assert.ok(markup.includes('U+0100-02BA'), 'the preview cannot select the latin-ext face')
  assert.ok(markup.includes(SANS_FAMILY.replace(/'/g, '')), 'the preview does not name the shipped sans')
  assert.equal(markup.includes('data:font/woff2'), false, 'the preview inlines fonts it could cache')
})

test('the export inlines every shipped face, including latin-ext', async () => {
  const html = await documentHtml(latinExtResume())
  assert.equal(
    (html.match(/data:font\/woff2;base64,/g) ?? []).length,
    FONT_FACES.length,
    'not every face is embedded'
  )
  assert.equal(html.includes("url('/fonts/"), false, 'the export still points at a URL')
  assert.ok(html.includes('U+0100-02BA'), 'the export cannot select the latin-ext face')
})

// ---------------------------------------------------------------------------
// The round trip: Chromium required
// ---------------------------------------------------------------------------

let unavailable: string | null = null
try {
  await resolveExecutablePath()
} catch (error) {
  unavailable = error instanceof ChromiumUnavailableError ? error.message : String(error)
}
const skip = unavailable ? `Chromium unavailable — ${unavailable}` : false

let browser: PdfBrowser | null = null
let short: ExtractionResult | null = null
let long: ExtractionResult | null = null

before(async () => {
  if (skip) return
  browser = await launchBrowser()
  short = await extractPdf(await exportResumePdf(sampleResume(), { browser }))
  long = await extractPdf(await exportResumePdf(longResume(), { browser }))
})

after(async () => { await browser?.close() })

test('the generated file is a PDF', { skip }, async () => {
  const bytes = await exportResumePdf(sampleResume(), { browser: browser! })
  assert.ok(bytes.length > 1000, 'suspiciously small')
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-')
})

test('the text is selectable and extractable, not an image', { skip }, () => {
  assert.equal(short!.imageOnly, false, 'the PDF has no text layer')
  assert.ok(short!.totalLines > 10)
})

test('round trip: what went in comes back out', { skip }, () => {
  const text = short!.text
  for (const expected of [
    'Jordan Ellery', 'BSN, RN, CCRN', 'jordan.ellery@example.test', 'Newark, NJ',
    'Critical care nurse with six years',
    'Rutgers University', 'GPA 3.85', 'Science GPA 3.71', 'Cum laude',
    'University Hospital', 'Registered Nurse', 'Medical ICU',
    'Managed vasoactive infusions', 'Precepted four new graduate nurses',
    'CCRN', 'AACN',
  ]) {
    assert.ok(text.includes(expected), `missing from the PDF: "${expected}"`)
  }
})

test('round trip: the order the applicant chose is the order in the file', { skip }, () => {
  const text = short!.text
  const sequence = [
    'Jordan Ellery',
    'Critical care nurse with six years',
    'Rutgers University',
    'University Hospital',
    'CCRN',
  ]
  let cursor = -1
  for (const marker of sequence) {
    const at = text.indexOf(marker, cursor + 1)
    assert.ok(at > cursor, `"${marker}" is out of order in the extracted text`)
    cursor = at
  }
})

test('clinical grounding never reaches the printed page', { skip }, () => {
  // The V1 defect, verified at the far end of the pipeline rather than in the
  // plan: a fact the applicant never wrote into a bullet must not be printable.
  for (const grounding of ['Ventilator', 'CRRT', 'Septic shock']) {
    assert.equal(short!.text.includes(grounding), false, `grounding reached the PDF: ${grounding}`)
  }
})

test('a hidden section is absent from the file, not merely invisible', { skip }, async () => {
  const hidden = sampleResume()
  const withHidden = {
    ...hidden,
    sections: hidden.sections.map((s) => (s.type === 'education' ? { ...s, visible: false } : s)),
  }
  const result = await extractPdf(await exportResumePdf(withHidden, { browser: browser! }))
  assert.equal(result.text.includes('Rutgers University'), false)
  assert.ok(result.text.includes('University Hospital'), 'the rest of the resume still prints')
})

test('a GPA the applicant withheld is not in the bytes', { skip }, async () => {
  const resume = sampleResume()
  const withheld = {
    ...resume,
    sections: resume.sections.map((s) =>
      s.type !== 'education' ? s : {
        ...s,
        entries: s.entries.map((e) => ({
          ...e,
          overallGpa: { ...e.overallGpa, showOnResume: false },
          scienceGpa: { ...e.scienceGpa, showOnResume: false },
        })),
      } as ResumeSectionV2),
  }
  const result = await extractPdf(await exportResumePdf(withheld, { browser: browser! }))
  assert.equal(result.text.includes('3.85'), false)
  assert.equal(result.text.includes('3.71'), false)
  assert.ok(result.text.includes('Rutgers University'))
})

// ------------------------------------------------------- page breaks

test('a long resume runs to several pages', { skip }, () => {
  assert.ok(long!.numPages > 1, `expected multiple pages, got ${long!.numPages}`)
})

test('no section heading is stranded at the foot of a page', { skip }, () => {
  const headings = ['Professional Summary', 'Education', 'Licensure', 'Certifications']
  for (let i = 0; i < long!.pages.length - 1; i++) {
    const lines = long!.pages[i].lines.filter((l) => l.trim() !== '')
    const last = (lines[lines.length - 1] ?? '').trim()
    for (const heading of headings) {
      assert.notEqual(
        last.toLowerCase(), heading.toLowerCase(),
        `"${heading}" is the last line of page ${i + 1} with its content on the next`
      )
    }
  }
})

test('an entry is never split across a page boundary', { skip }, () => {
  // Each position's employer line and its first bullet must land on one page.
  const pageOf = (needle: string) =>
    long!.pages.findIndex((p) => p.lines.some((l) => l.includes(needle)))

  for (let i = 0; i < 9; i++) {
    const employer = pageOf(`Hospital Number ${i + 1}`)
    const firstBullet = pageOf(`Position ${i + 1} bullet 1`)
    assert.notEqual(employer, -1, `Hospital Number ${i + 1} is missing from the PDF`)
    assert.notEqual(firstBullet, -1, `Position ${i + 1} bullet 1 is missing from the PDF`)
    assert.equal(
      employer, firstBullet,
      `position ${i + 1} is split: header on page ${employer + 1}, first bullet on page ${firstBullet + 1}`
    )
  }
})

test('a long certification list survives intact', { skip }, () => {
  for (let i = 0; i < 14; i++) {
    assert.ok(long!.text.includes(`Certification ${i + 1}`), `Certification ${i + 1} was dropped`)
  }
})

test('a very long summary is not truncated', { skip }, () => {
  assert.ok(long!.text.includes('long professional summary'), 'the end of the summary is missing')
})

test('every position and every bullet reaches the file', { skip }, () => {
  for (let i = 0; i < 9; i++) {
    for (let b = 0; b < 5; b++) {
      assert.ok(
        long!.text.includes(`Position ${i + 1} bullet ${b + 1}`),
        `position ${i + 1} bullet ${b + 1} was dropped`
      )
    }
  }
})

// ------------------------------------------------- V1 export defects

test('no stray empty bullet is printed', { skip }, () => {
  // V1 seeded every position with [''], so every exported PDF printed a lone
  // dot under every job. The model refuses to create one; this proves it at
  // the far end.
  for (const page of short!.pages) {
    for (const line of page.lines) {
      assert.notEqual(line.trim(), '•', 'an empty bullet was printed')
      assert.notEqual(line.trim(), '-', 'an empty bullet was printed')
    }
  }
})

test('ligature-forming words extract with every letter intact', { skip }, async () => {
  // Found by this very test file: a font rendering "fi" as one glyph put that
  // ligature in the PDF text layer, and extraction returned "Certication".
  // A resume is machine-read before it is human-read, so each of these is a
  // keyword an applicant tracking system would fail to match. The stylesheet
  // turns ligatures off; this proves it, at the far end of the pipeline.
  const words = [
    'certified', 'qualified', 'identified', 'efficiency', 'staffing',
    'reflection', 'briefly', 'sufficient', 'workflow', 'classification',
  ]
  const resume = sampleResume()
  const withWords = {
    ...resume,
    sections: resume.sections.map((s) =>
      s.type !== 'summary' ? s : ({
        ...s,
        text: createAuthoredText(`A nurse ${words.join(', ')}.`),
      } as ResumeSectionV2)),
  }
  const result = await extractPdf(await exportResumePdf(withWords, { browser: browser! }))
  for (const word of words) {
    assert.ok(result.text.includes(word), `"${word}" did not survive extraction`)
  }
})

test('a resume with no name does not print the word Name', { skip }, async () => {
  // Two of seventeen live V1 resumes print the literal placeholder "Name".
  const nameless = sampleResume({ contact: { ...emptyContact() } })
  const result = await extractPdf(await exportResumePdf(nameless, { browser: browser! }))
  assert.equal(/(^|\n)\s*Name\s*(\n|$)/.test(result.text), false, 'a placeholder was printed')
})

test('a missing or unparseable date never prints as Invalid Date', { skip }, async () => {
  // V1 called new Date(x).toLocaleDateString() unguarded on ICU dates, so an
  // empty or malformed value printed the literal "Invalid Date" onto a resume.
  const resume = sampleResume()
  const broken = {
    ...resume,
    sections: resume.sections.map((s) => {
      if (s.type === 'education') {
        return {
          ...s,
          entries: s.entries.map((e) => ({ ...e, graduationDate: { kind: 'absent' as const } })),
        } as ResumeSectionV2
      }
      if (s.type === 'critical_care') {
        return {
          ...s,
          positions: s.positions.map((p) => ({
            ...p,
            facts: {
              ...p.facts,
              dates: {
                start: { kind: 'unparsed' as const, raw: 'Spring 2021' },
                end: { kind: 'absent' as const },
                isCurrent: false,
              },
            },
          })),
        } as ResumeSectionV2
      }
      return s
    }),
  }

  const result = await extractPdf(await exportResumePdf(broken, { browser: browser! }))
  for (const poison of ['Invalid Date', 'NaN', 'undefined', 'null']) {
    assert.equal(result.text.includes(poison), false, `"${poison}" was printed onto the resume`)
  }
  // The applicant's own words survive instead of being discarded.
  assert.ok(result.text.includes('Spring 2021'), 'an unparseable date lost the text the applicant typed')
  assert.ok(result.text.includes('Rutgers University'), 'the entry still prints without its date')
})

test('characters pasted from Word survive the export', { skip }, async () => {
  // jsPDF's Helvetica is WinAnsi-encoded, so smart quotes, em dashes and any
  // accented character pasted from a Word document did not render in V1.
  const resume = sampleResume({
    contact: { ...contact(), fullName: 'José Ramírez-O’Neill' },
  })
  const withTypography = {
    ...resume,
    sections: resume.sections.map((s) =>
      s.type !== 'summary' ? s : ({
        ...s,
        text: createAuthoredText('Charge nurse — “the unit’s go-to” — across a 24-bed ICU… and beyond.'),
      } as ResumeSectionV2)),
  }

  const result = await extractPdf(await exportResumePdf(withTypography, { browser: browser! }))
  // Accents, em dashes, curly double quotes and ellipses all extract as
  // themselves.
  for (const fragment of ['José', 'Ramírez', '—', '“', '”', '…']) {
    assert.ok(result.text.includes(fragment), `"${fragment}" did not survive the export`)
  }
  // Apostrophes are normalised to U+0027 on the way to the page. Inter maps the
  // curly apostrophe and U+02BC to one glyph, so an un-normalised "O’Neill"
  // extracts as "OʼNeill" and an applicant tracking system searching the
  // surname finds nothing. See `atsText`.
  assert.ok(result.text.includes("O'Neill"), 'the surname is not searchable')
  assert.equal(result.text.includes('\u02bc'), false, 'a modifier-letter apostrophe reached the text layer')
  assert.equal(result.text.includes('\u02bb'), false, 'a modifier-letter turned comma reached the text layer')
  assert.ok(result.text.includes("unit's go-to"), 'an apostrophe inside prose is not searchable')
})

test('a long certification list wraps into lines instead of one overflowing row', { skip }, () => {
  // V1 joined every certification with " | " into a single doc.text() call and
  // never measured it, so a long list ran off the right-hand page edge.
  const certLines = long!.pages
    .flatMap((page) => page.lines)
    .filter((line) => line.includes('Certification '))
  assert.ok(certLines.length >= 10, `expected certifications on their own lines, found ${certLines.length}`)
  for (const line of certLines) {
    const count = (line.match(/Certification \d+/g) ?? []).length
    assert.equal(count, 1, `several certifications share one line: ${JSON.stringify(line)}`)
  }
})

test('an empty resume produces a valid, empty document rather than failing', { skip }, async () => {
  const blank = createResume({ id: 'r', userId: 'u', title: 'Empty', sectionIds: ids(20), now: NOW })
  const bytes = await exportResumePdf(blank, { browser: browser! })
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-')
  const result = await extractPdf(bytes)
  assert.equal(result.numPages, 1)
})

test('all three templates export and carry the same content', { skip }, async () => {
  const resume = sampleResume()
  for (const template of Object.values(TEMPLATES)) {
    const result = await extractPdf(await exportResumePdf(resume, { browser: browser!, template: template.id }))
    assert.equal(result.imageOnly, false, template.id)
    for (const expected of ['Jordan Ellery', 'University Hospital', 'Rutgers University', 'CCRN']) {
      assert.ok(result.text.includes(expected), `${template.id} lost "${expected}"`)
    }
  }
})

test('the two-column template still extracts as a resume, not as a list of licences', { skip }, async () => {
  // The ATS property, proved on the real extracted text rather than on the plan.
  const result = await extractPdf(
    await exportResumePdf(sampleResume(), { browser: browser!, template: 'modern' })
  )
  const name = result.text.indexOf('Jordan Ellery')
  const summary = result.text.indexOf('Critical care nurse with six years')
  const licence = result.text.indexOf('26NR12345600')
  assert.ok(name >= 0 && summary > name, 'the document does not open with who they are')
  assert.ok(licence > summary, 'credentials are extracted before the summary')
})

test('the PDF embeds the shipped font for a Latin Extended name', { skip }, async () => {
  const bytes = await exportResumePdf(latinExtResume(), { browser: browser!, template: 'modern' })
  const raw = bytes.toString('latin1')
  // Chromium subsets what it embeds, so the presence of the family's own name
  // is what proves the shipped face was used rather than a container fallback.
  assert.ok(/Inter/.test(raw), 'the shipped sans was not embedded')
  for (const fallback of ['DejaVu', 'Liberation', 'Nimbus', 'FreeSans']) {
    assert.equal(raw.includes(fallback), false, `fell back to ${fallback}`)
  }
})

test('the serif template embeds its own shipped face for the same name', { skip }, async () => {
  const raw = (await exportResumePdf(latinExtResume(), { browser: browser!, template: 'classic' }))
    .toString('latin1')
  assert.ok(/SourceSerif/.test(raw), 'the shipped serif was not embedded')
  assert.equal(/Inter/.test(raw), false, 'the serif template embedded the sans face')
})

test('Latin Extended characters survive extraction intact', { skip }, async () => {
  for (const template of ['classic', 'modern', 'compact'] as const) {
    const result = await extractPdf(
      await exportResumePdf(latinExtResume(), { browser: browser!, template })
    )
    // The name, character by character, so a failure names the one that broke.
    for (const character of ['\u0141', '\u0158', '\u00ed', '\u010d', '\u0218', '\u0103', '\u0219']) {
      assert.ok(
        result.text.includes(character),
        `${template}: U+${character.codePointAt(0)!.toString(16).toUpperCase()} did not survive`
      )
    }
    assert.ok(result.text.includes(LATIN_EXT_NAME), `${template}: the surname is not searchable`)
    assert.ok(result.text.includes('\u0219oc protocol'), `${template}: prose lost a character`)
    // Nothing was silently replaced with a lookalike or a box.
    assert.equal(result.text.includes('\ufffd'), false, `${template}: a replacement character was printed`)
  }
})
