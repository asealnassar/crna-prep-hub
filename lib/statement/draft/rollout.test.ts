import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANALYSIS_CACHE_ENV, PROMPT_SUBMISSIONS_ENV, REQUIREMENTS_ENV, analysisCacheEnabled,
  promptSubmissionsEnabled, requirementsEnabled,
} from './rollout.ts'

test('the feature is OFF unless the variable is exactly "on"', () => {
  // Every environment today, the owner's localhost included. Off means not one
  // query naming a table or column the database has not been migrated to have.
  assert.equal(promptSubmissionsEnabled({}), false)
  for (const notOn of ['', 'off', 'true', 'TRUE', '1', 'yes', 'ON', 'On', ' on', 'on ', 'enabled']) {
    assert.equal(promptSubmissionsEnabled({ [PROMPT_SUBMISSIONS_ENV]: notOn }), false, notOn)
  }
})

test('the feature is on for exactly one value', () => {
  assert.equal(promptSubmissionsEnabled({ [PROMPT_SUBMISSIONS_ENV]: 'on' }), true)
})

test('the variable is not the Studio gate, and cannot be confused with it', () => {
  assert.equal(PROMPT_SUBMISSIONS_ENV, 'STATEMENT_PROMPT_SUBMISSIONS')
  assert.notEqual(PROMPT_SUBMISSIONS_ENV, 'STATEMENT_STUDIO_MODE')
  // Turning the Studio on must not turn this on.
  assert.equal(promptSubmissionsEnabled({ STATEMENT_STUDIO_MODE: 'internal' }), false)
})

test('the analysis cache is OFF unless the variable is exactly "on"', () => {
  assert.equal(analysisCacheEnabled({}), false)
  for (const notOn of ['', 'off', 'true', 'TRUE', '1', 'ON', ' on', 'on ', 'enabled']) {
    assert.equal(analysisCacheEnabled({ [ANALYSIS_CACHE_ENV]: notOn }), false, notOn)
  }
  assert.equal(analysisCacheEnabled({ [ANALYSIS_CACHE_ENV]: 'on' }), true)
})

test('the two rollout flags are independent', () => {
  // Different features, different migrations. One variable would mean turning
  // on whichever was ready last.
  assert.notEqual(ANALYSIS_CACHE_ENV, PROMPT_SUBMISSIONS_ENV)
  assert.equal(analysisCacheEnabled({ [PROMPT_SUBMISSIONS_ENV]: 'on' }), false)
  assert.equal(promptSubmissionsEnabled({ [ANALYSIS_CACHE_ENV]: 'on' }), false)
})

test('the requirement catalog is OFF unless the variable is exactly "on"', () => {
  assert.equal(requirementsEnabled({}), false)
  for (const notOn of ['', 'off', 'true', 'TRUE', '1', 'ON', ' on', 'on ', 'enabled']) {
    assert.equal(requirementsEnabled({ [REQUIREMENTS_ENV]: notOn }), false, notOn)
  }
  assert.equal(requirementsEnabled({ [REQUIREMENTS_ENV]: 'on' }), true)
})

test('all THREE rollout flags are independent', () => {
  // Three features, three migrations. One variable would mean turning on
  // whichever was ready last.
  const names = [PROMPT_SUBMISSIONS_ENV, ANALYSIS_CACHE_ENV, REQUIREMENTS_ENV]
  assert.equal(new Set(names).size, 3)
  for (const [name, read] of [
    [PROMPT_SUBMISSIONS_ENV, promptSubmissionsEnabled],
    [ANALYSIS_CACHE_ENV, analysisCacheEnabled],
    [REQUIREMENTS_ENV, requirementsEnabled],
  ] as const) {
    for (const other of names.filter((n) => n !== name)) {
      assert.equal(read({ [other]: 'on' }), false, `${other} must not enable ${name}`)
    }
    assert.equal(read({ [name]: 'on' }), true, name)
  }
})

test('turning the Studio on does not turn the requirement catalog on', () => {
  assert.equal(requirementsEnabled({ STATEMENT_STUDIO_MODE: 'internal' }), false)
})
