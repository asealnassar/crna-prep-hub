import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALBANY, BUFFALO, FIXTURE_NOTICE, FIXTURE_SETS, FIXTURE_SOURCE, MINNESOTA, OHIO_STATE, RUTGERS,
  SAINT_MARYS, SIUE, UC_DAVIS, fixtureById,
} from './fixtures.ts'
import {
  checklist, isMultipart, requiredComponents, requiredDocumentCount,
} from './requirement.ts'
import { activatableForApplicants } from './verification.ts'
import { legacyProjection, snapshotOf } from './snapshot.ts'
import { statedWordMaximum } from './eligibility.ts'
import { liveCounts } from './constraints.ts'
import { constraintLines } from './constraintText.ts'

// ===================================================== the standing rule

test('NOT ONE FIXTURE MAY BE SHOWN TO APPLICANTS AS A REQUIREMENT', () => {
  // The spreadsheet's Verified column is empty on all 83 rows. Nothing here has
  // been checked against a school's own materials, so nothing here activates.
  assert.ok(FIXTURE_SETS.length >= 8)
  for (const set of FIXTURE_SETS) {
    assert.equal(activatableForApplicants(set.verification), false, set.schoolName)
    assert.equal(set.verification.sourceUrl, null, `${set.schoolName}: no URL was invented`)
    assert.equal(set.verification.verifiedOn, null, `${set.schoolName}: no date was invented`)
    assert.equal(set.verification.verbatim, false,
      `${set.schoolName}: research text is not the school's exact wording`)
  }
})

test('every fixture keeps the research text it was structured from', () => {
  for (const set of FIXTURE_SETS) {
    assert.ok(set.originalText.length > 50, set.schoolName)
    // The spreadsheet's two cells, joined: the prompt and the word-count note.
    assert.match(set.originalText, /\n\nWord count: /, set.schoolName)
  }
})

test('the notice says what these are and are not', () => {
  assert.match(FIXTURE_NOTICE, /[Dd]evelopment sample/)
  assert.match(FIXTURE_NOTICE, /unverified/)
  assert.match(FIXTURE_NOTICE, /not current\s+admissions requirements|not current admissions requirements/)
  assert.match(FIXTURE_NOTICE, /not in the school catalog/)
  assert.match(FIXTURE_SOURCE, /research file/)
})

test('fixture school ids cannot collide with real ones', () => {
  // Real school ids are uuids. These are not, so a fixture id can never be
  // mistaken for a catalog row or used to read one.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  for (const set of FIXTURE_SETS) {
    assert.doesNotMatch(set.schoolId, uuid, set.schoolName)
    assert.match(set.schoolId, /^fixture-school-/, set.schoolName)
    assert.match(set.id, /^fixture-/, set.schoolName)
    for (const requirement of set.requirements) {
      assert.match(requirement.id, /^fixture-/, requirement.label)
    }
  }
})

test('ids are unique across every fixture', () => {
  const ids = FIXTURE_SETS.flatMap((set) => set.requirements.map((r) => r.id))
  assert.equal(new Set(ids).size, ids.length)
  const setIds = FIXTURE_SETS.map((s) => s.id)
  assert.equal(new Set(setIds).size, setIds.length)
  for (const set of FIXTURE_SETS) assert.equal(fixtureById(set.id), set)
  assert.equal(fixtureById('nope'), null)
})

// ===================================================== the six named cases

test('Albany Medical College: THREE SEPARATE statements, 500 words each', () => {
  assert.equal(ALBANY.requirements.length, 3)
  assert.equal(requiredDocumentCount(ALBANY), 3)
  assert.equal(checklist(ALBANY).length, 3)
  for (const requirement of ALBANY.requirements) {
    assert.equal(requirement.constraints.words?.max, 500, requirement.label)
    assert.equal(isMultipart(requirement), false, 'each is one undivided prompt')
    assert.equal(legacyProjection(snapshotOf(ALBANY, requirement)).statedMaxWords, 500)
  }
  // "500 words EACH" is the per-item limit that proves they are separate.
  assert.match(ALBANY.originalText, /500 words EACH; 3 statements/)
  // The third item's question was not recorded, and is not invented.
  const third = ALBANY.requirements[2]!
  assert.match(third.label, /Doctor of Nursing Essay/)
  assert.equal(third.notes.length, 1)
  assert.match(third.notes[0]!, /records only the title of this item/)
})

test('Rutgers: TWO separate documents, ONE PAGE each, NO word count', () => {
  assert.equal(RUTGERS.requirements.length, 2)
  assert.equal(requiredDocumentCount(RUTGERS), 2)
  assert.deepEqual(RUTGERS.requirements.map((r) => r.documentType),
    ['personal-statement', 'writing-sample'])
  for (const requirement of RUTGERS.requirements) {
    assert.equal(requirement.constraints.pages?.max, 1, requirement.label)
    assert.equal(requirement.constraints.words, null, 'no word limit was stated')
    // THE PROJECTION STAYS NULL. One page does not become a word count.
    assert.equal(legacyProjection(snapshotOf(RUTGERS, requirement)).statedMaxWords, null)
    // And the displayed limit never mentions words.
    assert.doesNotMatch(constraintLines(requirement.constraints).join(' '), /word/i)
  }
  assert.match(RUTGERS.originalText, /1 page EACH; 2 separate documents \(no word count stated\)/)
})

test('University of Minnesota: a THREE-PART statement plus a SEPARATE essay', () => {
  assert.equal(MINNESOTA.requirements.length, 2, 'two documents')
  assert.equal(requiredDocumentCount(MINNESOTA), 2)

  const statement = MINNESOTA.requirements[0]!
  assert.equal(statement.documentType, 'personal-statement')
  assert.equal(isMultipart(statement), true)
  assert.equal(statement.components.length, 3, 'three questions INSIDE one essay')
  assert.equal(requiredComponents(statement).length, 3)
  // ONE page budget for all three, which is what makes them one document.
  assert.equal(statement.constraints.pages?.max, 4)
  assert.equal(statement.constraints.pages?.spacing, 'double')
  assert.equal(statement.constraints.words, null)

  const diversity = MINNESOTA.requirements[1]!
  assert.equal(diversity.documentType, 'diversity-statement')
  assert.equal(diversity.components.length, 0)
  assert.equal(diversity.constraints.words?.max, 500, 'its own, separate limit')

  // The two documents' limits are independent and in different units.
  assert.equal(legacyProjection(snapshotOf(MINNESOTA, statement)).statedMaxWords, null)
  assert.equal(legacyProjection(snapshotOf(MINNESOTA, diversity)).statedMaxWords, 500)
})

test('SIU Edwardsville: an ALTERNATIVE plus a required additional response', () => {
  assert.equal(SIUE.requirements.length, 3, 'three recorded prompts')
  const entries = checklist(SIUE)
  assert.equal(entries.length, 2, 'but TWO things to do')
  assert.deepEqual(entries.map((e) => e.kind), ['choice', 'document'])
  assert.equal(requiredDocumentCount(SIUE), 2, 'the applicant writes two essays')

  const choice = entries[0]!
  assert.equal(choice.kind === 'choice' && choice.group.options.length, 2)
  for (const option of choice.kind === 'choice' ? choice.group.options : []) {
    assert.equal(option.choiceGroup, 'siue-statement')
    assert.equal(option.constraints.pages?.max, 2)
    assert.equal(option.constraints.words, null)
  }
  const extra = SIUE.requirements[2]!
  assert.equal(extra.choiceGroup, null, 'the extra response is not an alternative')
  assert.equal(extra.constraints.words?.max, 250)
  assert.match(SIUE.originalText, /Choose ONE/)
  assert.match(SIUE.originalText, /PLUS REQUIRED/)
})

test('UC Davis: FIVE responses limited by CHARACTERS, not words', () => {
  assert.equal(UC_DAVIS.requirements.length, 5)
  assert.equal(requiredDocumentCount(UC_DAVIS), 5)
  for (const requirement of UC_DAVIS.requirements) {
    assert.equal(requirement.constraints.characters?.max, 2500, requirement.label)
    assert.equal(requirement.constraints.characters?.spacesCount, true, 'the file says INCLUDING')
    assert.equal(requirement.constraints.words, null, 'NOT a word limit')
    assert.deepEqual([...liveCounts(requirement.constraints)], ['characters'])
    assert.equal(statedWordMaximum(requirement.constraints), null,
      'characters are not a word maximum')
    assert.equal(legacyProjection(snapshotOf(UC_DAVIS, requirement)).statedMaxWords, null)
  }
  assert.match(UC_DAVIS.originalText, /2,500 CHARACTERS INCLUDING SPACES per answer/)
  assert.match(UC_DAVIS.originalText, /NOT a word limit/)
})

test('University at Buffalo: FOUR questions in ONE essay, plus an optional fifth', () => {
  assert.equal(BUFFALO.requirements.length, 1, 'ONE document')
  assert.equal(requiredDocumentCount(BUFFALO), 1)
  const essay = BUFFALO.requirements[0]!
  assert.equal(isMultipart(essay), true)
  assert.equal(essay.components.length, 5)
  assert.equal(requiredComponents(essay).length, 4, 'four required, one optional')
  assert.equal(essay.components[4]!.optional, true)
  assert.match(essay.components[4]!.text, /Optional additional comments/)
  // ONE budget for the whole essay -- the phrase that settles it.
  assert.equal(essay.constraints.words?.max, 1000)
  assert.match(BUFFALO.originalText, /1,000 words maximum \(entire essay\)/)
  assert.deepEqual([...liveCounts(essay.constraints)], ['words'])
})

// ===================================================== ambiguity and silence

test('Ohio State: CONFLICTING sources store NO limit and keep both readings', () => {
  assert.equal(OHIO_STATE.verification.status, 'conflicting')
  const requirement = OHIO_STATE.requirements[0]!
  // No page limit is stored, because there is no single correct one.
  assert.equal(requirement.constraints.pages, null)
  assert.equal(requirement.constraints.words, null)
  assert.deepEqual([...constraintLines(requirement.constraints)], [])
  // Both readings survive, in the note and in the original text.
  const note = requirement.notes.join(' ')
  assert.match(note, /three SINGLE-spaced pages/)
  assert.match(note, /three DOUBLE-spaced pages/)
  assert.match(note, /Confirm which applies/)
  assert.match(OHIO_STATE.originalText, /conflicting; verify before enforcing/)
})

test('Saint Mary’s: nothing published becomes NO constraints, not a default', () => {
  const requirement = SAINT_MARYS.requirements[0]!
  assert.deepEqual(requirement.constraints.words, null)
  assert.deepEqual(requirement.constraints.characters, null)
  assert.deepEqual(requirement.constraints.pages, null)
  assert.deepEqual([...constraintLines(requirement.constraints)], [])
  assert.match(SAINT_MARYS.originalText, /Not publicly specified/)
  assert.match(requirement.notes.join(' '), /no published length requirement/)
  // It still falls back to the ordinary word floor, like a general statement.
  assert.equal(statedWordMaximum(requirement.constraints), null)
})

// ===================================================== shape coverage

test('the fixtures between them cover every approved case', () => {
  const sets = FIXTURE_SETS
  // A: one document, one undivided prompt.
  assert.ok(sets.some((s) => s.requirements.length === 1 && s.requirements[0]!.components.length === 0))
  // B: one document, several questions.
  assert.ok(sets.some((s) => s.requirements.some((r) => isMultipart(r))))
  // C: several documents.
  assert.ok(sets.some((s) => s.requirements.filter((r) => r.choiceGroup === null).length > 1))
  // D: a choice.
  assert.ok(sets.some((s) => s.requirements.some((r) => r.choiceGroup !== null)))
  // E: an optional part.
  assert.ok(sets.some((s) => s.requirements.some((r) => r.components.some((c) => c.optional))))
  // F: named document types, more than one kind.
  const types = new Set(sets.flatMap((s) => s.requirements.map((r) => r.documentType)))
  assert.ok(types.size >= 4, [...types].join(','))
  assert.ok(types.has('diversity-statement'))
  assert.ok(types.has('writing-sample'))
  assert.ok(types.has('goal-statement'))
  // Units: words, characters and pages each appear.
  const all = sets.flatMap((s) => s.requirements)
  assert.ok(all.some((r) => r.constraints.words !== null))
  assert.ok(all.some((r) => r.constraints.characters !== null))
  assert.ok(all.some((r) => r.constraints.pages !== null))
})

test('NO FIXTURE CARRIES A WORD LIMIT THE RESEARCH DID NOT STATE', () => {
  // Every stored word maximum must appear as a number in its own set's
  // original text. This is the test that catches an invented limit.
  for (const set of FIXTURE_SETS) {
    for (const requirement of set.requirements) {
      const max = requirement.constraints.words?.max
      if (max === undefined || max === null) continue
      const written = max.toLocaleString('en-US')
      assert.ok(
        set.originalText.includes(String(max)) || set.originalText.includes(written),
        `${set.schoolName}/${requirement.label}: ${max} is not in the research text`,
      )
    }
  }
})

test('NO FIXTURE CARRIES A CHARACTER OR PAGE LIMIT THE RESEARCH DID NOT STATE', () => {
  for (const set of FIXTURE_SETS) {
    for (const requirement of set.requirements) {
      const chars = requirement.constraints.characters?.max
      if (chars != null) {
        assert.ok(set.originalText.includes(chars.toLocaleString('en-US'))
          || set.originalText.includes(String(chars)), `${set.schoolName}: ${chars} characters`)
      }
      const pages = requirement.constraints.pages?.max
      if (pages != null) {
        assert.ok(set.originalText.includes(String(pages)), `${set.schoolName}: ${pages} pages`)
      }
    }
  }
})
