import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_SECTION_HEADING, draftFromPlan } from './draft.ts'
import { buildImportPlan } from './organise.ts'
import type { OrganisedResume } from './organise.ts'
import { sourceFromText } from './source.ts'
import { planDocument, textOf } from '../document/plan.ts'
import { isAiAuthored } from '../model/authoredText.ts'
import { authoredTextsIn } from '../model/sections.ts'
import type { ResumeSectionV2 } from '../model/types.ts'

const NOW = '2026-09-11T09:00:00.000Z'
const RESUME = `Jordan Ellery
jordan.ellery@example.test
PROFESSIONAL SUMMARY
Critical care nurse in a medical ICU.
EXPERIENCE
University Hospital — Registered Nurse
Titrated vasoactive infusions overnight.
EDUCATION
Rutgers University — BSN
LEFTOVER LINE NOBODY PLACED`

const source = () => sourceFromText(RESUME, 'paste')

const organised = (over: Partial<OrganisedResume> = {}): OrganisedResume => ({
  contact: { fullName: 'Jordan Ellery', credentials: '', email: 'jordan.ellery@example.test', phone: '', city: '', state: '' },
  summary: 'Critical care nurse in a medical ICU.',
  positions: [{
    employer: 'University Hospital', role: 'Registered Nurse', unit: '', location: '',
    dates: '', bullets: ['Titrated vasoactive infusions overnight.'],
  }],
  education: [{ degree: 'BSN', field: '', institution: 'Rutgers University', location: '', graduated: '' }],
  certifications: [], licenses: [], entries: [],
  unmapped: ['LEFTOVER LINE NOBODY PLACED'],
  ...over,
})

const ids = { resumeId: 'r1', pool: Array.from({ length: 200 }, (_, i) => `id-${i}`) }
const reference = {
  importId: 'imp-1', sourceFormat: 'pdf' as const,
  documentFingerprint: 'abc', importedAt: NOW, originalRetained: false,
}

function build(over: Partial<OrganisedResume> = {}) {
  return draftFromPlan({
    plan: buildImportPlan(organised(over), source()),
    userId: 'u1', title: 'Imported', ids, now: NOW, importedFrom: reference,
  })
}

test('the draft carries only what traced to the document', () => {
  const printed = textOf(planDocument(build())).join(' | ')
  assert.ok(printed.includes('University Hospital'))
  assert.ok(printed.includes('Titrated vasoactive infusions overnight.'))
  assert.ok(printed.includes('Rutgers University'))
})

test('an invented value never appears in the draft', () => {
  const resume = build({
    positions: [{
      employer: 'Johns Hopkins Hospital', role: 'Registered Nurse', unit: '', location: '',
      dates: '', bullets: ['Ran ECMO circuits for eight years.'],
    }],
  })
  const printed = textOf(planDocument(resume)).join(' | ')
  assert.equal(printed.includes('Johns Hopkins'), false)
  assert.equal(printed.includes('ECMO'), false)
})

test('every imported piece of prose is marked as imported, not typed here', () => {
  const resume = build()
  for (const section of resume.sections) {
    for (const text of authoredTextsIn(section)) {
      if (text.accepted.trim() === '') continue
      assert.equal(text.originalOrigin, 'import', `"${text.accepted}" is not marked imported`)
      assert.equal(isAiAuthored(text), false, 'imported text was marked AI-authored')
    }
  }
})

test('the resume records where it came from, and that nothing was kept', () => {
  const resume = build()
  assert.ok(resume.importedFrom)
  assert.equal(resume.importedFrom!.originalRetained, false)
  assert.equal(resume.importedFrom!.documentFingerprint, 'abc')
})

test('unplaced lines are kept, hidden, and never printed', () => {
  const resume = build()
  const review = resume.sections.find(
    (s) => s.type === 'custom' && s.heading === REVIEW_SECTION_HEADING
  ) as Extract<ResumeSectionV2, { type: 'custom' }> | undefined

  assert.ok(review, 'the leftover line was thrown away')
  assert.equal(review!.visible, false, 'unreviewed text would print')
  assert.ok(
    review!.entries.some((e) => e.detail.accepted.includes('LEFTOVER LINE')),
    'the applicant’s own line was lost'
  )
  assert.equal(
    textOf(planDocument(resume)).join(' ').includes('LEFTOVER LINE'), false,
    'unreviewed text reached the document'
  )
})

test('no review section is added when everything was placed', () => {
  const resume = build({ unmapped: [] })
  assert.equal(resume.sections.some((s) => s.type === 'custom'), false)
})

test('an import never invents a GPA, a licence number or an expiry', () => {
  const resume = build({
    certifications: [{ name: 'CCRN', issuer: '' }],
    licenses: [{ licenseType: 'RN', state: '' }],
  })
  for (const section of resume.sections) {
    if (section.type === 'education') {
      for (const entry of section.entries) {
        assert.equal(entry.overallGpa.raw, '')
        assert.equal(entry.overallGpa.showOnResume, false)
      }
    }
    if (section.type === 'licensure') {
      for (const licence of section.licenses) {
        assert.equal(licence.identifier, '', 'a licence number was invented')
        assert.equal(licence.expires.kind, 'absent')
      }
    }
    if (section.type === 'certifications') {
      for (const cert of section.certifications) {
        assert.equal(cert.identifier, '')
        assert.equal(cert.earned.kind, 'absent', 'an earned date was invented')
      }
    }
  }
})

test('an import adds no empty visible section to clean up after', () => {
  const resume = build({ certifications: [], licenses: [], entries: [] })
  for (const section of resume.sections) {
    if (!section.visible) continue
    assert.notEqual(
      textOf(planDocument({ ...resume, sections: [section] })).length, 0,
      `${section.type} was added empty and visible`
    )
  }
})

test('the draft is a draft', () => {
  assert.equal(build().status, 'draft')
})

test('the same plan always builds the same resume', () => {
  assert.deepEqual(build(), build())
})
