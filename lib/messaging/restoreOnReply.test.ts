import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionFor } from './liveSession.test-helper.ts'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * H-1: a hidden conversation returns when a new message arrives.
 *
 * Runs against a REAL Supabase project — the behaviour under test is a database
 * trigger, so nothing here can be proved with a stub. Opt in with
 * MESSAGING_SECURITY_TESTS=1, the same gate the security suite uses.
 *
 * BEFORE the restore migration is applied, the tests that assert restoration
 * are EXPECTED TO FAIL. Every row created is tagged and removed at the end.
 */

const TAG = 'H1-RESTORE-TEST'
const B_EMAIL = process.env.MESSAGING_TEST_USER_B ?? 'testuserb@gmail.com'

try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
} catch { /* env may come from the shell */ }

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const enabled = process.env.MESSAGING_SECURITY_TESTS === '1' && !!URL && !!ANON && !!SERVICE
const skip = enabled ? false : 'set MESSAGING_SECURITY_TESTS=1 with Supabase credentials'

const admin: SupabaseClient = enabled
  ? createClient(URL!, SERVICE!, { auth: { autoRefreshToken: false, persistSession: false } })
  : (null as any)

/** Shared with the other live suites -- one authentication per account across
 *  every parallel test process. See liveSession.test-helper.ts. */
const sessionFor = makeSessionFor(admin, URL!, ANON!)
const asUser = (t: string) => createClient(URL!, ANON!, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { headers: { Authorization: `Bearer ${t}` } },
})
const asAnon = () => createClient(URL!, ANON!, { auth: { persistSession: false } })

type World = { adminId: string; B: string; bClient: SupabaseClient }
let world: World | null = null
async function ctx(): Promise<World> {
  if (world) return world
  const { data: adminId } = await admin.rpc('get_admin_user_id')
  const { data: u, error } = await admin.from('user_profiles').select('id').eq('email', B_EMAIL).single()
  if (error || !u) throw new Error(`throwaway account not found: ${B_EMAIL}`)
  world = { adminId: adminId as string, B: u.id, bClient: asUser(await sessionFor(B_EMAIL)) }
  return world
}

/** A valid two-party thread (admin + member) carrying one admin message. */
async function makeThread(label: string) {
  const w = await ctx()
  const { data: t } = await admin.from('message_threads')
    .insert({ subject: `${TAG} ${label}`, created_by: w.adminId }).select().single()
  await admin.from('thread_participants')
    .insert([{ thread_id: t!.id, user_id: w.adminId }, { thread_id: t!.id, user_id: w.B }])
  const { data: m } = await admin.from('thread_messages')
    .insert({ thread_id: t!.id, sender_id: w.adminId, message_text: `${TAG} first` }).select().single()
  await admin.from('message_read_status')
    .insert({ message_id: m!.id, user_id: w.B, delivered_at: new Date().toISOString() })
  return { w, threadId: t!.id as string, firstMessageId: m!.id as string }
}

const hideFor = (threadId: string, userId: string) =>
  admin.from('thread_participants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('thread_id', threadId).eq('user_id', userId)

const participantRows = async (threadId: string) => {
  const { data } = await admin.from('thread_participants')
    .select('id, thread_id, user_id, joined_at, deleted_at').eq('thread_id', threadId)
  return (data ?? []).slice().sort((a: any, b: any) => a.user_id.localeCompare(b.user_id))
}

// ============================================================ 1, 2, 11
test('1/2/11: an incoming message restores only the hidden recipient', { skip }, async () => {
  const { w, threadId } = await makeThread('restore')
  await hideFor(threadId, w.B)
  const before = await participantRows(threadId)
  const adminBefore = before.find((r: any) => r.user_id === w.adminId)
  assert.equal(adminBefore.deleted_at, null, 'the admin never hid it')

  // A new incoming message from the admin.
  await admin.from('thread_messages')
    .insert({ thread_id: threadId, sender_id: w.adminId, message_text: `${TAG} incoming` })

  const after = await participantRows(threadId)
  const b = after.find((r: any) => r.user_id === w.B)
  const a = after.find((r: any) => r.user_id === w.adminId)
  assert.equal(b.deleted_at, null, 'the hidden recipient must be restored')          // 1
  assert.equal(a.deleted_at, null, 'the sender must be left exactly as it was')      // 2, 11
})

// ============================================================ 3
test('3: a hidden user sending into their own thread stays hidden', { skip }, async () => {
  const { w, threadId } = await makeThread('self-send')
  await hideFor(threadId, w.B)
  const res = await w.bClient.from('thread_messages')
    .insert({ thread_id: threadId, sender_id: w.B, message_text: `${TAG} my own reply` }).select()
  assert.equal(res.error, null, `the member must still be able to reply: ${res.error?.message}`)
  const rows = await participantRows(threadId)
  assert.notEqual(rows.find((r: any) => r.user_id === w.B).deleted_at, null,
    'sending does not unhide your own copy')
})

// ============================================================ 4, 5, 6
test('4/5/6: the restored message is unread and no history is touched', { skip }, async () => {
  const { w, threadId, firstMessageId } = await makeThread('history')
  const { data: firstBefore } = await admin.from('thread_messages')
    .select('id, thread_id, sender_id, message_text, created_at').eq('id', firstMessageId).single()
  await hideFor(threadId, w.B)

  const { data: incoming } = await admin.from('thread_messages')
    .insert({ thread_id: threadId, sender_id: w.adminId, message_text: `${TAG} incoming` }).select().single()
  await admin.from('message_read_status')
    .insert({ message_id: incoming!.id, user_id: w.B, delivered_at: new Date().toISOString() })

  const { data: receipt } = await admin.from('message_read_status')
    .select('read_at, delivered_at').eq('message_id', incoming!.id).eq('user_id', w.B).single()
  assert.equal(receipt!.read_at, null, 'the restored message must arrive unread')     // 4
  assert.notEqual(receipt!.delivered_at, null)

  const { count } = await admin.from('thread_messages')
    .select('*', { count: 'exact', head: true }).eq('thread_id', threadId)
  assert.equal(count, 2, 'the prior history is still there')                          // 5

  const { data: firstAfter } = await admin.from('thread_messages')
    .select('id, thread_id, sender_id, message_text, created_at').eq('id', firstMessageId).single()
  assert.deepEqual(firstAfter, firstBefore, 'no existing message row may change')     // 6
})

// ============================================================ 7
test('7: no participant field other than deleted_at changes', { skip }, async () => {
  const { w, threadId } = await makeThread('fields')
  await hideFor(threadId, w.B)
  const before = await participantRows(threadId)
  await admin.from('thread_messages')
    .insert({ thread_id: threadId, sender_id: w.adminId, message_text: `${TAG} incoming` })
  const after = await participantRows(threadId)
  assert.equal(after.length, before.length)
  for (let i = 0; i < before.length; i++) {
    for (const field of ['id', 'thread_id', 'user_id', 'joined_at']) {
      assert.deepEqual((after[i] as any)[field], (before[i] as any)[field],
        `${field} must not change`)
    }
  }
})

// ============================================================ 8
test('8: a brand-new thread is unaffected', { skip }, async () => {
  const w = await ctx()
  const { data: threadId, error } = await w.bClient.rpc('create_thread_with_message', {
    p_subject: `${TAG} new thread`, p_recipient_ids: [w.adminId], p_message_text: `${TAG} hello`,
  })
  assert.equal(error, null, `member -> admin must still work: ${error?.message}`)
  const rows = await participantRows(threadId as string)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r: any) => r.deleted_at === null), 'nothing was hidden, nothing changes')
})

// ============================================================ 9
test('9: a NULL-sender message restores nobody', { skip }, async () => {
  const { w, threadId } = await makeThread('null-sender')
  await hideFor(threadId, w.B)
  await admin.from('thread_messages')
    .insert({ thread_id: threadId, sender_id: null, message_text: `${TAG} null sender` })
  const rows = await participantRows(threadId)
  assert.notEqual(rows.find((r: any) => r.user_id === w.B).deleted_at, null,
    'a message with no sender must restore nobody')
  assert.equal(rows.find((r: any) => r.user_id === w.adminId).deleted_at, null)
})

// ============================================================ 10
test('10: hiding still works after the trigger exists', { skip }, async () => {
  const { w, threadId } = await makeThread('hide-again')
  const hide = await w.bClient.from('thread_participants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('thread_id', threadId).eq('user_id', w.B).select()
  assert.equal(hide.error, null, `hiding must keep working: ${hide.error?.message}`)
  assert.equal(hide.data!.length, 1)
  const { data } = await w.bClient.from('thread_participants')
    .select('thread_id').eq('user_id', w.B).is('deleted_at', null)
  assert.ok(!(data ?? []).some((r: any) => r.thread_id === threadId),
    'a hidden thread leaves the inbox query')
})

// ============================================================ 12
test('12: the trigger function is not callable by anon or a member', { skip }, async () => {
  const w = await ctx()
  for (const [who, client] of [['anon', asAnon()], ['member', w.bClient]] as const) {
    const { error } = await client.rpc('messaging_restore_on_reply')
    assert.ok(error, `${who} must not be able to invoke the trigger function directly`)
  }
})

// ============================================================= CLEANUP
test('cleanup: every row this suite created is removed', { skip }, async () => {
  const { data: threads } = await admin.from('message_threads').select('id').like('subject', `${TAG}%`)
  const ids = (threads ?? []).map((t: any) => t.id)
  if (ids.length) {
    const { data: msgs } = await admin.from('thread_messages').select('id').in('thread_id', ids)
    const mids = (msgs ?? []).map((m: any) => m.id)
    if (mids.length) {
      await admin.from('message_read_status').delete().in('message_id', mids)
      await admin.from('message_deletions').delete().in('message_id', mids)
      await admin.from('thread_messages').delete().in('id', mids)
    }
    await admin.from('thread_participants').delete().in('thread_id', ids)
    await admin.from('message_threads').delete().in('id', ids)
  }
  const { count } = await admin.from('message_threads')
    .select('*', { count: 'exact', head: true }).like('subject', `${TAG}%`)
  assert.equal(count, 0, 'test data must not be left behind')
  world = null
})
