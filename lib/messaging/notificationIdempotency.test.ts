import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { idempotencyKeyFor } from './notificationWorker.ts'

/**
 * The deterministic provider key: one message, one key, forever.
 *
 * This suite once asserted that the browser notify route produced the key --
 * it existed so the inline sender and the future worker would present the SAME
 * key, letting the two overlap during the transition without emailing anyone
 * twice. That transition is over: both legacy routes are retired and the
 * handler that built the key is deleted, so the worker is the only producer.
 *
 * What still matters, and is asserted here: the key's shape and determinism,
 * that the worker is its sole source, and that the broadcast system keeps its
 * own separate keys. The worker's USE of it under crash and replay is covered
 * by notificationWorker.
 */

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

test('1: the key is message-notification-<message_id>', () => {
  assert.equal(idempotencyKeyFor(M1), `message-notification-${M1}`)
  assert.equal(idempotencyKeyFor(M2), `message-notification-${M2}`)
})

test('2: the same message always yields the same key', () => {
  assert.equal(idempotencyKeyFor(M1), idempotencyKeyFor(M1))
  // Derived, never stored -- there is no second copy that could drift.
  const worker = read('lib/messaging/notificationWorker.ts')
  assert.match(worker, /export const idempotencyKeyFor = \(messageId: string\) =>\s*`message-notification-\$\{messageId\}`/)
  assert.ok(!/idempotency_key/.test(worker), 'the notification queue stores no key column')
})

test('3: different messages yield different keys', () => {
  assert.notEqual(idempotencyKeyFor(M1), idempotencyKeyFor(M2))
  assert.ok(idempotencyKeyFor(M1).endsWith(M1))
  assert.ok(idempotencyKeyFor(M2).endsWith(M2))
})

test('4: the worker is the only producer of this key', () => {
  const worker = read('app/api/messages/notification-worker/route.ts')
  assert.match(worker, /idempotencyKey/, 'the worker presents it on every send')

  // The renderer holds no key logic, and no route can produce one any more.
  const notify = read('lib/messageNotify.ts')
  assert.ok(!/message-notification-/.test(notify), 'the renderer builds no keys')
  assert.ok(!/idempotencyKey/.test(notify))
})

test('5: the broadcast system keeps its own frozen keys', () => {
  const b = read('app/api/messages/broadcast/route.ts')
  assert.match(b, /idempotencyKey: batch\.idempotency_key/, 'batches carry their stored key')
  assert.ok(!/message-notification-/.test(b), 'and never the single-message key')
})

test('6: the send is not conditional on having a key', () => {
  // The worker always has one -- it is derived from the message id it is
  // processing -- so there is no keyless path left to guard.
  const worker = read('app/api/messages/notification-worker/route.ts')
  const send = worker.indexOf('resend.emails.send')
  assert.ok(send > -1)
  assert.ok(
    !/idempotencyKey \? \{ idempotencyKey \} : undefined/.test(worker),
    'the optional-key fallback belonged to the retired inline sender',
  )
})
