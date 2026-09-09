import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Every .ts/.tsx under a directory, excluding tests. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/**
 * Notification delivery after the cutover: the durable queue is the only
 * sender of normal-message email.
 *
 * This file used to hold M-5 Phase 1 -- the awaited inline sends, their
 * res.ok checks and their per-recipient counters. All of that is gone, and
 * deliberately: an inline send could never survive the tab closing, and it
 * reported an outcome the browser had to wait for. The database trigger now
 * enqueues on insert and the worker delivers, so what is worth asserting is
 * the ABSENCE of the old sender and the integrity of the boundary around it.
 *
 * H-3 and H-3B duplicate-send protection are not re-asserted here; sendReply
 * and composeMessage own those and still pass.
 */

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')
const MODAL = read('components/MessagesModal.tsx')
/** Executable text only, so a comment about the old sender cannot fail a test. */
const code = MODAL.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

test('1: the browser no longer calls /api/messages/notify', () => {
  assert.ok(!/api\/messages\/notify/.test(code), 'no normal-message send may remain in the UI')
  assert.ok(!/notifyRecipient/.test(code), 'the helper itself is gone')
})

test('2: no inline notification sender of any shape remains', () => {
  // Neither the helper nor a hand-rolled replacement.
  assert.ok(!/notifyFailed/.test(code), 'the per-send failure flag is gone')
  assert.ok(!/emailFailed|emailed\+\+/.test(code), 'the synchronous counters are gone')
  assert.ok(
    !/could not be delivered\.'\)/.test(code),
    'no alert may claim a specific email outcome at send time',
  )
})

test('3: the tier broadcast email path is untouched', () => {
  assert.match(code, /supabase\.rpc\('send_tier_broadcast'/, 'the RPC still runs')
  assert.match(code, /fetch\('\/api\/messages\/broadcast'/, 'and still drives its own email system')
  assert.match(code, /requestKey/, 'still replayed under one key')
  assert.match(code, /DELAYS_MS/, 'still its own polling schedule')
})

test('4: the message paths themselves are unchanged', () => {
  // Messages are still created exactly as before -- only the email moved.
  assert.match(code, /supabase\.rpc\('create_thread_with_message'/)
  assert.match(code, /\.from\('thread_messages'\)\s*\.insert\(\{/, 'replies still insert directly')
  assert.match(code, /const sendInFlight = useRef\(false\)/, 'H-3 lock intact')
  assert.match(code, /const composeInFlight = useRef\(false\)/, 'H-3B lock intact')
  assert.match(code, /alert\('Your reply could not be sent\. Please try again\.'\)/,
    'the approved reply INSERT-failure copy survives -- that is a message failure, not an email one')
})

test('5: multi-select reports messages, and says notifications are queued', () => {
  assert.match(code, /Messages sent to \$\{sent\} users\. Email notifications queued\./)
  assert.match(code, /Email notifications queued for the \$\{sent\} successful messages\./)

  // Scoped to the multi-select branch. The tier broadcast further up
  // legitimately reports "Email notifications sent to X of Y members" -- its
  // email system is polled to completion before the alert, so that claim is
  // true there and must not be caught by this assertion.
  const loop = code.indexOf('for (const recipientId of compose.selectedUserIds)')
  const branchEnd = code.indexOf('setShowCompose(false)', loop)
  assert.ok(loop > -1 && branchEnd > loop)
  const branch = code.slice(loop, branchEnd)
  assert.ok(
    !/Email notifications sent to/.test(branch),
    'delivery is asynchronous now; multi-select must not claim it happened',
  )
  assert.ok(!/notifyRecipient/.test(branch), 'and must not send inline')
})

test('6: both legacy notification routes are gone', () => {
  // The durable queue is the only normal-message sender now, enforced by there
  // being no endpoint left to call rather than by convention.
  assert.ok(!existsSync(`${ROOT}app/api/messages/notify/route.ts`), '/api/messages/notify retired')
  assert.ok(!existsSync(`${ROOT}app/api/messages/notify`), 'and its directory')
  assert.ok(!existsSync(`${ROOT}app/api/messages/route.ts`), 'the legacy /api/messages twin retired')

  // Only the three live routes remain under app/api/messages.
  const routes = readdirSync(`${ROOT}app/api/messages`).sort()
  assert.deepEqual(routes, ['broadcast', 'notification-worker', 'participants'])
})

test('7: no production code references either retired route', () => {
  // Comments and test assertions may name them; runtime code may not.
  for (const dir of ['app', 'components']) {
    for (const file of walk(`${ROOT}${dir}`)) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ')
      assert.ok(
        !/['"`]\/api\/messages\/notify['"`]/.test(src),
        `${file} still calls /api/messages/notify`,
      )
      assert.ok(
        !/fetch\(\s*['"`]\/api\/messages['"`]/.test(src),
        `${file} still calls the legacy /api/messages`,
      )
    }
  }
})

test('8: handleMessageNotification no longer exists', () => {
  const notify = read('lib/messageNotify.ts')
  const exec = notify.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  assert.ok(!/handleMessageNotification/.test(exec), 'the dead handler is gone from the code')
  // Its dependencies went with it -- the renderer needs none of them.
  for (const gone of ['authenticateRequest', 'readAccessToken', 'UUID_RE', 'new Resend', 'next/server']) {
    assert.ok(!exec.includes(gone), `${gone} was handler-only and must be gone`)
  }
  assert.equal([...exec.matchAll(/^import /gm)].length, 0, 'the renderer imports nothing')
})

test('9: the renderer is shared, not forked', () => {
  const notify = read('lib/messageNotify.ts')
  for (const kept of ['NOTIFICATION_FROM', 'NOTIFICATION_SUBJECT', 'buildNotificationEmail', 'escapeHtml']) {
    assert.ok(notify.includes(`export `) && notify.includes(kept), `${kept} must remain exported`)
  }
  // Both senders import it; neither carries its own copy of the markup.
  for (const consumer of [
    'app/api/messages/notification-worker/route.ts',
    'app/api/messages/broadcast/route.ts',
  ]) {
    const src = read(consumer)
    assert.match(src, /buildNotificationEmail/, `${consumer} must use the shared renderer`)
    assert.ok(!/<div style=/.test(src), `${consumer} must not fork the markup`)
  }
})

test('10: the queue is the delivery mechanism -- worker and cron are in place', () => {
  assert.ok(existsSync(`${ROOT}app/api/messages/notification-worker/route.ts`))
  assert.ok(existsSync(`${ROOT}vercel.json`), 'the worker must actually be scheduled')
  const cron = JSON.parse(read('vercel.json'))
  assert.equal(cron.crons.length, 1)
  assert.equal(cron.crons[0].path, '/api/messages/notification-worker')
  assert.equal(cron.crons[0].schedule, '* * * * *')
})
