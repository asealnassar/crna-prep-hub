import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAX_CONFIRM_TEXT, hasSomethingToCreate, parseConfirmRequest, toReviewPayload,
} from './review.ts'
import { buildImportPlan } from './organise.ts'
import type { OrganisedResume } from './organise.ts'
import { sourceFromText } from './source.ts'

/**
 * Analyse → review → explicit create.
 *
 * The two guarantees that cannot be reached from a unit test on their own --
 * that analysis creates nothing, and that confirmation makes no second model
 * call -- are asserted against the route source, because both are properties of
 * where code is rather than of what it returns.
 */

const IMPORT_ID = '11111111-1111-4111-8111-111111111111'
const RESUME = `Jordan Ellery
jordan.ellery@example.test
EXPERIENCE
University Hospital — Registered Nurse
Titrated vasoactive infusions overnight.
LEFTOVER LINE NOBODY PLACED`
const source = () => sourceFromText(RESUME, 'paste')

const organised = (over: Partial<OrganisedResume> = {}): OrganisedResume => ({
  contact: { fullName: 'Jordan Ellery', credentials: '', email: 'jordan.ellery@example.test', phone: '', city: '', state: '' },
  summary: '',
  positions: [{
    employer: 'University Hospital', role: 'Registered Nurse', unit: '', location: '',
    dates: '', bullets: ['Titrated vasoactive infusions overnight.'],
  }],
  education: [], certifications: [], licenses: [], entries: [],
  unmapped: ['LEFTOVER LINE NOBODY PLACED'],
  ...over,
})

const payload = (over: Partial<OrganisedResume> = {}) =>
  toReviewPayload(buildImportPlan(organised(over), source()), source(), IMPORT_ID)

// -------------------------------------------- the payload is sanitised

test('a value the verifier discarded never reaches the client', () => {
  const withLies = payload({
    positions: [{
      employer: 'Johns Hopkins Hospital', role: 'Registered Nurse', unit: '', location: '',
      dates: '', bullets: ['Ran ECMO circuits for eight years.'],
    }],
    certifications: [{ name: 'CRNA', issuer: 'AANA' }],
  })

  const whole = JSON.stringify(withLies)
  for (const fabrication of ['Johns Hopkins', 'ECMO', 'CRNA', 'AANA']) {
    assert.equal(whole.includes(fabrication), false, `"${fabrication}" reached the review payload`)
  }
  assert.ok(withLies.discarded >= 4, 'discarded values were not counted')
})

test('the payload carries the filtered plan, not the model’s reply', () => {
  const withLies = payload({
    positions: [{
      employer: 'Johns Hopkins Hospital', role: 'Registered Nurse', unit: '', location: '',
      dates: '', bullets: [],
    }],
  })
  assert.equal(withLies.organised.positions[0].employer, '', 'an invented employer survived')
})

test('verified mappings are listed in full, not counted', () => {
  const review = payload()
  assert.ok(review.mapped.length > 0)
  assert.ok(review.mapped.every((m) => m.path !== '' && m.value !== ''))
  assert.ok(review.mapped.some((m) => m.value === 'University Hospital'))
})

test('source-backed uncertain mappings are visible, with their values', () => {
  const loose = payload({
    positions: [{
      employer: 'University Hospital Registered Nurse', role: '', unit: '', location: '',
      dates: '', bullets: [],
    }],
  })
  assert.equal(loose.uncertain.length, 1)
  assert.equal(loose.uncertain[0].value, 'University Hospital Registered Nurse')
  assert.notEqual(loose.uncertain[0].path, '')
})

test('unplaced lines are returned so the applicant can see them', () => {
  assert.ok(payload().unmapped.includes('LEFTOVER LINE NOBODY PLACED'))
})

test('discarded values are a count and nothing else', () => {
  const review = payload({ licenses: [{ licenseType: 'APRN', state: 'Texas' }] })
  assert.equal(typeof review.discarded, 'number')
  assert.equal('rejected' in review, false, 'the rejected values themselves are exposed')
})

test('the payload carries what confirmation needs and no more', () => {
  const review = payload()
  assert.deepEqual(
    Object.keys(review).sort(),
    ['discarded', 'importId', 'mapped', 'organised', 'source', 'unmapped', 'uncertain'].sort()
  )
  assert.equal(review.source.text, source().text)
  assert.equal(review.source.fingerprint, source().fingerprint)
})

test('an import that traced nothing is not worth creating', () => {
  const nothing = payload({
    contact: { fullName: 'Someone Else', credentials: '', email: '', phone: '', city: '', state: '' },
    positions: [], unmapped: [],
  })
  assert.equal(hasSomethingToCreate(nothing), false)
  assert.equal(hasSomethingToCreate(payload()), true)
})

// ------------------------------------------------ confirmation shape

test('a confirmation needs an id, the source and a reviewed plan', () => {
  const good = {
    importId: IMPORT_ID, sourceText: RESUME, format: 'paste', organised: organised(),
  }
  assert.equal(parseConfirmRequest(good).ok, true)
  for (const bad of [
    { ...good, importId: 'nope' },
    { ...good, sourceText: '' },
    { ...good, sourceText: 'x'.repeat(MAX_CONFIRM_TEXT + 1) },
    { ...good, format: 'rtf' },
    { ...good, organised: 'nope' },
    { ...good, organised: null },
    null, [], 'create',
  ]) {
    assert.equal(parseConfirmRequest(bad).ok, false, JSON.stringify(bad)?.slice(0, 50) ?? 'null')
  }
})

test('confirmation re-traces, so a tampered plan gains nothing', () => {
  // The client could send anything back. It is traced again against the source,
  // and anything not in the document is dropped exactly as it was the first
  // time -- which is why the round trip needs nothing persisted.
  const tampered = organised({
    positions: [{
      employer: 'Johns Hopkins Hospital', role: 'Chief Nurse Anesthetist', unit: '',
      location: '', dates: '', bullets: ['Performed 500 anaesthetics independently.'],
    }],
  })
  const plan = buildImportPlan(tampered, source())
  assert.equal(plan.organised.positions[0].employer, '')
  assert.equal(plan.organised.positions[0].role, '')
  assert.deepEqual(plan.organised.positions[0].bullets, [])
  assert.equal(plan.rejected.length, 3)
})

// ------------------------------------------- the route's own shape

const ROUTE = readFileSync(
  fileURLToPath(new URL('../../../app/api/resume-v2/import/route.ts', import.meta.url)), 'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Imports stripped: a name appears at the top of the file long before it is
 *  called, and counting call sites has to count calls. */
const BODY = ROUTE.replace(/^import[\s\S]*?from\s+'[^']+'\s*$/gm, '')

test('analysis creates nothing and consumes no slot', () => {
  const analyse = ROUTE.slice(ROUTE.indexOf('async function analyseImport'), ROUTE.indexOf('async function confirmImport'))
  assert.equal(analyse.includes('createResumeRows'), false, 'analysis creates a resume')
  assert.equal(analyse.includes('draftFromPlan'), false, 'analysis builds a draft')
  assert.ok(analyse.includes('toReviewPayload'), 'analysis returns no review')
})

test('analysis still checks the limit before spending anything', () => {
  const analyse = ROUTE.slice(ROUTE.indexOf('async function analyseImport'), ROUTE.indexOf('async function confirmImport'))
  const limit = analyse.indexOf('roomForAnother')
  assert.ok(limit >= 0)
  for (const later of ['extractSource', 'openai.chat.completions.create', 'buildImportPlan']) {
    assert.ok(analyse.indexOf(later) > limit, `${later} runs before the limit check`)
  }
})

test('creation re-checks the limit and re-verifies, with no second model call', () => {
  const confirm = ROUTE.slice(ROUTE.indexOf('async function confirmImport'), ROUTE.indexOf('async function roomForAnother'))
  assert.ok(confirm.includes('roomForAnother'), 'the limit is not re-checked on confirmation')
  assert.ok(confirm.includes('buildImportPlan'), 'the plan is not re-traced on confirmation')
  assert.equal(confirm.includes('openai'), false, 'confirmation calls the model again')
  assert.ok(confirm.indexOf('roomForAnother') < confirm.indexOf('createResumeRows'))
  assert.ok(confirm.indexOf('buildImportPlan') < confirm.indexOf('createResumeRows'))
})

test('confirmation is idempotent — a retry returns the resume already made', () => {
  const confirm = ROUTE.slice(ROUTE.indexOf('async function confirmImport'), ROUTE.indexOf('async function roomForAnother'))
  const check = confirm.indexOf("ledger.outcome === 'created'")
  assert.ok(check >= 0, 'a double submission would create a second resume')
  assert.ok(check < confirm.indexOf('createResumeRows'), 'the idempotency check runs too late')
  assert.ok(confirm.includes('alreadyCreated'))
})

test('the importId must belong to the caller', () => {
  const read = ROUTE.slice(ROUTE.indexOf('async function readImport'))
  assert.match(read, /\.eq\('user_id', userId\)/)
  assert.match(read, /\.eq\('id', importId\)/)
})

test('only creation is a create path', () => {
  assert.equal((BODY.match(/createResumeRows\(/g) ?? []).length, 1)
})

test('the client is offered Cancel, and cancelling calls nothing', () => {
  const tile = readFileSync(
    fileURLToPath(new URL('../../../app/resume-studio/components/import/UploadTile.tsx', import.meta.url)), 'utf8'
  )
  assert.match(tile, /onCancel=\{\(\) => setState\(\{ kind: 'idle' \}\)\}/)
  const ui = readFileSync(
    fileURLToPath(new URL('../../../app/resume-studio/components/import/ImportReview.tsx', import.meta.url)), 'utf8'
  )
  assert.ok(ui.includes('Cancel'), 'there is no way to back out')
  assert.ok(ui.includes('Create this resume'), 'there is no explicit confirmation')
  // Uncertain mappings are listed, not counted.
  assert.match(ui, /review\.uncertain\.map/)
  assert.match(ui, /review\.mapped\.map/)
})
