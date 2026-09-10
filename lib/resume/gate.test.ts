import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKED_BODY, resumeV2Access } from './gate.ts'

/**
 * The gate on an unreleased feature. There is exactly one way through it, and
 * a phase that forgets to call it ships a half-built resume builder to users.
 */

test('an admin is let through', () => {
  assert.deepEqual(resumeV2Access({ isAdmin: true }), { allowed: true })
})

test('everyone else is refused', () => {
  assert.deepEqual(resumeV2Access({ isAdmin: false }), { allowed: false, status: 404 })
})

test('a refusal is a 404, so the route does not advertise itself', () => {
  const access = resumeV2Access({ isAdmin: false })
  assert.equal(access.allowed, false)
  if (!access.allowed) assert.equal(access.status, 404, 'a 403 would confirm the route exists')
  assert.deepEqual(BLOCKED_BODY, { error: 'Not found' })
})

test('the refusal body says nothing about resumes, tiers or permission', () => {
  const text = JSON.stringify(BLOCKED_BODY).toLowerCase()
  for (const leak of ['resume', 'admin', 'tier', 'permission', 'forbidden', 'v2']) {
    assert.equal(text.includes(leak), false, `leaked "${leak}"`)
  }
})

test('the gate is closed by default for anything that is not a true boolean', () => {
  for (const value of [undefined, null, 0, '', 'true', NaN]) {
    const access = resumeV2Access({ isAdmin: value as unknown as boolean })
    assert.equal(access.allowed, false, `"${String(value)}" must not open the gate`)
  }
})
