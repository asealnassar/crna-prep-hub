import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Option C: the Phase 1 inline email and the future durable worker must present
 * the SAME provider idempotency key for the same message.
 *
 * Without it, every job the trigger has queued since Phase 2 would be a second
 * email once a worker starts -- the recipient having already been notified
 * inline, under no key at all.
 *
 * The hard part was never the key, it was proving WHICH message a notification
 * is for. Replies already carry the exact id. Compose cannot: the RPC returns
 * the thread, not the message. So Compose sends the thread and the server
 * resolves the message itself -- create_thread_with_message inserts exactly one
 * message into a brand-new thread, so "the caller's message in this thread"
 * names that row by construction rather than by ordering.
 *
 * When that cannot be proven the key is DROPPED, never guessed. A missing key
 * risks a duplicate; a wrong key makes the provider suppress a real email, and
 * a suppressed email is invisible to everyone.
 */

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')
const NOTIFY = read('lib/messageNotify.ts')
const MODAL = read('components/MessagesModal.tsx')
/** Executable text only, so a comment cannot satisfy an assertion. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const N = code(NOTIFY)
const M = code(MODAL)

/** The key, exactly as the server builds it. */
const keyFor = (messageId: string) => `message-notification-${messageId}`

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

// ------------------------------------------------- 1-5: the key itself

test('1: a reply keys on the exact message id it already supplies', () => {
  // The client sends messageId; the server verifies authorship and thread
  // membership, then keys on that same id.
  assert.match(M, /messageId: newMessage\.id/, 'the reply path still sends the exact id')
  assert.match(N, /resolvedMessageId = messageId/, 'and the server keys on it')
  assert.equal(keyFor(M1), 'message-notification-11111111-1111-4111-8111-111111111111')
})

test('2: compose resolves one exact message from the thread and keys on it', () => {
  assert.match(N, /const threadId = typeof body\?\.threadId === 'string'/)
  assert.match(N, /\.eq\('thread_id', threadId\)/)
  assert.match(N, /\.eq\('sender_id', auth\.userId\)/)
  assert.match(N, /if \(\(authored \?\? \[\]\)\.length === 1\) \{/, 'exactly one, or no key')
  assert.match(N, /resolvedMessageId = authored!\[0\]\.id/)
})

test('3: each multi-select recipient carries its own thread', () => {
  // The RPC is called once per recipient, so each iteration has its own thread
  // id and therefore resolves its own message and its own key.
  assert.match(
    M,
    /const \{ data: newThreadId, error: threadError \} = await supabase\.rpc\('create_thread_with_message'/,
  )
  assert.match(M, /notifyRecipient\(recipientId, 'CRNA Prep Hub Admin', newThreadId\)/)
  const loop = M.slice(M.indexOf('for (const recipientId of compose.selectedUserIds)'))
  const rpc = loop.indexOf("supabase.rpc('create_thread_with_message'")
  const notify = loop.indexOf('notifyRecipient(recipientId')
  assert.ok(rpc > -1 && notify > rpc, 'each recipient notifies with the thread just created for them')
})

test('4: the same message always yields the same key', () => {
  assert.equal(keyFor(M1), keyFor(M1))
  assert.match(N, /`message-notification-\$\{resolvedMessageId\}`/, 'derived, never stored')
})

test('5: different messages yield different keys', () => {
  assert.notEqual(keyFor(M1), keyFor(M2))
  assert.ok(keyFor(M1).endsWith(M1) && keyFor(M2).endsWith(M2))
})

// ------------------------------------------------- 6: the fallback

test('6: an unprovable message sends WITHOUT a key rather than guessing', () => {
  // Not one row -> no assignment -> null key -> options omitted entirely.
  assert.match(
    N,
    /const idempotencyKey = resolvedMessageId \? `message-notification-\$\{resolvedMessageId\}` : null/,
  )
  assert.match(N, /idempotencyKey \? \{ idempotencyKey \} : undefined/, 'omitted, not empty-string')

  // The email is still sent: the send call is not inside any conditional that
  // the missing key could skip.
  const send = N.indexOf('resend.emails.send(')
  const guard = N.indexOf('if ((authored ?? []).length === 1)')
  assert.ok(guard > -1 && send > guard, 'the send is unconditional and comes after')
  assert.ok(
    !/if \(!resolvedMessageId\)[\s\S]{0,120}return/.test(N),
    'a missing key must never short-circuit the send',
  )
})

// ------------------------------------------------- 7: no heuristic

test('7: no key is ever derived from a "latest message" query', () => {
  // Exactly two assignments, both from an exact row.
  const assigns = [...N.matchAll(/resolvedMessageId = /g)]
  assert.equal(assigns.length, 2, 'one for the supplied id, one for the resolved thread')

  // The one remaining ordered query is preview-only and selects no id.
  const ordered = N.indexOf(".order('created_at', { ascending: false })")
  assert.ok(ordered > -1, 'the preview fallback still exists')
  const block = N.slice(N.lastIndexOf('const { data: lastMessage }', ordered), ordered + 400)
  assert.match(block, /\.select\('message_text'\)/, 'it selects text only')
  assert.ok(!/\.select\('id/.test(block), 'it must never select an id')
  assert.ok(!/resolvedMessageId/.test(block), 'and must never assign one')

  // The exact-resolution query is unordered and bounded.
  const exact = N.slice(N.indexOf(".eq('thread_id', threadId)") - 200, N.indexOf('.limit(2)') + 12)
  assert.ok(!/\.order\(/.test(exact), 'the resolution query must not be ordered')
  assert.match(exact, /\.limit\(2\)/, 'two is enough to detect ambiguity')
})

// ------------------------------------------------- 8: the warning

/** The exact console.warn(...) call, paren-balanced. A fixed-width slice
 *  overruns it and swallows the preview query that follows, which legitimately
 *  mentions message_text. */
function callAt(src: string, marker: string): string {
  const start = src.indexOf(marker)
  assert.ok(start > -1, `not found: ${marker}`)
  let depth = 0
  for (let i = start + marker.length - 1; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced: ${marker}`)
}

test('8: the fallback logs a warning with no sensitive content', () => {
  const warn = callAt(N, 'console.warn(')
  assert.match(warn, /Notification idempotency/)
  assert.match(warn, /threadId/, 'the thread id is enough to investigate')
  for (const forbidden of ['message_text', 'preview', 'recipient.email', 'token', 'auth.email', 'session']) {
    assert.ok(!warn.includes(forbidden), `the warning must not contain ${forbidden}`)
  }
})

test('8b: a client-supplied message id is never trusted for compose', () => {
  // The messageId branch verifies authorship AND thread membership first.
  const named = N.slice(N.indexOf('const { data: named }'), N.indexOf('resolvedMessageId = messageId'))
  assert.match(named, /named\.sender_id !== auth\.userId/)
  assert.match(named, /!sharedThreadIds\.includes\(named\.thread_id\)/)
  // And the thread branch checks membership before reading anything.
  assert.match(N, /if \(!sharedThreadIds\.includes\(threadId\)\) \{/)
})

// ------------------------------------------------- 9: nothing else moved

test('9: the broadcast email path is untouched', () => {
  const b = read('app/api/messages/broadcast/route.ts')
  assert.match(b, /idempotencyKey: batch\.idempotency_key/, 'it keeps its own frozen key')
  assert.ok(!/message-notification-/.test(b), 'and never uses the single-send key')
  assert.match(b, /const ALLOWED_TIERS = \['free', 'premium', 'ultimate'\] as const/)
})

test('9b: body, subject, recipient and authorization are unchanged', () => {
  assert.match(N, /from: NOTIFICATION_FROM/)
  assert.match(N, /to: recipient\.email/)
  assert.match(N, /subject: NOTIFICATION_SUBJECT/)
  assert.match(N, /html: buildNotificationEmail\(senderName, preview\)/)
  assert.match(N, /const isAdmin = isAdminEmail\(auth\.email\)/)
  assert.match(N, /sharedThreadIds\.length === 0 && !isAdmin/, 'the 403 rule is intact')
  // H-3/H-3B locks and the M-5 Phase 1 helper still stand.
  assert.match(M, /const sendInFlight = useRef\(false\)/)
  assert.match(M, /const composeInFlight = useRef\(false\)/)
  assert.match(M, /if \(!res\.ok\) \{/, 'the awaited res.ok check survives')
})
