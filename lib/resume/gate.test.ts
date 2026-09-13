import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKED_BODY, UNAUTHORIZED_BODY, resumeV2Access } from './gate.ts'
import type { ResumeBuilderMode } from './rollout.ts'

/**
 * The rollout gate. There is exactly one way through it, and a phase that gets
 * it wrong either ships a half-built resume builder to everyone or leaves the
 * finished one switched off for everyone.
 */

const access = (mode: ResumeBuilderMode, isAuthenticated: boolean, isAdmin: boolean) =>
  resumeV2Access({ mode, isAuthenticated, isAdmin })

// --- the whole matrix, stated once -----------------------------------------

test('v1 mode: only a signed-in admin is let through', () => {
  assert.deepEqual(access('v1', true, true), { allowed: true })
  assert.deepEqual(access('v1', true, false), { allowed: false, status: 404, reason: 'hidden' })
})

test('v2 mode: every signed-in user is let through, admin or not', () => {
  assert.deepEqual(access('v2', true, false), { allowed: true })
  assert.deepEqual(access('v2', true, true), { allowed: true })
})

test('an anonymous request never reaches V2, in either mode', () => {
  assert.equal(access('v1', false, false).allowed, false)
  assert.equal(access('v2', false, false).allowed, false)
})

test('an anonymous request cannot be admitted by claiming to be an admin', () => {
  // isAdmin is derived from a verified session, so this combination should be
  // unreachable -- which is exactly why it is worth pinning down.
  assert.equal(access('v1', false, true).allowed, false)
  assert.equal(access('v2', false, true).allowed, false)
})

// --- what each refusal tells the caller ------------------------------------

test('v1 mode tells an anonymous probe nothing, not even to sign in', () => {
  const result = access('v1', false, false)
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.status, 404, 'V2 does not exist for the public yet')
})

test('v2 mode asks an anonymous visitor to sign in, because V2 is live', () => {
  const result = access('v2', false, false)
  assert.equal(result.allowed, false)
  if (!result.allowed) {
    assert.equal(result.status, 401)
    assert.equal(result.reason, 'sign-in')
  }
})

test('a signed-in non-admin in v1 mode gets a 404, never a 403', () => {
  const result = access('v1', true, false)
  assert.equal(result.allowed, false)
  if (!result.allowed) {
    assert.equal(result.status, 404, 'a 403 would confirm the route exists for someone else')
    assert.equal(result.reason, 'hidden')
  }
})

test('the refusal bodies say nothing about resumes, tiers or permission', () => {
  for (const body of [BLOCKED_BODY, UNAUTHORIZED_BODY]) {
    const text = JSON.stringify(body).toLowerCase()
    for (const leak of ['resume', 'admin', 'tier', 'permission', 'v2', 'mode', 'rollout']) {
      assert.equal(text.includes(leak), false, `leaked "${leak}"`)
    }
  }
  assert.deepEqual(BLOCKED_BODY, { error: 'Not found' })
  assert.deepEqual(UNAUTHORIZED_BODY, { error: 'Unauthorized' })
})

// --- the gate is closed by default -----------------------------------------

test('nothing but a true boolean opens the admin path in v1 mode', () => {
  for (const value of [undefined, null, 0, '', 'true', NaN, 1, {}]) {
    const result = resumeV2Access({
      isAdmin: value as unknown as boolean, isAuthenticated: true, mode: 'v1',
    })
    assert.equal(result.allowed, false, `isAdmin "${String(value)}" must not open the gate`)
  }
})

test('nothing but a true boolean satisfies the authentication check', () => {
  for (const value of [undefined, null, 0, '', 'true', NaN, 1, {}]) {
    for (const mode of ['v1', 'v2'] as const) {
      const result = resumeV2Access({
        isAdmin: true, isAuthenticated: value as unknown as boolean, mode,
      })
      assert.equal(
        result.allowed, false,
        `isAuthenticated "${String(value)}" must not pass in ${mode} mode`
      )
    }
  }
})

test('an unrecognised mode value behaves as v1, not as v2', () => {
  // parseMode should make this unreachable. If something ever hands the gate a
  // raw string anyway, the failure must still be towards keeping V2 hidden.
  for (const mode of [undefined, null, '', 'V2', 'v3', true]) {
    const result = resumeV2Access({
      isAdmin: false, isAuthenticated: true, mode: mode as unknown as ResumeBuilderMode,
    })
    assert.equal(result.allowed, false, `mode "${String(mode)}" must not admit a non-admin`)
  }
})

test('the gate never considers subscription tier', () => {
  // Entitlements are resolved from the database in entitlement.ts. If the gate
  // ever grew a tier input, Free and Premium users would lose the builder.
  const signature = resumeV2Access.toString()
  for (const word of ['tier', 'ultimate', 'premium', 'free', 'entitle']) {
    assert.equal(
      signature.toLowerCase().includes(word), false,
      `the gate must not read "${word}" -- the builder is available to every tier`
    )
  }
})
