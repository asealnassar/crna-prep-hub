import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * H-3: one send action creates at most one message.
 *
 * The old sendReply took no lock at all. `setSending(true)` sat AFTER
 * `await supabase.auth.getUser()`, so the entire auth round-trip was an open
 * window; and `sending` is React state, which two events in the same tick both
 * read as `false` because no re-render separates them. The button's
 * `disabled={sending}` was therefore decorative under a real double-click, and
 * the Enter handler consulted nothing whatsoever.
 *
 * There is no DOM harness in this repo, so the race is exercised against a
 * model that reproduces sendReply's exact control flow -- gate, validate,
 * take, await, release in `finally` -- and the source assertions at the end
 * pin the shipped component to that flow so the model cannot drift from it.
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

type Hooks = {
  /** null models `if (!user) return`. */
  getUser?: () => Promise<{ id: string } | null>
  /** null models an insert that returned an error. */
  insert?: (text: string) => Promise<{ id: string } | null>
  notify?: (messageId: string) => Promise<void>
}

/**
 * sendReply's control flow, statement for statement. Only the supabase and
 * fetch calls are replaced -- the ordering, the gate, and the `finally` are
 * the same shape as the component.
 */
function makeSender(hooks: Hooks = {}) {
  const log = {
    insertAttempts: [] as string[],
    stored: [] as string[],
    readStatus: [] as string[],
    threadTouches: 0,
    notified: [] as string[],
    alerts: [] as string[],
    reloads: 0,
    clears: 0,
  }
  const state = { replyText: 'hello', selectedThread: { id: 'thread-1' } as { id: string } | null }
  const sendInFlight = { current: false }
  let sending = false
  let seq = 0

  const participants = [{ user_id: 'them' }]

  const getUser = hooks.getUser ?? (async () => ({ id: 'me' }))
  const insert =
    hooks.insert ??
    (async (text: string) => ({ id: `msg-${++seq}` }))
  const notify = hooks.notify ?? (async () => {})

  const sendReply = async () => {
    if (sendInFlight.current) return
    if (!state.replyText.trim() || !state.selectedThread) return

    sendInFlight.current = true
    sending = true
    try {
      const user = await getUser()
      if (!user) return

      const text = state.replyText
      log.insertAttempts.push(text)
      const newMessage = await insert(text)
      if (!newMessage) {
        log.alerts.push('send-failed')
        return
      }
      log.stored.push(newMessage.id)

      for (const p of participants) {
        log.readStatus.push(`${newMessage.id}:${p.user_id}`)
      }
      log.threadTouches++

      for (const p of participants) {
        await notify(newMessage.id)
        log.notified.push(newMessage.id)
      }

      state.replyText = ''
      log.clears++
      log.reloads++
    } finally {
      sendInFlight.current = false
      sending = false
    }
  }

  /** The button's onClick. */
  const clickSend = () => sendReply()
  /** The textarea's onKeyPress, including the shift-Enter escape. */
  const pressEnter = (shiftKey = false) => (shiftKey ? undefined : sendReply())

  return { sendReply, clickSend, pressEnter, log, state, sendInFlight, isSending: () => sending }
}

// ------------------------------------------------------------ 1-4: one action, one message

test('1: a single click stores exactly one message', async () => {
  const h = makeSender()
  await h.clickSend()
  assert.equal(h.log.stored.length, 1)
})

test('2: a rapid double-click stores exactly one message', async () => {
  const h = makeSender()
  // Both handlers fire before any await resolves -- the real double-click.
  await Promise.all([h.clickSend(), h.clickSend()])
  assert.equal(h.log.stored.length, 1, 'the second click must not reach the insert')
  assert.equal(h.log.insertAttempts.length, 1, 'it must not even attempt a second insert')
})

test('3: a rapid double-Enter stores exactly one message', async () => {
  const h = makeSender()
  await Promise.all([h.pressEnter(), h.pressEnter()])
  assert.equal(h.log.stored.length, 1)
})

test('4: click and Enter racing store exactly one message', async () => {
  const h = makeSender()
  await Promise.all([h.clickSend(), h.pressEnter()])
  assert.equal(h.log.stored.length, 1)

  const reversed = makeSender()
  await Promise.all([reversed.pressEnter(), reversed.clickSend()])
  assert.equal(reversed.log.stored.length, 1, 'order of the two events must not matter')
})

test('4b: shift-Enter sends nothing', async () => {
  const h = makeSender()
  await h.pressEnter(true)
  assert.equal(h.log.insertAttempts.length, 0)
  assert.equal(h.state.replyText, 'hello', 'a newline keystroke must not clear the box')
})

// ------------------------------------------------------- 5-7: blocked at each await point

test('5: a second invocation while the first awaits auth is blocked', async () => {
  const gate = deferred<{ id: string } | null>()
  const h = makeSender({ getUser: () => gate.promise })

  const first = h.sendReply()
  // This is the window the old code left wide open: sending was not yet set.
  const second = h.sendReply()
  gate.resolve({ id: 'me' })
  await Promise.all([first, second])

  assert.equal(h.log.stored.length, 1)
  assert.equal(h.log.insertAttempts.length, 1)
})

test('6: a second invocation while the insert is pending is blocked', async () => {
  const gate = deferred<{ id: string } | null>()
  const h = makeSender({ insert: () => gate.promise })

  const first = h.sendReply()
  await Promise.resolve()
  await Promise.resolve()
  const second = h.sendReply()
  gate.resolve({ id: 'msg-1' })
  await Promise.all([first, second])

  assert.equal(h.log.stored.length, 1)
})

test('7: a second invocation while the notification is pending is blocked', async () => {
  const gate = deferred<void>()
  const h = makeSender({ notify: () => gate.promise })

  const first = h.sendReply()
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(h.log.stored.length, 1, 'the message is already stored at this point')

  const second = h.sendReply()
  gate.resolve()
  await Promise.all([first, second])

  assert.equal(h.log.stored.length, 1, 'the pending email must not admit a second send')
  assert.equal(h.log.insertAttempts.length, 1)
})

// ------------------------------------------------------------- 8-9: failure releases

test('8: a failed auth releases the lock', async () => {
  const h = makeSender({ getUser: async () => null })
  await h.sendReply()

  assert.equal(h.log.stored.length, 0)
  assert.equal(h.sendInFlight.current, false, 'the gate must not be left held')
  assert.equal(h.isSending(), false, 'the button must not be left disabled')
  assert.equal(h.state.replyText, 'hello', 'the text must survive so it can be retried')
})

test('8b: a failed insert releases the lock and does not report success', async () => {
  const h = makeSender({ insert: async () => null })
  await h.sendReply()

  assert.equal(h.log.stored.length, 0)
  assert.equal(h.log.clears, 0, 'a failed send must not clear the reply box')
  assert.equal(h.log.threadTouches, 0, 'updated_at must not be bumped for a message that does not exist')
  assert.equal(h.log.notified.length, 0)
  assert.deepEqual(h.log.alerts, ['send-failed'])
  assert.equal(h.sendInFlight.current, false)
})

test('8c: a thrown request releases the lock', async () => {
  const h = makeSender({
    notify: async () => {
      throw new Error('network down')
    },
  })
  await assert.rejects(() => h.sendReply())
  assert.equal(h.sendInFlight.current, false, 'finally must release even on a throw')
  assert.equal(h.isSending(), false)
})

test('9: a retry after a failure succeeds exactly once', async () => {
  let attempt = 0
  const h = makeSender({
    insert: async (text) => (++attempt === 1 ? null : { id: 'msg-retry' }),
  })

  await h.sendReply()
  assert.equal(h.log.stored.length, 0, 'first attempt failed')
  assert.equal(h.state.replyText, 'hello', 'text preserved for the retry')

  await h.sendReply()
  assert.deepEqual(h.log.stored, ['msg-retry'], 'the retry stored exactly one message')
  assert.equal(h.log.insertAttempts.length, 2, 'two attempts, one stored message')
  assert.equal(h.state.replyText, '')
})

// ------------------------------------------------------ 10-12: preserved behaviour

test('10: an empty or whitespace reply sends nothing and takes no lock', async () => {
  for (const text of ['', '   ', '\n\t ']) {
    const h = makeSender()
    h.state.replyText = text
    await h.sendReply()
    assert.equal(h.log.insertAttempts.length, 0, `"${text}" must not send`)
    assert.equal(h.sendInFlight.current, false, 'validation returns before the gate is taken')
  }
})

test('10b: no thread selected sends nothing', async () => {
  const h = makeSender()
  h.state.selectedThread = null
  await h.sendReply()
  assert.equal(h.log.insertAttempts.length, 0)
  assert.equal(h.sendInFlight.current, false)
})

test('11: a successful send clears the reply exactly once', async () => {
  const h = makeSender()
  await Promise.all([h.clickSend(), h.clickSend(), h.pressEnter()])
  assert.equal(h.log.clears, 1, 'three racing events, one clear')
  assert.equal(h.state.replyText, '')
})

test('12: receipt, thread-touch and notification behaviour are unchanged', async () => {
  const h = makeSender()
  await h.clickSend()

  assert.deepEqual(h.log.readStatus, ['msg-1:them'], 'one delivery row per other participant')
  assert.equal(h.log.threadTouches, 1, 'updated_at bumped exactly once')
  assert.deepEqual(h.log.notified, ['msg-1'], 'one notification per other participant')
  assert.equal(h.log.reloads, 1)
})

test('12b: a blocked duplicate creates no extra receipts or notifications', async () => {
  const h = makeSender()
  await Promise.all([h.clickSend(), h.clickSend()])

  assert.equal(h.log.readStatus.length, 1, 'no duplicate delivery rows')
  assert.equal(h.log.threadTouches, 1, 'no duplicate updated_at bump')
  assert.equal(h.log.notified.length, 1, 'no duplicate email')
})

// ------------------------------------- 13+: the shipped component implements this flow

const start = code.indexOf('const sendReply = async ()')
const end = code.indexOf('const composeMessage = async ()')
assert.ok(start > -1 && end > start, 'sendReply must be locatable in the component')
const sendReplySrc = code.slice(start, end)

test('13: the gate is read and taken before the first await', () => {
  const firstAwait = sendReplySrc.indexOf('await')
  const read = sendReplySrc.indexOf('if (sendInFlight.current) return')
  const take = sendReplySrc.indexOf('sendInFlight.current = true')

  assert.ok(read > -1, 'sendReply must return early when a send is in flight')
  assert.ok(take > -1, 'sendReply must take the gate')
  assert.ok(firstAwait > -1)
  assert.ok(read < firstAwait, 'the gate must be read before any await')
  assert.ok(take < firstAwait, 'the gate must be taken before any await -- including getUser()')
  assert.ok(read < take, 'read the gate, then take it, with nothing in between')
})

test('14: the gate is a synchronous ref, not React state', () => {
  assert.match(code, /useRef/, 'useRef must be imported')
  assert.match(code, /const sendInFlight = useRef\(false\)/)
  assert.ok(
    !/const \[sendInFlight/.test(code),
    'the gate must not be useState -- state is not synchronous',
  )
})

test('15: setSending is no longer the guard, and no longer precedes it', () => {
  const take = sendReplySrc.indexOf('sendInFlight.current = true')
  const setTrue = sendReplySrc.indexOf('setSending(true)')
  assert.ok(take > -1, 'the ref gate must exist')
  assert.ok(setTrue > -1, 'the UI sending state must still be set')
  assert.ok(setTrue > take, 'the ref must be taken before the UI state is set')
})

test('16: the gate is released in a finally block, once', () => {
  const fin = sendReplySrc.lastIndexOf('} finally {')
  assert.ok(fin > -1, 'sendReply must release in finally')

  const releases = [...sendReplySrc.matchAll(/sendInFlight\.current = false/g)].map((m) => m.index!)
  assert.equal(releases.length, 1, 'exactly one release site')
  assert.ok(releases[0] > fin, 'the release must be inside finally')

  const uiReleases = [...sendReplySrc.matchAll(/setSending\(false\)/g)].map((m) => m.index!)
  assert.equal(uiReleases.length, 1, 'the success path must not release the UI state separately')
  assert.ok(uiReleases[0] > fin, 'setSending(false) must be inside finally')
})

test('17: a failed insert returns before the success path', () => {
  assert.match(sendReplySrc, /error: insertError/, 'the insert error must be captured')
  const guard = sendReplySrc.indexOf('if (insertError || !newMessage)')
  const clear = sendReplySrc.indexOf("setReplyText('')")
  assert.ok(guard > -1, 'a failed insert must be detected')
  assert.ok(guard < clear, 'the failure must return before the reply box is cleared')
})

test('18: the Enter handler routes through the same guarded function', () => {
  const handler = code.slice(code.indexOf('onKeyPress={(e) =>'))
  const block = handler.slice(0, handler.indexOf('}}') + 2)
  assert.match(block, /e\.key === 'Enter' && !e\.shiftKey/, 'shift-Enter must still insert a newline')
  assert.match(block, /sendReply\(\)/, 'Enter must call the guarded sendReply')
  assert.ok(
    !/thread_messages/.test(block),
    'Enter must not have its own send path that bypasses the gate',
  )
})

test('19: the old unguarded ordering is gone', () => {
  assert.ok(
    !/if \(!replyText\.trim\(\) \|\| !selectedThread\) return\s+const \{ data: \{ user \} \} = await/.test(
      sendReplySrc,
    ),
    'auth must no longer be awaited before any guard is taken',
  )
})
