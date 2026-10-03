import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checklistView, progressLabel, type StartedDraft } from './checklistView.ts'
import { ALBANY, BUFFALO, MINNESOTA, OHIO_STATE, RUTGERS, SIUE, UC_DAVIS } from './fixtures.ts'

const draft = (requirementId: string, over: Partial<StartedDraft> = {}): StartedDraft => ({
  id: `draft-${requirementId}`, requirementId, title: 'A draft',
  updatedAt: '2026-10-01T12:00:00.000Z', words: 300, ...over,
})

// ===================================================== nothing is eager

test('a five-document school starts with FIVE OFFERS AND NO DRAFTS', () => {
  const view = checklistView({ set: UC_DAVIS, drafts: [] })
  assert.equal(view.rows.length, 5)
  assert.equal(view.requiredCount, 5)
  assert.equal(view.startedCount, 0)
  for (const row of view.rows) {
    assert.equal(row.kind, 'document')
    assert.equal(row.kind === 'document' && row.card.action, 'start')
    assert.equal(row.kind === 'document' && row.card.started, null)
  }
  assert.equal(progressLabel(view), '5 required documents')
})

test('starting one does not touch the others', () => {
  const view = checklistView({
    set: UC_DAVIS, drafts: [draft('fixture-uc-davis-leadership')],
  })
  const actions = view.rows.map((r) => r.kind === 'document' ? r.card.action : 'choice')
  assert.deepEqual(actions, ['start', 'continue', 'start', 'start', 'start'])
  assert.equal(view.startedCount, 1)
  assert.equal(progressLabel(view), '1 of 5 started')
})

test('every document started reads as all started', () => {
  const view = checklistView({
    set: UC_DAVIS, drafts: UC_DAVIS.requirements.map((r) => draft(r.id)),
  })
  assert.equal(progressLabel(view), 'All 5 started')
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
  const davis = checklistView({ set: UC_DAVIS, drafts: [] })
  for (const row of davis.rows) {
    assert.equal(row.kind === 'document' && row.card.constraintSummary,
      '2,500 characters maximum including spaces')
    assert.deepEqual(row.kind === 'document' ? [...row.card.liveCounts] : null, ['characters'])
  }
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
  const view = checklistView({ set: OHIO_STATE, drafts: [] })
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
  const view = checklistView({ set: OHIO_STATE, drafts: [] })
  assert.match(view.verificationNotice!, /disagree/)
  const notes = view.rows[0]!.kind === 'document' ? view.rows[0]!.card.notes : []
  assert.match(notes.join(' '), /three SINGLE-spaced pages/)
  assert.match(notes.join(' '), /three DOUBLE-spaced pages/)
  assert.match(view.notes.join(' '), /flags this entry as conflicting/)
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
