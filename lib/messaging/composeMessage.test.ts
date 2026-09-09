import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * H-3B: one Compose send action produces at most one result.
 *
 * Compose carried the identical defect to the reply path -- `setSending(true)`
 * placed after `await supabase.auth.getUser()`, and `sending` is React state,
 * which two events in the same tick both read as false. The blast radius was
 * larger: a doubled tier broadcast calls send_tier_broadcast twice and fans
 * out to every member of the tier twice, and the email poll that follows runs
 * for up to a minute, so the two runs overlap.
 *
 * Two RPC errors were also discarded outright -- send_tier_broadcast and the
 * single-recipient create_thread_with_message -- so a rejected send cleared
 * the compose form and alerted success. Both now route to the pre-existing
 * catch, which keeps the existing 'Failed to send message' copy.
 *
 * As with H-3 there is no DOM harness: the races run against a model of
 * composeMessage's control flow, and the source assertions at the end pin the
 * shipped component to that flow.
 */

const SRC = readFileSync(new URL('../../components/MessagesModal.tsx', import.meta.url), 'utf8')
/** Executable text only, so a comment describing the old bug cannot pass a test. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Rpc<T> = { data: T; error: unknown }
const ok = <T,>(data: T): Rpc<T> => ({ data, error: null })
const fail = (message: string): Rpc<null> => ({ data: null, error: new Error(message) })

type Opts = {
  mode: 'tier' | 'multi' | 'single'
  recipients?: string[]
  adminId?: string
  getUser?: () => Promise<{ id: string } | null>
  broadcast?: () => Promise<Rpc<number | null>>
  createThread?: (recipientId: string) => Promise<Rpc<unknown>>
  pollEmail?: () => Promise<void>
}

/**
 * composeMessage's control flow, branch for branch. Only the supabase and
 * fetch calls are replaced.
 */
function makeComposer(opts: Opts) {
  const isAdmin = opts.mode !== 'single'
  const log = {
    broadcastCalls: 0,
    threadCalls: [] as string[],
    threadsCreated: [] as string[],
    notified: [] as string[],
    alerts: [] as string[],
    resets: 0,
    reloads: 0,
  }
  const compose = {
    subject: 'Subject',
    message: 'Body',
    selectedUserIds: opts.recipients ?? ['them'],
    selectedTier: 'free',
  }
  const composeInFlight = { current: false }
  let sending = false
  let showCompose = true

  const adminId = opts.adminId ?? 'admin-1'
  const getUser = opts.getUser ?? (async () => ({ id: 'me' }))
  const broadcast = opts.broadcast ?? (async () => ok(42))
  const createThread = opts.createThread ?? (async () => ok(null))
  const pollEmail = opts.pollEmail ?? (async () => {})

  const resetCompose = () => {
    compose.subject = ''
    compose.message = ''
    compose.selectedUserIds = []
    compose.selectedTier = 'free'
    log.resets++
  }

  /** Fire-and-forget in the thread paths, exactly as the component does it. */
  const notify = (recipientId: string) => {
    log.notified.push(recipientId)
  }

  const composeMessage = async () => {
    if (composeInFlight.current) return
    if (!compose.subject || !compose.message) {
      log.alerts.push('required')
      return
    }

    composeInFlight.current = true
    sending = true
    try {
      const user = await getUser()
      if (!user) return

      if (opts.mode === 'tier' && isAdmin) {
        log.broadcastCalls++
        const { data: count, error: broadcastError } = await broadcast()
        if (broadcastError) throw broadcastError
        await pollEmail()
        log.alerts.push(`Message sent to ${count} users in ${compose.selectedTier} tier`)
      } else {
        let recipientId: string
        if (isAdmin) {
          if (compose.selectedUserIds.length === 0) {
            log.alerts.push('select-recipient')
            return
          }
          const failed: string[] = []
          let sent = 0
          const targets = [...compose.selectedUserIds]
          for (const r of targets) {
            log.threadCalls.push(r)
            const { error: threadError } = await createThread(r)
            if (threadError) {
              failed.push(r)
              continue
            }
            sent++
            log.threadsCreated.push(r)
            notify(r)
          }
          log.alerts.push(
            failed.length === 0
              ? `Message sent to ${sent} user(s)`
              : `Message sent to ${sent} of ${targets.length} user(s). ${failed.length} could not be delivered.`,
          )
          resetCompose()
          showCompose = false
          log.reloads++
          return
        } else {
          recipientId = adminId
          if (!recipientId) {
            log.alerts.push('admin-not-found')
            return
          }
        }

        log.threadCalls.push(recipientId)
        const { error: createError } = await createThread(recipientId)
        if (createError) throw createError
        log.threadsCreated.push(recipientId)
        notify(recipientId)
      }

      resetCompose()
      showCompose = false
      log.reloads++
    } catch {
      log.alerts.push('Failed to send message')
    } finally {
      composeInFlight.current = false
      sending = false
    }
  }

  return {
    composeMessage,
    click: () => composeMessage(),
    log,
    compose,
    composeInFlight,
    isSending: () => sending,
    isComposeOpen: () => showCompose,
  }
}

// ------------------------------------------------------- 1-2: one action, one result

test('1: a single send creates exactly one thread', async () => {
  const c = makeComposer({ mode: 'single' })
  await c.click()
  assert.deepEqual(c.log.threadsCreated, ['admin-1'])
  assert.deepEqual(c.log.notified, ['admin-1'])
  assert.equal(c.log.reloads, 1)
})

test('2: a rapid double-click on a one-recipient compose creates one thread', async () => {
  const c = makeComposer({ mode: 'single' })
  await Promise.all([c.click(), c.click()])
  assert.equal(c.log.threadCalls.length, 1, 'the second click must not reach the RPC')
  assert.equal(c.log.threadsCreated.length, 1)
  assert.equal(c.log.notified.length, 1, 'and must not send a second email')
  // The member-to-admin path deliberately has no success alert: the compose
  // panel closing and the thread list reloading are the feedback. What must
  // not happen is a second reset or a second reload.
  assert.equal(c.log.alerts.length, 0, 'no alert on this path, and certainly not two')
  assert.equal(c.log.resets, 1, 'one reset')
  assert.equal(c.log.reloads, 1, 'one thread-list reload')
})

// ---------------------------------------------------- 3-5: blocked at each await point

test('3: a duplicate while auth is pending is blocked', async () => {
  const gate = deferred<{ id: string } | null>()
  const c = makeComposer({ mode: 'single', getUser: () => gate.promise })

  const first = c.click()
  // The window the old code left open: sending was not yet set.
  const second = c.click()
  gate.resolve({ id: 'me' })
  await Promise.all([first, second])

  assert.equal(c.log.threadCalls.length, 1)
})

test('4: a duplicate while create_thread_with_message is pending is blocked', async () => {
  const gate = deferred<Rpc<unknown>>()
  const c = makeComposer({ mode: 'single', createThread: () => gate.promise })

  const first = c.click()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  const second = c.click()
  gate.resolve(ok(null))
  await Promise.all([first, second])

  assert.equal(c.log.threadCalls.length, 1)
  assert.equal(c.log.threadsCreated.length, 1)
})

test('5: a duplicate during the broadcast email poll is blocked', async () => {
  // The real one-minute window: send_tier_broadcast has already returned and
  // the client is polling /api/messages/broadcast.
  const gate = deferred<void>()
  const c = makeComposer({ mode: 'tier', pollEmail: () => gate.promise })

  const first = c.click()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  assert.equal(c.log.broadcastCalls, 1, 'the broadcast RPC has already run')

  const second = c.click()
  gate.resolve()
  await Promise.all([first, second])

  assert.equal(c.log.broadcastCalls, 1, 'a click during the poll must not fan out again')
  assert.equal(c.log.alerts.length, 1)
})

// --------------------------------------------------------- 6-8: multi-select and tier

test('6: an admin multi-select double-click gives each recipient exactly one thread', async () => {
  const c = makeComposer({ mode: 'multi', recipients: ['u1', 'u2', 'u3'] })
  await Promise.all([c.click(), c.click()])

  assert.deepEqual(c.log.threadsCreated, ['u1', 'u2', 'u3'])
  assert.equal(c.log.threadCalls.length, 3, 'three RPC calls, not six')
  const counts = new Map<string, number>()
  for (const r of c.log.threadsCreated) counts.set(r, (counts.get(r) ?? 0) + 1)
  for (const [r, n] of counts) assert.equal(n, 1, `${r} must get exactly one private thread`)
})

test('7: a blocked multi-select duplicate sends no duplicate notification', async () => {
  const c = makeComposer({ mode: 'multi', recipients: ['u1', 'u2', 'u3'] })
  await Promise.all([c.click(), c.click(), c.click()])

  assert.deepEqual(c.log.notified, ['u1', 'u2', 'u3'], 'one email each')
  assert.equal(c.log.alerts.length, 1, 'one success alert')
  assert.equal(c.log.reloads, 1)
})

test('8: a tier-broadcast double-click invokes the broadcast RPC exactly once', async () => {
  const c = makeComposer({ mode: 'tier' })
  await Promise.all([c.click(), c.click()])

  assert.equal(c.log.broadcastCalls, 1, 'send_tier_broadcast must run once')
  assert.deepEqual(c.log.alerts, ['Message sent to 42 users in free tier'])
})

test('8b: three racing clicks on a broadcast still invoke it once', async () => {
  const c = makeComposer({ mode: 'tier' })
  await Promise.all([c.click(), c.click(), c.click()])
  assert.equal(c.log.broadcastCalls, 1)
})

// ------------------------------------------------------ 9-12: failure, unlock, retry

test('9: a failed auth releases the lock and preserves the form', async () => {
  const c = makeComposer({ mode: 'single', getUser: async () => null })
  await c.click()

  assert.equal(c.log.threadCalls.length, 0)
  assert.equal(c.composeInFlight.current, false, 'the gate must not be left held')
  assert.equal(c.isSending(), false, 'the button must not be left disabled')
  assert.equal(c.compose.subject, 'Subject', 'the draft must survive')
  assert.equal(c.log.resets, 0)
})

test('10: a failed broadcast RPC releases the lock and reports failure', async () => {
  const c = makeComposer({ mode: 'tier', broadcast: async () => fail('rls denied') })
  await c.click()

  assert.deepEqual(c.log.alerts, ['Failed to send message'], 'existing copy, not a success claim')
  assert.equal(c.composeInFlight.current, false)
  assert.equal(c.isSending(), false)
  assert.equal(c.log.resets, 0)
  assert.equal(c.isComposeOpen(), true, 'the compose panel must stay open to retry')
})

test('10b: a failed single-recipient RPC releases the lock and reports failure', async () => {
  const c = makeComposer({ mode: 'single', createThread: async () => fail('rls denied') })
  await c.click()

  assert.deepEqual(c.log.alerts, ['Failed to send message'])
  assert.equal(c.log.threadsCreated.length, 0)
  assert.equal(c.log.notified.length, 0, 'no email for a thread that was never created')
  assert.equal(c.composeInFlight.current, false)
})

test('11: a retry after a failure succeeds exactly once', async () => {
  let attempt = 0
  const c = makeComposer({
    mode: 'single',
    createThread: async () => (++attempt === 1 ? fail('transient') : ok(null)),
  })

  await c.click()
  assert.equal(c.log.threadsCreated.length, 0)
  assert.equal(c.compose.subject, 'Subject', 'draft preserved for the retry')

  await c.click()
  assert.deepEqual(c.log.threadsCreated, ['admin-1'], 'the retry created exactly one thread')
  assert.equal(c.log.threadCalls.length, 2, 'two attempts, one thread')
})

test('12: a failed send does not clear compose state', async () => {
  for (const c of [
    makeComposer({ mode: 'tier', broadcast: async () => fail('x') }),
    makeComposer({ mode: 'single', createThread: async () => fail('x') }),
    makeComposer({ mode: 'single', getUser: async () => null }),
  ]) {
    await c.click()
    assert.equal(c.log.resets, 0, 'the draft must not be discarded on failure')
    assert.equal(c.compose.message, 'Body')
  }
})

test('12b: an incomplete form sends nothing and takes no lock', async () => {
  const c = makeComposer({ mode: 'single' })
  c.compose.subject = ''
  await c.click()
  assert.equal(c.log.threadCalls.length, 0)
  assert.deepEqual(c.log.alerts, ['required'])
  assert.equal(c.composeInFlight.current, false, 'validation returns before the gate is taken')
})

test('12c: an admin multi-select with no recipient sends nothing and unlocks', async () => {
  const c = makeComposer({ mode: 'multi', recipients: [] })
  await c.click()
  assert.deepEqual(c.log.alerts, ['select-recipient'])
  assert.equal(c.composeInFlight.current, false)
  assert.equal(c.isSending(), false)
  assert.equal(c.log.resets, 0)
})

// --------------------------------------------------- 13-15: preserved behaviour

test('13: a successful send clears compose state exactly once', async () => {
  const single = makeComposer({ mode: 'single' })
  await Promise.all([single.click(), single.click()])
  assert.equal(single.log.resets, 1, 'two racing clicks, one reset')
  assert.equal(single.compose.subject, '')

  const multi = makeComposer({ mode: 'multi', recipients: ['u1', 'u2'] })
  await Promise.all([multi.click(), multi.click()])
  assert.equal(multi.log.resets, 1)
})

test('14: multi-select partial-failure reporting is intact', async () => {
  const c = makeComposer({
    mode: 'multi',
    recipients: ['u1', 'u2', 'u3'],
    createThread: async (r) => (r === 'u2' ? fail('denied') : ok(null)),
  })
  await Promise.all([c.click(), c.click()])

  assert.deepEqual(
    c.log.alerts,
    ['Message sent to 2 of 3 user(s). 1 could not be delivered.'],
    'the approved partial-failure alert must survive the gate',
  )
  assert.deepEqual(c.log.threadsCreated, ['u1', 'u3'])
  assert.deepEqual(c.log.notified, ['u1', 'u3'], 'the failed recipient gets no email')
})

test('14b: an all-failed multi-select does not claim success', async () => {
  const c = makeComposer({
    mode: 'multi',
    recipients: ['u1', 'u2'],
    createThread: async () => fail('denied'),
  })
  await c.click()
  assert.deepEqual(c.log.alerts, ['Message sent to 0 of 2 user(s). 2 could not be delivered.'])
  assert.equal(c.log.notified.length, 0)
})

// ------------------------------- 15+: the shipped component implements this flow

const cStart = code.indexOf('const composeMessage = async ()')
assert.ok(cStart > -1, 'composeMessage must be locatable')
const composeSrc = code.slice(cStart, code.indexOf('const loadUsers', cStart) > -1
  ? code.indexOf('const loadUsers', cStart)
  : cStart + 12000)

const rStart = code.indexOf('const sendReply = async ()')
const replySrc = code.slice(rStart, cStart)

test('15: the H-3 reply gate is still in place and unchanged', () => {
  const firstAwait = replySrc.indexOf('await')
  assert.ok(replySrc.indexOf('if (sendInFlight.current) return') < firstAwait)
  assert.ok(replySrc.indexOf('sendInFlight.current = true') < firstAwait)
  assert.match(replySrc, /sendInFlight\.current = false/)
  assert.match(
    replySrc,
    /alert\('Your reply could not be sent\. Please try again\.'\)/,
    'the approved reply failure copy must be exactly this',
  )
})

test('16: compose reads and takes its gate before the first await', () => {
  const firstAwait = composeSrc.indexOf('await')
  const read = composeSrc.indexOf('if (composeInFlight.current) return')
  const take = composeSrc.indexOf('composeInFlight.current = true')

  assert.ok(read > -1, 'composeMessage must return early when a send is in flight')
  assert.ok(take > -1, 'composeMessage must take the gate')
  assert.ok(read < firstAwait, 'the gate must be read before any await')
  assert.ok(take < firstAwait, 'the gate must be taken before any await -- including getUser()')
  assert.ok(read < take, 'read the gate, then take it, with nothing in between')
})

test('17: compose and reply use separate refs', () => {
  assert.match(code, /const composeInFlight = useRef\(false\)/)
  assert.match(code, /const sendInFlight = useRef\(false\)/)
  assert.ok(
    !/const \[composeInFlight/.test(code),
    'the gate must not be useState -- state is not synchronous',
  )
  assert.ok(
    !composeSrc.includes('sendInFlight'),
    'compose must not contend for the reply lock',
  )
})

test('18: compose releases in finally, once', () => {
  const fin = composeSrc.lastIndexOf('} finally {')
  assert.ok(fin > -1, 'composeMessage must release in finally')

  const releases = [...composeSrc.matchAll(/composeInFlight\.current = false/g)].map((m) => m.index!)
  assert.equal(releases.length, 1, 'exactly one release site')
  assert.ok(releases[0] > fin, 'the release must be inside finally')

  const uiReleases = [...composeSrc.matchAll(/setSending\(false\)/g)].map((m) => m.index!)
  assert.equal(uiReleases.length, 1, 'every manual setSending(false) must be gone')
  assert.ok(uiReleases[0] > fin, 'setSending(false) must be inside finally')
})

test('19: both discarded RPC errors are now captured', () => {
  assert.match(composeSrc, /error: broadcastError/, 'the broadcast error must be captured')
  assert.match(composeSrc, /if \(broadcastError\) throw broadcastError/)
  assert.match(composeSrc, /error: createError/, 'the single-recipient error must be captured')
  assert.match(composeSrc, /if \(createError\) throw createError/)

  const guard = composeSrc.indexOf('if (broadcastError) throw broadcastError')
  const poll = composeSrc.indexOf("fetch('/api/messages/broadcast'")
  assert.ok(guard < poll, 'a rejected broadcast must not proceed to the email poll')
})

test('20: broadcast tier semantics are untouched', () => {
  assert.match(composeSrc, /p_tier: compose\.selectedTier/, 'tier matching must be unchanged')
  assert.match(composeSrc, /p_subject: compose\.subject/)
  assert.match(composeSrc, /p_message_text: compose\.message/)
  const calls = [...composeSrc.matchAll(/supabase\.rpc\('send_tier_broadcast'/g)]
  assert.equal(calls.length, 1, 'exactly one broadcast call site')
})

test('21: one private thread per recipient is unchanged', () => {
  assert.match(
    composeSrc,
    /p_recipient_ids: \[recipientId\]/,
    'the RPC must still be called with a single-element array',
  )
  assert.ok(
    !/p_recipient_ids: compose\.selectedUserIds/.test(composeSrc),
    'never one shared thread with many recipients',
  )
})

test('22: the approved multi-select partial-failure alert is intact', () => {
  assert.match(composeSrc, /const failed: string\[\] = \[\]/)
  assert.match(composeSrc, /failed\.push\(recipientId\)/)
  assert.match(composeSrc, /could not be delivered\./)
  assert.match(composeSrc, /alert\('Failed to send message'\)/, 'existing compose failure copy kept')
})

test('23: compose shows only approved copy', () => {
  // H-3B introduced no copy of its own; the first four strings plus the tier
  // summary are what it inherited. M-5 Phase 1 then added the two approved
  // notification strings, which is why they are listed rather than excluded.
  // Anything outside this set is new copy nobody signed off.
  const alerts = [...composeSrc.matchAll(/alert\(\s*([\s\S]{0,80})/g)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  )
  const known = [
    "'Subject and message are required'",
    "'Please select at least one recipient'",
    "'Admin user not found'",
    "'Failed to send message'",
    '`Message sent to ${count} users in ${compose.selectedTier} tier${emailSummary}`',
    // M-5 Phase 1, approved:
    "'Message sent, but the email notification could not be delivered.'",
    'failed.length === 0 && emailFailed === 0',
  ]
  for (const a of alerts) {
    assert.ok(
      known.some((k) => a.startsWith(k)),
      `unexpected new copy in compose: ${a}`,
    )
  }
  assert.ok(alerts.length >= 6, 'the allowlist must actually be matching alerts')
})
