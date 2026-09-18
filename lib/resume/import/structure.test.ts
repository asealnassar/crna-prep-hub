import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gpasIn, headingKind, isSeparatorOnly, segmentBullets, stripGlyphs } from './structure.ts'
import { buildImportPlan, parseOrganised } from './organise.ts'
import type { OrganisedResume } from './organise.ts'
import { draftFromPlan } from './draft.ts'
import { sourceFromText } from './source.ts'
import type { SourceDocument } from './source.ts'

/**
 * Reading an imported document's structure without adding to it.
 *
 * The fixture has the shape of a real PDF extraction that failed import UAT --
 * bullet glyphs on lines of their own, before and after their sentences, a
 * wrapped summary under its heading, GPAs on their own lines under each degree
 * -- with every name and sentence fictional.
 */

const CONTACT_LINE = '12 Harbor Lane, Riverton, NJ 07000 | 555-0188 | morgan.avery@example.test'
const GPA_LINE = 'Science GPA: 4.0 | Overall GPA: 3.3 (4.0 scale)'
const COMBINED_HEADING = 'Committees/Leadership/Shadow Experience'

const DOCUMENT = [
  'Morgan Avery, BSN, RN, CCRN',
  // A street address and ZIP code the resume has no fields for.
  CONTACT_LINE,
  'SUMMARY',
  'Critical care nurse with six years in cardiothoracic and medical ICUs, experienced',
  'with Impella, IABP and continuous renal replacement therapy, and committed to',
  'precepting new graduates.',
  'EXPERIENCE',
  'Harborview Heart Institute | Riverton, NJ',
  'Registered Nurse, Cardiothoracic ICU | Jan 2021 – Present',
  'Recover post-operative cardiac surgery patients on mechanical circulatory support',
  '•',
  'Titrate vasoactive and sedation infusions to hemodynamic goals',
  '•',
  '• Precept newly hired nurses through a twelve-week orientation',
  'Serve as relief charge nurse for a 20-bed unit',
  '•',
  'Keystone Staffing Partners | Easton, NJ',
  'Travel ICU Nurse | Mar 2019 – Dec 2020',
  '•',
  'Cared for patients requiring proning, CRRT and',
  'neuromuscular blockade',
  '•',
  'Completed contracts across three medical ICUs',
  'Bayside Medical Center | Bayside, NJ',
  'Staff Nurse, Medical-Surgical | Jun 2017 – Feb 2019',
  '• Delivered care to five to six patients per shift',
  '• Joined the unit falls prevention committee',
  'EDUCATION',
  'Northfield University, Newark, NJ',
  'Bachelor of Science in Nursing, May 2017',
  GPA_LINE,
  'Eastbrook State University, Eastbrook, NJ',
  'Bachelor of Science in Biology',
  'Overall GPA: 3.5',
  'Lakeview County Community College',
  'Associate of Science',
  'Science GPA: 3.9',
  'CERTIFICATIONS',
  'CCRN, BLS, ACLS',
  COMBINED_HEADING,
  'Member, Unit Practice Council | 2022 – Present',
  'CRNA Shadowing, Riverton Surgical Center',
].join('\n')

const HARBORVIEW = [
  'Recover post-operative cardiac surgery patients on mechanical circulatory support',
  'Titrate vasoactive and sedation infusions to hemodynamic goals',
  'Precept newly hired nurses through a twelve-week orientation',
  'Serve as relief charge nurse for a 20-bed unit',
]
const KEYSTONE = [
  'Cared for patients requiring proning, CRRT and neuromuscular blockade',
  'Completed contracts across three medical ICUs',
]
const BAYSIDE = [
  'Delivered care to five to six patients per shift',
  'Joined the unit falls prevention committee',
]
const SUMMARY = 'Critical care nurse with six years in cardiothoracic and medical ICUs, experienced ' +
  'with Impella, IABP and continuous renal replacement therapy, and committed to precepting new graduates.'

const source = (text = DOCUMENT): SourceDocument => sourceFromText(text, 'pdf')

/** What an organiser plausibly returns for it: headers verbatim, bullets and summary partial or loose. */
const organised = (over: Partial<OrganisedResume> = {}): OrganisedResume => parseOrganised({
  contact: {
    fullName: 'Morgan Avery', credentials: 'BSN, RN, CCRN', email: 'morgan.avery@example.test',
    phone: '555-0188', city: 'Riverton', state: 'NJ',
  },
  // Wrapped across three lines: traces only loosely, so on its own it would be set aside.
  summary: SUMMARY,
  positions: [
    {
      employer: 'Harborview Heart Institute', role: 'Registered Nurse', unit: 'Cardiothoracic ICU',
      location: 'Riverton, NJ', dates: 'Jan 2021 – Present',
      bullets: [HARBORVIEW[0], HARBORVIEW[1]],
    },
    {
      employer: 'Keystone Staffing Partners', role: 'Travel ICU Nurse', unit: '',
      location: 'Easton, NJ', dates: 'Mar 2019 – Dec 2020',
      bullets: [KEYSTONE[0]],
    },
    {
      employer: 'Bayside Medical Center', role: 'Staff Nurse', unit: 'Medical-Surgical',
      location: 'Bayside, NJ', dates: 'Jun 2017 – Feb 2019',
      bullets: ['• Delivered care to five to six patients per shift'],
    },
  ],
  education: [
    { degree: 'Bachelor of Science in Nursing', field: '', institution: 'Northfield University', location: 'Newark, NJ', graduated: 'May 2017' },
    { degree: 'Bachelor of Science in Biology', field: '', institution: 'Eastbrook State University', location: 'Eastbrook, NJ', graduated: '' },
    { degree: 'Associate of Science', field: '', institution: 'Lakeview County Community College', location: '', graduated: '' },
  ],
  certifications: [{ name: 'CCRN', issuer: '' }, { name: 'BLS', issuer: '' }, { name: 'ACLS', issuer: '' }],
  licenses: [],
  entries: [
    { section: 'leadership', title: 'Member', organization: 'Unit Practice Council', dates: '2022 – Present', detail: '' },
    { section: 'shadowing', title: 'CRNA Shadowing', organization: 'Riverton Surgical Center', dates: '', detail: '' },
  ],
  unmapped: [],
  ...over,
})

const segment = (texts: readonly string[]) =>
  segmentBullets(texts.map((text, index) => ({ index, text }))).map((bullet) => bullet.text)

const GLYPH = /[•●◦▪■]/

// ---------------------------------------------------------------- 1-3: glyphs

test('1: a bullet glyph extracted on its own line after its sentence ends that bullet', () => {
  assert.deepEqual(
    segment(['Recover patients on circulatory support', '•', 'Titrate infusions to goals', '•']),
    ['Recover patients on circulatory support', 'Titrate infusions to goals']
  )
  // After the FIRST line of a wrapped bullet is where such a glyph lands; it
  // does not split the bullet it belongs to.
  assert.deepEqual(
    segment(['Cared for patients requiring proning, CRRT and', '•', 'neuromuscular blockade', 'Completed contracts', '•']),
    ['Cared for patients requiring proning, CRRT and neuromuscular blockade', 'Completed contracts']
  )
  // Nor when the wrap starts with a capital: two glyphs are two bullets.
  assert.deepEqual(
    segment(['Managed complex patients', '•', 'ECMO and Impella devices', 'Titrated drips', '•']),
    ['Managed complex patients ECMO and Impella devices', 'Titrated drips']
  )
})

test('2: a bullet glyph extracted on its own line before its sentence starts that bullet', () => {
  assert.deepEqual(
    segment(['•', 'Recover patients on circulatory support', '•', 'Titrate infusions to goals']),
    ['Recover patients on circulatory support', 'Titrate infusions to goals']
  )
  assert.deepEqual(
    segment(['•', 'Cared for patients requiring proning, CRRT and', 'neuromuscular blockade', '•', 'Completed contracts']),
    ['Cared for patients requiring proning, CRRT and neuromuscular blockade', 'Completed contracts']
  )
  // Word's Symbol-font bullet, as pdf.js extracts it.
  assert.deepEqual(segment(['', 'First bullet', '', 'Second bullet']), ['First bullet', 'Second bullet'])
})

test('3: mixed extraction patterns in one job keep every bullet once, separate, and without glyphs', () => {
  // Sentence / • / Sentence / • / • Sentence / Sentence / •
  const bullets = segment([
    'Recover post-operative cardiac surgery patients', '•',
    'Titrate vasoactive and sedation infusions', '•',
    '• Precept newly hired nurses', 'Serve as relief charge nurse', '•',
  ])
  assert.deepEqual(bullets, [
    'Recover post-operative cardiac surgery patients',
    'Titrate vasoactive and sedation infusions',
    'Precept newly hired nurses',
    'Serve as relief charge nurse',
  ])
  for (const bullet of bullets) {
    assert.notEqual(bullet.trim(), '', 'an empty bullet was created')
    assert.equal(GLYPH.test(bullet), false, `a glyph was kept in "${bullet}"`)
  }
  // Doubled and trailing glyphs, and glyph-only runs, never become bullets of their own.
  assert.deepEqual(segment(['First •', '•', '• • Second', '•', '•']), ['First', 'Second'])
  assert.deepEqual(segment(['•', '•']), [])
  // A finished sentence is not joined to the next one, glyph or no glyph.
  assert.deepEqual(
    segment(['•', 'Precepted new graduates.', 'Led the unit falls committee.', '•', 'Charge nurse.']),
    ['Precepted new graduates.', 'Led the unit falls committee.', 'Charge nurse.']
  )
  assert.deepEqual(stripGlyphs('• Titrated drips'), { text: 'Titrated drips', lead: true, trail: false })
})

// ----------------------------------------------------------- 4-5: which job

test('4: bullets stay with the job they sit under until the next job begins', () => {
  const plan = buildImportPlan(organised(), source())
  assert.deepEqual(plan.organised.positions[0].bullets, HARBORVIEW)
  assert.deepEqual(plan.organised.positions[1].bullets, KEYSTONE)
  assert.deepEqual(plan.organised.positions[2].bullets, BAYSIDE)
  // All of them verified, none set aside.
  assert.equal(plan.uncertain.filter((u) => u.path.includes('.bullets[')).length, 0)
  assert.equal(plan.mapped.filter((m) => m.path.startsWith('positions[0].bullets[')).length, 4)
})

test('5: no bullet leaks into the next job, even a job the organiser did not recognise', () => {
  // The organiser misses Bayside entirely and files a Keystone bullet under Harborview.
  const base = organised()
  const plan = buildImportPlan(organised({
    positions: [
      { ...base.positions[0], bullets: [...base.positions[0].bullets, KEYSTONE[1]] },
      base.positions[1],
    ],
  }), source())

  assert.deepEqual(plan.organised.positions[0].bullets, HARBORVIEW)
  assert.deepEqual(plan.organised.positions[1].bullets, KEYSTONE)
  const placed = plan.organised.positions.flatMap((p) => p.bullets)
  for (const bullet of BAYSIDE) {
    assert.equal(placed.some((b) => b.includes(bullet)), false, `"${bullet}" leaked into another job`)
  }
  // The unrecognised job is not lost: its header and bullets wait for the applicant.
  const recovered = plan.recovery.map((item) => item.text)
  assert.ok(recovered.includes('Bayside Medical Center | Bayside, NJ'))
  assert.ok(recovered.includes('Staff Nurse, Medical-Surgical | Jun 2017 – Feb 2019'))
  assert.ok(recovered.includes('• Delivered care to five to six patients per shift'))
  assert.ok(recovered.includes('• Joined the unit falls prevention committee'))
})

// ------------------------------------------------------------ 6: summary

test('6: a paragraph under a Summary heading is the summary, verbatim', () => {
  const plan = buildImportPlan(organised(), source())
  assert.equal(plan.organised.summary, SUMMARY)
  assert.ok(plan.mapped.some((m) => m.path === 'summary' && m.confidence === 'high' && m.value === SUMMARY))
  assert.equal(plan.uncertain.some((u) => u.path === 'summary'), false, 'the summary was still set aside')

  // Even when the organiser did not return one at all.
  assert.equal(buildImportPlan(organised({ summary: '' }), source()).organised.summary, SUMMARY)

  // A bulleted list under the heading is not a paragraph: it is not glued into
  // one, and it is kept for the applicant, suggested for the summary.
  const listed = DOCUMENT.replace(
    'Critical care nurse with six years in cardiothoracic and medical ICUs, experienced\n' +
    'with Impella, IABP and continuous renal replacement therapy, and committed to\n' +
    'precepting new graduates.',
    '• Six years of critical care experience\n• Impella and IABP management'
  )
  const bulleted = buildImportPlan(organised({ summary: '' }), source(listed))
  assert.equal(bulleted.organised.summary, '')
  const items = bulleted.recovery.filter((item) => item.suggestion.kind === 'summary').map((item) => item.text)
  assert.deepEqual(items, ['• Six years of critical care experience', '• Impella and IABP management'])
})

// --------------------------------------------------------------- 7: GPA

test('7: a stated GPA belongs to the degree it is written under, and is never inferred', () => {
  const plan = buildImportPlan(organised(), source())
  const [northfield, eastbrook, lakeview] = plan.organised.education
  assert.equal(northfield.scienceGpa, '4.0')
  assert.equal(northfield.overallGpa, '3.3')
  assert.equal(eastbrook.overallGpa, '3.5')
  assert.equal(eastbrook.scienceGpa, '', 'a science GPA was inferred')
  assert.equal(lakeview.scienceGpa, '3.9')
  assert.equal(lakeview.overallGpa, '', 'an overall GPA was inferred')

  const draft = draftFromPlan({
    plan, userId: 'u1', title: 'Imported',
    ids: { resumeId: 'r1', pool: Array.from({ length: 200 }, (_, i) => `id-${i}`) },
    now: '2026-09-17T09:00:00.000Z',
    importedFrom: { importId: 'i1', sourceFormat: 'pdf', documentFingerprint: 'f', importedAt: '2026-09-17T09:00:00.000Z', originalRetained: false },
  })
  const education = draft.sections.find((s) => s.type === 'education')
  assert.ok(education && education.type === 'education')
  assert.deepEqual(
    education.entries.map((e) => [e.institution, e.overallGpa.raw, e.scienceGpa.raw]),
    [
      ['Northfield University', '3.3', '4.0'],
      ['Eastbrook State University', '3.5', ''],
      ['Lakeview County Community College', '', '3.9'],
    ]
  )
  // Imported is not the same as chosen for print: the applicant turns a GPA on.
  assert.ok(education.entries.every((e) => !e.overallGpa.showOnResume && !e.scienceGpa.showOnResume))

  // A differently named GPA is not filed as the overall one, and a GPA under no
  // degree belongs to none.
  assert.deepEqual(gpasIn('Nursing GPA: 3.8').map((g) => g.kind), [null])
  assert.deepEqual(gpasIn('Cumulative GPA 3.6, sGPA 3.7').map((g) => [g.kind, g.raw]), [['overall', '3.6'], ['science', '3.7']])
  assert.deepEqual(gpasIn('GPA: 3.5/4.0').map((g) => g.raw), ['3.5/4.0'])
  const stray = buildImportPlan(organised(), source(DOCUMENT.replace('EDUCATION', 'EDUCATION\nOverall GPA: 2.9\nNursing GPA: 3.8')))
  assert.equal(stray.organised.education[0].overallGpa, '3.3')
  assert.ok(stray.recovery.some((item) => item.text === 'Overall GPA: 2.9'))
  assert.equal(
    buildImportPlan(organised(), source(DOCUMENT.replace(GPA_LINE, 'Nursing GPA: 3.8'))).organised.education[0].overallGpa,
    ''
  )
})

// ---------------------------------------------------------- 13: nothing invented

/** A document's text with its glyphs gone, as one run -- what every placed value must come from. */
function runOf(doc: SourceDocument): string {
  return doc.lines.map((line) => stripGlyphs(line).text).join(' ').replace(/\s+/g, ' ')
}

test('13: nothing is invented, and nothing from the document silently disappears', () => {
  const doc = source()
  const withLie = organised({
    positions: organised().positions.map((p, i) =>
      i === 0 ? { ...p, bullets: [...p.bullets, 'Maintained a 1:1 ECMO assignment for eight years.'] } : p),
  })
  const plan = buildImportPlan(withLie, doc)

  // The invention is discarded, and appears nowhere.
  assert.equal(plan.rejected.length, 1)
  const placed = [
    plan.organised.summary,
    ...plan.organised.positions.flatMap((p) => p.bullets),
    ...plan.organised.education.flatMap((e) => [e.overallGpa ?? '', e.scienceGpa ?? '']),
  ].filter((value) => value !== '')
  assert.equal(placed.some((value) => value.includes('ECMO assignment')), false)

  // Every structural value is the document's own lines, in order, glyphs removed.
  const run = runOf(doc)
  for (const value of placed) {
    assert.ok(run.includes(value), `"${value}" is not text from the document`)
  }

  // Every line with content is placed, is structure, is a header or GPA line
  // whose fields were read, or is waiting for the applicant.
  const mappedText = plan.mapped.map((m) => m.value.toLowerCase())
  const recovered = new Set(plan.recovery.map((item) => item.sourceLine))
  doc.lines.forEach((line, i) => {
    if (recovered.has(i) || headingKind(line) !== null || isSeparatorOnly(line)) return
    let rest = stripGlyphs(line).text
    const stated = gpasIn(rest)
    for (const gpa of stated) {
      assert.ok(plan.mapped.some((m) => /Gpa$/.test(m.path) && m.value === gpa.raw && m.sourceLine === i),
        `the GPA on line ${i} was not placed`)
      rest = rest.replace(gpa.match, ' ')
    }
    if (stated.length > 0) return
    const contact = plan.mapped.filter((m) => m.path.startsWith('contact.') && m.sourceLine === i)
    if (contact.some((m) => ['contact.email', 'contact.phone', 'contact.fullName'].includes(m.path))) return
    const words = rest.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2)
    assert.ok(words.every((word) => mappedText.some((value) => value.includes(word))),
      `line ${i} "${line}" was neither placed nor kept`)
  })
})

test('a school the organiser missed keeps its own GPA', () => {
  const base = organised()
  const plan = buildImportPlan(organised({ education: base.education.slice(0, 2) }), source())
  assert.equal(plan.organised.education[1].overallGpa, '3.5')
  assert.equal(plan.organised.education[1].scienceGpa, '', 'the missed school’s GPA was filed under the one above')
  assert.ok(plan.recovery.some((item) => item.text === 'Science GPA: 3.9'))
  assert.ok(plan.recovery.some((item) => item.text === 'Lakeview County Community College'))
})

test('confirmation reproduces exactly what review showed', () => {
  const doc = source()
  const reviewed = buildImportPlan(organised(), doc)
  // What the browser sends back is the sanitised plan, round-tripped as JSON.
  const confirmed = buildImportPlan(parseOrganised(JSON.parse(JSON.stringify(reviewed.organised))), doc)
  assert.deepEqual(confirmed.organised, reviewed.organised)
  assert.deepEqual(confirmed.recovery, reviewed.recovery)
  assert.equal(confirmed.rejected.length, 0, 'structure’s own values were counted as discards')
})

// ------------------------------------------ what is used up is not offered again

const reviewTexts = (text = DOCUMENT) => buildImportPlan(organised(), source(text)).recovery.map((item) => item.text)

test('a document that imported completely leaves nothing to review', () => {
  assert.deepEqual(reviewTexts(), [])
})

test('R1: a contact line whose contact fields were read is not listed for review again', () => {
  const plan = buildImportPlan(organised(), source())
  for (const path of ['contact.email', 'contact.phone', 'contact.city', 'contact.state']) {
    assert.ok(plan.mapped.some((m) => m.path === path && m.sourceLine === 1), `${path} was not read from the contact line`)
  }
  assert.equal(reviewTexts().includes(CONTACT_LINE), false)
  // Split across lines -- name, then address, then phone and email -- the same.
  const split = DOCUMENT.replace(CONTACT_LINE, '12 Harbor Lane, Riverton, NJ 07000\n555-0188 | morgan.avery@example.test')
  assert.deepEqual(reviewTexts(split), [])
})

test('R2: a GPA line whose GPAs were read is not listed for review again', () => {
  const plan = buildImportPlan(organised(), source())
  assert.equal(plan.organised.education[0].scienceGpa, '4.0')
  assert.equal(plan.organised.education[0].overallGpa, '3.3')
  assert.equal(reviewTexts().includes(GPA_LINE), false)
  // The same figure stated again under the same degree is the same data.
  assert.deepEqual(reviewTexts(DOCUMENT.replace('Overall GPA: 3.5', 'Overall GPA: 3.5\nOverall GPA: 3.5 (4.0 scale)')), [])
})

test('R3: a recognised section heading is structure, not an item to review', () => {
  assert.equal(headingKind(COMBINED_HEADING), 'other')
  assert.equal(headingKind('Leadership & Committees'), 'leadership')
  assert.equal(headingKind('Shadow Experience'), 'shadowing')
  assert.equal(headingKind('Leadership, teamwork and communication'), null)
  assert.equal(reviewTexts().includes(COMBINED_HEADING), false)
})

test('R4: genuinely unplaced text still waits for review beside lines that were used up', () => {
  const texts = reviewTexts(DOCUMENT
    // A sentence in the header block that merely mentions the city.
    .replace(CONTACT_LINE, `${CONTACT_LINE}\nSeeking admission to a nurse anesthesia program near Riverton, NJ`)
    // A GPA the resume has no field for, beside one it has.
    .replace('Overall GPA: 3.5', 'Overall GPA: 3.5 | Nursing GPA: 3.8')
    // A different figure for a GPA already read.
    .replace('Science GPA: 3.9', 'Science GPA: 3.9\nScience GPA: 3.7')
    // Unknown text under a known heading, mentioning the applicant's city.
    .replace('CCRN, BLS, ACLS', 'CCRN, BLS, ACLS\nRelocating to Riverton, NJ in 2026 to be near family'))
  assert.deepEqual(texts, [
    'Seeking admission to a nurse anesthesia program near Riverton, NJ',
    'Overall GPA: 3.5 | Nursing GPA: 3.8',
    'Science GPA: 3.7',
    'Relocating to Riverton, NJ in 2026 to be near family',
  ])
})
