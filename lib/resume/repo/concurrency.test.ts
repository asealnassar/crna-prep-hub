import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideWrite, isRecoverable, refusalMessage } from './concurrency.ts'
import type { WriteRefusal } from './concurrency.ts'

/**
 * Write admission.
 *
 * V1's edit page issues one UPDATE per section, discards every error, and
 * reports success regardless. These are the checks that make that impossible.
 */

const stored = (over: Partial<{ userId: string; revision: number; schemaVersion: number }> = {}) => ({
  userId: 'u1', revision: 3, schemaVersion: 2, ...over,
})

test('a matching revision is admitted and increments', () => {
  const d = decideWrite({ stored: stored(), actingUserId: 'u1', expectedRevision: 3 })
  assert.equal(d.ok, true)
  if (d.ok) assert.equal(d.nextRevision, 4)
})

test('a stale revision is refused rather than overwriting', () => {
  const d = decideWrite({ stored: stored({ revision: 5 }), actingUserId: 'u1', expectedRevision: 3 })
  assert.equal(d.ok, false)
  if (!d.ok) {
    assert.equal(d.reason, 'stale-revision')
    assert.match(d.detail, /expected 3, stored 5/)
  }
})

test('a revision from the future is also refused', () => {
  // Not a real scenario, but "not equal" is the rule, not "less than".
  const d = decideWrite({ stored: stored({ revision: 2 }), actingUserId: 'u1', expectedRevision: 9 })
  assert.equal(d.ok, false)
  if (!d.ok) assert.equal(d.reason, 'stale-revision')
})

test('a missing row is a refusal, never an insert', () => {
  const d = decideWrite({ stored: null, actingUserId: 'u1', expectedRevision: 1 })
  assert.equal(d.ok, false)
  if (!d.ok) assert.equal(d.reason, 'not-found')
})

test('another user’s resume is refused', () => {
  const d = decideWrite({ stored: stored({ userId: 'someone-else' }), actingUserId: 'u1', expectedRevision: 3 })
  assert.equal(d.ok, false)
  if (!d.ok) assert.equal(d.reason, 'not-owner')
})

test('a V1 row is refused, so V2 cannot write over it', () => {
  const d = decideWrite({ stored: stored({ schemaVersion: 1 }), actingUserId: 'u1', expectedRevision: 3 })
  assert.equal(d.ok, false)
  if (!d.ok) {
    assert.equal(d.reason, 'wrong-schema-version')
    assert.match(d.detail, /schema_version=1/)
  }
})

test('ownership is checked before the revision', () => {
  // Otherwise a wrong-revision message would confirm the resume exists.
  const d = decideWrite({
    stored: stored({ userId: 'someone-else', revision: 99 }),
    actingUserId: 'u1', expectedRevision: 3,
  })
  assert.equal(d.ok, false)
  if (!d.ok) assert.equal(d.reason, 'not-owner')
})

test('not-found and not-owner read identically to the applicant', () => {
  assert.equal(refusalMessage('not-found'), refusalMessage('not-owner'))
  assert.doesNotMatch(refusalMessage('not-owner'), /another user|owner|permission/i)
})

test('every refusal has a message and none of them blames the user', () => {
  const reasons: WriteRefusal[] = ['not-found', 'not-owner', 'wrong-schema-version', 'stale-revision']
  for (const reason of reasons) {
    const message = refusalMessage(reason)
    assert.ok(message.length > 0, reason)
    assert.doesNotMatch(message, /error|failed|invalid/i, `${reason} should explain, not scold`)
  }
})

test('only a stale revision is worth retrying', () => {
  assert.equal(isRecoverable('stale-revision'), true)
  assert.equal(isRecoverable('not-found'), false)
  assert.equal(isRecoverable('not-owner'), false)
  assert.equal(isRecoverable('wrong-schema-version'), false)
})

test('the conflict message tells the applicant what to do', () => {
  assert.match(refusalMessage('stale-revision'), /reload/i)
})
