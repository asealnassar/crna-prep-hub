import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mayApplyInboxResult } from './sessionGuard.ts'

/**
 * The account-switch guard. No React, no DOM, no network.
 *
 * Every case below is a real sequence the component can experience, named for
 * the sequence rather than for the boolean it produces.
 */

const REPO = new URL('../../', import.meta.url).pathname
const read = (p: string) => readFileSync(`${REPO}${p}`, 'utf8')
const MODAL = 'components/MessagesModal.tsx'

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

// ------------------------------------------------- the normal case

test('1: the same user, still mounted -- the result is applied', () => {
  assert.equal(
    mayApplyInboxResult({ mounted: true, loadedFor: A, sessionUserId: A }),
    true,
  )
})

test('2: the session has not resolved yet -- applied, since no mismatch is provable', () => {
  // Only possible between mount and the first auth resolution, during which
  // no account change can have occurred.
  assert.equal(
    mayApplyInboxResult({ mounted: true, loadedFor: A, sessionUserId: undefined }),
    true,
  )
})

// ------------------------------------------------- path 1: logout, then login

test('3: LOGOUT -- A\'s read finishes after the modal unmounted', () => {
  // This is the unread-count leak: setThreads is discarded by React, but
  // setGlobalMessagesUnreadCount writes to SidebarContext, which outlives the
  // modal. Without this guard, A's count lands on the next account's badge.
  assert.equal(
    mayApplyInboxResult({ mounted: false, loadedFor: A, sessionUserId: null }),
    false,
    'nothing may be written after unmount',
  )
})

test('4: LOGOUT then LOGIN as B -- A\'s late read must not reach B', () => {
  // B has mounted a fresh modal; A's read belongs to the unmounted instance.
  assert.equal(
    mayApplyInboxResult({ mounted: false, loadedFor: A, sessionUserId: B }),
    false,
  )
})

test('5: signed out while still mounted -- nothing is applied', () => {
  assert.equal(
    mayApplyInboxResult({ mounted: true, loadedFor: A, sessionUserId: null }),
    false,
    'a signed-out session must not render the previous inbox',
  )
})

// ------------------------------------------------- path 2: direct A -> B switch

test('6: DIRECT SWITCH -- another tab signs in as B, no SIGNED_OUT in between', () => {
  // The modal stays mounted, so without this guard EVERY write lands --
  // including the thread list itself, showing A's conversations to B.
  assert.equal(
    mayApplyInboxResult({ mounted: true, loadedFor: A, sessionUserId: B }),
    false,
    "A's thread list must never render under B's session",
  )
})

test('7: the reverse switch is equally blocked', () => {
  assert.equal(
    mayApplyInboxResult({ mounted: true, loadedFor: B, sessionUserId: A }),
    false,
  )
})

test('8: switching away and back to A before the read lands -- applied', () => {
  // A -> B -> A. The session id matches again, and the data is A's, so it is
  // correct to render it. Blocking here would be over-strict.
  assert.equal(
    mayApplyInboxResult({ mounted: true, loadedFor: A, sessionUserId: A }),
    true,
  )
})

// ------------------------------------------------- unmount dominates

test('9: unmounted blocks even when the session still matches', () => {
  assert.equal(
    mayApplyInboxResult({ mounted: false, loadedFor: A, sessionUserId: A }),
    false,
    'an unmounted component must not write through a surviving context',
  )
})

test('10: unmounted blocks even before the session resolves', () => {
  assert.equal(
    mayApplyInboxResult({ mounted: false, loadedFor: A, sessionUserId: undefined }),
    false,
  )
})

// ------------------------------------------------- the component uses it

test('11: every state write in loadThreads is behind the guard', () => {
  const src = read(MODAL)
  const body = src.slice(
    src.indexOf('const loadThreads = async'),
    src.indexOf('const loadThread ='),
  )
  assert.ok(body.length > 0, 'loadThreads must still be findable')

  // The three write clusters: empty inbox, read failure, and the result.
  const writes = [...body.matchAll(/set(Threads|GlobalMessagesUnreadCount|LoadFailed|MetaDegraded)\(/g)]
  assert.ok(writes.length >= 7, `expected the known write sites, found ${writes.length}`)

  // The guard is defined once from mayApplyInboxResult and invoked at each
  // write cluster, rather than repeating the call expression four times.
  assert.match(
    body,
    /const stillOurs = \(\) =>\s*mayApplyInboxResult\(\{/,
    'the guard must be derived from mayApplyInboxResult',
  )
  const guards = [...body.matchAll(/if \(!stillOurs\(\)\) return/g)]
  assert.ok(
    guards.length >= 4,
    `every write cluster needs a guard; found ${guards.length}`,
  )

  // And no write cluster may sit before its guard: the final render write in
  // particular must be immediately preceded by one.
  assert.match(
    body,
    /if \(!stillOurs\(\)\) return\s*\n\s*setThreads\(combined\)/,
    'the result write must be guarded immediately before it happens',
  )
})

test('12: the guard reads a ref, never a fresh network call', () => {
  const src = read(MODAL)
  const body = src.slice(
    src.indexOf('const loadThreads = async'),
    src.indexOf('const loadThread ='),
  )
  // Exactly one getUser() in loadThreads: the one that starts it. A second
  // would add an Auth round trip per refresh, which is the opposite of the
  // point of this work.
  const calls = [...body.matchAll(/auth\.getUser\(\)/g)]
  assert.equal(calls.length, 1, 'the guard must not cost another auth request')
  assert.match(src, /sessionUserId = useRef/, 'the live session id is held in a ref')
  assert.match(src, /isMounted = useRef/, 'mount state is held in a ref')
})

test('13: the auth listener keeps the ref in step', () => {
  const src = read(MODAL)
  assert.match(
    src,
    /onAuthStateChange\(\(_event, session\) => \{[\s\S]{0,200}sessionUserId\.current =/,
    'the existing listener must update the ref, not just component state',
  )
})

test('14: the refresh scheduler was not altered by this fix', () => {
  const src = read(MODAL)
  assert.match(src, /createRefreshScheduler\(\{ run: \(\) => loadThreads\(\) \}\)/)
  assert.match(src, /scheduler\.onRealtimeEvent\(\)/)
  assert.match(src, /scheduler\.onVisible\(\)/)
  assert.match(src, /scheduler\.cancel\(\)/)
})
