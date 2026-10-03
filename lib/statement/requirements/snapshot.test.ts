import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NO_CONSTRAINTS, characterLimit, pageLimit, wordLimit,} from './constraints.ts'
import { UNVERIFIED } from './verification.ts'
import type { RequirementSet, WritingRequirement } from './requirement.ts'
import {
  effectiveSnapshot, legacyProjection, parseRequirementSnapshot, snapshotFromLegacy, snapshotOf,
} from './snapshot.ts'
import {
  ALBANY, BUFFALO, MINNESOTA, RUTGERS, SIUE, SOUTHERN_MISS, SOUTH_DAKOTA, UC_DAVIS,
  UT_KNOXVILLE,
} from './fixtures.ts'

function req(over: Partial<WritingRequirement> & { id: string }): WritingRequirement {
  return {
    documentType: 'personal-statement', label: 'L', promptText: 'q', components: [],
    constraints: NO_CONSTRAINTS, choiceGroup: null, optional: false, displayOrder: 0, notes: [],
    ...over,
  }
}
const set = (requirements: readonly WritingRequirement[], over: Partial<RequirementSet> = {}): RequirementSet => ({
  id: 'set-1', schoolId: 'school-1', schoolName: 'S', applicationCycle: null,
  verification: UNVERIFIED, originalText: 'orig', requirements, notes: [], ...over,
})

// -------------------------------------------------- freezing

test('a snapshot carries the document AND the set’s identity', () => {
  const r = req({ id: 'r1' })
  const snap = snapshotOf(set([r], { applicationCycle: '2026-2027' }), r)
  assert.equal(snap.requirementId, 'r1')
  assert.equal(snap.setId, 'set-1')
  assert.equal(snap.schoolId, 'school-1')
  assert.equal(snap.applicationCycle, '2026-2027')
})

test('both levels of uncertainty reach the draft', () => {
  const r = req({ id: 'r1', notes: ['document note'] })
  const snap = snapshotOf(set([r], { notes: ['set note'] }), r)
  assert.deepEqual([...snap.notes], ['set note', 'document note'])
})

test('a snapshot does not alias the requirement’s component array', () => {
  const components = [{ id: 'c1', text: 'one', optional: false }]
  const r = req({ id: 'r1', components })
  const snap = snapshotOf(set([r]), r)
  assert.notEqual(snap.components[0], components[0], 'components are copied, not shared')
  assert.deepEqual(snap.components[0], components[0])
})

test('THE CHOSEN ALTERNATIVE IS RECORDED, so the other can never be used', () => {
  const chosen = SIUE.requirements.find((r) => r.id === 'fixture-siue-choice-background')!
  const snap = snapshotOf(SIUE, chosen)
  assert.equal(snap.requirementId, 'fixture-siue-choice-background')
  assert.equal(snap.choiceGroup, 'siue-statement')
  assert.match(snap.promptText, /background, identity, interest or talent/)
  // The alternative's text is nowhere in the snapshot.
  assert.doesNotMatch(snap.promptText, /professional goals are and how your graduate/)
})

// -------------------------------------------------- the legacy projection

test('a word maximum projects onto stated_max_words', () => {
  const snap = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  assert.deepEqual(legacyProjection(snap), {
    promptText: 'Your essay must address the following.', statedMaxWords: 1000,
  })
})

test('A PAGE LIMIT PROJECTS TO NULL, not to an invented word count', () => {
  // Rutgers: one page each, no word count stated anywhere.
  for (const requirement of RUTGERS.requirements) {
    const snap = snapshotOf(RUTGERS, requirement)
    assert.equal(snap.constraints.pages?.max, 1)
    assert.equal(legacyProjection(snap).statedMaxWords, null,
      'the existing code reads null as "no word limit stated", which is true')
  }
})

test('A CHARACTER LIMIT PROJECTS TO NULL TOO', () => {
  // UT Knoxville, which is the verified character-limit school. UC Davis used
  // to stand here and does not have a character limit at all; see
  // 05_FIXTURE_CORRECTIONS.md.
  const snap = snapshotOf(UT_KNOXVILLE, UT_KNOXVILLE.requirements[0]!)
  assert.equal(snap.constraints.characters?.max, 18_000)
  assert.equal(snap.constraints.characters?.spacesCount, false)
  assert.equal(legacyProjection(snap).statedMaxWords, null)
})

test('A SUGGESTED WORD MAXIMUM PROJECTS TO NULL, BECAUSE IT IS NOT A MAXIMUM', () => {
  // THE HEADLINE CONSEQUENCE OF THE REGISTER. stated_max_words is what
  // overLimit() reads and what the editor's violation banner reads. UC Davis
  // publishes "Suggested Length: Maximum of 250 words"; projecting 250 into
  // that column would give every UC Davis applicant a broken-limit banner over
  // a figure their school calls a suggestion.
  const snap = snapshotOf(UC_DAVIS, UC_DAVIS.requirements[0]!)
  assert.equal(snap.constraints.words?.max, 250, 'the number is still stored')
  assert.equal(snap.constraints.words?.enforcement, 'suggested')
  assert.equal(legacyProjection(snap).statedMaxWords, null, 'and is NOT a hard cap')
})

test('A TARGET LENGTH PROJECTS TO NULL TOO', () => {
  // South Dakota: "A written 500 word statement" -- a length, never called a
  // maximum. Same number as a real cap elsewhere, different standing.
  const snap = snapshotOf(SOUTH_DAKOTA, SOUTH_DAKOTA.requirements[0]!)
  assert.equal(snap.constraints.words?.max, 500)
  assert.equal(snap.constraints.words?.enforcement, 'target')
  assert.equal(legacyProjection(snap).statedMaxWords, null)
})

test('AN ENFORCED WORD MAXIMUM STILL PROJECTS, exactly as before', () => {
  // The other half of the guarantee: nothing was relaxed for a real cap.
  const snap = snapshotOf(ALBANY, ALBANY.requirements[0]!)
  assert.equal(snap.constraints.words?.enforcement, 'enforced')
  assert.equal(legacyProjection(snap).statedMaxWords, 500)
})

test('A TRUNCATED LIMIT IS NOT A WORD LIMIT AND STILL PROJECTS TO NULL', () => {
  // Southern Mississippi's truncated bound is a PAGE count. The strictest
  // register there is does not create a word maximum out of nothing.
  const snap = snapshotOf(SOUTHERN_MISS, SOUTHERN_MISS.requirements[0]!)
  assert.equal(snap.constraints.pages?.enforcement, 'truncated')
  assert.equal(snap.constraints.words, null)
  assert.equal(legacyProjection(snap).statedMaxWords, null)
})

test('a word MINIMUM alone projects to null -- a floor is not a ceiling', () => {
  const r = req({ id: 'r', constraints: { ...NO_CONSTRAINTS,
    words: wordLimit({ min: 500, max: null, enforcement: 'enforced' }) } })
  assert.equal(legacyProjection(snapshotOf(set([r]), r)).statedMaxWords, null)
})

test('an empty prompt projects to null, never to an empty string', () => {
  const r = req({ id: 'r', promptText: '' })
  assert.equal(legacyProjection(snapshotOf(set([r]), r)).promptText, null)
})

// -------------------------------------------------- OLD DRAFTS

test('BACKWARD COMPATIBILITY: an existing single-prompt draft reads as one document', () => {
  const legacy = snapshotFromLegacy({
    schoolId: 'school-x', promptId: 'prompt-x',
    promptText: 'Describe your professional goals.', statedMaxWords: 1000,
  })
  assert.ok(legacy)
  assert.equal(legacy.requirementId, 'prompt-x')
  assert.equal(legacy.setId, 'prompt-x', 'no set exists; the prompt id is truthful about that')
  assert.equal(legacy.documentType, 'personal-statement')
  assert.deepEqual([...legacy.components], [], 'one undivided prompt')
  assert.deepEqual(legacy.constraints.words,
    { min: null, max: 1000, enforcement: 'enforced', statedAs: null },
    'an old draft\u2019s maximum keeps being the hard cap it has always been treated as')
  assert.equal(legacyProjection(legacy).statedMaxWords, 1000,
    'and still projects, so no existing draft loses its over-limit warning')
  assert.equal(legacy.constraints.pages, null)
  assert.equal(legacy.choiceGroup, null)
  assert.equal(legacy.verification.status, 'unverified')
})

test('an old draft with no word limit gains NO constraints', () => {
  const legacy = snapshotFromLegacy({
    schoolId: 's', promptId: 'p', promptText: 'q', statedMaxWords: null,
  })
  assert.deepEqual(legacy!.constraints, NO_CONSTRAINTS)
})

test('a GENERAL statement has no requirement, and is not given an empty one', () => {
  assert.equal(snapshotFromLegacy({
    schoolId: null, promptId: null, promptText: null, statedMaxWords: null,
  }), null)
  // A partial snapshot is also not a requirement.
  assert.equal(snapshotFromLegacy({
    schoolId: 's', promptId: null, promptText: 'q', statedMaxWords: null,
  }), null)
  assert.equal(snapshotFromLegacy({
    schoolId: null, promptId: 'p', promptText: 'q', statedMaxWords: null,
  }), null)
})

test('the legacy projection ROUND-TRIPS an old draft unchanged', () => {
  // The guarantee that matters: reading an old draft into the new model and
  // projecting it back must give the same two column values.
  const columns = { promptText: 'The question.', statedMaxWords: 750 }
  const snap = snapshotFromLegacy({ schoolId: 's', promptId: 'p', ...columns })!
  assert.deepEqual(legacyProjection(snap), columns)
})

// -------------------------------------------------- effectiveSnapshot

test('effectiveSnapshot prefers a stored snapshot and falls back to the columns', () => {
  const structured = snapshotOf(MINNESOTA, MINNESOTA.requirements[0]!)
  const fromStored = effectiveSnapshot({
    schoolId: 'ignored', promptId: 'ignored', promptText: 'ignored', statedMaxWords: 1,
    requirementSnapshot: JSON.parse(JSON.stringify(structured)),
  })
  assert.equal(fromStored?.requirementId, 'fixture-minnesota-1')
  assert.equal(fromStored?.components.length, 3)

  const fromColumns = effectiveSnapshot({
    schoolId: 's', promptId: 'p', promptText: 'old question', statedMaxWords: 500,
  })
  assert.equal(fromColumns?.promptText, 'old question')
  assert.equal(fromColumns?.components.length, 0)
})

test('a MALFORMED stored snapshot falls back rather than showing an empty document', () => {
  for (const junk of [{}, { requirementId: 'r' }, [], 'string', 7, null, { requirementId: 'r', setId: 's', schoolId: 'c' }]) {
    const result = effectiveSnapshot({
      schoolId: 's', promptId: 'p', promptText: 'old question', statedMaxWords: 500,
      requirementSnapshot: junk,
    })
    assert.equal(result?.promptText, 'old question', JSON.stringify(junk))
  }
})

// -------------------------------------------------- parsing one back

test('a snapshot survives a JSON round trip exactly', () => {
  for (const set_ of [BUFFALO, MINNESOTA, RUTGERS, UC_DAVIS, SIUE]) {
    for (const requirement of set_.requirements) {
      const snap = snapshotOf(set_, requirement)
      const parsed = parseRequirementSnapshot(JSON.parse(JSON.stringify(snap)))
      assert.deepEqual(parsed, snap, `${set_.id}/${requirement.id}`)
    }
  }
})

test('the five identity fields are required', () => {
  const full = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const json = JSON.parse(JSON.stringify(full)) as Record<string, unknown>
  for (const key of ['requirementId', 'setId', 'schoolId', 'promptText', 'label']) {
    const missing = { ...json }
    delete missing[key]
    assert.equal(parseRequirementSnapshot(missing), null, key)
  }
})

test('AN UNRECOGNISED VERIFICATION STATUS DEGRADES TO UNVERIFIED, never to verified', () => {
  const full = JSON.parse(JSON.stringify(snapshotOf(BUFFALO, BUFFALO.requirements[0]!)))
  full.verification = { status: 'super-verified', sourceUrl: 'https://x', verifiedOn: '2026-10-02', verbatim: true }
  assert.equal(parseRequirementSnapshot(full)!.verification.status, 'unverified')
})

test('a malformed limit degrades to NO limit, which is never enforced', () => {
  const full = JSON.parse(JSON.stringify(snapshotOf(BUFFALO, BUFFALO.requirements[0]!)))
  full.constraints = {
    words: wordLimit({ min: 'lots', max: -5, enforcement: 'enforced' }),
    characters: characterLimit({ min: null, max: 0, spacesCount: 'yes', enforcement: 'enforced' }),
    pages: pageLimit({ min: null, max: 2.5, spacing: 'triple', enforcement: 'enforced' }),
    typography: { fontSizePt: 0, fontFamily: 7, marginsInches: -1 },
    citation: { family: 'mla' },
    otherInstructions: ['keep', 7, null],
  }
  const parsed = parseRequirementSnapshot(full)!
  // THE REGISTER SURVIVES A MALFORMED BOUND, and defaults where it is absent.
  // A limit with no bounds is never enforced against anything, so a strict
  // register on an empty limit is inert rather than dangerous.
  assert.deepEqual(parsed.constraints.words,
    { min: null, max: null, enforcement: 'enforced', statedAs: null })
  assert.deepEqual(parsed.constraints.characters,
    { min: null, max: null, spacesCount: null, enforcement: 'enforced', statedAs: null })
  assert.deepEqual(parsed.constraints.pages,
    { min: null, max: null, spacing: null, enforcement: 'enforced', statedAs: null })
  assert.deepEqual(parsed.constraints.typography, { fontSizePt: null, fontFamily: null, marginsInches: null })
  assert.equal(parsed.constraints.citation, null, 'a style with no wording is not a style')
  assert.deepEqual([...parsed.constraints.otherInstructions], ['keep'])
})

test('a malformed verification date is dropped, not kept', () => {
  const full = JSON.parse(JSON.stringify(snapshotOf(BUFFALO, BUFFALO.requirements[0]!)))
  full.verification = { status: 'verified', sourceUrl: 'https://x', verifiedOn: '10/02/2026', verbatim: true }
  assert.equal(parseRequirementSnapshot(full)!.verification.verifiedOn, null)
})

test('components missing an id or text are dropped, not defaulted', () => {
  const full = JSON.parse(JSON.stringify(snapshotOf(BUFFALO, BUFFALO.requirements[0]!)))
  full.components = [
    { id: 'good', text: 'kept', optional: false },
    { id: 'no-text' },
    { text: 'no-id' },
    null,
    'string',
  ]
  const parsed = parseRequirementSnapshot(full)!
  assert.deepEqual(parsed.components.map((c) => c.id), ['good'])
})

test('an unknown document type becomes "other", not a guess', () => {
  const full = JSON.parse(JSON.stringify(snapshotOf(BUFFALO, BUFFALO.requirements[0]!)))
  full.documentType = 'thesis'
  assert.equal(parseRequirementSnapshot(full)!.documentType, 'other')
})
