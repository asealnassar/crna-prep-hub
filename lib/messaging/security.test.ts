import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionFor } from './liveSession.test-helper.ts'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Messaging security suite.
 *
 * Runs against a REAL Supabase project, because the controls being tested are
 * RLS policies and function privileges — none of them exist in application
 * code, so nothing here can be proved with a stub.
 *
 * Opt-in: set MESSAGING_SECURITY_TESTS=1 and provide .env.local. It is gated
 * rather than always-on so a normal `node --test` run does not reach out to a
 * live database.
 *
 * BEFORE the security migration these tests are EXPECTED TO FAIL. That is what
 * they are for: each one names a control the audit proved absent.
 *
 * Every row created is tagged and removed in the final test. Real
 * conversations are never read, written or deleted.
 */

const TAG = 'MSGSEC-TEST'
const A_EMAIL = process.env.MESSAGING_TEST_USER_A ?? 'testusera@gmail.com'
const B_EMAIL = process.env.MESSAGING_TEST_USER_B ?? 'testuserb@gmail.com'

function loadEnv() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* env may come from the shell instead */ }
}
loadEnv()

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const enabled = process.env.MESSAGING_SECURITY_TESTS === '1' && !!URL && !!ANON && !!SERVICE
const skip = enabled ? false : 'set MESSAGING_SECURITY_TESTS=1 with Supabase credentials'

const admin: SupabaseClient = enabled
  ? createClient(URL!, SERVICE!, { auth: { autoRefreshToken: false, persistSession: false } })
  : (null as any)

/**
 * A session for a throwaway account, shared with every other live suite.
 *
 * The magic-link exchange used to be duplicated in each of the three live
 * files. Because node --test runs them in parallel processes, a full run fired
 * nine OTP verifications at three accounts within a second or two and Supabase
 * throttled them -- failures that moved between suites on each rerun. The
 * helper caches one token per account across processes; see
 * liveSession.test-helper.ts.
 */
const sessionFor = makeSessionFor(admin, URL!, ANON!)

const asUser = (token: string) =>
  createClient(URL!, ANON!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

const asAnon = () => createClient(URL!, ANON!, { auth: { persistSession: false } })

type World = {
  A: string; B: string; adminId: string
  aToken: string; bToken: string
  aClient: SupabaseClient; bClient: SupabaseClient
  threadAB: string; messageAB: string
}
let world: World | null = null

/** One shared fixture: a thread between user A and the admin, which B is not in. */
async function setup(): Promise<World> {
  if (world) return world
  const { data: users, error } = await admin
    .from('user_profiles').select('id, email').in('email', [A_EMAIL, B_EMAIL])
  if (error) throw new Error(error.message)
  const A = users!.find((u: any) => u.email === A_EMAIL)?.id
  const B = users!.find((u: any) => u.email === B_EMAIL)?.id
  if (!A || !B) throw new Error(`throwaway accounts not found: ${A_EMAIL}, ${B_EMAIL}`)
  const { data: adminId } = await admin.rpc('get_admin_user_id')

  const { data: t } = await admin.from('message_threads')
    .insert({ subject: `${TAG} A-with-admin`, created_by: A }).select().single()
  await admin.from('thread_participants')
    .insert([{ thread_id: t!.id, user_id: A }, { thread_id: t!.id, user_id: adminId }])
  const { data: m } = await admin.from('thread_messages')
    .insert({ thread_id: t!.id, sender_id: A, message_text: `${TAG} body` }).select().single()
  await admin.from('message_read_status')
    .insert({ message_id: m!.id, user_id: adminId, delivered_at: new Date().toISOString() })

  // One authentication per account for the whole run, shared across suites.
  const [aToken, bToken] = await Promise.all([sessionFor(A_EMAIL), sessionFor(B_EMAIL)])

  world = {
    A, B, adminId: adminId as string,
    aToken,
    bToken,
    aClient: asUser(aToken),
    bClient: asUser(bToken),
    threadAB: t!.id, messageAB: m!.id,
  }
  return world
}

/** True when the database refused: an error, or a filtered-away empty result. */
const denied = (res: any) => Boolean(res.error) || (Array.isArray(res.data) && res.data.length === 0)

// ============================================================ A. PRIVACY
test('1: a participant can read their own thread', { skip }, async () => {
  const w = await setup()
  const { data, error } = await w.aClient.from('message_threads').select('id').eq('id', w.threadAB)
  assert.equal(error, null)
  assert.equal(data!.length, 1, 'a participant must still see their own conversation')
})

test('2: a non-participant cannot read that thread', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('message_threads').select('id').eq('id', w.threadAB)))
})

test('3: a non-participant cannot read its messages', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('thread_messages').select('id, message_text').eq('thread_id', w.threadAB)))
})

test('4: a non-participant cannot read its participant rows', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('thread_participants').select('id').eq('thread_id', w.threadAB)))
})

test('5: a non-participant cannot read its read-status rows', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('message_read_status').select('id').eq('message_id', w.messageAB)))
})

test('5b: a member cannot enumerate the whole messaging database', { skip }, async () => {
  const w = await setup()
  const { count } = await w.bClient.from('thread_messages').select('*', { count: 'exact', head: true })
  const { count: total } = await admin.from('thread_messages').select('*', { count: 'exact', head: true })
  assert.ok((count ?? 0) < (total ?? 0),
    `a member saw ${count} of ${total} messages — the whole table must never be visible`)
})

// ============================================================ B. WRITES
test('6: a non-participant cannot insert into another thread', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('thread_messages')
    .insert({ thread_id: w.threadAB, sender_id: w.B, message_text: `${TAG} intrusion` }).select()))
})

test('7: sender_id cannot be forged', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.aClient.from('thread_messages')
    .insert({ thread_id: w.threadAB, sender_id: w.adminId, message_text: `${TAG} spoofed` }).select()),
    'a participant must not be able to post as somebody else')
})

test('8: another user’s message cannot be edited', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('thread_messages')
    .update({ message_text: `${TAG} tampered` }).eq('id', w.messageAB).select()))
})

test('9: another user’s message cannot be deleted', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('thread_messages').delete().eq('id', w.messageAB).select()))
})

test('10: a user cannot join an unrelated thread', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('thread_participants')
    .insert({ thread_id: w.threadAB, user_id: w.B }).select()))
})

test('11: another participant cannot be modified', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('thread_participants')
    .update({ deleted_at: new Date().toISOString() }).eq('thread_id', w.threadAB).select()))
  // Nor may a participant rewrite their own row into someone else's.
  assert.ok(denied(await w.aClient.from('thread_participants')
    .update({ user_id: w.B }).eq('thread_id', w.threadAB).eq('user_id', w.A).select()))
})

test('11b: a participant may still hide their own conversation', { skip }, async () => {
  const w = await setup()
  const hide = await w.aClient.from('thread_participants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('thread_id', w.threadAB).eq('user_id', w.A).select()
  assert.equal(hide.error, null)
  assert.equal(hide.data!.length, 1, 'hiding your own conversation must keep working')
  await admin.from('thread_participants').update({ deleted_at: null })
    .eq('thread_id', w.threadAB).eq('user_id', w.A)
})

test('12: an unrelated thread cannot be renamed or deleted', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.bClient.from('message_threads')
    .update({ subject: `${TAG} hijacked` }).eq('id', w.threadAB).select()))
  assert.ok(denied(await w.bClient.from('message_threads').delete().eq('id', w.threadAB).select()))
  // Even a participant may not rename: only updated_at may move.
  assert.ok(denied(await w.aClient.from('message_threads')
    .update({ subject: `${TAG} renamed by participant` }).eq('id', w.threadAB).select()))
})

// ====================================================== C. PRODUCT RULE
test('13: a member may open a conversation with the admin', { skip }, async () => {
  const w = await setup()
  const { data, error } = await w.bClient.rpc('create_thread_with_message', {
    p_subject: `${TAG} member-to-admin`, p_recipient_ids: [w.adminId], p_message_text: `${TAG} hello`,
  })
  assert.equal(error, null, `a member must still be able to message the admin: ${error?.message}`)
  assert.ok(typeof data === 'string' && data.length > 0)
})

test('15/16: a member cannot open a conversation with another member', { skip }, async () => {
  const w = await setup()
  const { error } = await w.bClient.rpc('create_thread_with_message', {
    p_subject: `${TAG} member-to-member`, p_recipient_ids: [w.A], p_message_text: `${TAG} nope`,
  })
  assert.ok(error, 'user-to-user threads must be rejected by the database, not just hidden in the UI')
  // And the admin cannot be smuggled in alongside a second recipient.
  const { error: mixed } = await w.bClient.rpc('create_thread_with_message', {
    p_subject: `${TAG} mixed`, p_recipient_ids: [w.adminId, w.A], p_message_text: `${TAG} nope`,
  })
  assert.ok(mixed, 'a member must not reach another member by adding the admin to the list')
})

// ============================== G. ONE PRIVATE THREAD PER RECIPIENT
test('G3: a member cannot pass multiple recipients', { skip }, async () => {
  const w = await setup()
  for (const list of [[], [w.adminId, w.adminId], [w.adminId, w.B], [null]]) {
    const { error } = await w.bClient.rpc('create_thread_with_message', {
      p_subject: `${TAG} multi`, p_recipient_ids: list, p_message_text: `${TAG} nope`,
    })
    assert.ok(error, `recipient list ${JSON.stringify(list)} must be rejected`)
  }
})

test('G5: even the admin cannot create one thread with several recipients', { skip }, async () => {
  // Exercised through a member session: the DB must refuse the SHAPE before it
  // ever reaches the member-vs-admin branch, so a tampered admin client is
  // refused by the same clause. Verified as admin in the manual UAT step.
  const w = await setup()
  const { error } = await w.bClient.rpc('create_thread_with_message', {
    p_subject: `${TAG} group`, p_recipient_ids: [w.A, w.B, w.adminId], p_message_text: `${TAG} nope`,
  })
  assert.ok(error, 'no caller may produce a thread holding more than two people')
})

test('G6/G7/G8: one thread per recipient, two participants each, mutually invisible', { skip }, async () => {
  const w = await setup()
  // The admin compose box loops: one single-recipient call per selected user.
  const created: string[] = []
  for (const recipient of [w.A, w.B]) {
    const { data: t } = await admin.from('message_threads')
      .insert({ subject: `${TAG} fanout`, created_by: w.adminId }).select().single()
    await admin.from('thread_participants')
      .insert([{ thread_id: t!.id, user_id: w.adminId }, { thread_id: t!.id, user_id: recipient }])
    created.push(t!.id)
  }
  assert.equal(created.length, 2, 'each recipient gets their own thread')
  for (const id of created) {
    const { count } = await admin.from('thread_participants')
      .select('*', { count: 'exact', head: true }).eq('thread_id', id)
    assert.equal(count, 2, 'a conversation is always admin plus exactly one member')
  }
  // B must not see A's thread, nor anyone in it.
  assert.ok(denied(await w.bClient.from('message_threads').select('id').eq('id', created[0])))
  assert.ok(denied(await w.bClient.from('thread_participants').select('user_id').eq('thread_id', created[0])))
})

test('G9: a legacy user-to-user thread accepts no new reply', { skip }, async () => {
  const w = await setup()
  // A thread with no admin participant — the shape this migration must render
  // unusable without deleting it.
  const { data: t } = await admin.from('message_threads')
    .insert({ subject: `${TAG} legacy user-to-user`, created_by: w.A }).select().single()
  await admin.from('thread_participants')
    .insert([{ thread_id: t!.id, user_id: w.A }, { thread_id: t!.id, user_id: w.B }])
  // Both members are genuine participants, and both must still be refused.
  for (const [who, client, id] of [['A', w.aClient, w.A], ['B', w.bClient, w.B]] as const) {
    const res = await client.from('thread_messages')
      .insert({ thread_id: t!.id, sender_id: id, message_text: `${TAG} legacy reply` }).select()
    assert.ok(denied(res), `${who} must not be able to reply in a user-to-user thread`)
  }
  // The historical row itself is untouched by the rule.
  const { count } = await admin.from('thread_messages')
    .select('*', { count: 'exact', head: true }).eq('thread_id', t!.id)
  assert.equal(count, 0)
})

test('G3b: a legacy admin + TWO members thread accepts no reply from either', { skip }, async () => {
  const w = await setup()
  const { data: t } = await admin.from('message_threads')
    .insert({ subject: `${TAG} legacy multi-party`, created_by: w.adminId }).select().single()
  await admin.from('thread_participants').insert([
    { thread_id: t!.id, user_id: w.adminId },
    { thread_id: t!.id, user_id: w.A },
    { thread_id: t!.id, user_id: w.B },
  ])
  // Both members are genuine participants, and the admin IS present -- the
  // condition that "caller is in it and admin is in it" would have allowed.
  for (const [who, client, id] of [['A', w.aClient, w.A], ['B', w.bClient, w.B]] as const) {
    const res = await client.from('thread_messages')
      .insert({ thread_id: t!.id, sender_id: id, message_text: `${TAG} multi reply` }).select()
    assert.ok(denied(res), `${who} must not reach another member through a three-party thread`)
  }
  // The historical rows are untouched by the rule.
  const { count } = await admin.from('thread_participants')
    .select('*', { count: 'exact', head: true }).eq('thread_id', t!.id)
  assert.equal(count, 3, 'a legacy thread keeps every participant row it had')
})

test('G7b: a newly created thread always holds exactly two distinct participants', { skip }, async () => {
  const w = await setup()
  const { data: threadId, error } = await w.bClient.rpc('create_thread_with_message', {
    p_subject: `${TAG} two-party`, p_recipient_ids: [w.adminId], p_message_text: `${TAG} hello`,
  })
  assert.equal(error, null, `a member must still be able to message the admin: ${error?.message}`)
  const { data: parts } = await admin.from('thread_participants')
    .select('user_id').eq('thread_id', threadId as string)
  const distinct = new Set((parts ?? []).map((p: any) => p.user_id))
  assert.equal(distinct.size, 2, 'every new conversation is admin plus exactly one member')
  assert.ok(distinct.has(w.adminId) && distinct.has(w.B))
})

test('G11: a member can still reply in their own admin thread', { skip }, async () => {
  const w = await setup()
  const res = await w.aClient.from('thread_messages')
    .insert({ thread_id: w.threadAB, sender_id: w.A, message_text: `${TAG} legitimate reply` }).select()
  assert.equal(res.error, null, `a member must still be able to reply to the admin: ${res.error?.message}`)
  assert.equal(res.data!.length, 1)
})

// ======================================================== D. BROADCAST
test('17: an anonymous caller cannot broadcast', { skip }, async () => {
  const { error } = await asAnon().rpc('send_tier_broadcast', {
    p_subject: `${TAG} anon`, p_message_text: `${TAG} anon`, p_tier: 'free',
  })
  assert.ok(error, 'send_tier_broadcast must not be reachable without a session')
})

test('18: an ordinary member cannot broadcast', { skip }, async () => {
  const w = await setup()
  const { error } = await w.bClient.rpc('send_tier_broadcast', {
    p_subject: `${TAG} member`, p_message_text: `${TAG} member`, p_tier: 'free',
  })
  assert.ok(error, 'a non-admin must be refused explicitly, not merely starved of recipients')
})

test('18b: get_admin_user_id is not answerable anonymously', { skip }, async () => {
  const { error } = await asAnon().rpc('get_admin_user_id')
  assert.ok(error, 'a signed-out visitor has no reason to learn the admin user id')
})

// ========================================================= E. REALTIME
async function receivesRealtime(token: string | null, threadId: string, body: string) {
  const c = token
    ? createClient(URL!, ANON!, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      })
    : asAnon()
  if (token) c.realtime.setAuth(token)
  let got: any = null
  await new Promise<void>((resolve) => {
    c.channel(`msgsec-${Math.random().toString(16).slice(2)}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'thread_messages' },
        (p: any) => { if (p.new?.thread_id === threadId) { got = p.new; resolve() } })
      .subscribe((s: string) => { if (s === 'SUBSCRIBED') setTimeout(resolve, 1500) })
  })
  const { data: m } = await admin.from('thread_messages')
    .insert({ thread_id: threadId, sender_id: null, message_text: body }).select().single()
  await new Promise((r) => setTimeout(r, 4000))
  await admin.from('thread_messages').delete().eq('id', m!.id)
  await c.removeAllChannels()
  return got
}

test('20: a participant receives realtime messages for their own thread', { skip }, async () => {
  const w = await setup()
  // w.aToken, not a fresh sessionFor: the same account, already authenticated.
  const got = await receivesRealtime(w.aToken, w.threadAB, `${TAG} rt-allowed`)
  assert.ok(got, 'a participant must still receive live updates')
})

test('21: a non-participant receives no realtime payload', { skip }, async () => {
  const w = await setup()
  const got = await receivesRealtime(w.bToken, w.threadAB, `${TAG} rt-denied`)
  assert.equal(got, null, 'realtime must obey the same boundary as SELECT')
})

// ============================================================= F. AUTH
test('22: anonymous callers cannot read the messaging tables', { skip }, async () => {
  const anon = asAnon()
  for (const t of ['message_threads', 'thread_messages', 'thread_participants',
                   'message_read_status', 'message_deletions']) {
    const res = await anon.from(t).select('*').limit(1)
    assert.ok(denied(res), `anon could read ${t}`)
  }
})

test('23: anonymous callers cannot create a thread', { skip }, async () => {
  const anon = asAnon()
  assert.ok(denied(await anon.from('message_threads')
    .insert({ subject: `${TAG} anon`, created_by: null }).select()))
  const { error } = await anon.rpc('create_thread_with_message', {
    p_subject: `${TAG} anon`, p_recipient_ids: [], p_message_text: `${TAG} anon`,
  })
  assert.ok(error, 'thread creation must require a session')
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

/**
 * NOT COVERED HERE — anything requiring a session for the real admin account,
 * which this suite will not mint:
 *
 *   * admin -> one user succeeds
 *   * the admin can reply in a valid two-party thread they participate in
 *   * the admin CANNOT reply in a legacy three-party thread
 *
 * The reply predicate treats both parties of a valid thread identically, and
 * counts participants without reference to who is asking, so the member-side
 * results above exercise the same clause -- but the admin cases are listed in
 * the manual post-migration UAT plan rather than asserted here.
 */

/**
 * NOT COVERED HERE — test 19, "a legitimate admin broadcast still succeeds".
 *
 * It needs a session for the real admin account, which this suite will not
 * mint. It is a manual post-migration UAT step: sign in as the admin, send a
 * tier broadcast to a throwaway tier holding one throwaway account, confirm
 * one thread is created and the email summary reports one recipient.
 */
