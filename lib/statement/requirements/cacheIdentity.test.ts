import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { analysisFingerprint } from '../draft/analysisFingerprint.ts'
import { RUBRIC_VERSION } from '../draft/rubric.ts'
import { REVIEW_SCHEMA_VERSION } from '../draft/reviewSchema.ts'
import { parseRequirementSnapshot, snapshotFromLegacy, snapshotOf } from './snapshot.ts'
import { ALBANY, BUFFALO, MINNESOTA, SIUE, UC_DAVIS, WAYNE_STATE } from './fixtures.ts'
import { ENFORCEMENTS } from './constraints.ts'
import { requirementDigest } from './digest.ts'
import { characterLimit, pageLimit, wordLimit } from './constraints.ts'

const LEGACY = {
  essay: 'My statement about becoming a nurse anesthetist.',
  promptText: 'Describe your professional goals.',
  schoolId: '11111111-1111-4111-8111-111111111111',
  promptId: '22222222-2222-4222-8222-222222222222',
  statedMaxWords: 1000,
}

// ===================================================== backward compatibility

test('AN OLD DRAFT’S FINGERPRINT IS BYTE-IDENTICAL TO THE PRE-REQUIREMENT ONE', () => {
  // Recomputed here from the documented field order, independently of the
  // module, so this is a pin on the value and not a tautology.
  const expected = createHash('sha256').update([
    RUBRIC_VERSION,
    REVIEW_SCHEMA_VERSION,
    LEGACY.essay,
    LEGACY.promptText,
    LEGACY.schoolId,
    LEGACY.promptId,
    String(LEGACY.statedMaxWords),
  ].join('\u0000\u0001'), 'utf8').digest('hex')

  assert.equal(analysisFingerprint(LEGACY), expected)
  // Omitted, explicitly null, and explicitly undefined all mean the same thing.
  assert.equal(analysisFingerprint({ ...LEGACY, requirement: null }), expected)
  assert.equal(analysisFingerprint({ ...LEGACY, requirement: undefined }), expected)
})

test('a general statement’s fingerprint is unchanged too', () => {
  const general = {
    essay: 'A general statement.', promptText: null, schoolId: null, promptId: null,
    statedMaxWords: null,
  }
  const expected = createHash('sha256').update([
    RUBRIC_VERSION, REVIEW_SCHEMA_VERSION, general.essay,
    '\u0000null', '\u0000null', '\u0000null', '\u0000null',
  ].join('\u0000\u0001'), 'utf8').digest('hex')
  assert.equal(analysisFingerprint(general), expected)
})

test('A LEGACY-PROJECTED SNAPSHOT IS NOT THE SAME AS NO SNAPSHOT', () => {
  // The documented hazard: snapshotFromLegacy() produces a real snapshot for an
  // old draft, and passing it here WOULD change the fingerprint. This test
  // records that difference so the route's choice to omit it is deliberate and
  // visible rather than an accident waiting to be "fixed".
  const projected = snapshotFromLegacy(LEGACY)
  assert.ok(projected)
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: projected }),
    analysisFingerprint(LEGACY),
    'which is exactly why the route passes the STORED snapshot only',
  )
})

// ===================================================== what must invalidate

test('a changed essay changes the fingerprint', () => {
  const requirement = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const base = { ...LEGACY, requirement }
  assert.notEqual(
    analysisFingerprint({ ...base, essay: `${LEGACY.essay} One more sentence.` }),
    analysisFingerprint(base))
})

test('THE TITLE IS NOT AN INPUT, so a rename reuses the paid result', () => {
  const requirement = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  // There is no title field to pass. A rename changes nothing this reads, and
  // the structured path does not reintroduce one.
  const once = analysisFingerprint({ ...LEGACY, requirement })
  const again = analysisFingerprint({ ...LEGACY, requirement })
  assert.equal(once, again)
  const source = Object.keys({ ...LEGACY, requirement })
  assert.ok(!source.includes('title'))
  assert.ok(!source.includes('revision'))
})

test('A DIFFERENT ALTERNATIVE IS A DIFFERENT ANALYSIS', () => {
  // SIU Edwardsville's two options. An essay written to one must never match a
  // stored result for the other, even with identical text and identical limits.
  const [optionA, optionB] = SIUE.requirements
  assert.equal(optionA!.choiceGroup, optionB!.choiceGroup, 'precondition: same group')
  assert.deepEqual(optionA!.constraints, optionB!.constraints, 'precondition: same limits')
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: snapshotOf(SIUE, optionA!) }),
    analysisFingerprint({ ...LEGACY, requirement: snapshotOf(SIUE, optionB!) }),
  )
})

test('A DIFFERENT DOCUMENT IN THE SAME SET IS A DIFFERENT ANALYSIS', () => {
  // Minnesota's personal statement and diversity essay. Same essay text,
  // different requirement: two analyses, never one shared result.
  const [statement, diversity] = MINNESOTA.requirements
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: snapshotOf(MINNESOTA, statement!) }),
    analysisFingerprint({ ...LEGACY, requirement: snapshotOf(MINNESOTA, diversity!) }),
  )
})

test('every UC Davis response has its own identity', () => {
  const prints = UC_DAVIS.requirements.map((r) =>
    analysisFingerprint({ ...LEGACY, requirement: snapshotOf(UC_DAVIS, r) }))
  assert.equal(new Set(prints).size, 6, 'six responses, six distinct cache keys')
})

// ===================================================== the length register

test('AN OLD SNAPSHOT’S FINGERPRINT IS UNCHANGED BY THE REGISTER FIELDS', () => {
  // THE BACKWARD-COMPATIBILITY GUARANTEE, PINNED AT THE BYTE. A snapshot saved
  // before `enforcement` and `statedAs` existed has no register, parses as the
  // strict default, and produces the instructions it always produced -- so it
  // must produce the digest it always produced, or every draft saved to date
  // would silently lose its cached analysis and have to be paid for again.
  //
  // The expected digest is rebuilt here from the PRE-REGISTER field order, so
  // this is a pin on the value rather than a restatement of the code.
  const stored = {
    requirementId: 'r1', setId: 's1', schoolId: 'c1', label: 'Personal Statement',
    promptText: 'Describe your goals.', documentType: 'personal-statement',
    components: [{ id: 'q1', text: 'one', optional: false }],
    constraints: { words: { min: null, max: 500 } },
    optional: false, choiceGroup: null, applicationCycle: null, notes: ['a note'],
  }
  const parsed = parseRequirementSnapshot(stored)!
  assert.equal(parsed.constraints.words?.enforcement, 'enforced')

  const NUL = '\u0000'
  const expected = [
    'r1', 's1', 'c1', 'personal-statement', `${NUL}null`, 'false', 'Describe your goals.',
    ['q1', 'false', 'one'].join(`${NUL}\u0002`),
    'words', `${NUL}null`, '500',
    'chars', `${NUL}null`, `${NUL}null`, `${NUL}null`,
    'pages', `${NUL}null`, `${NUL}null`, `${NUL}null`,
    'type', `${NUL}null`, `${NUL}null`, `${NUL}null`,
    'cite', `${NUL}null`, `${NUL}null`, `${NUL}null`,
    'other',
    'label', 'Personal Statement',
    'notes', 'a note',
  ].join(`${NUL}\u0003`)
  assert.equal(requirementDigest(parsed), expected,
    'no register segment appears when every register is the default')
})

test('A NON-DEFAULT REGISTER DOES CHANGE THE FINGERPRINT, and must', () => {
  // The other half. "250 words suggested" is a different instruction from "250
  // words maximum": different constraint lines, different over-limit sentence,
  // and the analyser is told explicitly not to treat one as a cap. A result
  // produced under one is not an answer to the other.
  const base = snapshotOf(UC_DAVIS, UC_DAVIS.requirements[0]!)
  assert.equal(base.constraints.words?.enforcement, 'suggested')
  const asMaximum = {
    ...base,
    constraints: {
      ...base.constraints,
      words: { ...base.constraints.words!, enforcement: 'enforced' as const },
    },
  }
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: base }),
    analysisFingerprint({ ...LEGACY, requirement: asMaximum }))

  // AND SO DOES THE SCHOOL'S QUOTED SENTENCE, which the applicant reads and
  // which travels into the analyser's prompt.
  const requoted = {
    ...base,
    constraints: {
      ...base.constraints,
      words: { ...base.constraints.words!, statedAs: 'Maximum of 250 words.' },
    },
  }
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: base }),
    analysisFingerprint({ ...LEGACY, requirement: requoted }))
})

test('EVERY REGISTER IS A DISTINCT CACHE IDENTITY', () => {
  const base = snapshotOf(UC_DAVIS, UC_DAVIS.requirements[0]!)
  const prints = ENFORCEMENTS.map((enforcement) => analysisFingerprint({
    ...LEGACY,
    requirement: {
      ...base,
      constraints: { ...base.constraints, words: { ...base.constraints.words!, enforcement } },
    },
  }))
  assert.equal(new Set(prints).size, ENFORCEMENTS.length)
})

test('a changed COMPONENT changes the fingerprint', () => {
  const requirement = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const reworded = {
    ...requirement,
    components: requirement.components.map((c, i) =>
      i === 0 ? { ...c, text: `${c.text} And say why.` } : c),
  }
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: reworded }),
    analysisFingerprint({ ...LEGACY, requirement }))
})

test('REORDERING COMPONENTS changes the fingerprint', () => {
  // The school's numbering is part of the question.
  const requirement = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const swapped = {
    ...requirement,
    components: [requirement.components[1]!, requirement.components[0]!,
      ...requirement.components.slice(2)],
  }
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: swapped }),
    analysisFingerprint({ ...LEGACY, requirement }))
})

test('making a component optional changes the fingerprint', () => {
  const requirement = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const relaxed = {
    ...requirement,
    components: requirement.components.map((c, i) => i === 0 ? { ...c, optional: true } : c),
  }
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: relaxed }),
    analysisFingerprint({ ...LEGACY, requirement }))
})

test('EVERY CONSTRAINT UNIT PARTICIPATES IN THE IDENTITY', () => {
  const base = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const print = (requirement: typeof base) => analysisFingerprint({ ...LEGACY, requirement })
  const original = print(base)
  const variants: readonly (typeof base)[] = [
    { ...base, constraints: { ...base.constraints, words: wordLimit({ min: null, max: 900, enforcement: 'enforced' }) } },
    { ...base, constraints: { ...base.constraints, words: wordLimit({ min: 500, max: 1000, enforcement: 'enforced' }) } },
    { ...base, constraints: { ...base.constraints, characters: characterLimit({ min: null, max: 2500, spacesCount: true, enforcement: 'enforced' }) } },
    { ...base, constraints: { ...base.constraints, characters: characterLimit({ min: null, max: 2500, spacesCount: false, enforcement: 'enforced' }) } },
    { ...base, constraints: { ...base.constraints, pages: pageLimit({ min: null, max: 2, spacing: 'double', enforcement: 'enforced' }) } },
    { ...base, constraints: { ...base.constraints, pages: pageLimit({ min: null, max: 2, spacing: 'single', enforcement: 'enforced' }) } },
    // THE REGISTER AND THE SCHOOL'S SENTENCE, in the canonical every-field
    // table. Both reach the model, so both are cache identity.
    { ...base, constraints: { ...base.constraints, words: wordLimit({ min: null, max: 1000, enforcement: 'suggested' }) } },
    { ...base, constraints: { ...base.constraints, words: wordLimit({ min: null, max: 1000, enforcement: 'target' }) } },
    { ...base, constraints: { ...base.constraints, words: wordLimit({ min: null, max: 1000, enforcement: 'enforced', statedAs: '1,000 words maximum.' }) } },
    { ...base, constraints: { ...base.constraints, typography: { fontSizePt: 12, fontFamily: null, marginsInches: null } } },
    { ...base, constraints: { ...base.constraints, typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: null } } },
    { ...base, constraints: { ...base.constraints, typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: 1 } } },
    { ...base, constraints: { ...base.constraints, citation: { family: 'apa', statedAs: 'APA', minReferences: null } } },
    { ...base, constraints: { ...base.constraints, citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: null } } },
    { ...base, constraints: { ...base.constraints, citation: { family: 'apa', statedAs: 'APA', minReferences: 3 } } },
    { ...base, constraints: { ...base.constraints, otherInstructions: ['no cover page'] } },
    { ...base, documentType: 'diversity-statement' },
    { ...base, promptText: 'A different instruction.' },
    { ...base, optional: true },
    { ...base, choiceGroup: 'some-group' },
  ]
  const prints = new Set([original, ...variants.map(print)])
  assert.equal(prints.size, variants.length + 1,
    'each variant must produce a distinct fingerprint')
})

test('A CHANGED LABEL DOES CHANGE THE FINGERPRINT', () => {
  // THE REQUIREMENT LABEL IS NOT THE DRAFT TITLE, and an earlier version of
  // this test confused the two. The draft title reaches nothing, so renaming a
  // draft is genuinely free. The requirement label is written into the
  // <document> block the model reads -- "This is ONE document: Diversity
  // Statement" -- so a cached result produced under the old label is not an
  // answer to the new instructions.
  const base = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: { ...base, label: 'Essay 1' } }),
    analysisFingerprint({ ...LEGACY, requirement: base }))
})

test('CHANGED NOTES CHANGE THE FINGERPRINT TOO', () => {
  // Quoted to the model as "the catalog records unresolved uncertainty about
  // this requirement", so they are instructions like any other.
  const base = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: { ...base, notes: ['a new note'] } }),
    analysisFingerprint({ ...LEGACY, requirement: base }))
})

test('THE AUTHENTICITY VERDICT IS PART OF THE KEY', () => {
  // An outdated requirement must not retrieve a row stored while it was still
  // the school's. The snapshot is identical in both calls -- only our
  // confidence in it differs -- and that alone must separate the two rows.
  const base = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const authentic = analysisFingerprint({
    ...LEGACY, requirement: base, requirementAuthentic: true,
  })
  const notAuthentic = analysisFingerprint({
    ...LEGACY, requirement: base, requirementAuthentic: false,
  })
  assert.notEqual(authentic, notAuthentic)
  // Omitted means not authenticated: the cautious default.
  assert.equal(analysisFingerprint({ ...LEGACY, requirement: base }), notAuthentic)
})

test('the verdict is ignored when there is no requirement', () => {
  // Otherwise a legacy draft's key would move the day this field was added.
  for (const authentic of [true, false, undefined]) {
    assert.equal(
      analysisFingerprint({ ...LEGACY, requirementAuthentic: authentic }),
      analysisFingerprint(LEGACY), String(authentic))
  }
})

test('THE SNAPSHOT\u2019S OWN verification AND cycle DO NOT CHANGE THE FINGERPRINT', () => {
  // Neither reaches the model. Digesting the verification object would also
  // mean a re-verification date bump invalidated every stored analysis, which
  // is a regression rather than a protection -- and the object is never
  // trusted anyway, because provenance is computed from the catalog's columns.
  //
  // `notes` IS NOT IN THIS LIST ANY MORE. An earlier version bundled it here,
  // which was wrong: notes are quoted to the model.
  const base = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const rebadged = {
    ...base,
    verification: {
      status: 'verified' as const, sourceUrl: 'https://example.edu', verifiedOn: '2026-10-02',
      verbatim: true,
    },
    applicationCycle: '2026-2027',
  }
  assert.equal(
    analysisFingerprint({ ...LEGACY, requirement: rebadged }),
    analysisFingerprint({ ...LEGACY, requirement: base }))
})

test('the fingerprint is a sha256 hex digest, and stable across calls', () => {
  const requirement = snapshotOf(MINNESOTA, MINNESOTA.requirements[0]!)
  const once = analysisFingerprint({ ...LEGACY, requirement })
  assert.match(once, /^[0-9a-f]{64}$/)
  assert.equal(analysisFingerprint({ ...LEGACY, requirement }), once)
})

test('AN UNENFORCED LENGTH SENTENCE IS CACHE IDENTITY', () => {
  // It is quoted to the model together with an instruction about how to treat
  // it, so changing the sentence changes the advice. A result produced under
  // one wording is not an answer to another.
  const base = snapshotOf(WAYNE_STATE, WAYNE_STATE.requirements[0]!)
  assert.ok(base.constraints.unenforcedLength)
  const reworded = {
    ...base,
    constraints: { ...base.constraints, unenforcedLength: 'a summary of one page' },
  }
  const removed = {
    ...base,
    constraints: { ...base.constraints, unenforcedLength: null },
  }
  const prints = [base, reworded, removed].map((requirement) =>
    analysisFingerprint({ ...LEGACY, requirement }))
  assert.equal(new Set(prints).size, 3)
})

test('AND A NULL ONE STILL COSTS NOTHING, so no existing draft was disturbed', () => {
  // The digest omits the whole register-and-unenforced section when every value
  // is the default and the sentence is null. The byte-for-byte pin above covers
  // this; here it is stated against a real fixture that has no register at all.
  const albany = snapshotOf(ALBANY, ALBANY.requirements[0]!)
  assert.equal(albany.constraints.unenforcedLength, null)
  assert.equal(albany.constraints.words?.enforcement, 'enforced')
  assert.doesNotMatch(requirementDigest(albany), /unenf/,
    'no unenforced segment appears for a plain enforced requirement')
})

test('THE VERBATIM FLAG IS CACHE IDENTITY, not just the text', () => {
  // The same sentence shown as a quotation and shown as a summary are two
  // different instructions to the model -- one may be repeated back to the
  // applicant as the school's words and the other may not -- so they cannot
  // share a cache row.
  const base = snapshotOf(WAYNE_STATE, WAYNE_STATE.requirements[0]!)
  const text = base.constraints.unenforcedLength!.text
  const asSummary = {
    ...base,
    constraints: { ...base.constraints, unenforcedLength: { text, verbatim: false } },
  }
  assert.notEqual(
    analysisFingerprint({ ...LEGACY, requirement: base }),
    analysisFingerprint({ ...LEGACY, requirement: asSummary }))
})
