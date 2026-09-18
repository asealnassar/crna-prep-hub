import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMON_CERTIFICATIONS, alreadyHasCertification, certificationsToAdd,
  normaliseCertificationName,
} from './certifications.ts'
import { blankEntry, descriptorFor } from './fields.ts'

/**
 * The certification picker.
 *
 * A LIST, NOT A CLAIM. Nothing here asserts that anyone holds anything, and
 * nothing here fills in a fact the applicant has not given.
 */

test('the certifications the brief names are all offered', () => {
  const names = COMMON_CERTIFICATIONS.map((c) => c.name)
  for (const expected of ['CCRN', 'CMC', 'CSC', 'BLS', 'ACLS', 'PALS', 'NRP', 'TNCC', 'TCRN']) {
    assert.ok(names.includes(expected), `${expected} is not offered`)
  }
})

test('each one is told apart from the others', () => {
  for (const certification of COMMON_CERTIFICATIONS) {
    assert.notEqual(certification.note.trim(), '', `${certification.name} has nothing to tell it apart`)
  }
  assert.equal(new Set(COMMON_CERTIFICATIONS.map((c) => c.id)).size, COMMON_CERTIFICATIONS.length)
  assert.equal(new Set(COMMON_CERTIFICATIONS.map((c) => c.name)).size, COMMON_CERTIFICATIONS.length)
})

test('the catalogue claims no issuer, number or date', () => {
  // Those are facts only the applicant has. A pre-filled issuer would be the
  // product inventing a credential detail.
  for (const certification of COMMON_CERTIFICATIONS) {
    assert.deepEqual(Object.keys(certification).sort(), ['id', 'name', 'note'])
  }
})

test('what is added is an empty entry with a name', () => {
  const entry = blankEntry('certifications', 'c1')
  assert.equal(entry.name, '')
  assert.equal(entry.issuer, '')
  assert.equal(entry.identifier, '')
  assert.deepEqual(entry.earned, { kind: 'absent' })
  assert.deepEqual(entry.expires, { kind: 'absent' })
})

test('the field the picker fills is a real certification field', () => {
  const fields = descriptorFor('certifications').entry!.fields.map((f) => f.name)
  assert.ok(fields.includes('name'), 'the picker writes a field the descriptor does not declare')
})

test('spelling variants of one credential are one credential', () => {
  assert.equal(normaliseCertificationName('CCRN'), normaliseCertificationName('ccrn'))
  assert.equal(normaliseCertificationName('C.C.R.N.'), normaliseCertificationName('CCRN'))
  assert.equal(normaliseCertificationName(' CCRN '), normaliseCertificationName('CCRN'))
  assert.notEqual(normaliseCertificationName('CCRN'), normaliseCertificationName('CMC'))
})

test('a certification they already have is not added twice', () => {
  const existing = [{ name: 'ccrn' }, { name: 'ACLS' }]
  assert.equal(alreadyHasCertification(existing, 'CCRN'), true)
  assert.equal(alreadyHasCertification(existing, 'BLS'), false)
  assert.deepEqual(certificationsToAdd(existing, ['CCRN', 'BLS', 'ACLS']), ['BLS'])
})

test('ticking the same thing twice adds it once', () => {
  assert.deepEqual(certificationsToAdd([], ['BLS', 'bls', 'B.L.S.']), ['BLS'])
})

test('a blank custom entry adds nothing', () => {
  assert.deepEqual(certificationsToAdd([], ['', '   ', '...']), [])
})

test('the applicant’s own spelling is what gets stored', () => {
  assert.deepEqual(certificationsToAdd([], ['  CNRN  ']), ['CNRN'])
})

test('an empty existing list is not an error', () => {
  assert.equal(alreadyHasCertification([], 'CCRN'), false)
  assert.deepEqual(certificationsToAdd([], ['CCRN', 'CMC']), ['CCRN', 'CMC'])
})

test('selection order is kept, so what appears is what they read', () => {
  assert.deepEqual(certificationsToAdd([], ['TNCC', 'BLS', 'CCRN']), ['TNCC', 'BLS', 'CCRN'])
})
