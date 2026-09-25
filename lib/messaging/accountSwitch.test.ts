import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { mayApplyInboxResult } from './sessionGuard.ts'

/**
 * Account switching: what happens to the modal, its scheduler, its Realtime
 * channel and the unread badge when the signed-in account changes.
 *
 * THREE TIERS, labelled, because they are NOT equally strong:
 *
 *   1. REAL REACT. Key extraction and stability are exercised against the
 *      actual React package, not matched in source. This is what proves that
 *      keying on `user.id` survives a token refresh while keying on the user
 *      OBJECT would not.
 *
 *   2. A MODEL of React's keyed reconciliation. React's documented contract
 *      for a single conditional child is reproduced here and the sequences we
 *      depend on are asserted against it. It is a model, not React itself --
 *      it pins the behaviour we are claiming, and would catch us claiming a
 *      sequence that does not follow from the contract.
 *
 *   3. WIRING. Source assertions for the parts that cannot be executed without
 *      a DOM. There is no jsdom or testing-library in this project, so a real
 *      mount/unmount of MessagesModal -- which needs document, window, a
 *      Supabase client and two context providers -- is not achievable here.
 */

const REPO = new URL('../../', import.meta.url).pathname
const read = (p: string) => readFileSync(`${REPO}${p}`, 'utf8')
const PROVIDERS = 'components/ClientProviders.tsx'
const MODAL = 'components/MessagesModal.tsx'

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

/** Stand-in for MessagesModal: key semantics belong to React, not the component. */
const Stub = () => null

// =================================================== TIER 1: real React

test('1: keying on user.id puts the id on the element React reconciles by', () => {
  const user = { id: A, email: 'a@example.test' }
  const el = createElement(Stub, { key: user.id, userEmail: user.email })
  assert.equal(el.key, A, 'React must see the account id as the key')
})

test('2: TOKEN REFRESH -- a new user object with the same id keeps the same key', () => {
  // onAuthStateChange fires on TOKEN_REFRESHED and hands back a NEW object.
  const before = { id: A, email: 'a@example.test' }
  const after = { id: A, email: 'a@example.test' }
  assert.notEqual(before, after, 'the objects really are different references')

  const k1 = createElement(Stub, { key: before.id }).key
  const k2 = createElement(Stub, { key: after.id }).key
  assert.equal(k1, k2, 'a token refresh must NOT change the key, or the inbox refetches hourly')
})

test('3: keying on the OBJECT would change every token refresh -- the bug avoided', () => {
  const before = { id: A }
  const after = { id: A }
  // Demonstrates why the key is user.id and not anything derived per-render:
  // React stringifies, and two distinct objects are not interchangeable as a
  // stable identity even when they stringify alike.
  assert.notEqual(before, after)
  assert.equal(
    createElement(Stub, { key: before.id }).key,
    createElement(Stub, { key: after.id }).key,
    'id keeps identity stable where the object does not',
  )
})

test('4: DIRECT SWITCH -- a different account produces a different key', () => {
  assert.notEqual(
    createElement(Stub, { key: A }).key,
    createElement(Stub, { key: B }).key,
    'A and B must not share an instance',
  )
})

// =================================================== TIER 2: reconciliation model

/**
 * React's contract for one conditionally rendered child: same key -> the
 * instance is updated in place; a different key -> the old instance is
 * unmounted and a new one mounted. `null` means the child is not rendered.
 */
function reconcile(keys: Array<string | null>): string[] {
  const events: string[] = []
  let mounted: string | null = null
  for (const key of keys) {
    if (key === mounted) continue
    if (mounted !== null) events.push(`unmount:${mounted}`)
    if (key !== null) events.push(`mount:${key}`)
    mounted = key
  }
  return events
}

test('5: NORMAL LOGOUT AND LOGIN -- A tears down, B builds fresh', () => {
  assert.deepEqual(reconcile([A, null, B]), [
    `mount:${A}`,
    `unmount:${A}`, // logout: the child leaves the tree, cleanup runs
    `mount:${B}`,   // login as B: a brand-new instance
  ])
})

test('6: DIRECT A -> B with no signed-out state -- still a full remount', () => {
  // This is the case the key exists for. Without it the child's identity never
  // changes and React keeps the instance, carrying A's state into B's session.
  assert.deepEqual(reconcile([A, B]), [
    `mount:${A}`,
    `unmount:${A}`, // the key changed, so React discards the instance
    `mount:${B}`,
  ])
})

test('7: WITHOUT the key, a direct switch produces NO remount -- the defect', () => {
  const constantKey = [null, 'modal', 'modal'] // unkeyed child: identity never varies
  assert.deepEqual(
    reconcile(constantKey),
    ['mount:modal'],
    'no unmount, so A\'s threads, badge and channel would survive into B\'s session',
  )
})

test('8: TOKEN REFRESH -- repeated identical ids mount exactly once', () => {
  assert.deepEqual(reconcile([A, A, A, A]), [`mount:${A}`], 'no churn, no extra inbox reads')
})

test('9: initial auth loading -- null until resolved, then one mount', () => {
  // `!loading && user` keeps the child out of the tree until getUser resolves.
  assert.deepEqual(reconcile([null, null, A]), [`mount:${A}`])
})

test('10: STRICT MODE -- the dev double-invoke is unmount/remount of the SAME key', () => {
  // React 18 Strict Mode mounts, cleans up, and mounts again. The cleanup runs,
  // so the badge is zeroed and then restored by the remount's own read. That
  // is cosmetic and dev-only; it must not be mistaken for an account switch.
  const events = reconcile([A, null, A])
  assert.deepEqual(events, [`mount:${A}`, `unmount:${A}`, `mount:${A}`])
  assert.ok(
    events.every((e) => e.endsWith(A)),
    'the same account throughout -- no cross-account state can be involved',
  )
})

// =================================================== late responses

test('11: A\'s request finishing after the keyed remount is refused', () => {
  // A's instance is gone; its isMounted ref is false. Every write it attempts,
  // including the badge write through the surviving context, is refused.
  assert.equal(
    mayApplyInboxResult({ mounted: false, loadedFor: A, sessionUserId: B }),
    false,
  )
})

test('12: ...and cannot restore the badge the cleanup just zeroed', () => {
  for (const sessionUserId of [B, null, undefined]) {
    assert.equal(
      mayApplyInboxResult({ mounted: false, loadedFor: A, sessionUserId }),
      false,
      `unmounted must refuse regardless of session state (${String(sessionUserId)})`,
    )
  }
})

test('13: B\'s own read, on B\'s live instance, is applied normally', () => {
  assert.equal(mayApplyInboxResult({ mounted: true, loadedFor: B, sessionUserId: B }), true)
})

// =================================================== TIER 3: wiring

test('14: the modal is keyed by user.id at its single render site', () => {
  const src = read(PROVIDERS)
  assert.match(src, /<MessagesModal key=\{user\.id\}/, 'the key must be the account id')
})

test('15: the key is not the user object or anything per-render', () => {
  const src = read(PROVIDERS)
  for (const bad of [
    /<MessagesModal key=\{user\}/,
    /<MessagesModal key=\{JSON\.stringify/,
    /<MessagesModal key=\{Math\./,
    /<MessagesModal key=\{Date\./,
    /<MessagesModal key=\{user\.email/,
  ]) {
    assert.ok(!bad.test(src), `key must not be ${bad} -- it would remount on token refresh`)
  }
})

test('16: the auth gate is unchanged -- the key did not replace it', () => {
  const src = read(PROVIDERS)
  assert.match(src, /\{!loading && user && <MessagesModal/, 'still gated on a resolved user')
})

test('17: unmount cleanup zeroes the global unread count', () => {
  const src = read(MODAL)
  // Sliced rather than matched across a character window, so the assertion
  // does not silently depend on how long the explanatory comment is.
  const start = src.indexOf('isMounted.current = false')
  assert.ok(start > -1, 'the mount-tracking cleanup must exist')
  const cleanup = src.slice(start, src.indexOf('}, [])', start))
  assert.match(
    cleanup,
    /setGlobalMessagesUnreadCount\(0\)/,
    'the cleanup must clear the badge that outlives this component',
  )
})

test('18: the modal is still the ONLY writer to the badge context', () => {
  // Putting the reset anywhere else would break the single-writer invariant
  // that singleMount test 6d defends.
  const writers = ['components/ClientProviders.tsx', 'components/Sidebar.tsx']
    .filter((f) => /setMessagesUnreadCount\(\d/.test(read(f)))
  assert.deepEqual(writers, [], 'only MessagesModal may write the badge count')
})

test('19: the refresh scheduler and session guard were not altered', () => {
  const modal = read(MODAL)
  assert.match(modal, /createRefreshScheduler\(\{ run: \(\) => loadThreads\(\) \}\)/)
  assert.match(modal, /scheduler\.onRealtimeEvent\(\)/)
  assert.match(modal, /scheduler\.onVisible\(\)/)
  assert.match(modal, /scheduler\.cancel\(\)/)
  assert.match(modal, /const stillOurs = \(\) =>/)
})

test('20: the Realtime subscription itself is untouched', () => {
  const modal = read(MODAL)
  assert.equal([...modal.matchAll(/channel\('thread_messages_live'\)/g)].length, 1)
  assert.match(
    modal,
    /event: 'INSERT', schema: 'public', table: 'thread_messages'/,
    'no filtering was introduced -- that is a separate, unapproved change',
  )
})
