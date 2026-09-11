import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scoreDeterministic } from './deterministic.ts'
import { compose } from './compose.ts'
import { containsAdmissionsClaim } from './language.ts'
import type { CategoryId, CategoryResult } from './types.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * The Data Quality half. Every defect here is one the applicant can see and
 * fix, which is why the deterministic layer is worth 40 points and costs
 * nothing to recompute.
 */

const NOW = '2026-09-11T09:00:00.000Z'
const MAR_2021 = resumeDateFromParts(2021, 3)
const JUN_2023 = resumeDateFromParts(2023, 6)
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

const find = (results: CategoryResult[], id: CategoryId) => results.find((r) => r.id === id)!

function base(sections: readonly ResumeSectionV2[] = [], contact = {}): ResumeV2 {
  const resume = createResume({ id: 'r1', userId: 'u1', title: 'T', sectionIds: ids(20), now: NOW })
  return {
    ...resume,
    contact: { ...emptyContact(), fullName: 'Jordan Ellery', email: 'j@example.test', phone: '555-0142', city: 'Newark', state: 'NJ', ...contact },
    sections,
  }
}

/** A resume with enough on it to be judged on length as well as on defects. */
function realisticResume(extra: readonly ResumeSectionV2[] = []): ResumeV2 {
  const education = {
    ...createSection('education', 'ed'),
    entries: [{
      id: 'e', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
      location: 'Newark, NJ', graduationDate: JUN_2023,
      overallGpa: parseGpa(''), scienceGpa: parseGpa(''), honors: '',
    }],
  } as ResumeSectionV2

  const jobs = {
    ...createSection('critical_care', 'cc'),
    positions: [0, 1].map((n) => ({
      ...createClinicalPosition(`p${n}`, {
        employer: `University Hospital ${n}`, role: 'Registered Nurse', unit: 'Medical ICU',
        dates: { start: MAR_2021, end: JUN_2023, isCurrent: false },
      }),
      bullets: Array.from({ length: 6 }, (_, b) =>
        createBullet(`Position ${n} line ${b}: sustained responsibility for critically ill patients, coordinating closely with the intensivist team.`)),
    })),
  } as ResumeSectionV2

  return base([
    summary('Critical care nurse with sustained experience in a high-acuity medical ICU, known for early recognition of deterioration and calm escalation under pressure.'),
    education,
    jobs,
    ...extra,
  ])
}

const summary = (text: string, over: Partial<ResumeSectionV2> = {}) =>
  ({ ...createSection('summary', 'sm'), text: createAuthoredText(text), ...over }) as ResumeSectionV2

const position = (bullets: string[], over = {}) =>
  ({
    ...createSection('critical_care', 'cc'),
    positions: [{
      ...createClinicalPosition('p1', {
        employer: 'University Hospital', role: 'RN',
        dates: { start: MAR_2021, end: { kind: 'absent' }, isCurrent: true }, ...over,
      }),
      bullets: bullets.map((b) => createBullet(b)),
    }],
  }) as ResumeSectionV2

// ------------------------------------------------- section completeness

test('a resume whose visible sections all have content scores full marks', () => {
  const results = scoreDeterministic(base([summary('Six years in a medical ICU.')]))
  const section = find(results, 'section-completeness')
  assert.equal(section.earned, 10)
  assert.ok(section.strengths.length > 0)
})

test('a visible but empty section is named, and costs proportionally', () => {
  const resume = base([summary('Something.'), createSection('awards', 'aw') as ResumeSectionV2])
  const section = find(scoreDeterministic(resume), 'section-completeness')
  assert.equal(section.earned, 5)
  assert.ok(section.weaknesses.some((w) => /empty/i.test(w)))
  assert.ok(section.improvements.some((i) => /hide/i.test(i)), 'hiding is not offered as a fix')
})

test('a HIDDEN empty section costs nothing — hiding is a legitimate choice', () => {
  const hidden = { ...createSection('awards', 'aw'), visible: false } as ResumeSectionV2
  const results = scoreDeterministic(base([summary('Something.'), hidden]))
  assert.equal(find(results, 'section-completeness').earned, 10)
})

test('not having a section is never counted — only leaving one empty is', () => {
  // Two resumes: one with three filled sections, one with a single filled
  // section. Neither is penalised for what it does not contain.
  const many = base([summary('A.'), position(['B.']), { ...createSection('awards', 'aw'), awards: [{ id: 'a', title: 'DAISY', issuer: '', awarded: MAR_2021, detail: createAuthoredText('') }] } as ResumeSectionV2])
  const one = base([summary('A.')])
  assert.equal(find(scoreDeterministic(many), 'section-completeness').earned, 10)
  assert.equal(find(scoreDeterministic(one), 'section-completeness').earned, 10)
})

// ------------------------------------------------- contact completeness

test('name, email, phone and location are worth two points each', () => {
  assert.equal(find(scoreDeterministic(base()), 'contact-completeness').earned, 8)
  const noPhone = base([], { phone: '' })
  assert.equal(find(scoreDeterministic(noPhone), 'contact-completeness').earned, 6)
  const nothing = { ...base(), contact: emptyContact() }
  assert.equal(find(scoreDeterministic(nothing), 'contact-completeness').earned, 0)
})

test('lacking credentials costs nothing at all', () => {
  // The explicit rule: contact completeness scores reachability, not letters
  // after a name.
  const withCredentials = base([], { credentials: 'BSN, RN, CCRN' })
  const without = base([], { credentials: '' })
  assert.equal(
    find(scoreDeterministic(withCredentials), 'contact-completeness').earned,
    find(scoreDeterministic(without), 'contact-completeness').earned
  )
})

test('optional links are not scored either', () => {
  const withLinks = base([], { linkedin: 'linkedin.com/in/x', website: 'example.test' })
  assert.equal(find(scoreDeterministic(withLinks), 'contact-completeness').earned, 8)
  assert.equal(find(scoreDeterministic(base()), 'contact-completeness').earned, 8)
})

// ------------------------------------------------------- date integrity

test('dates are not assessed when none have been entered', () => {
  const result = find(scoreDeterministic(base([summary('A.')])), 'date-integrity')
  assert.equal(result.earned, null, 'a resume with no dates was penalised for having none')
  assert.ok(result.notAssessed)
})

test('clear dates score full marks', () => {
  const result = find(scoreDeterministic(base([position(['A bullet.'])])), 'date-integrity')
  assert.equal(result.earned, 8)
})

test('a range that ends before it starts is a real error', () => {
  const backwards = position(['A.'], { dates: { start: JUN_2023, end: MAR_2021, isCurrent: false } })
  const result = find(scoreDeterministic(base([backwards])), 'date-integrity')
  assert.equal(result.earned, 0)
  assert.ok(result.weaknesses.some((w) => /end before they start/i.test(w)))
})

test('an unparseable date costs half, and keeps the applicant’s own words', () => {
  const vague = position(['A.'], {
    dates: { start: { kind: 'unparsed', raw: 'Spring 2021' }, end: { kind: 'absent' }, isCurrent: true },
  })
  const result = find(scoreDeterministic(base([vague])), 'date-integrity')
  assert.equal(result.earned, 4)
  assert.ok(result.improvements.some((i) => /Spring 2021/.test(i)))
})

test('a missing optional date is not a defect', () => {
  // A certification with no expiry entered: absence is a choice, not an error.
  const certs = {
    ...createSection('certifications', 'ct'),
    certifications: [{ id: 'c', name: 'CCRN', issuer: 'AACN', identifier: '', earned: MAR_2021, expires: { kind: 'absent' as const } }],
  } as ResumeSectionV2
  assert.equal(find(scoreDeterministic(base([certs])), 'date-integrity').earned, 8)
})

// ------------------------------------------------------ content hygiene

test('clean prose scores full marks', () => {
  const result = find(scoreDeterministic(base([position(['One.', 'Two.'])])), 'content-hygiene')
  assert.equal(result.earned, 8)
})

test('an empty bullet is caught — the V1 defect', () => {
  const result = find(scoreDeterministic(base([position(['One.', '  '])])), 'content-hygiene')
  assert.ok((result.earned as number) < 8)
  assert.ok(result.weaknesses.some((w) => /empty/i.test(w)))
})

test('a repeated line is caught and quoted back', () => {
  const result = find(scoreDeterministic(base([position(['Same line.', 'Same line.'])])), 'content-hygiene')
  assert.ok((result.earned as number) < 8)
  assert.ok(result.weaknesses.some((w) => /Same line/.test(w)))
})

test('hygiene is not assessed before anything is written', () => {
  const result = find(scoreDeterministic(base([createSection('summary', 'sm') as ResumeSectionV2])), 'content-hygiene')
  assert.equal(result.earned, null)
})

// -------------------------------------------------------- length and fit

test('a comfortable resume scores full marks', () => {
  assert.equal(find(scoreDeterministic(realisticResume()), 'length-and-fit').earned, 6)
})

test('a thin resume and a comfortable one differ only in how much was written', () => {
  // Not in how much experience they have: the thin one is flagged for having
  // little SAID, and told to add detail to the roles already listed.
  const thin = find(scoreDeterministic(base([summary('Nurse.')])), 'length-and-fit')
  const full = find(scoreDeterministic(realisticResume()), 'length-and-fit')
  assert.ok((thin.earned as number) < (full.earned as number))
})

test('a very thin resume is flagged, and told to add detail — not experience', () => {
  const result = find(scoreDeterministic(base([summary('Nurse.')])), 'length-and-fit')
  assert.ok((result.earned as number) < 6)
  assert.ok(result.improvements.some((i) => /add detail/i.test(i)))
})

test('a long resume is told to tighten, never to remove experience', () => {
  const many = {
    ...createSection('critical_care', 'cc'),
    positions: Array.from({ length: 12 }, (_, i) => ({
      ...createClinicalPosition(`p${i}`, { employer: `Hospital ${i}`, dates: { start: MAR_2021, end: JUN_2023, isCurrent: false } }),
      bullets: Array.from({ length: 6 }, (_, b) =>
        createBullet(`A detailed line ${b} about sustained responsibility for critically ill patients across a long shift.`)),
    })),
  } as ResumeSectionV2
  const result = find(scoreDeterministic(base([many])), 'length-and-fit')
  assert.ok((result.earned as number) < 6)
  const advice = result.improvements.join(' ')
  assert.match(advice, /tighten|shorten|keep every role/i)
  assert.doesNotMatch(advice, /remove (a|your) (job|role|position)/i, 'it told them to delete experience')
})

test('length is not assessed on an empty resume', () => {
  assert.equal(find(scoreDeterministic(base()), 'length-and-fit').earned, null)
})

// ------------------------------------------------- the no-penalty rule

test('no deterministic rule reads a GPA, a certification or an hour count', () => {
  // Asserted against the source, because the guarantee is the absence of a rule
  // rather than the behaviour of one.
  const source = readFileSync(
    fileURLToPath(new URL('./deterministic.ts', import.meta.url)), 'utf8'
  )
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // Narrow on purpose. The layer DOES read certification dates, because date
  // integrity checks the dates someone entered -- that is not a credential
  // penalty, and the behavioural tests below prove it costs nothing. What would
  // be a penalty is reading a GPA value, an hour count, or a credential's
  // presence as a score input. None of those appear.
  for (const forbidden of ['overallGpa', 'scienceGpa', 'showOnResume', '.hours', 'gpa']) {
    assert.equal(
      code.includes(forbidden), false,
      `the deterministic layer consults "${forbidden}"`
    )
  }
})

test('a resume with a GPA scores the same as one without', () => {
  const withGpa = {
    ...createSection('education', 'ed'),
    entries: [{
      id: 'e', degree: 'BSN', field: 'Nursing', institution: 'Rutgers', location: '',
      graduationDate: JUN_2023, overallGpa: parseGpa('3.9', true), scienceGpa: parseGpa('3.8', true), honors: '',
    }],
  } as ResumeSectionV2
  const withoutGpa = {
    ...createSection('education', 'ed'),
    entries: [{
      id: 'e', degree: 'BSN', field: 'Nursing', institution: 'Rutgers', location: '',
      graduationDate: JUN_2023, overallGpa: parseGpa(''), scienceGpa: parseGpa(''), honors: '',
    }],
  } as ResumeSectionV2

  const a = compose({ categories: scoreDeterministic(base([withGpa])), revision: 1, now: NOW })
  const b = compose({ categories: scoreDeterministic(base([withoutGpa])), revision: 1, now: NOW })
  assert.equal(a.dataQuality.points, b.dataQuality.points)
})

test('an otherwise-complete resume reaches full Data Quality with or without certifications', () => {
  const certs = {
    ...createSection('certifications', 'ct'),
    certifications: [{ id: 'c', name: 'CCRN', issuer: 'AACN', identifier: '', earned: MAR_2021, expires: JUN_2023 }],
  } as ResumeSectionV2

  const withCerts = compose({
    categories: scoreDeterministic(realisticResume([certs])), revision: 1, now: NOW,
  })
  const without = compose({ categories: scoreDeterministic(realisticResume()), revision: 1, now: NOW })

  assert.equal(withCerts.dataQuality.points, 40)
  assert.equal(without.dataQuality.points, 40, 'having no certifications capped the score')
})

test('having no certifications never lowers a category’s own marks', () => {
  // The per-category guarantee. Rescaling can move the SUB-SCORE when an
  // excluded category changes the denominator, which is the locked rule
  // working; what must never happen is a category scoring lower because a
  // credential is absent.
  const certs = {
    ...createSection('certifications', 'ct'),
    certifications: [{ id: 'c', name: 'CCRN', issuer: 'AACN', identifier: '', earned: MAR_2021, expires: JUN_2023 }],
  } as ResumeSectionV2
  const withCerts = scoreDeterministic(realisticResume([certs]))
  const without = scoreDeterministic(realisticResume())

  for (const result of without) {
    const other = find(withCerts, result.id)
    if (result.earned === null || other.earned === null) continue
    assert.ok(
      result.earned >= other.earned,
      `${result.id} scored lower without certifications (${result.earned} vs ${other.earned})`
    )
  }
})

// --------------------------------------------------------- the language

test('nothing the deterministic layer says mentions admission', () => {
  const resumes = [base(), base([summary('A.')]), base([position(['One.', '  ', 'One.'])])]
  for (const resume of resumes) {
    for (const result of scoreDeterministic(resume)) {
      for (const line of [...result.strengths, ...result.weaknesses, ...result.improvements, result.notAssessed ?? '']) {
        assert.equal(containsAdmissionsClaim(line), false, `admissions claim: "${line}"`)
      }
    }
  }
})

test('every assessed category explains itself', () => {
  const resume = base([summary('A.'), position(['One.', '  '])])
  for (const result of scoreDeterministic(resume)) {
    const explained =
      result.strengths.length + result.weaknesses.length + result.improvements.length > 0 ||
      result.notAssessed !== undefined
    assert.ok(explained, `${result.id} returned a bare number`)
  }
})

test('scoring is pure — the resume is never touched', () => {
  const resume = base([summary('A.'), position(['One.'])])
  const before = JSON.stringify(resume)
  scoreDeterministic(resume)
  assert.equal(JSON.stringify(resume), before)
})
