import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UNVERIFIED, VERIFICATION_LABELS, VERIFICATION_NOTICES, activatableForApplicants, isIsoDate,
  needsVerificationWarning, textAttribution, type Verification, type VerificationStatus,
} from './verification.ts'

const STATUSES: readonly VerificationStatus[] = ['unverified', 'needs-review', 'verified', 'conflicting']

test('the default is "we do not know"', () => {
  assert.equal(UNVERIFIED.status, 'unverified')
  assert.equal(UNVERIFIED.sourceUrl, null)
  assert.equal(UNVERIFIED.verifiedOn, null)
  assert.equal(UNVERIFIED.verbatim, false)
  assert.equal(activatableForApplicants(UNVERIFIED), false)
})

test('ONLY a verified entry with a source AND a date may be activated', () => {
  const full: Verification = {
    status: 'verified', sourceUrl: 'https://example.edu/crna', verifiedOn: '2026-10-02', verbatim: true,
  }
  assert.equal(activatableForApplicants(full), true)
  // Each missing piece alone is disqualifying -- a status is not evidence.
  assert.equal(activatableForApplicants({ ...full, sourceUrl: null }), false)
  assert.equal(activatableForApplicants({ ...full, sourceUrl: '' }), false)
  assert.equal(activatableForApplicants({ ...full, verifiedOn: null }), false)
  assert.equal(activatableForApplicants({ ...full, status: 'unverified' }), false)
  assert.equal(activatableForApplicants({ ...full, status: 'needs-review' }), false)
  assert.equal(activatableForApplicants({ ...full, status: 'conflicting' }), false)
})

test('a conflicting entry is never activatable, however complete', () => {
  assert.equal(activatableForApplicants({
    status: 'conflicting', sourceUrl: 'https://example.edu', verifiedOn: '2026-10-02', verbatim: true,
  }), false)
})

test('a malformed date is not a date', () => {
  for (const bad of ['2026-10-2', '10-02-2026', '2026/10/02', '2026-13-01', '2026-02-30', '', 'today', null, 20261002]) {
    assert.equal(isIsoDate(bad), false, String(bad))
  }
  assert.equal(isIsoDate('2026-10-02'), true)
  assert.equal(isIsoDate('2026-02-29'), false, '2026 is not a leap year')
  assert.equal(isIsoDate('2024-02-29'), true, '2024 is')
})

test('a malformed date blocks activation', () => {
  assert.equal(activatableForApplicants({
    status: 'verified', sourceUrl: 'https://example.edu', verifiedOn: '2026-13-45', verbatim: true,
  }), false)
})

test('VERBATIM IS A SEPARATE FACT FROM VERIFIED', () => {
  // A quotation nobody has checked, and a checked paraphrase. Both are possible.
  const quotedUnchecked: Verification = { ...UNVERIFIED, verbatim: true }
  assert.equal(activatableForApplicants(quotedUnchecked), false)
  assert.match(textAttribution(quotedUnchecked), /Quoted from/)

  const checkedParaphrase: Verification = {
    status: 'verified', sourceUrl: 'https://example.edu', verifiedOn: '2026-10-02', verbatim: false,
  }
  assert.equal(activatableForApplicants(checkedParaphrase), true)
  assert.match(textAttribution(checkedParaphrase), /summary of published requirements/)
  // NOT a word-absence check: "exact wording" appears in this string inside the
  // negation "not the school's exact wording", which is the correct sentence.
  // What must be absent is the CLAIM, so the affirmative openings are what is
  // asserted against.
  assert.doesNotMatch(textAttribution(checkedParaphrase), /^Quoted|\bis verbatim\b/)
})

test('a paraphrase is NEVER described as the school’s words', () => {
  const attribution = textAttribution({ ...UNVERIFIED, verbatim: false })
  assert.doesNotMatch(attribution, /verbatim|quoted|exactly as/i)
  assert.match(attribution, /not the school’s exact wording/)
})

test('every status has a label and an applicant-facing notice', () => {
  for (const status of STATUSES) {
    assert.equal(typeof VERIFICATION_LABELS[status], 'string')
    assert.ok(VERIFICATION_LABELS[status].length > 0, status)
    const notice = VERIFICATION_NOTICES[status]
    assert.ok(notice.length > 0, status)
    // Each one sends the reader to their own materials, which is the only
    // source that is authoritative for them.
    assert.match(notice, /application materials|Confirm|confirm/, status)
  }
})

test('the unverified notice does not read as an endorsement', () => {
  const notice = VERIFICATION_NOTICES.unverified
  assert.match(notice, /has not been verified/)
  // Again the negation contains the word: "not been verified against the
  // school's OFFICIAL materials" is right. Affirmative claims are what is barred.
  assert.doesNotMatch(notice, /\bis official\b|\bhas been (?:verified|confirmed)\b|\bis accurate\b/i)
  assert.match(notice, /confirm the current requirements yourself/)
})

test('the conflicting notice says both readings are shown', () => {
  assert.match(VERIFICATION_NOTICES.conflicting, /disagree/)
  assert.match(VERIFICATION_NOTICES.conflicting, /[Bb]oth readings/)
})

test('a warning is needed for everything that is not activatable', () => {
  for (const status of STATUSES) {
    const v: Verification = { status, sourceUrl: null, verifiedOn: null, verbatim: false }
    assert.equal(needsVerificationWarning(v), !activatableForApplicants(v), status)
  }
})
