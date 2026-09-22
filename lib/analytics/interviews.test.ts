import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  completionRate,
  followUpLabel,
  grantState,
  isStarted,
  lengthLabel,
  modeLabel,
  totalGrants,
  typeLabel,
  type GrantRow,
} from './interviews.ts'

const NOW = new Date('2026-09-22T16:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString()

const grant = (overrides: Partial<GrantRow> = {}): GrantRow => ({
  created_at: hoursAgo(1),
  completed: false,
  session_id: 'session-1',
  abandoned_at: null,
  ...overrides,
})

// --- the states -------------------------------------------------------------

test('a finished interview is completed', () => {
  assert.equal(grantState(grant({ completed: true }), NOW), 'completed')
})

test('a completed interview stays completed even if it was also abandoned', () => {
  // completeGrant and abandonGrant write different columns; finishing wins.
  assert.equal(grantState(grant({ completed: true, abandoned_at: hoursAgo(1) }), NOW), 'completed')
})

test('an interview the applicant gave up is abandoned, not completed', () => {
  assert.equal(grantState(grant({ abandoned_at: hoursAgo(1) }), NOW), 'abandoned')
})

test('a grant abandoned before it was ever bound to a session is a void, not an interview', () => {
  // issueInterview() voids a grant this way when the entitlement charge fails.
  // Its id never reached a browser, so nobody ever started this interview.
  const voided = grant({ abandoned_at: hoursAgo(1), session_id: null })

  assert.equal(grantState(voided, NOW), 'voided')
  assert.equal(isStarted('voided'), false)
})

test('an interview inside its resume window is still in progress', () => {
  assert.equal(grantState(grant({ created_at: hoursAgo(2) }), NOW), 'in_progress')
  assert.equal(grantState(grant({ created_at: hoursAgo(23.9) }), NOW), 'in_progress')
})

test('past 24 hours an unfinished interview can no longer be resumed', () => {
  assert.equal(grantState(grant({ created_at: hoursAgo(25) }), NOW), 'unfinished')
})

test('a grant from before resume existed is judged by age alone', () => {
  // Every grant issued before 21 Sep has a null session_id and no abandoned_at.
  const old = { created_at: '2026-09-01T10:00:00.000Z', completed: false, session_id: null, abandoned_at: null }

  assert.equal(grantState(old, NOW), 'unfinished')
  assert.equal(grantState({ ...old, completed: true }, NOW), 'completed')
})

test('an unreadable timestamp does not become in-progress by accident', () => {
  assert.equal(grantState(grant({ created_at: 'nonsense' }), NOW), 'unfinished')
})

// --- totals -----------------------------------------------------------------

test('starts exclude voids but include everything else', () => {
  const totals = totalGrants(
    [
      grant({ completed: true }),
      grant({ completed: true }),
      grant({ abandoned_at: hoursAgo(2) }),
      grant({ abandoned_at: hoursAgo(2), session_id: null }), // void
      grant({ created_at: hoursAgo(3) }), // in progress
      grant({ created_at: hoursAgo(72) }), // unfinished
    ],
    NOW
  )

  assert.deepEqual(totals, {
    started: 5,
    completed: 2,
    abandoned: 1,
    voided: 1,
    inProgress: 1,
    unfinished: 1,
  })
})

test('an empty window totals to zeroes, which is a real answer here', () => {
  assert.deepEqual(totalGrants([], NOW), {
    started: 0,
    completed: 0,
    abandoned: 0,
    voided: 0,
    inProgress: 0,
    unfinished: 0,
  })
})

// --- completion rate --------------------------------------------------------

test('completion rate ignores interviews that are still running', () => {
  const totals = totalGrants(
    [
      grant({ completed: true }),
      grant({ abandoned_at: hoursAgo(2) }),
      grant({ created_at: hoursAgo(1) }), // still resumable
      grant({ created_at: hoursAgo(1) }), // still resumable
    ],
    NOW
  )

  // One completed of two settled, not one of four.
  assert.equal(completionRate(totals), 50)
})

test('a rate over nothing is null, never zero', () => {
  const totals = totalGrants([grant({ created_at: hoursAgo(1) })], NOW)

  assert.equal(completionRate(totals), null)
})

// --- labels -----------------------------------------------------------------

test('Quick and Full are named, and pre-Phase-3 grants are not silently called Full', () => {
  assert.equal(lengthLabel(5), 'Quick (5 questions)')
  assert.equal(lengthLabel(10), 'Full (10 questions)')
  assert.equal(lengthLabel(null), 'Before Quick/Full existed (10 questions)')
  assert.equal(lengthLabel(undefined), 'Before Quick/Full existed (10 questions)')
})

test('the follow-up choice distinguishes off from never-asked', () => {
  assert.equal(followUpLabel(true), 'Follow-ups on')
  assert.equal(followUpLabel(false), 'Follow-ups off')
  assert.equal(followUpLabel(null), 'Before the choice existed (on)')
})

test('types and modes read as words, and an unknown value is shown as itself', () => {
  assert.equal(typeLabel('emotional'), 'Emotional intelligence')
  assert.equal(typeLabel('custom'), 'Custom topic')
  assert.equal(typeLabel(null), 'Not recorded')
  assert.equal(typeLabel('something-new'), 'something-new')
  assert.equal(modeLabel('real'), 'Real interview (feedback at the end)')
  assert.equal(modeLabel(null), 'Not recorded')
})
