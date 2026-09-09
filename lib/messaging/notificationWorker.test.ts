import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import {
  processJob, runWorker, canClaim, isSafeToReplay, decideAfterSend,
  idempotencyKeyFor, isRetryable, backoffMs, senderNameFor, previewFor,
  MAX_ATTEMPTS, BASE_BACKOFF_MS, LEASE_MS, SAFE_REPLAY_WINDOW_MS,
  type JobRow, type WorkerDeps, type SendOutcome,
} from './notificationWorker.ts'

/**
 * The durable worker, exercised entirely offline.
 *
 * NO NETWORK AND NO DATABASE. Every effect is injected, so not one assertion
 * here can reach Supabase, Resend, or a production job row. That is deliberate:
 * the queue currently holds real obligations that must not be drained until
 * cron is deliberately switched on.
 */

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')
const ROUTE = 'app/api/messages/notification-worker/route.ts'

const T0 = Date.parse('2026-09-09T12:00:00.000Z')
const MID = '11111111-1111-4111-8111-111111111111'

const job = (over: Partial<JobRow> = {}): JobRow => ({
  message_id: MID,
  recipient_user_id: 'rec-1',
  status: 'pending',
  attempts: 0,
  next_attempt_at: new Date(T0 - 1000).toISOString(),
  lease_owner: null,
  lease_expires_at: null,
  ...over,
})

const ok: SendOutcome = { ok: true }
const failWith = (code: string): SendOutcome => ({ ok: false, code, message: 'x' })

/** Records every effect the worker performs. */
function harness(over: Partial<WorkerDeps> = {}, clock = T0) {
  const log = {
    sends: [] as { to: string; senderName: string; idempotencyKey: string }[],
    patches: [] as { messageId: string; patch: Record<string, unknown> }[],
  }
  const deps: WorkerDeps = {
    now: () => clock,
    claim: async () => [],
    resolvePayload: async () => ({
      recipientEmail: 'r@example.test', senderName: 'Sender', preview: 'body',
    }),
    send: async (a) => {
      log.sends.push({ to: a.to, senderName: a.senderName, idempotencyKey: a.idempotencyKey })
      return ok
    },
    update: async (messageId, patch) => {
      log.patches.push({ messageId, patch })
    },
    ...over,
  }
  return { deps, log }
}
const last = (log: ReturnType<typeof harness>['log']) => log.patches[log.patches.length - 1].patch

// -------------------------------------------------------------- 1-2: success

test('1: a pending job that sends is marked sent', async () => {
  const { deps, log } = harness()
  const r = await processJob(job(), deps)
  assert.equal(r.outcome, 'sent')
  const p = last(log)
  assert.equal(p.status, 'sent')
  assert.equal(p.attempts, 1)
  assert.ok(p.sent_at, 'sent_at recorded')
  assert.equal(p.last_error, null)
  assert.equal(p.lease_owner, null, 'the lease is released')
  assert.equal(p.lease_expires_at, null)
})

test('2: the send carries exactly the deterministic key', async () => {
  const { deps, log } = harness()
  await processJob(job(), deps)
  assert.equal(log.sends.length, 1)
  assert.equal(log.sends[0].idempotencyKey, `message-notification-${MID}`)
  // The same key the browser notify route already uses for this message.
  assert.equal(idempotencyKeyFor(MID), `message-notification-${MID}`)
  assert.notEqual(idempotencyKeyFor(MID), idempotencyKeyFor('22222222-2222-4222-8222-222222222222'))
})

// ------------------------------------------------------- 3-5: retryable classes

for (const code of ['rate_limit_exceeded', 'internal_server_error', 'application_error']) {
  test(`3: ${code} is retried with backoff`, async () => {
    const { deps, log } = harness({ send: async () => failWith(code) })
    const r = await processJob(job(), deps)
    assert.equal(r.outcome, 'retry')
    const p = last(log)
    assert.equal(p.status, 'pending', 'returned to the queue, not failed')
    assert.equal(p.attempts, 1)
    assert.match(String(p.last_error), new RegExp(`^${code}:`))
    assert.equal(
      Date.parse(String(p.next_attempt_at)) - T0, BASE_BACKOFF_MS,
      'first retry waits one base interval',
    )
    assert.equal(p.lease_owner, null, 'the lease is released so a peer may take it')
  })
}

test('4: a non-retryable provider error fails immediately', async () => {
  const { deps, log } = harness({ send: async () => failWith('validation_error') })
  const r = await processJob(job(), deps)
  assert.equal(r.outcome, 'failed')
  assert.equal(last(log).status, 'failed')
  assert.equal(last(log).attempts, 1, 'one attempt, not four')
  assert.equal(isRetryable('validation_error'), false)
})

test('5: a thrown request is retried, not lost', async () => {
  const { deps, log } = harness({
    send: async () => { throw new Error('socket hang up') },
  })
  const r = await processJob(job(), deps)
  assert.equal(r.outcome, 'retry', 'a non-answer is transient, not a rejection')
  assert.match(String(last(log).last_error), /application_error: socket hang up/)
})

// ------------------------------------------------- 6: permanent, unresolvable

test('6: a missing recipient is permanent and never sends', async () => {
  const { deps, log } = harness({ resolvePayload: async () => null })
  const r = await processJob(job(), deps)
  assert.equal(r.outcome, 'failed')
  assert.equal(log.sends.length, 0, 'no email is attempted without an address')
  assert.equal(last(log).status, 'failed')
  assert.match(String(last(log).last_error), /could not be resolved/)
})

// ------------------------------------------------- 7-9: attempts and backoff

test('7: attempts increments on every outcome', async () => {
  for (const [outcome, send] of [
    ['sent', async () => ok],
    ['retry', async () => failWith('rate_limit_exceeded')],
    ['failed', async () => failWith('validation_error')],
  ] as const) {
    const { deps, log } = harness({ send })
    await processJob(job({ attempts: 2 }), deps)
    assert.equal(last(log).attempts, 3, `${outcome} must still count the attempt`)
  }
})

test('8: backoff is exponential from the base interval', () => {
  assert.equal(backoffMs(1), 1000)
  assert.equal(backoffMs(2), 2000)
  assert.equal(backoffMs(3), 4000)
  assert.equal(backoffMs(4), 8000)
  assert.equal(BASE_BACKOFF_MS, 1000)
})

test('9: the final attempt fails instead of retrying forever', async () => {
  const { deps, log } = harness({ send: async () => failWith('rate_limit_exceeded') })
  // attempts 3 -> this makes 4, which is MAX_ATTEMPTS.
  const r = await processJob(job({ attempts: MAX_ATTEMPTS - 1 }), deps)
  assert.equal(r.outcome, 'failed')
  assert.equal(last(log).attempts, MAX_ATTEMPTS)
  assert.equal(last(log).status, 'failed', 'a retryable error still stops at the cap')

  // One attempt earlier it is still retried.
  const earlier = harness({ send: async () => failWith('rate_limit_exceeded') })
  const r2 = await processJob(job({ attempts: MAX_ATTEMPTS - 2 }), earlier.deps)
  assert.equal(r2.outcome, 'retry')
})

// ------------------------------------------------- 10-12: leases

test('10: a live lease blocks a second worker', () => {
  const held = job({ status: 'sending', lease_expires_at: new Date(T0 + 60_000).toISOString() })
  assert.equal(canClaim(held, T0), false, 'someone else is working on it')
})

test('11: an expired lease is recoverable', () => {
  const stale = job({ status: 'sending', lease_expires_at: new Date(T0 - 1000).toISOString() })
  assert.equal(canClaim(stale, T0), true, 'a dead worker must not wedge the job')
})

test('12: a fresh lease is not stolen, and a future job is not taken early', () => {
  assert.equal(canClaim(job({ lease_expires_at: new Date(T0 + 1).toISOString() }), T0), false)
  assert.equal(canClaim(job({ next_attempt_at: new Date(T0 + 5000).toISOString() }), T0), false)
  assert.equal(canClaim(job({ status: 'sent' }), T0), false, 'finished work is never reclaimed')
  assert.equal(canClaim(job({ status: 'failed' }), T0), false)
  assert.equal(canClaim(job({ status: 'uncertain' }), T0), false, 'uncertain needs a person')
  assert.equal(canClaim(job(), T0), true)
})

// ------------------------------------------- 13-14: crash, replay, safe window

test('13: a crash after provider acceptance replays under the SAME key', async () => {
  // The row the dead worker left: 'sending', lease expired, well inside the
  // window. The provider still recognises the key, so this is collapsed.
  const crashed = job({
    status: 'sending',
    lease_expires_at: new Date(T0 - 60_000).toISOString(),
  })
  assert.equal(isSafeToReplay(crashed, T0), true)

  const { deps, log } = harness()
  const r = await processJob(crashed, deps)
  assert.equal(r.outcome, 'sent')
  assert.equal(log.sends.length, 1)
  assert.equal(
    log.sends[0].idempotencyKey, `message-notification-${MID}`,
    'the replay must present the identical key, or it becomes a second email',
  )
  // No new job or message is created -- the worker only ever patches.
  for (const p of log.patches) {
    assert.ok(!('message_id' in p.patch), 'message_id is never written')
    assert.ok(!('recipient_user_id' in p.patch), 'recipient is never written')
  }
})

test('14: beyond the safe window the job becomes uncertain and is NOT resent', async () => {
  const old = job({
    status: 'sending',
    lease_expires_at: new Date(T0 - SAFE_REPLAY_WINDOW_MS - LEASE_MS - 1000).toISOString(),
  })
  assert.equal(isSafeToReplay(old, T0), false)

  const { deps, log } = harness()
  const r = await processJob(old, deps)
  assert.equal(r.outcome, 'uncertain')
  assert.equal(log.sends.length, 0, '*** no resend past the retention window ***')
  assert.equal(last(log).status, 'uncertain')
  assert.match(String(last(log).last_error), /safe replay window/)

  // The boundary itself is inside the window. submittedAt is derived as
  // lease_expires_at - LEASE_MS, so the lease must be set that much later to
  // land a submission just inside the window.
  const edge = job({
    status: 'sending',
    lease_expires_at: new Date(T0 - SAFE_REPLAY_WINDOW_MS + 1000 + LEASE_MS).toISOString(),
  })
  assert.equal(isSafeToReplay(edge, T0), true)
})

// ------------------------------------------------- 15: identity is immutable

test('15: no patch ever rewrites message_id or recipient_user_id', async () => {
  const cases: Partial<WorkerDeps>[] = [
    {},
    { send: async () => failWith('rate_limit_exceeded') },
    { send: async () => failWith('validation_error') },
    { resolvePayload: async () => null },
  ]
  for (const over of cases) {
    const { deps, log } = harness(over)
    await processJob(job(), deps)
    for (const p of log.patches) {
      assert.ok(!('message_id' in p.patch))
      assert.ok(!('recipient_user_id' in p.patch))
      // Only the seven columns service_role may update.
      for (const k of Object.keys(p.patch)) {
        assert.ok(
          ['status', 'attempts', 'next_attempt_at', 'last_error', 'sent_at', 'lease_owner', 'lease_expires_at'].includes(k),
          `unexpected column in patch: ${k}`,
        )
      }
    }
  }
})

// ------------------------------------------------- 16: nobody can invoke it

test('16: the route is cron-only and fails closed', () => {
  const src = read(ROUTE)
  assert.match(src, /const secret = process\.env\.CRON_SECRET/)
  assert.match(src, /if \(!secret\)/, 'an unconfigured deployment must refuse')
  assert.match(src, /status: 503/)
  assert.match(src, /header !== `Bearer \$\{secret\}`/)
  assert.match(src, /status: 401/)

  // There is no session path at all: no browser, member or admin, can reach it.
  // isAdminEmail IS present, but only to name a stored sender in the email --
  // it never authorizes the request, which is why the check is narrowed to the
  // two helpers that actually read a session.
  assert.ok(!/authenticateRequest|readAccessToken/.test(src),
    'the worker must not accept a browser session by any route')
  const adminUses = [...src.matchAll(/isAdminEmail\(/g)]
  assert.equal(adminUses.length, 1, 'exactly one use')
  assert.match(src, /senderName: senderNameFor\(senderEmail, isAdminEmail\(senderEmail\)\)/,
    'and it is the sender-name lookup, not an authorization check')
  // Vercel Cron invokes with GET, so GET exists -- but it is the SAME function
  // object as POST, not a second copy of the worker body.
  assert.match(src, /export const GET = handleWorkerRequest/)
  assert.match(src, /export const POST = handleWorkerRequest/)
  assert.equal(
    [...src.matchAll(/async function handleWorkerRequest/g)].length, 1,
    'exactly one handler implementation',
  )
  assert.ok(!/export async function (GET|POST)/.test(src), 'no separately-defined method')

  // Authorization happens before anything else.
  const authorize = src.indexOf('const refused = authorize(request)')
  const client = src.indexOf('const db = serviceClient()')
  assert.ok(authorize > -1 && client > authorize, 'no database client before authorization')
})

// ------------------------------------- 17: nothing here touches production

test('17: these tests cannot reach a database, a provider, or a real job', () => {
  const self = read('lib/messaging/notificationWorker.test.ts')
  // Needles are assembled at runtime: spelled out, each would match this very
  // assertion and the test would fail against itself.
  for (const forbidden of ['create' + 'Client', 'SUPABASE_SERVICE' + '_ROLE_KEY', 'new ' + 'Resend']) {
    assert.ok(!self.includes(forbidden), 'the worker tests must not reach real effects')
  }
  // And the logic module itself pulls in no client. Assembled at runtime for
  // the same reason as above.
  const mod = read('lib/messaging/notificationWorker.ts')
  for (const forbidden of ['@supabase/' + 'supabase-js', 'new ' + 'Resend', 'next/' + 'server']) {
    assert.ok(!mod.includes(forbidden), 'the decision logic must stay free of effects')
  }
})

test('17b: cron is ON, pointed at this worker, and carries no secret', () => {
  // Was "cron is OFF". Phases 1-3 held the worker dormant; the cutover armed
  // it. What still matters: the schedule names THIS worker, nothing else runs
  // on it, and no secret was committed.
  const cron = JSON.parse(read('vercel.json'))
  assert.deepEqual(Object.keys(cron), ['crons'])
  assert.equal(cron.crons.length, 1)
  assert.equal(cron.crons[0].path, '/api/messages/notification-worker')
  assert.equal(cron.crons[0].schedule, '* * * * *')
  assert.ok(!JSON.stringify(cron).includes('CRON_SECRET'))

  // Still no browser path to it: cron calls it, nothing in the UI does.
  const modal = read('components/MessagesModal.tsx')
  assert.ok(!/notification-worker/.test(modal), 'the browser must not invoke it')
})

test('17c: the broadcast worker is untouched', () => {
  const b = read('app/api/messages/broadcast/route.ts')
  assert.match(b, /idempotencyKey: batch\.idempotency_key/)
  assert.ok(!/message-notification-/.test(b))
  assert.ok(!/email_notification_jobs/.test(b), 'the two queues stay separate')
})

// ------------------------------------------------- helpers reused, not forked

test('18: rendering and naming reuse the browser route\'s own logic', () => {
  // The route -- not this module -- imports the builder, so the markup has
  // exactly one definition and the logic module stays free of dependencies.
  const route = read(ROUTE)
  assert.match(route, /buildNotificationEmail\(senderName, preview\)/,
    'the HTML builder is imported, never copied')
  assert.match(route, /from: NOTIFICATION_FROM/)
  assert.match(route, /subject: NOTIFICATION_SUBJECT/)
  assert.match(route, /isAdminEmail\(senderEmail\)/, 'the admin allowlist has one home')

  const mod = read('lib/messaging/notificationWorker.ts')
  assert.ok(!/<div style=/.test(mod), 'no forked email markup')
  assert.ok(!/^import /m.test(mod), 'the decision logic imports nothing at all')

  assert.equal(senderNameFor('asealnassar@gmail.com', true), 'CRNA Prep Hub Admin')
  assert.equal(senderNameFor('member@example.test', false), 'member@example.test')
  assert.equal(senderNameFor(null, false), 'A CRNA Prep Hub member')

  assert.equal(previewFor('hello'), 'hello')
  assert.equal(previewFor(''), 'You have a new message on CRNA Prep Hub.')
  assert.equal(previewFor(null), 'You have a new message on CRNA Prep Hub.')
  assert.equal(previewFor('x'.repeat(200)), `${'x'.repeat(150)}...`)
})

test('19: runWorker processes every claimed job in order', async () => {
  const jobs = [job({ message_id: 'a' }), job({ message_id: 'b' }), job({ message_id: 'c' })]
  const { deps, log } = harness({ claim: async () => jobs })
  const results = await runWorker('worker-1', deps)
  assert.deepEqual(results.map((r) => r.messageId), ['a', 'b', 'c'])
  assert.deepEqual(log.sends.map((s) => s.idempotencyKey), [
    'message-notification-a', 'message-notification-b', 'message-notification-c',
  ])
})

test('20: constants mirror the proven broadcast worker', () => {
  assert.equal(MAX_ATTEMPTS, 4)
  assert.equal(BASE_BACKOFF_MS, 1000)
  assert.equal(LEASE_MS, 2 * 60 * 1000)
  assert.equal(SAFE_REPLAY_WINDOW_MS, 12 * 60 * 60 * 1000)
  const b = read('app/api/messages/broadcast/route.ts')
  assert.match(b, /const MAX_ATTEMPTS = 4/)
  assert.match(b, /const BASE_BACKOFF_MS = 1000/)
  assert.match(b, /const LEASE_MS = 2 \* 60 \* 1000/)
  assert.match(b, /const SAFE_REPLAY_WINDOW_MS = 12 \* 60 \* 60 \* 1000/)
})
