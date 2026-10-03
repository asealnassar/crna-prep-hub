import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NO_CONSTRAINTS } from './constraints.ts'
import { UNVERIFIED } from './verification.ts'
import {
  DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, checklist, choiceGroups, isDocumentType, isMultiDocument,
  isMultipart, optionalRequirements, orderedRequirements, requiredComponents,
  requiredDocumentCount, requiredRequirements, requirementById, type RequirementSet,
  type WritingRequirement,
} from './requirement.ts'

function req(over: Partial<WritingRequirement> & { id: string }): WritingRequirement {
  return {
    documentType: 'other',
    label: over.id,
    promptText: 'q',
    components: [],
    constraints: NO_CONSTRAINTS,
    choiceGroup: null,
    optional: false,
    displayOrder: 0,
    notes: [],
    ...over,
  }
}

function set(requirements: readonly WritingRequirement[]): RequirementSet {
  return {
    id: 's', schoolId: 'school', schoolName: 'Test School', applicationCycle: null,
    verification: UNVERIFIED, originalText: '', requirements, notes: [],
  }
}

// -------------------------------------------------- document types

test('every document type has a label', () => {
  for (const type of DOCUMENT_TYPES) {
    assert.equal(typeof DOCUMENT_TYPE_LABELS[type], 'string')
    assert.ok(DOCUMENT_TYPE_LABELS[type].length > 0, type)
  }
  assert.ok(DOCUMENT_TYPES.includes('personal-statement'))
  assert.ok(DOCUMENT_TYPES.includes('goal-statement'))
  assert.ok(DOCUMENT_TYPES.includes('diversity-statement'))
  assert.ok(DOCUMENT_TYPES.includes('writing-sample'))
})

test('an unknown document type is not a document type', () => {
  for (const bad of ['', 'essay', 'Personal-Statement', null, 7, {}]) {
    assert.equal(isDocumentType(bad), false, String(bad))
  }
  assert.equal(isDocumentType('other'), true)
})

// -------------------------------------------------- A QUESTION IS NOT A DOCUMENT

test('CASE A: one prompt, no components', () => {
  const only = req({ id: 'a' })
  assert.equal(isMultipart(only), false)
  assert.deepEqual([...requiredComponents(only)], [])
  assert.equal(isMultiDocument(set([only])), false)
  assert.equal(requiredDocumentCount(set([only])), 1)
})

test('CASE B: several questions INSIDE one document stay one document', () => {
  const multipart = req({
    id: 'b',
    components: [
      { id: 'q1', text: 'one', optional: false },
      { id: 'q2', text: 'two', optional: false },
      { id: 'q3', text: 'three', optional: true },
    ],
  })
  assert.equal(isMultipart(multipart), true)
  // THE DISTINCTION: three questions, ONE document, ONE draft.
  assert.equal(requiredDocumentCount(set([multipart])), 1)
  assert.equal(isMultiDocument(set([multipart])), false)
  assert.equal(checklist(set([multipart])).length, 1)
  // And the optional question is excluded from what must be answered.
  assert.deepEqual(requiredComponents(multipart).map((c) => c.id), ['q1', 'q2'])
})

test('CASE C: several documents are several documents', () => {
  const three = set([req({ id: 'c1', displayOrder: 0 }), req({ id: 'c2', displayOrder: 1 }), req({ id: 'c3', displayOrder: 2 })])
  assert.equal(requiredDocumentCount(three), 3)
  assert.equal(isMultiDocument(three), true)
  assert.equal(checklist(three).length, 3)
  for (const entry of checklist(three)) assert.equal(entry.kind, 'document')
})

test('CASE D: alternatives collapse to ONE checklist entry', () => {
  const choice = set([
    req({ id: 'd1', choiceGroup: 'g', displayOrder: 0 }),
    req({ id: 'd2', choiceGroup: 'g', displayOrder: 1 }),
  ])
  const entries = checklist(choice)
  assert.equal(entries.length, 1, 'choose one of two is ONE item on a to-do list')
  assert.equal(entries[0]!.kind, 'choice')
  assert.equal(requiredDocumentCount(choice), 1, 'the applicant writes one of them')
  const groups = choiceGroups(choice)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]!.options.map((o) => o.id), ['d1', 'd2'])
})

test('CASE D+C: a choice plus a required extra is TWO entries, not three', () => {
  const siue = set([
    req({ id: 'opt1', choiceGroup: 'g', displayOrder: 0 }),
    req({ id: 'opt2', choiceGroup: 'g', displayOrder: 1 }),
    req({ id: 'extra', displayOrder: 2 }),
  ])
  const entries = checklist(siue)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((e) => e.kind), ['choice', 'document'])
  assert.equal(requiredDocumentCount(siue), 2)
})

test('CASE E: an optional supplement is required by nothing', () => {
  const withOptional = set([
    req({ id: 'required', displayOrder: 0 }),
    req({ id: 'supplement', optional: true, displayOrder: 1 }),
  ])
  assert.deepEqual(requiredRequirements(withOptional).map((r) => r.id), ['required'])
  assert.deepEqual(optionalRequirements(withOptional).map((r) => r.id), ['supplement'])
  assert.equal(requiredDocumentCount(withOptional), 1)
  // It is still ON the checklist -- the applicant may choose to write it.
  assert.equal(checklist(withOptional).length, 2)
})

test('an all-optional choice group is an optional entry', () => {
  const optionalChoice = set([
    req({ id: 'o1', choiceGroup: 'g', optional: true, displayOrder: 0 }),
    req({ id: 'o2', choiceGroup: 'g', optional: true, displayOrder: 1 }),
  ])
  const entry = checklist(optionalChoice)[0]!
  assert.equal(entry.kind, 'choice')
  assert.equal(entry.kind === 'choice' && entry.optional, true)
  assert.equal(requiredDocumentCount(optionalChoice), 0)
})

test('a choice group of ONE stays a choice, and does not become a requirement', () => {
  // Research that recorded one alternative and not the other. Promoting it
  // would invent a requirement the school did not state.
  const lonely = set([req({ id: 'only', choiceGroup: 'g' })])
  const entry = checklist(lonely)[0]!
  assert.equal(entry.kind, 'choice')
  assert.equal(entry.kind === 'choice' && entry.group.options.length, 1)
})

// -------------------------------------------------- ordering and lookup

test('ordering is display order, then label, and is stable', () => {
  const unordered = set([
    req({ id: 'c', label: 'C', displayOrder: 2 }),
    req({ id: 'a2', label: 'A2', displayOrder: 0 }),
    req({ id: 'a1', label: 'A1', displayOrder: 0 }),
    req({ id: 'b', label: 'B', displayOrder: 1 }),
  ])
  assert.deepEqual(orderedRequirements(unordered).map((r) => r.id), ['a1', 'a2', 'b', 'c'])
  // Called twice, same answer: nothing mutates the set.
  assert.deepEqual(orderedRequirements(unordered).map((r) => r.id), ['a1', 'a2', 'b', 'c'])
})

test('orderedRequirements does not mutate the set', () => {
  const original = set([req({ id: 'z', displayOrder: 9 }), req({ id: 'a', displayOrder: 0 })])
  orderedRequirements(original)
  assert.deepEqual(original.requirements.map((r) => r.id), ['z', 'a'])
})

test('a requirement is found by id, including an unchosen alternative', () => {
  const choice = set([
    req({ id: 'picked', choiceGroup: 'g' }),
    req({ id: 'unpicked', choiceGroup: 'g' }),
  ])
  assert.equal(requirementById(choice, 'unpicked')?.id, 'unpicked')
  assert.equal(requirementById(choice, 'absent'), null)
})

test('an empty set has no documents and no checklist', () => {
  assert.equal(requiredDocumentCount(set([])), 0)
  assert.deepEqual([...checklist(set([]))], [])
  assert.equal(isMultiDocument(set([])), false)
})
