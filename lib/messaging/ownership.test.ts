import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * H-2: a message is "mine" only when its stored sender_id is the authenticated
 * reader's id.
 *
 * Ownership used to be `msg.senderEmail === userEmail`, where senderEmail was
 * resolved over the network and fell back to the string 'Unknown'. A single
 * failed request therefore rendered every message in a thread — including the
 * reader's own — as the other person's: wrong side, wrong colour, receipt gone.
 *
 * These tests need no database. They evaluate the ownership rule directly, and
 * assert against the component source that the old rule is gone and the
 * already-correct sender_id logic elsewhere in the file is untouched.
 */

const SRC = readFileSync(new URL('../../components/MessagesModal.tsx', import.meta.url), 'utf8')
/** Executable text only, so a comment describing the old rule cannot fail a test. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

const ME = '9a354b78-a210-413f-9825-cc2551553167'
const THEM = '32b07752-8c3e-4ee6-8b94-4f4f167ad509'
const MY_EMAIL = 'testusera@gmail.com'

/** The rule as the component now applies it. */
const isMine = (msg: { sender_id: string | null }, currentUserId: string | null) =>
  msg.sender_id != null && msg.sender_id === currentUserId

/** How senderEmail is still derived — display only, whatever the lookup returns. */
const senderEmailFor = (
  msg: { sender_id: string | null },
  emails: Record<string, { email: string }>,
) => emails[msg.sender_id as string]?.email || 'Unknown'

const HEALTHY = { [ME]: { email: MY_EMAIL }, [THEM]: { email: 'asealnassar@gmail.com' } }
const EMPTY: Record<string, { email: string }> = {}
const MISSING_ME = { [THEM]: { email: 'asealnassar@gmail.com' } }
const WRONG_CASE = { [ME]: { email: 'TestUserA@Gmail.com' }, [THEM]: { email: 'asealnassar@gmail.com' } }

// ------------------------------------------------ 1-4: ownership survives lookup failure
test('1: own message with a healthy lookup is mine', () => {
  const msg = { sender_id: ME }
  assert.equal(senderEmailFor(msg, HEALTHY), MY_EMAIL)
  assert.equal(isMine(msg, ME), true)
})

test('2: own message with an EMPTY email map is still mine', () => {
  const msg = { sender_id: ME }
  // This is what fetchInboxMeta returns on any non-2xx or thrown error.
  assert.equal(senderEmailFor(msg, EMPTY), 'Unknown')
  assert.equal(isMine(msg, ME), true, 'a failed lookup must not change who owns a message')
})

test('3: own message with the caller’s own profile missing is still mine', () => {
  const msg = { sender_id: ME }
  assert.equal(senderEmailFor(msg, MISSING_ME), 'Unknown')
  assert.equal(isMine(msg, ME), true)
})

test('4: own message whose stored email differs in case is still mine', () => {
  const msg = { sender_id: ME }
  assert.notEqual(senderEmailFor(msg, WRONG_CASE), MY_EMAIL)
  assert.equal(isMine(msg, ME), true)
})

// --------------------------------------------------------- 5, 6: never mine
test('5: the other participant’s message is never mine, in any lookup state', () => {
  const msg = { sender_id: THEM }
  for (const emails of [HEALTHY, EMPTY, MISSING_ME, WRONG_CASE]) {
    senderEmailFor(msg, emails)
    assert.equal(isMine(msg, ME), false)
  }
})

test('6: a NULL sender_id is never mine', () => {
  assert.equal(isMine({ sender_id: null }, ME), false)
  assert.equal(isMine({ sender_id: null }, null), false,
    'and never mine merely because the reader is also unresolved')
})

// ----------------------------------------------- 7: nothing painted too early
test('7: no bubble is rendered before currentUserId resolves', () => {
  assert.ok(/\{!currentUserId \? \(/.test(code),
    'the message list must be gated on currentUserId')
  const gate = code.indexOf('!currentUserId ? (')
  const list = code.indexOf('messages.map((msg)')
  assert.ok(gate > 0 && gate < list, 'the gate must precede the message list')
  assert.ok(/Loading conversation/.test(SRC), 'an unresolved reader sees a neutral state')
})

// ------------------------------------------------- 8: receipts follow ownership
test('8: read-receipt visibility follows sender_id ownership', () => {
  const render = code.slice(code.indexOf('const isMyMessage'), code.indexOf('EMPTY STATE'))
  assert.ok(/isMyMessage && \(/.test(render), 'the receipt is gated on isMyMessage')
  for (const driven of ["justify-end", "items-end", "bg-blue-600", "text-gray-500"]) {
    assert.ok(render.includes(driven), `${driven} must still be driven by ownership`)
  }
})

// ------------------------------------- 9: the correct id logic is untouched
test('9: the existing sender_id read-status branches are unchanged', () => {
  assert.ok(code.includes('if (msg.sender_id === user.id) {'), 'sent-vs-received branch')
  assert.ok(code.includes("if (msg.sender_id !== user.id) {"), 'mark-as-read branch')
  assert.ok(code.includes(".neq('user_id', msg.sender_id)"), 'read-status lookup')
  assert.ok(code.includes('sender_id: user.id'), 'the insert still stamps the session user')
})

// ------------------------------------------ 10: the old rule is really gone
test('10: no render path compares senderEmail with userEmail', () => {
  assert.ok(!/senderEmail\s*===\s*userEmail/.test(code),
    'email must never decide ownership')
  assert.ok(/const isMyMessage =\s*\n?\s*msg\.sender_id != null && msg\.sender_id === currentUserId/.test(code))
  // senderEmail may still be populated — display only.
  assert.ok(code.includes("msg.senderEmail = senderEmails[msg.sender_id]?.email || 'Unknown'"))
})

// -------------------------------------- 11: email still available for notifications
test('11: userEmail is still used for the notification sender name', () => {
  assert.ok(/senderName: isAdmin \? 'CRNA Prep Hub Admin' : userEmail/.test(code),
    'the notify payload still names the sender by address')
  assert.ok(code.includes('userEmail: string'), 'the prop is retained')
})

// --------------------------------------- 12: the id follows the session
test('12: currentUserId is sourced from the session and follows account changes', () => {
  const effect = code.slice(code.indexOf('supabase.auth.getUser().then'), code.indexOf('const getAdminId'))
  assert.ok(/setCurrentUserId\(data\?\.user\?\.id \?\? null\)/.test(effect), 'initial resolution')
  assert.ok(/onAuthStateChange/.test(effect), 'kept in step with the session')
  assert.ok(/setCurrentUserId\(session\?\.user\?\.id \?\? null\)/.test(effect),
    'a sign-out or account switch updates it, and clears it on sign-out')
  assert.ok(/sub\.subscription\.unsubscribe\(\)/.test(effect), 'the listener is torn down')
  // Ownership is computed from that state, never from a prop.
  assert.ok(!/const isMyMessage[^\n]*userEmail/.test(code))
})
