import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SECTION_DESCRIPTORS, blankEntry, descriptorFor } from '../studio/fields.ts'
import { factSheetForEntryField } from './factSheet.ts'
import { applyPatches } from '../studio/patch.ts'
import type { StudioPatch } from '../studio/patch.ts'
import { parsePatch } from '../studio/parse.ts'
import { createSection } from '../model/sections.ts'
import { createResume } from '../model/resume.ts'
import { SECTION_TYPES } from '../model/types.ts'
import type { ResumeSectionType, ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * Who gets AI, and who does not.
 *
 * ONE RULE DECIDES IT: a field the descriptor calls 'authored' is narrative and
 * may be written with help; everything else is a fact the applicant supplied,
 * and an assistant that offered to rewrite a licence number would be offering
 * to invent one. These tests assert that rule holds in all four places it has
 * to -- grounding, the patch layer, the request parser and the editor -- so a
 * new section type is covered, or correctly excluded, the moment it is declared.
 */

const NOW = '2026-09-10T12:00:00.000Z'
const SEC = '11111111-1111-4111-8111-111111111111'
const ENTRY = '22222222-2222-4222-8222-222222222222'

/** Every section type that holds a list of entries. */
const ENTRY_SECTIONS = SECTION_TYPES.filter((type) => Boolean(descriptorFor(type).entry))

function sectionWithEntry(type: ResumeSectionType): ResumeSectionV2 {
  const descriptor = descriptorFor(type).entry!
  const entry = blankEntry(type, ENTRY)
  // Give it one factual value so the sheet has something to ground with.
  const firstText = descriptor.fields.find((f) => f.kind === 'text')
  if (firstText) entry[firstText.name] = 'A supplied value'
  return {
    ...(createSection(type, SEC) as unknown as Record<string, unknown>),
    [descriptor.listKey]: [entry],
  } as unknown as ResumeSectionV2
}

function resumeWith(section: ResumeSectionV2): ResumeV2 {
  const base = createResume({
    id: '99999999-9999-4999-8999-999999999999', userId: 'u1', title: 'T',
    sectionIds: Array.from({ length: 20 }, (_, i) => `s${i}`), now: NOW,
  })
  return { ...base, sections: [section] }
}

// ------------------------------------------------- what must be covered

test('every narrative field the model has can be written with help', () => {
  const covered: string[] = []
  for (const type of ENTRY_SECTIONS) {
    const section = sectionWithEntry(type)
    for (const field of descriptorFor(type).entry!.fields) {
      if (field.kind !== 'authored') continue
      const sheet = factSheetForEntryField(section, ENTRY, field.name)
      assert.ok(sheet, `${type}.${field.name} has no grounding, so it can never be written`)
      assert.equal(sheet!.subject, `${type}/${ENTRY}/${field.name}`)
      covered.push(`${type}.${field.name}`)
    }
  }
  assert.ok(covered.length >= 8, `only ${covered.length} narrative fields found`)
})

test('the sections named in the brief are all covered', () => {
  // Leadership / precepting, quality improvement, research, shadowing,
  // volunteering, awards, publications, custom -- plus clinical bullets and the
  // summary, which are handled by their own editors.
  const required: ResumeSectionType[] = [
    'leadership', 'quality_improvement', 'research', 'shadowing',
    'volunteer', 'awards', 'publications', 'custom',
  ]
  for (const type of required) {
    const authored = descriptorFor(type).entry?.fields.filter((f) => f.kind === 'authored') ?? []
    assert.ok(authored.length > 0, `${type} declares no narrative field`)
    const section = sectionWithEntry(type)
    for (const field of authored) {
      assert.ok(factSheetForEntryField(section, ENTRY, field.name), `${type}.${field.name}`)
    }
  }
})

test('both clinical sections are written through the positions editor', () => {
  // other_clinical shares critical_care's shape, so its bullets are covered by
  // the same path rather than by a second one.
  for (const type of ['critical_care', 'other_clinical'] as const) {
    assert.equal(descriptorFor(type).shape, 'positions', `${type} is not a positions section`)
  }
  const editor = readFileSync(
    fileURLToPath(new URL('../../../app/resume-studio/components/sections/SectionEditor.tsx', import.meta.url)),
    'utf8'
  )
  assert.match(editor, /section\.type === 'critical_care' \|\| section\.type === 'other_clinical'/)
})

// ------------------------------------------- what must NOT be covered

test('a factual field is never grounded for writing', () => {
  for (const type of ENTRY_SECTIONS) {
    const section = sectionWithEntry(type)
    for (const field of descriptorFor(type).entry!.fields) {
      if (field.kind === 'authored') continue
      assert.equal(
        factSheetForEntryField(section, ENTRY, field.name), null,
        `${type}.${field.name} (${field.kind}) was offered grounding to be rewritten`
      )
    }
  }
})

test('the identity fields named in the brief are all factual', () => {
  // Names, dates, institutions, certification names, licence numbers.
  const mustBeFactual: [ResumeSectionType, string][] = [
    ['education', 'institution'], ['education', 'degree'], ['education', 'graduationDate'],
    ['education', 'overallGpa'],
    ['licensure', 'licenseType'], ['licensure', 'identifier'], ['licensure', 'state'],
    ['licensure', 'expires'],
    ['certifications', 'name'], ['certifications', 'identifier'], ['certifications', 'issuer'],
    ['organizations', 'organization'],
    ['shadowing', 'providerName'], ['shadowing', 'hours'], ['shadowing', 'dates'],
    ['awards', 'title'], ['awards', 'awarded'],
    ['publications', 'title'], ['publications', 'venue'], ['publications', 'date'],
    ['leadership', 'role'], ['leadership', 'organization'],
  ]
  for (const [type, name] of mustBeFactual) {
    const field = descriptorFor(type).entry?.fields.find((f) => f.name === name)
    assert.ok(field, `${type}.${name} is not a field any more`)
    assert.notEqual(field!.kind, 'authored', `${type}.${name} would be offered AI writing`)
    assert.equal(factSheetForEntryField(sectionWithEntry(type), ENTRY, name), null, `${type}.${name}`)
  }
})

test('three sections are entirely factual and get no AI at all', () => {
  for (const type of ['education', 'licensure', 'certifications', 'organizations'] as const) {
    const authored = descriptorFor(type).entry!.fields.filter((f) => f.kind === 'authored')
    assert.deepEqual(authored, [], `${type} has a narrative field that is not wired`)
  }
})

// ------------------------------------- the rule holds in the patch layer

test('an accept into a factual field does nothing', () => {
  for (const [type, name] of [
    ['education', 'institution'], ['licensure', 'identifier'], ['certifications', 'name'],
  ] as [ResumeSectionType, string][]) {
    const resume = resumeWith(sectionWithEntry(type))
    const patch = {
      op: 'ai-accept-field', sectionId: SEC, entryId: ENTRY, field: name,
      text: 'Rewritten by an assistant.', model: 'gpt-4o', groundedIn: [],
    } as StudioPatch
    assert.equal(applyPatches(resume, [patch], { now: NOW }), resume, `${type}.${name} was rewritten`)
  }
})

test('an accept into a narrative field does apply', () => {
  const resume = resumeWith(sectionWithEntry('leadership'))
  const after = applyPatches(resume, [{
    op: 'ai-accept-field', sectionId: SEC, entryId: ENTRY, field: 'detail',
    text: 'Coordinated the unit through a difficult winter.', model: 'gpt-4o', groundedIn: [],
  }], { now: NOW })
  assert.notEqual(after, resume)
  const entries = (after.sections[0] as unknown as { entries: Record<string, { accepted: string; origin: string }>[] }).entries
  assert.equal(entries[0].detail.accepted, 'Coordinated the unit through a difficult winter.')
  assert.equal(entries[0].detail.origin, 'ai-accepted', 'the text claims to be the applicant’s')
})

test('accepted AI text never becomes grounding', () => {
  const resume = resumeWith(sectionWithEntry('leadership'))
  const after = applyPatches(resume, [{
    op: 'ai-accept-field', sectionId: SEC, entryId: ENTRY, field: 'detail',
    text: 'Led a team of twelve.', model: 'gpt-4o', groundedIn: [],
  }], { now: NOW })
  const sheet = factSheetForEntryField(after.sections[0], ENTRY, 'detail')
  assert.ok(sheet)
  assert.equal(
    sheet!.facts.some((f) => f.value.includes('Led a team of twelve')), false,
    'an accepted proposal came back as a fact on the next call'
  )
})

// --------------------------------------- the rule holds at the boundary

test('the parser refuses an AI patch aimed at a factual field', () => {
  const good = {
    op: 'ai-accept-field', sectionId: SEC, entryId: ENTRY, field: 'detail',
    text: 'x', model: 'gpt-4o', groundedIn: [],
  }
  assert.notEqual(parsePatch(good, () => 'leadership'), null)
  for (const field of ['role', 'organization', 'dates', 'id', 'user_id', '__proto__']) {
    assert.equal(
      parsePatch({ ...good, field }, () => 'leadership'), null,
      `a proposal aimed at "${field}" was accepted`
    )
  }
})

test('a restore aimed at a factual field is refused too', () => {
  const base = { op: 'ai-restore-field', sectionId: SEC, entryId: ENTRY, scope: 'user' }
  assert.notEqual(parsePatch({ ...base, field: 'detail' }, () => 'leadership'), null)
  assert.equal(parsePatch({ ...base, field: 'organization' }, () => 'leadership'), null)
})

// ------------------------------------------ the rule holds in the editor

test('the editor offers AI on narrative fields and on nothing else', () => {
  const editor = readFileSync(
    fileURLToPath(new URL('../../../app/resume-studio/components/sections/SectionEditor.tsx', import.meta.url)),
    'utf8'
  )
  const code = editor.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  assert.ok(code.includes('<AiAssist'), 'the entries editor offers no AI at all')
  // Guarded by the descriptor, not by a list of section names.
  assert.match(code, /field\.kind === 'authored' && \(\s*<AiAssist/)
  for (const type of ENTRY_SECTIONS) {
    assert.equal(
      new RegExp(`'${type}'[^\\n]*AiAssist`).test(code), false,
      `the editor special-cases ${type} instead of reading the descriptor`
    )
  }
})

test('every section type is reachable by the generic editor or a bespoke one', () => {
  for (const type of SECTION_TYPES) {
    const shape = descriptorFor(type).shape
    assert.ok(['prose', 'entries', 'positions'].includes(shape), `${type} has no editor shape`)
  }
  assert.equal(Object.keys(SECTION_DESCRIPTORS).length, SECTION_TYPES.length)
})
