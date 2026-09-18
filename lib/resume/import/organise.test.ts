import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildImportPlan, buildOrganiserPrompt, parseOrganised, traceValue,
} from './organise.ts'
import type { OrganisedResume } from './organise.ts'
import { sourceFromText } from './source.ts'
import { checkPaste, checkUpload, detectFormat } from './upload.ts'

/**
 * The organiser's one rule: it may map what is there, and may not add what is
 * not. Everything below is that rule, checked from as many directions as it can
 * be reached from.
 */

const RESUME = `Jordan Ellery, BSN, RN, CCRN
jordan.ellery@example.test | 555-0142 | Newark, NJ

PROFESSIONAL SUMMARY
Critical care nurse with sustained experience in a high-acuity medical ICU.

EXPERIENCE
University Hospital — Registered Nurse, Medical ICU
Newark, NJ | March 2021 - Present
Titrated vasoactive infusions through haemodynamic collapse.
Precepted new graduate nurses through unit orientation.

EDUCATION
Rutgers University — BSN, Nursing
Newark, NJ | May 2019

LICENSURE
RN, New Jersey

CERTIFICATIONS
CCRN — AACN`

const source = () => sourceFromText(RESUME, 'paste')

const organised = (over: Partial<OrganisedResume> = {}): OrganisedResume => ({
  contact: {
    fullName: 'Jordan Ellery', credentials: 'BSN, RN, CCRN',
    email: 'jordan.ellery@example.test', phone: '555-0142', city: 'Newark', state: 'NJ',
  },
  summary: 'Critical care nurse with sustained experience in a high-acuity medical ICU.',
  positions: [{
    employer: 'University Hospital', role: 'Registered Nurse', unit: 'Medical ICU',
    location: 'Newark, NJ', dates: 'March 2021 - Present',
    bullets: [
      'Titrated vasoactive infusions through haemodynamic collapse.',
      'Precepted new graduate nurses through unit orientation.',
    ],
  }],
  education: [{
    degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
    location: 'Newark, NJ', graduated: 'May 2019',
  }],
  certifications: [{ name: 'CCRN', issuer: 'AACN' }],
  licenses: [{ licenseType: 'RN', state: 'New Jersey' }],
  entries: [],
  unmapped: [],
  ...over,
})

// ------------------------------------------------------------ tracing

test('a value written in the document traces to the line it came from', () => {
  const trace = traceValue('University Hospital', source())
  assert.ok(trace)
  assert.equal(trace!.confidence, 'high')
  assert.ok(trace!.sourceLine !== null)
})

test('a value nowhere in the document does not trace at all', () => {
  for (const invented of ['ECMO', 'Johns Hopkins', '2:1 patient ratio', 'CRNA']) {
    assert.equal(traceValue(invented, source()), null, invented)
  }
})

test('a value recoverable only by its words traces as uncertain', () => {
  // Punctuation an extractor mangles, or a value split across a line break.
  const trace = traceValue('University Hospital Registered Nurse', source())
  assert.ok(trace)
  assert.equal(trace!.confidence, 'low')
})

test('an empty value never traces', () => {
  assert.equal(traceValue('', source()), null)
  assert.equal(traceValue('   ', source()), null)
})

// ------------------------------------- the organiser adds nothing

test('every value that reaches the draft came from the document', () => {
  // The blueprint's test, and the phase's central claim.
  const plan = buildImportPlan(organised(), source())
  for (const value of plan.mapped) {
    assert.ok(
      traceValue(value.value, source()) !== null,
      `"${value.value}" reached the draft without being in the source`
    )
  }
  assert.deepEqual(plan.rejected, [], 'a legitimate import was wrongly rejected')
})

test('an invented employer is discarded, not imported', () => {
  const withLie = organised({
    positions: [{
      employer: 'Johns Hopkins Hospital', role: 'Registered Nurse', unit: 'Medical ICU',
      location: 'Newark, NJ', dates: 'March 2021 - Present', bullets: [],
    }],
  })
  const plan = buildImportPlan(withLie, source())
  assert.equal(plan.organised.positions[0].employer, '', 'the invented employer was kept')
  assert.ok(plan.rejected.some((r) => r.value === 'Johns Hopkins Hospital'))
  assert.equal(plan.rejected[0].reason, 'not-found-in-source')
})

test('an invented bullet is discarded while the real ones survive', () => {
  const withLie = organised({
    positions: [{
      ...organised().positions[0],
      bullets: [
        'Titrated vasoactive infusions through haemodynamic collapse.',
        'Maintained a 2:1 patient assignment on ECMO.',
      ],
    }],
  })
  const plan = buildImportPlan(withLie, source())
  // Both real bullets under the job -- including the one the organiser left
  // out, which the document's own structure places -- and never the invention.
  assert.deepEqual(plan.organised.positions[0].bullets, [
    'Titrated vasoactive infusions through haemodynamic collapse.',
    'Precepted new graduate nurses through unit orientation.',
  ])
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].value, 'Maintained a 2:1 patient assignment on ECMO.')
})

test('an invented certification never reaches the draft', () => {
  const withLie = organised({ certifications: [{ name: 'CRNA', issuer: 'AANA' }] })
  const plan = buildImportPlan(withLie, source())
  assert.equal(plan.organised.certifications[0].name, '')
  assert.equal(plan.organised.certifications[0].issuer, '')
})

test('an invented contact detail never reaches the draft', () => {
  const withLie = organised({
    contact: { ...organised().contact, phone: '555-9999', email: 'someone.else@example.test' },
  })
  const plan = buildImportPlan(withLie, source())
  assert.equal(plan.organised.contact.phone, '')
  assert.equal(plan.organised.contact.email, '')
  assert.equal(plan.organised.contact.fullName, 'Jordan Ellery', 'the real name was lost too')
})

// -------------------------------------------------- uncertain, not guessed

test('a loosely traced value is set aside rather than written in', () => {
  // The source reads "Registered Nurse, Medical ICU": the organiser's version
  // matches only once punctuation is ignored.
  const base = organised().positions[0]
  const loose = organised({ positions: [{ ...base, role: 'Registered Nurse Medical ICU' }] })
  const plan = buildImportPlan(loose, source())
  assert.equal(plan.organised.positions[0].role, '', 'an uncertain value was written into the resume')
  assert.equal(plan.uncertain.length, 1)
  assert.equal(plan.uncertain[0].confidence, 'low')
})

test('a loosely traced summary is not written in -- the document’s own paragraph under its heading is', () => {
  const loose = organised({ summary: 'Critical care nurse with sustained experience in a high acuity medical ICU' })
  const plan = buildImportPlan(loose, source())
  assert.equal(plan.organised.summary, 'Critical care nurse with sustained experience in a high-acuity medical ICU.')
  assert.equal(plan.uncertain.length, 0)
})

test('every mapping carries a path and provenance', () => {
  const plan = buildImportPlan(organised(), source())
  for (const value of [...plan.mapped, ...plan.uncertain]) {
    assert.notEqual(value.path, '', 'a mapping does not say where it lands')
    assert.ok(['high', 'low'].includes(value.confidence))
  }
  assert.ok(plan.mapped.some((m) => m.path === 'contact.email'))
  assert.ok(plan.mapped.some((m) => /^positions\[0\]\.bullets\[\d+\]$/.test(m.path)))
})

test('unmapped lines are kept only when they are genuinely in the document', () => {
  const withLie = organised({ unmapped: ['VOLUNTEER WORK', 'Something never written'] })
  const plan = buildImportPlan(withLie, source())
  assert.equal(plan.unmapped.includes('Something never written'), false)
})

// -------------------------------------------------------- parsing

test('a malformed reply yields an empty organised resume, never a guess', () => {
  for (const raw of ['not json', null, 42, [], { positions: 'nope' }]) {
    const result = parseOrganised(raw)
    assert.equal(result.summary, '')
    assert.deepEqual(result.positions, [])
    assert.deepEqual(result.education, [])
  }
})

test('a fenced reply is still read', () => {
  const parsed = parseOrganised('```json\n{"summary":"Hello."}\n```')
  assert.equal(parsed.summary, 'Hello.')
})

test('an unknown entry section falls back rather than inventing one', () => {
  const parsed = parseOrganised({ entries: [{ section: 'nonsense', title: 'A thing' }] })
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].section, 'leadership')
})

test('the prompt says what it may not do, and numbers the lines', () => {
  const { system, user } = buildOrganiserPrompt(source())
  assert.match(system, /must appear in the text/i)
  assert.match(system, /never fill in something that is not there/i)
  assert.match(system, /unmapped/)
  assert.match(user, /^0: Jordan Ellery/m)
})

test('building a plan is pure and repeatable', () => {
  const input = organised()
  const before = JSON.stringify(input)
  assert.deepEqual(buildImportPlan(input, source()), buildImportPlan(input, source()))
  assert.equal(JSON.stringify(input), before)
})

// --------------------------------------------------------- uploads

test('the format comes from the file’s signature, not its name', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])
  assert.equal(detectFormat(pdf), 'pdf')
  assert.equal(detectFormat(zip), 'docx')
  // A .pdf that is really something else is refused whatever it is called.
  assert.equal(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null)
  assert.equal(detectFormat(new Uint8Array([])), null)
})

test('an oversized or empty upload is refused before parsing', () => {
  assert.equal(checkUpload(new Uint8Array(0)).ok, false)
  const huge = new Uint8Array(16 * 1024 * 1024)
  huge.set([0x25, 0x50, 0x44, 0x46, 0x2d])
  const result = checkUpload(huge)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'too-large')
})

test('pasted text is bounded at both ends', () => {
  assert.equal(checkPaste('').ok, false)
  assert.equal(checkPaste('   ').ok, false)
  assert.equal(checkPaste(RESUME).ok, true)
  assert.equal(checkPaste('x'.repeat(200_001)).ok, false)
})
