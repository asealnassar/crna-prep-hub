import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * H-6: a grouped admin broadcast reports real read progress, X / Y read.
 *
 * The synthesized group row used to hardcode `recipientHasRead: true`. The
 * grouping invariant is `!hasReply` -- no recipient has REPLIED -- which says
 * nothing about whether anyone has READ, so the assertion was simply false:
 * measured against production, 497 of 503 grouped threads had a recipient who
 * had never opened the message, and all three broadcasts were filed under
 * "Read" and were absent from "Unread".
 *
 * `unreadCount: 0` is deliberately left alone. That one IS protected by the
 * invariant -- a thread nobody has replied to holds nothing unread for the
 * admin who sent it -- and recipient-side badge behaviour was verified correct
 * against live data.
 *
 * As elsewhere in this repo there is no DOM harness: the row builder and the
 * filter are modelled exactly, and the source assertions pin the component to
 * them.
 */

const SRC = readFileSync(new URL('../../components/MessagesModal.tsx', import.meta.url), 'utf8')
/** Executable text only, so a comment describing the old rule cannot pass a test. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

type Member = {
  groupId: string | null
  recipientHasRead: boolean
  unreadCount: number
  lastMessage: string
  lastMessageTime: string
}
type Group = { group_id: string; subject: string; recipients: number; replies: number; last_message_at: string }

const member = (groupId: string | null, recipientHasRead: boolean, i = 0): Member => ({
  groupId,
  recipientHasRead,
  unreadCount: 0,
  lastMessage: 'body',
  lastMessageTime: `2026-09-0${(i % 9) + 1}T00:00:00Z`,
})

/** Y members of which X have read. */
const cohort = (groupId: string, read: number, total: number) =>
  Array.from({ length: total }, (_, i) => member(groupId, i < read, i))

/** The group-row builder, as the component now writes it. */
function buildGroupRows(groups: Group[], grouped: Member[]) {
  return groups
    .filter((g) => grouped.some((t) => t.groupId === g.group_id))
    .map((g) => {
      const members = grouped.filter((t) => t.groupId === g.group_id)
      const newest = members.reduce(
        (a, b) => (a.lastMessageTime > b.lastMessageTime ? a : b),
        members[0],
      )
      const recipientCount = members.length
      const readCount = members.filter((m) => m.recipientHasRead).length
      const replyNote =
        g.replies > 0 ? `${g.replies} ${g.replies === 1 ? 'reply' : 'replies'}` : 'No replies yet'
      return {
        id: g.group_id,
        isGroup: true,
        subject: g.subject,
        readCount,
        recipientCount,
        otherParticipantEmail: `${readCount} / ${recipientCount} read · ${replyNote}`,
        lastMessage: newest?.lastMessage ?? '',
        lastMessageTime: g.last_message_at || newest?.lastMessageTime,
        unreadCount: 0,
        recipientHasRead: readCount === recipientCount,
      }
    })
}

/** The inbox filter, verbatim from the component. */
const applyFilter = (rows: { recipientHasRead: boolean }[], f: 'all' | 'unread' | 'read') =>
  rows.filter((thread) => {
    if (f === 'unread') return !thread.recipientHasRead
    if (f === 'read') return thread.recipientHasRead
    return true
  })

const G = (over: Partial<Group> = {}): Group => ({
  group_id: 'g1',
  subject: 'Announcement',
  recipients: 100,
  replies: 0,
  last_message_at: '2026-09-08T00:00:00Z',
  ...over,
})

// ------------------------------------------------------------ 1-4: the filter thresholds

test('1: a 0 / 100 broadcast is Unread', () => {
  const [row] = buildGroupRows([G()], cohort('g1', 0, 100))
  assert.equal(row.readCount, 0)
  assert.equal(row.recipientHasRead, false)
  assert.equal(applyFilter([row], 'unread').length, 1)
  assert.equal(applyFilter([row], 'read').length, 0)
})

test('2: an 8 / 100 broadcast is Unread', () => {
  const [row] = buildGroupRows([G()], cohort('g1', 8, 100))
  assert.equal(row.readCount, 8)
  assert.equal(row.recipientHasRead, false)
  assert.equal(applyFilter([row], 'unread').length, 1)
  assert.equal(applyFilter([row], 'read').length, 0)
})

test('3: a 99 / 100 broadcast is still Unread', () => {
  const [row] = buildGroupRows([G()], cohort('g1', 99, 100))
  assert.equal(row.recipientHasRead, false, 'one unread recipient keeps the whole broadcast unread')
  assert.equal(applyFilter([row], 'unread').length, 1)
  assert.equal(applyFilter([row], 'read').length, 0)
})

test('4: a 100 / 100 broadcast is Read', () => {
  const [row] = buildGroupRows([G()], cohort('g1', 100, 100))
  assert.equal(row.recipientHasRead, true)
  assert.equal(applyFilter([row], 'unread').length, 0)
  assert.equal(applyFilter([row], 'read').length, 1)
})

test('4b: every threshold from 0..N behaves monotonically', () => {
  for (let read = 0; read <= 10; read++) {
    const [row] = buildGroupRows([G()], cohort('g1', read, 10))
    assert.equal(row.recipientHasRead, read === 10, `${read}/10`)
  }
})

// --------------------------------------------------------------- 5-7: the numbers

test('5: the row displays exactly "X / Y read"', () => {
  const [row] = buildGroupRows([G()], cohort('g1', 8, 100))
  assert.match(row.otherParticipantEmail, /^8 \/ 100 read · /)
  assert.equal(row.otherParticipantEmail, '8 / 100 read · No replies yet')

  const [withReplies] = buildGroupRows([G({ replies: 1 })], cohort('g1', 63, 100))
  assert.equal(withReplies.otherParticipantEmail, '63 / 100 read · 1 reply')

  const [plural] = buildGroupRows([G({ replies: 4 })], cohort('g1', 100, 100))
  assert.equal(plural.otherParticipantEmail, '100 / 100 read · 4 replies')
})

test('6: readCount is derived from the members, not from the server cluster size', () => {
  // The server claims 100; only 3 member threads are actually present.
  const [row] = buildGroupRows([G({ recipients: 100 })], cohort('g1', 2, 3))
  assert.equal(row.readCount, 2)
  assert.equal(row.recipientCount, 3, 'Y is the represented member count, not g.recipients')
  assert.ok(row.readCount <= row.recipientCount, 'X can never exceed Y')
})

test('7: recipientCount equals the represented member-thread count', () => {
  for (const n of [1, 3, 15, 111, 377]) {
    const [row] = buildGroupRows([G({ recipients: 9999 })], cohort('g1', 0, n))
    assert.equal(row.recipientCount, n)
  }
})

// ------------------------------------------------- 8-11: nothing else may change

test('8: a normal 1-to-1 thread keeps its own recipientHasRead', () => {
  // Normal rows are not built here at all -- they carry the server's value.
  const normal = [
    { recipientHasRead: false, isGroup: false },
    { recipientHasRead: true, isGroup: false },
  ]
  assert.equal(applyFilter(normal, 'unread').length, 1)
  assert.equal(applyFilter(normal, 'read').length, 1)
  assert.match(code, /recipientHasRead: m\?\.recipient_has_read \?\? true/, 'normal rows untouched')
})

test('9: the Read/Unread filter itself is unchanged', () => {
  const block = code.slice(code.indexOf("if (messageFilter === 'unread')"))
  assert.match(block.slice(0, 200), /if \(messageFilter === 'unread'\) return !thread\.recipientHasRead/)
  assert.match(block.slice(0, 200), /if \(messageFilter === 'read'\) return thread\.recipientHasRead/)
  assert.ok(
    !/isGroup/.test(block.slice(0, 200)),
    'the fix must not special-case groups in the filter',
  )
})

test('10: the recipient-side unread badge formula is unchanged', () => {
  assert.match(
    code,
    /setGlobalMessagesUnreadCount\(individual\.filter\(t => t\.unreadCount > 0\)\.length\)/,
    'the badge must still count individual threads only',
  )
})

test('11: grouped unreadCount is still 0', () => {
  const [row] = buildGroupRows([G()], cohort('g1', 8, 100))
  assert.equal(row.unreadCount, 0, 'left alone: safe under the grouping invariant')
})

// --------------------------------------------------- 12-14: progress, dedup, safety

test('12: progress advances from X/Y to X+1/Y as a member is read', () => {
  const members = cohort('g1', 8, 100)
  const [before] = buildGroupRows([G()], members)
  assert.equal(before.otherParticipantEmail, '8 / 100 read · No replies yet')
  assert.equal(before.recipientHasRead, false)

  const next = members.findIndex((m) => !m.recipientHasRead)
  members[next] = { ...members[next], recipientHasRead: true }

  const [after] = buildGroupRows([G()], members)
  assert.equal(after.otherParticipantEmail, '9 / 100 read · No replies yet')
  assert.equal(after.recipientHasRead, false)

  // ...and the last one flips it to Read.
  const all = cohort('g1', 100, 100)
  const [done] = buildGroupRows([G()], all)
  assert.equal(done.otherParticipantEmail, '100 / 100 read · No replies yet')
  assert.equal(done.recipientHasRead, true)
})

test('13: members of other groups and ungrouped threads are never counted', () => {
  const mixed = [
    ...cohort('g1', 2, 5),
    ...cohort('g2', 7, 7),
    member(null, false),
    member(null, true),
  ]
  const rows = buildGroupRows([G({ group_id: 'g1' }), G({ group_id: 'g2' })], mixed)
  assert.equal(rows.length, 2)

  const g1 = rows.find((r) => r.id === 'g1')!
  const g2 = rows.find((r) => r.id === 'g2')!
  assert.equal(g1.recipientCount, 5)
  assert.equal(g1.readCount, 2)
  assert.equal(g1.recipientHasRead, false)
  assert.equal(g2.recipientCount, 7)
  assert.equal(g2.readCount, 7)
  assert.equal(g2.recipientHasRead, true)

  const total = rows.reduce((n, r) => n + r.recipientCount, 0)
  assert.equal(total, 12, 'no member counted twice, no ungrouped thread pulled in')
})

test('14: a group with no present members is dropped, not rendered or crashed', () => {
  const rows = buildGroupRows([G({ group_id: 'ghost' })], cohort('g1', 1, 2))
  assert.equal(rows.length, 0, 'the pre-filter removes a group whose members are absent')

  // And the builder itself survives an empty member list without throwing.
  assert.doesNotThrow(() => {
    const members: Member[] = []
    const newest = members.reduce((a, b) => (a.lastMessageTime > b.lastMessageTime ? a : b), members[0])
    const row = {
      lastMessage: newest?.lastMessage ?? '',
      readCount: members.filter((m) => m.recipientHasRead).length,
      recipientCount: members.length,
    }
    assert.equal(row.lastMessage, '')
    assert.equal(row.recipientCount, 0)
  })
})

// ------------------------------- 15+: the shipped component implements this

const start = code.indexOf('const groupRows = meta.groups')
const end = code.indexOf('const combined =', start)
assert.ok(start > -1 && end > start, 'the group-row builder must be locatable')
const rowSrc = code.slice(start, end)

test('15: the component derives the counts and no longer hardcodes read', () => {
  assert.match(rowSrc, /const recipientCount = members\.length/)
  assert.match(rowSrc, /const readCount = members\.filter\(m => m\.recipientHasRead\)\.length/)
  assert.match(rowSrc, /recipientHasRead: readCount === recipientCount/)
  assert.ok(
    !/recipientHasRead: true/.test(rowSrc),
    'the hardcoded true must be gone from the group row',
  )
})

test('16: the row text carries the progress, and unreadCount stays 0', () => {
  assert.match(rowSrc, /\$\{readCount\} \/ \$\{recipientCount\} read/)
  assert.match(rowSrc, /unreadCount: 0/, 'deliberately preserved')
  assert.ok(
    !/g\.recipients\} recipients/.test(rowSrc),
    'the old "N recipients" subtitle is replaced by the progress',
  )
})

test('17: Y comes from members, never from the server cluster size', () => {
  assert.ok(
    !/recipientCount = g\.recipients/.test(rowSrc),
    'recipientCount must not be taken from g.recipients',
  )
})
