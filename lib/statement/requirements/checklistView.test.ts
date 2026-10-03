import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checklistView, progressLabel, type StartedDraft } from './checklistView.ts'
import { NO_CONSTRAINTS, type Constraints, wordLimit } from './constraints.ts'
import { constraintSummary } from './constraintText.ts'
import {
  ALBANY, BUFFALO, LOYOLA, MINNESOTA, OHIO_STATE, RUTGERS, SIUE, SOUTHERN_MISS, SOUTH_DAKOTA,
  UC_DAVIS, UT_KNOXVILLE, WAYNE_STATE,
} from './fixtures.ts'

const draft = (requirementId: string, over: Partial<StartedDraft> = {}): StartedDraft => ({
  id: `draft-${requirementId}`, requirementId, title: 'A draft',
  updatedAt: '2026-10-01T12:00:00.000Z', words: 300, ...over,
})

// ===================================================== nothing is eager

test('a six-document school starts with SIX OFFERS AND NO DRAFTS', () => {
  // UC Davis publishes six prompts. The fixture modelled five and omitted one.
  const view = checklistView({ set: UC_DAVIS, drafts: [] })
  assert.equal(view.rows.length, 6)
  assert.equal(view.requiredCount, 6)
  assert.equal(view.startedCount, 0)
  for (const row of view.rows) {
    assert.equal(row.kind, 'document')
    assert.equal(row.kind === 'document' && row.card.action, 'start')
    assert.equal(row.kind === 'document' && row.card.started, null)
  }
  assert.equal(progressLabel(view), '6 required documents')
})

test('starting one does not touch the others', () => {
  const view = checklistView({
    set: UC_DAVIS, drafts: [draft('fixture-uc-davis-leadership')],
  })
  const actions = view.rows.map((r) => r.kind === 'document' ? r.card.action : 'choice')
  assert.deepEqual(actions, ['start', 'start', 'continue', 'start', 'start', 'start'])
  assert.equal(view.startedCount, 1)
  assert.equal(progressLabel(view), '1 of 6 started')
})

test('every document started reads as all started', () => {
  const view = checklistView({
    set: UC_DAVIS, drafts: UC_DAVIS.requirements.map((r) => draft(r.id)),
  })
  assert.equal(progressLabel(view), 'All 6 started')
})

// ===================================================== one draft per document

test('EACH DOCUMENT CARRIES ITS OWN DRAFT', () => {
  const view = checklistView({
    set: ALBANY,
    drafts: [draft('fixture-albany-1', { id: 'd1' }), draft('fixture-albany-3', { id: 'd3' })],
  })
  const cards = view.rows.map((r) => r.kind === 'document' ? r.card : null)
  assert.equal(cards[0]?.started?.id, 'd1')
  assert.equal(cards[1]?.started, null)
  assert.equal(cards[2]?.started?.id, 'd3')
})

test('a draft for another school’s document is not shown here', () => {
  const view = checklistView({ set: ALBANY, drafts: [draft('fixture-rutgers-1')] })
  for (const row of view.rows) {
    assert.equal(row.kind === 'document' && row.card.started, null)
  }
  assert.equal(view.startedCount, 0)
})

test('two drafts against one document open the most recently edited', () => {
  const view = checklistView({
    set: BUFFALO,
    drafts: [
      draft('fixture-buffalo-1', { id: 'older', updatedAt: '2026-09-01T00:00:00.000Z' }),
      draft('fixture-buffalo-1', { id: 'newer', updatedAt: '2026-10-02T00:00:00.000Z' }),
    ],
  })
  const row = view.rows[0]!
  assert.equal(row.kind === 'document' && row.card.started?.id, 'newer')
})

// ===================================================== questions in one card

test('a multipart document shows its questions TOGETHER in one card', () => {
  const view = checklistView({ set: BUFFALO, drafts: [] })
  assert.equal(view.rows.length, 1, 'ONE card for four questions and an optional fifth')
  const card = view.rows[0]!.kind === 'document' ? view.rows[0]! : null
  assert.ok(card)
  const questions = card.kind === 'document' ? card.card.questions : []
  assert.equal(questions.length, 5)
  assert.equal(questions.filter((q) => q.optional).length, 1)
  assert.match(questions[4]!.text, /Optional additional comments/)
})

test('an undivided prompt has no question list', () => {
  const view = checklistView({ set: RUTGERS, drafts: [] })
  for (const row of view.rows) {
    assert.deepEqual(row.kind === 'document' ? [...row.card.questions] : null, [])
  }
})

// ===================================================== the choice

test('a choice is ONE row offering both options', () => {
  const view = checklistView({ set: SIUE, drafts: [] })
  assert.equal(view.rows.length, 2)
  const choice = view.rows[0]!
  assert.equal(choice.kind, 'choice')
  assert.equal(choice.kind === 'choice' && choice.options.length, 2)
  assert.equal(choice.kind === 'choice' && choice.chosen, null)
  for (const option of choice.kind === 'choice' ? choice.options : []) {
    assert.equal(option.action, 'start')
  }
  assert.equal(view.requiredCount, 2, 'the choice plus the extra response')
})

test('ONCE AN OPTION IS STARTED THE CHOICE IS MADE', () => {
  const view = checklistView({
    set: SIUE, drafts: [draft('fixture-siue-choice-background')],
  })
  const choice = view.rows[0]!
  assert.equal(choice.kind === 'choice' && choice.chosen?.requirementId,
    'fixture-siue-choice-background')
  assert.equal(choice.kind === 'choice' && choice.chosen?.action, 'continue')
  assert.equal(view.startedCount, 1)
})

test('the OTHER option is still listed, so the applicant can see what it was', () => {
  const view = checklistView({
    set: SIUE, drafts: [draft('fixture-siue-choice-goals')],
  })
  const choice = view.rows[0]!
  assert.equal(choice.kind === 'choice' && choice.options.length, 2)
  const unchosen = choice.kind === 'choice'
    ? choice.options.find((o) => o.requirementId === 'fixture-siue-choice-background')
    : null
  assert.equal(unchosen?.started, null)
})

// ===================================================== limits on every card

test('every card shows its own limits, in its own unit', () => {
  const albany = checklistView({ set: ALBANY, drafts: [] })
  for (const row of albany.rows) {
    assert.equal(row.kind === 'document' && row.card.constraintSummary, '500 words maximum')
    assert.deepEqual(row.kind === 'document' ? [...row.card.liveCounts] : null, ['words'])
  }
  // A SUGGESTED LENGTH NEVER READS AS A MAXIMUM ON A CARD. The word "maximum"
  // is reserved for bounds the school made one.
  const davis = checklistView({ set: UC_DAVIS, drafts: [] })
  for (const row of davis.rows) {
    assert.equal(row.kind === 'document' && row.card.constraintSummary, '250 words suggested')
    assert.deepEqual(row.kind === 'document' ? [...row.card.liveCounts] : null, ['words'])
  }
  // And the character case, on a school that really has one.
  const utk = checklistView({ set: UT_KNOXVILLE, drafts: [] })
  const utkCard = utk.rows[0]!.kind === 'document' ? utk.rows[0]!.card : null
  assert.match(utkCard!.constraintSummary, /5,000–18,000 characters excluding spaces/)
  assert.match(utkCard!.constraintSummary, /3–5 pages \(double-spaced\)/)
  assert.deepEqual([...utkCard!.liveCounts], ['characters'])
})

test('EVERY REGISTER GETS ITS OWN WORDING ON A CARD', () => {
  // The five registers, side by side, as an applicant would read them.
  const summaryOf = (set: Parameters<typeof checklistView>[0]['set']) => {
    const row = checklistView({ set, drafts: [] }).rows[0]!
    return row.kind === 'document' ? row.card.constraintSummary : ''
  }
  assert.equal(summaryOf(ALBANY), '500 words maximum', 'enforced')
  assert.equal(summaryOf(UC_DAVIS), '250 words suggested', 'suggested')
  assert.equal(summaryOf(SOUTH_DAKOTA), '500 words (the stated length, not a maximum)', 'target')
  // Wayne State is the OPTION A case now: the sentence is shown and no bound is
  // stored, so there is no "1-2 pages" chip to render at all.
  assert.match(summaryOf(WAYNE_STATE), /The school states: /)
  assert.match(summaryOf(WAYNE_STATE), /not enforced here/)
  // The 'unknown' REGISTER still renders, for a row that stores a bound whose
  // standing a reviewer has recorded as undetermined.
  const unknownRegister: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ max: 500, enforcement: 'unknown', statedAs: 'the school’s words' }),
  }
  assert.equal(constraintSummary(unknownRegister),
    '500 words stated, without saying whether it is a limit')
  assert.match(summaryOf(SOUTHERN_MISS), /2 pages maximum \(double-spaced\)/)
  assert.match(summaryOf(SOUTHERN_MISS), /the school reads only this much/)
  // AND NOT ONE OF THEM MENTIONS A WORD COUNT FOR A PAGE LIMIT.
  for (const set of [WAYNE_STATE, SOUTHERN_MISS]) {
    assert.doesNotMatch(summaryOf(set), /\bwords?\b/i, set.schoolName)
  }
})

test('THE SCHOOL’S OWN SENTENCE REACHES THE CARD FOR EVERY SOFT REGISTER', () => {
  for (const set of [UC_DAVIS, SOUTH_DAKOTA, WAYNE_STATE, SOUTHERN_MISS]) {
    const row = checklistView({ set, drafts: [] }).rows[0]!
    const card = row.kind === 'document' ? row.card : null
    assert.ok(card!.statedWordings.length > 0, set.schoolName)
  }
  // A plain enforced limit needs no quotation and has none invented for it.
  const albany = checklistView({ set: ALBANY, drafts: [] }).rows[0]!
  assert.deepEqual(albany.kind === 'document' ? [...albany.card.statedWordings] : null, [])
})

test('A TRUNCATION POLICY IS SHOWN AS THE SCHOOL’S POLICY, NOT AS A MEASUREMENT', () => {
  const row = checklistView({ set: SOUTHERN_MISS, drafts: [] }).rows[0]!
  const card = row.kind === 'document' ? row.card : null
  assert.ok(card!.truncationNotice)
  assert.match(card!.truncationNotice!, /reads only the first 2 pages/)
  assert.match(card!.truncationNotice!, /Only the first two pages will be read/)
  // NO CLAIM ABOUT THIS DRAFT. There is no draft, and pages are unmeasurable.
  assert.doesNotMatch(card!.truncationNotice!, /your draft|this draft|you are over/i)
  // And a school with no such policy gets no notice.
  const albany = checklistView({ set: ALBANY, drafts: [] }).rows[0]!
  assert.equal(albany.kind === 'document' ? albany.card.truncationNotice : 'x', null)
})

test('A PAGE-LIMITED CARD SHOWS PAGES AND NO WORD ESTIMATE', () => {
  const view = checklistView({ set: RUTGERS, drafts: [] })
  for (const row of view.rows) {
    const card = row.kind === 'document' ? row.card : null
    assert.equal(card?.constraintSummary, '1 page maximum')
    assert.doesNotMatch(card!.constraintSummary, /word/i)
    assert.equal(card?.showUnmeasuredNotice, true)
    // The counter is words, with nothing to compare against -- which is honest.
    assert.deepEqual([...card!.liveCounts], ['words'])
    const measured = card!.constraints.filter((c) => c.measured)
    assert.deepEqual(measured, [], 'nothing on this card is checkable here')
  }
})

test('a card with nothing stated says so', () => {
  // Loyola, whose two official page limits disagree, so none is stored.
  const view = checklistView({ set: LOYOLA, drafts: [] })
  const card = view.rows[0]!.kind === 'document' ? view.rows[0] : null
  assert.equal(card!.kind === 'document' && card!.card.constraintSummary,
    'No length requirement stated')
  assert.equal(card!.kind === 'document' && card!.card.showUnmeasuredNotice, false)
})

test('the two Minnesota documents show DIFFERENT units side by side', () => {
  const view = checklistView({ set: MINNESOTA, drafts: [] })
  const summaries = view.rows.map((r) => r.kind === 'document' ? r.card.constraintSummary : null)
  assert.deepEqual(summaries, ['4 pages maximum (double-spaced)', '500 words maximum'])
})

// ===================================================== provenance on screen

test('AN UNVERIFIED SET CARRIES ITS WARNING', () => {
  const view = checklistView({ set: ALBANY, drafts: [] })
  assert.ok(view.verificationNotice)
  assert.match(view.verificationNotice!, /has not been verified/)
  assert.match(view.textAttribution, /not the school’s exact wording/)
})

test('a conflicting set says sources disagree, and both readings reach the card', () => {
  // Loyola is the conflicting example now. Ohio State's disagreement was
  // resolved by the verification and its limit is stored.
  const view = checklistView({ set: LOYOLA, drafts: [] })
  assert.match(view.verificationNotice!, /disagree/)
  const notes = view.rows[0]!.kind === 'document' ? view.rows[0]!.card.notes : []
  assert.match(notes.join(' '), /maximum of two pages/)
  assert.match(notes.join(' '), /limited to one page/)
  assert.match(view.notes.join(' '), /live on the same official site/)
})

test('the research text travels so the structuring can be audited', () => {
  for (const set of [ALBANY, RUTGERS, MINNESOTA, SIUE, UC_DAVIS, BUFFALO]) {
    const view = checklistView({ set, drafts: [] })
    assert.equal(view.originalText, set.originalText)
    assert.ok(view.originalText.length > 50, set.schoolName)
  }
})

// ===================================================== the optional supplement

test('an OPTIONAL document is listed but not counted as required', () => {
  const withOptional = {
    ...BUFFALO,
    requirements: [
      BUFFALO.requirements[0]!,
      { ...BUFFALO.requirements[0]!, id: 'extra', label: 'Optional Addendum', optional: true },
    ],
  }
  const view = checklistView({ set: withOptional, drafts: [] })
  assert.equal(view.rows.length, 2)
  assert.equal(view.requiredCount, 1)
  assert.equal(progressLabel(view), '1 required document')
})

test('WRITING AN OPTIONAL DOCUMENT CANNOT REPORT MORE STARTED THAN REQUIRED', () => {
  const withOptional = {
    ...BUFFALO,
    requirements: [
      BUFFALO.requirements[0]!,
      { ...BUFFALO.requirements[0]!, id: 'extra', label: 'Optional Addendum', optional: true },
    ],
  }
  const view = checklistView({
    set: withOptional, drafts: [draft('fixture-buffalo-1'), draft('extra')],
  })
  assert.equal(view.requiredCount, 1)
  assert.equal(view.startedCount, 1, 'not 2')
  assert.ok(view.startedCount <= view.requiredCount)
  assert.equal(progressLabel(view), 'All 1 started')
})

test('a set with no required writing says so rather than "0 of 0"', () => {
  const allOptional = {
    ...BUFFALO,
    requirements: [{ ...BUFFALO.requirements[0]!, optional: true }],
  }
  const view = checklistView({ set: allOptional, drafts: [] })
  assert.equal(view.requiredCount, 0)
  assert.equal(progressLabel(view), 'No required writing recorded')
})
