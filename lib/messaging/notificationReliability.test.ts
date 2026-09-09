import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * M-5 Phase 1: no successfully-created message loses its notification silently.
 *
 * Both compose paths fired `/api/messages/notify` and walked away. A
 * fire-and-forget fetch is cancelled when the tab closes, and a non-2xx
 * RESOLVES rather than throwing, so `.catch()` alone saw none of it -- the
 * multi-select loop additionally fired every recipient at once, which is what
 * met the provider's rate limiting. The broadcast route's own header records
 * the result: about 19 of 114 emails delivered, nothing recorded.
 *
 * The reply path was already awaited and already checked res.ok; these tests
 * pin that so it cannot regress to match the others.
 *
 * Durable retry is explicitly NOT part of this phase. A failed notification
 * is reported accurately and the message stands; it is not queued.
 */

const SRC = readFileSync(new URL('../../components/MessagesModal.tsx', import.meta.url), 'utf8')
/** Executable text only, so a comment describing the old behaviour cannot pass a test. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

type Res = { ok: boolean; status: number }
const OK: Res = { ok: true, status: 200 }
const res = (status: number): Res => ({ ok: status >= 200 && status < 300, status })

/** notifyRecipient, statement for statement. */
function makeNotifier(impl: (id: string) => Promise<Res>) {
  const log = { attempts: [] as string[], concurrent: 0, maxConcurrent: 0 }
  const notifyRecipient = async (recipientId: string): Promise<boolean> => {
    log.attempts.push(recipientId)
    log.concurrent++
    log.maxConcurrent = Math.max(log.maxConcurrent, log.concurrent)
    try {
      const r = await impl(recipientId)
      if (!r.ok) return false
      return true
    } catch {
      return false
    } finally {
      log.concurrent--
    }
  }
  return { notifyRecipient, log }
}

/** The admin multi-select loop, as the component now writes it. */
async function multiSelect(
  recipients: string[],
  createThread: (id: string) => Promise<{ error: unknown }>,
  notify: (id: string) => Promise<Res>,
) {
  const n = makeNotifier(notify)
  const failed: string[] = []
  let sent = 0
  let emailed = 0
  let emailFailed = 0
  const created: string[] = []

  for (const recipientId of recipients) {
    const { error } = await createThread(recipientId)
    if (error) {
      failed.push(recipientId)
      continue
    }
    sent++
    created.push(recipientId)
    if (await n.notifyRecipient(recipientId)) emailed++
    else emailFailed++
  }

  const totalSelected = recipients.length
  const messagePart =
    failed.length === 0
      ? `Messages sent to ${sent} users.`
      : `Messages sent to ${sent} of ${totalSelected} users. ${failed.length} could not be delivered.`
  const emailPart =
    emailFailed === 0
      ? `Email notifications sent to ${emailed}.`
      : `Email notifications sent to ${emailed}; ${emailFailed} failed.`
  const alertText =
    failed.length === 0 && emailFailed === 0
      ? `Messages and email notifications sent to ${sent} users.`
      : `${messagePart} ${emailPart}`

  return { sent, failed, emailed, emailFailed, created, alertText, log: n.log }
}

/** The single-recipient compose path. */
async function singleCompose(
  recipientId: string,
  createThread: () => Promise<{ error: unknown }>,
  notify: (id: string) => Promise<Res>,
) {
  const n = makeNotifier(notify)
  const alerts: string[] = []
  let created = 0
  const { error } = await createThread()
  if (error) {
    alerts.push('Failed to send message')
    return { created, alerts, log: n.log }
  }
  created++
  if (!(await n.notifyRecipient(recipientId))) {
    alerts.push('Message sent, but the email notification could not be delivered.')
  }
  return { created, alerts, log: n.log }
}

/** The reply path's notification handling. */
async function reply(participants: string[], notify: (id: string) => Promise<Res>) {
  const n = makeNotifier(notify)
  let inserted = 0
  let notifyFailed = false
  inserted++ // the insert succeeded before this block
  for (const p of participants) {
    if (!(await n.notifyRecipient(p))) notifyFailed = true
  }
  return {
    inserted,
    notifyFailed,
    alert: notifyFailed
      ? 'Your reply was sent, but the email notification could not be delivered.'
      : null,
    log: n.log,
  }
}

const ok = async () => OK
const fails = (status: number) => async () => res(status)
const throws = async () => {
  throw new Error('network down')
}
const noError = async () => ({ error: null })

// ------------------------------------------- 1-2: new conversations, both directions

test('1: Member -> Admin new conversation notifies exactly once, awaited', async () => {
  const r = await singleCompose('admin-1', noError, ok)
  assert.equal(r.created, 1, 'one in-app message')
  assert.deepEqual(r.log.attempts, ['admin-1'], 'exactly one notification attempt')
  assert.equal(r.log.maxConcurrent, 1, 'awaited, never in flight alongside anything')
  assert.deepEqual(r.alerts, [], 'silent success, as before')
})

test('2: Admin -> Member new conversation goes through the same guarded helper', async () => {
  const r = await multiSelect(['u1'], noError, ok)
  assert.equal(r.sent, 1)
  assert.deepEqual(r.log.attempts, ['u1'])
  assert.equal(r.emailed, 1)
  assert.equal(r.emailFailed, 0)
})

// -------------------------------------- 3-6: non-2xx and throws are never success

for (const status of [400, 403, 429, 500, 502]) {
  test(`3: a ${status} notification is a failure, and the message stands`, async () => {
    const r = await singleCompose('admin-1', noError, fails(status))
    assert.equal(r.created, 1, 'the in-app message must survive')
    assert.deepEqual(r.alerts, ['Message sent, but the email notification could not be delivered.'])
    assert.equal(r.log.attempts.length, 1, 'no retry, and no second message')
  })
}

test('4: a thrown network error is a failure, and the message stands', async () => {
  const r = await singleCompose('admin-1', noError, throws)
  assert.equal(r.created, 1)
  assert.deepEqual(r.alerts, ['Message sent, but the email notification could not be delivered.'])
})

test('5: a failed notification never creates another in-app message', async () => {
  for (const impl of [fails(502), throws]) {
    const single = await singleCompose('admin-1', noError, impl)
    assert.equal(single.created, 1, 'exactly one, never two')

    const multi = await multiSelect(['u1', 'u2'], noError, impl)
    assert.equal(multi.sent, 2, 'one message each, no re-creation')
    assert.equal(multi.log.attempts.length, 2, 'one attempt each, no retry')
  }
})

test('6: a failed message creation is never reported as sent', async () => {
  const r = await singleCompose('admin-1', async () => ({ error: new Error('rls') }), ok)
  assert.equal(r.created, 0)
  assert.deepEqual(r.alerts, ['Failed to send message'])
  assert.equal(r.log.attempts.length, 0, 'no email for a thread that does not exist')
})

// ------------------------------------------------ 7-13: multi-select counting

test('7: all notifications succeed', async () => {
  const r = await multiSelect(['u1', 'u2', 'u3', 'u4', 'u5'], noError, ok)
  assert.equal(r.sent, 5)
  assert.equal(r.emailed, 5)
  assert.equal(r.emailFailed, 0)
  assert.equal(r.alertText, 'Messages and email notifications sent to 5 users.')
})

test('8: one notification fails', async () => {
  const r = await multiSelect(['u1', 'u2', 'u3'], noError, async (id) =>
    id === 'u2' ? res(502) : OK,
  )
  assert.equal(r.sent, 3, 'every message still created')
  assert.equal(r.emailed, 2)
  assert.equal(r.emailFailed, 1)
  assert.equal(r.alertText, 'Messages sent to 3 users. Email notifications sent to 2; 1 failed.')
})

test('9: several notifications fail -- the approved 5/3 example', async () => {
  const r = await multiSelect(['u1', 'u2', 'u3', 'u4', 'u5'], noError, async (id) =>
    ['u4', 'u5'].includes(id) ? res(429) : OK,
  )
  assert.equal(r.sent, 5)
  assert.equal(r.emailed, 3)
  assert.equal(r.emailFailed, 2)
  assert.equal(r.alertText, 'Messages sent to 5 users. Email notifications sent to 3; 2 failed.')
})

test('10: thread creation failing skips that recipient entirely', async () => {
  const r = await multiSelect(
    ['u1', 'u2', 'u3'],
    async (id) => ({ error: id === 'u2' ? new Error('denied') : null }),
    ok,
  )
  assert.deepEqual(r.created, ['u1', 'u3'])
  assert.deepEqual(r.failed, ['u2'])
  assert.deepEqual(r.log.attempts, ['u1', 'u3'], 'no notification for the failed recipient')
  assert.equal(r.emailed, 2)
  assert.equal(
    r.alertText,
    'Messages sent to 2 of 3 users. 1 could not be delivered. Email notifications sent to 2.',
  )
})

test('11: a network throw mid-loop does not abort the remaining recipients', async () => {
  const r = await multiSelect(['u1', 'u2', 'u3'], noError, async (id) => {
    if (id === 'u2') throw new Error('network down')
    return OK
  })
  assert.equal(r.sent, 3)
  assert.deepEqual(r.log.attempts, ['u1', 'u2', 'u3'], 'every recipient still attempted')
  assert.equal(r.emailed, 2)
  assert.equal(r.emailFailed, 1)
})

test('12: message counts and email counts are reported separately', async () => {
  const r = await multiSelect(
    ['u1', 'u2', 'u3', 'u4'],
    async (id) => ({ error: id === 'u1' ? new Error('denied') : null }),
    async (id) => (id === 'u2' ? res(500) : OK),
  )
  assert.equal(r.sent, 3, '3 messages created')
  assert.equal(r.failed.length, 1)
  assert.equal(r.emailed, 2, '2 emails sent')
  assert.equal(r.emailFailed, 1)
  assert.equal(
    r.alertText,
    'Messages sent to 3 of 4 users. 1 could not be delivered. Email notifications sent to 2; 1 failed.',
  )
})

test('13: every notification failing still reports the messages as sent', async () => {
  const r = await multiSelect(['u1', 'u2'], noError, fails(502))
  assert.equal(r.sent, 2)
  assert.equal(r.emailed, 0)
  assert.equal(r.emailFailed, 2)
  assert.equal(r.alertText, 'Messages sent to 2 users. Email notifications sent to 0; 2 failed.')
})

// ------------------------------------------------------- 14: pacing

test('14: notifications are sequential -- never a concurrent burst', async () => {
  const r = await multiSelect(
    Array.from({ length: 25 }, (_, i) => `u${i}`),
    noError,
    async () => {
      await new Promise((res) => setTimeout(res, 0))
      return OK
    },
  )
  assert.equal(r.log.maxConcurrent, 1, 'at most one notify request in flight at any moment')
  assert.equal(r.log.attempts.length, 25)
  assert.equal(r.emailed, 25)
})

// ------------------------------------------------- 15-16: replies, both directions

test('15: Member -> Admin reply notifies once, awaited, and survives failure', async () => {
  const good = await reply(['admin-1'], ok)
  assert.equal(good.inserted, 1)
  assert.deepEqual(good.log.attempts, ['admin-1'])
  assert.equal(good.alert, null)

  for (const impl of [fails(502), throws]) {
    const bad = await reply(['admin-1'], impl)
    assert.equal(bad.inserted, 1, 'the reply is kept')
    assert.equal(bad.notifyFailed, true)
    assert.equal(bad.alert, 'Your reply was sent, but the email notification could not be delivered.')
  }
})

test('16: Admin -> Member reply behaves identically', async () => {
  const r = await reply(['member-1'], fails(429))
  assert.equal(r.inserted, 1)
  assert.equal(r.notifyFailed, true)
  assert.equal(r.log.maxConcurrent, 1)
})

// ------------------------------ 17+: the shipped component implements this

/** notifyRecipient through the end of composeMessage. deleteThread is the next
 *  declaration after it; loadUsers sits far EARLIER in the file, so it cannot
 *  be used as the end anchor. */
const composeStart = code.indexOf('const notifyRecipient')
const composeEnd = code.indexOf('const deleteThread', composeStart)
assert.ok(composeStart > -1 && composeEnd > composeStart, 'compose region must be locatable')
const compose = code.slice(composeStart, composeEnd)

test('17: a single awaited helper replaces both fire-and-forget call sites', () => {
  assert.match(code, /const notifyRecipient = async \([^)]*\): Promise<boolean> =>/)
  assert.match(code, /const res = await fetch\('\/api\/messages\/notify'/)
  assert.match(code, /if \(!res\.ok\) \{/, 'res.ok must be inspected')
  assert.match(code, /\} catch \(err\) \{[\s\S]*?return false/, 'a throw is a failure, not a crash')
})

test('18: no fire-and-forget notify remains anywhere', () => {
  // Every notify fetch must be awaited into a variable, never chained away.
  const chained = /fetch\('\/api\/messages\/notify'[\s\S]{0,400}?\}\)\s*\.(then|catch)\(/.test(code)
  assert.ok(!chained, 'a .then/.catch chain on a notify fetch is fire-and-forget')
  const sites = [...code.matchAll(/fetch\('\/api\/messages\/notify'/g)]
  assert.equal(sites.length, 2, 'one in the reply path, one in the shared helper')
  for (const m of sites) {
    const before = code.slice(Math.max(0, m.index! - 40), m.index!)
    assert.match(before, /await /, 'every notify fetch must be awaited')
  }
})

test('19: both compose paths call the helper and await it', () => {
  // The trailing argument is the thread id Option C added so the server can
  // resolve the exact message for its idempotency key. The await and the
  // counters -- what this test is actually about -- are unchanged.
  assert.match(
    compose,
    /if \(await notifyRecipient\(recipientId, 'CRNA Prep Hub Admin'(, [A-Za-z]+)?\)\) emailed\+\+/,
  )
  assert.match(compose, /else emailFailed\+\+/)
  assert.match(compose, /const notified = await notifyRecipient\(/)
  assert.match(compose, /alert\('Message sent, but the email notification could not be delivered\.'\)/)
})

test('20: multi-select counts messages and emails separately', () => {
  assert.match(compose, /let emailed = 0/)
  assert.match(compose, /let emailFailed = 0/)
  assert.match(compose, /Messages and email notifications sent to \$\{sent\} users\./)
  assert.match(compose, /Email notifications sent to \$\{emailed\}; \$\{emailFailed\} failed\./)
  // A failed creation must `continue` before the notify call.
  const loop = compose.slice(compose.indexOf('for (const recipientId of compose.selectedUserIds)'))
  const skip = loop.indexOf('continue')
  const notify = loop.indexOf('await notifyRecipient')
  assert.ok(skip > -1 && skip < notify, 'a failed thread must skip its notification')
})

test('21: notifications are not fired with Promise.all', () => {
  assert.ok(
    !/Promise\.all[\s\S]{0,200}notifyRecipient/.test(code),
    'a burst is what met the rate limit in the first place',
  )
})

test('22: the tier-broadcast architecture is untouched', () => {
  assert.match(code, /supabase\.rpc\('send_tier_broadcast'/, 'still the RPC, not notify')
  assert.match(code, /fetch\('\/api\/messages\/broadcast'/, 'still its own durable endpoint')
  assert.match(code, /requestKey/, 'still replayed under one key')
  assert.match(code, /DELAYS_MS/, 'still its own polling schedule')
  const broadcastBranch = code.slice(
    code.indexOf("compose.recipientType === 'tier'"),
    code.indexOf('let recipientId'),
  )
  assert.ok(
    !/notifyRecipient/.test(broadcastBranch),
    'the broadcast path must never route through the single-notification helper',
  )
})

test('23: H-3 / H-3B duplicate-send protection is intact', () => {
  assert.match(code, /const sendInFlight = useRef\(false\)/)
  assert.match(code, /const composeInFlight = useRef\(false\)/)
  assert.match(code, /if \(sendInFlight\.current\) return/)
  assert.match(code, /if \(composeInFlight\.current\) return/)
  // The compose gate must still be taken before the first await in that function.
  const fn = code.slice(code.indexOf('const composeMessage = async ()'))
  const firstAwait = fn.indexOf('await')
  assert.ok(fn.indexOf('if (composeInFlight.current) return') < firstAwait)
  assert.ok(fn.indexOf('composeInFlight.current = true') < firstAwait)
})

test('24: the reply path keeps its own awaited check and copy', () => {
  assert.match(code, /if \(!res\.ok\) notifyFailed = true/)
  assert.match(
    code,
    /alert\('Your reply was sent, but the email notification could not be delivered\.'\)/,
  )
  assert.match(code, /alert\('Your reply could not be sent\. Please try again\.'\)/, 'H-3 copy')
})
