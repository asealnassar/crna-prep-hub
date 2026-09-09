import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionFor } from './liveSession.test-helper.ts'
import { readFileSync, existsSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * M-5 durable notification jobs, PHASE 1: the table exists and is locked down,
 * and NOTHING writes to it.
 *
 * Phase 1 is deliberately inert. These tests prove both halves of that: the
 * security model is the hardened one used by email_broadcast_batches, and no
 * message-creation path produces a job. The inertness half matters more than
 * it sounds -- shipping the Phase 2 trigger before broadcast exclusion would
 * double-email an entire tier, so "still zero jobs" is the checkpoint that
 * keeps the phases honest.
 *
 * Opt-in, like every live suite here: MESSAGING_SECURITY_TESTS=1 with
 * credentials. Throwaway accounts only; every row created is tagged and
 * removed. No email is sent by any test in this file.
 */

const TAG = 'MSGJOB-TEST'
const A_EMAIL = process.env.MESSAGING_TEST_USER_A ?? 'testusera@gmail.com'
const B_EMAIL = process.env.MESSAGING_TEST_USER_B ?? 'testuserb@gmail.com'
const ADMIN_EMAIL = 'asealnassar@gmail.com'
const JOBS = 'email_notification_jobs'

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
const anon: SupabaseClient = enabled
  ? createClient(URL!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } })
  : (null as any)

/** Shared with the other live suites -- one authentication per account across
 *  every parallel test process. See liveSession.test-helper.ts. */
const sessionFor = makeSessionFor(admin, URL!, ANON!)

const asUser = (token: string) =>
  createClient(URL!, ANON!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

/** PostgREST reports "not visible" and "not permitted" in several shapes. */
const denied = (res: { data: unknown; error: unknown }) =>
  Boolean(res.error) || (Array.isArray(res.data) && res.data.length === 0)

/** The table must exist before any of this means anything. */
async function tableExists(): Promise<boolean> {
  const { error } = await admin.from(JOBS).select('message_id').limit(1)
  return !error || error.code !== 'PGRST205'
}

type World = {
  aId: string; bId: string; adminId: string
  aClient: SupabaseClient; bClient: SupabaseClient; adminClient: SupabaseClient
  threadId: string; messageId: string
}
let world: World | null = null

async function setup(): Promise<World> {
  if (world) return world
  const ids: Record<string, string> = {}
  for (const email of [A_EMAIL, B_EMAIL, ADMIN_EMAIL]) {
    const { data } = await admin.from('user_profiles').select('id').eq('email', email).single()
    ids[email] = data!.id
  }
  const [aTok, bTok, adminTok] = await Promise.all([
    sessionFor(A_EMAIL), sessionFor(B_EMAIL), sessionFor(ADMIN_EMAIL),
  ])

  // One tagged thread, admin <-> A, created the normal way.
  const { data: threadId, error } = await asUser(adminTok).rpc('create_thread_with_message', {
    p_subject: `${TAG} fixture`,
    p_recipient_ids: [ids[A_EMAIL]],
    p_message_text: `${TAG} fixture body`,
  })
  if (error) throw new Error(`fixture thread: ${error.message}`)
  const { data: msg } = await admin
    .from('thread_messages').select('id').eq('thread_id', threadId).limit(1).single()

  world = {
    aId: ids[A_EMAIL], bId: ids[B_EMAIL], adminId: ids[ADMIN_EMAIL],
    aClient: asUser(aTok), bClient: asUser(bTok), adminClient: asUser(adminTok),
    threadId: threadId as string, messageId: msg!.id,
  }
  return world
}

/** Jobs for the tagged fixture only -- never a count of the whole table. */
async function jobsForTaggedMessages(): Promise<number> {
  const { data: threads } = await admin
    .from('message_threads').select('id').like('subject', `${TAG}%`)
  const tids = (threads ?? []).map((t: any) => t.id)
  if (!tids.length) return 0
  const { data: msgs } = await admin.from('thread_messages').select('id').in('thread_id', tids)
  const mids = (msgs ?? []).map((m: any) => m.id)
  if (!mids.length) return 0
  const { count } = await admin
    .from(JOBS).select('*', { count: 'exact', head: true }).in('message_id', mids)
  return count ?? 0
}

// ===================================================== the table is there at all

test('0: the table exists after the migration', { skip }, async () => {
  assert.ok(await tableExists(), `${JOBS} not found -- apply 20260908_002 first`)
})

// ===================================================== A. no browser role may touch it

for (const [label, who] of [['anon', 'anon']] as const) {
  test(`A1: ${label} cannot SELECT, INSERT, UPDATE or DELETE`, { skip }, async () => {
    const w = await setup()
    assert.ok(denied(await anon.from(JOBS).select('*')), 'SELECT must be refused')
    assert.ok(
      denied(await anon.from(JOBS).insert({ message_id: w.messageId, recipient_user_id: w.aId }).select()),
      'INSERT must be refused',
    )
    assert.ok(denied(await anon.from(JOBS).update({ status: 'sent' }).eq('message_id', w.messageId).select()))
    assert.ok(denied(await anon.from(JOBS).delete().eq('message_id', w.messageId).select()))
  })
}

test('A2: an ordinary authenticated member cannot touch it', { skip }, async () => {
  const w = await setup()
  assert.ok(denied(await w.aClient.from(JOBS).select('*')), 'SELECT must be refused')
  assert.ok(
    denied(await w.aClient.from(JOBS).insert({ message_id: w.messageId, recipient_user_id: w.aId }).select()),
  )
  assert.ok(denied(await w.aClient.from(JOBS).update({ status: 'sent' }).eq('message_id', w.messageId).select()))
  assert.ok(denied(await w.aClient.from(JOBS).delete().eq('message_id', w.messageId).select()))
})

test('A3: the ADMIN browser session cannot touch it either', { skip }, async () => {
  // The admin is just another authenticated session. This queue is
  // infrastructure, not an admin-editable table.
  const w = await setup()
  assert.ok(denied(await w.adminClient.from(JOBS).select('*')), 'admin SELECT must be refused')
  assert.ok(
    denied(await w.adminClient.from(JOBS).insert({ message_id: w.messageId, recipient_user_id: w.aId }).select()),
    'admin INSERT must be refused',
  )
  assert.ok(denied(await w.adminClient.from(JOBS).update({ status: 'sent' }).eq('message_id', w.messageId).select()))
  assert.ok(denied(await w.adminClient.from(JOBS).delete().eq('message_id', w.messageId).select()))
})

// ===================================================== B. the worker's role works

test('B1: service_role can SELECT and INSERT a valid job', { skip }, async () => {
  const w = await setup()
  await admin.from(JOBS).delete().eq('message_id', w.messageId)
  const { error } = await admin
    .from(JOBS).insert({ message_id: w.messageId, recipient_user_id: w.aId })
  assert.equal(error, null, 'the worker must be able to record an obligation')

  const { data } = await admin.from(JOBS).select('*').eq('message_id', w.messageId).single()
  assert.equal(data!.status, 'pending', 'default status')
  assert.equal(data!.attempts, 0, 'default attempts')
  assert.ok(data!.next_attempt_at, 'default next_attempt_at')
  assert.equal(data!.sent_at, null)
})

test('B2: service_role can update every worker-controlled field', { skip }, async () => {
  const w = await setup()
  const { error } = await admin
    .from(JOBS)
    .update({
      status: 'sending',
      attempts: 1,
      next_attempt_at: new Date(Date.now() + 1000).toISOString(),
      last_error: `${TAG} probe`,
      lease_owner: `${TAG}-worker`,
      lease_expires_at: new Date(Date.now() + 60000).toISOString(),
    })
    .eq('message_id', w.messageId)
  assert.equal(error, null, 'the lease/retry columns must be writable')

  const { error: sentErr } = await admin
    .from(JOBS).update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('message_id', w.messageId)
  assert.equal(sentErr, null)
})

test('B3: service_role CANNOT rewrite message_id or recipient_user_id', { skip }, async () => {
  const w = await setup()
  const mid = await admin.from(JOBS).update({ message_id: w.messageId }).eq('message_id', w.messageId)
  assert.ok(mid.error, 'message_id must not be updatable')
  assert.match(String(mid.error?.code ?? ''), /42501|PGRST/, 'expected a privilege refusal')

  const rid = await admin.from(JOBS).update({ recipient_user_id: w.bId }).eq('message_id', w.messageId)
  assert.ok(rid.error, 'recipient_user_id must not be updatable')

  const { data } = await admin.from(JOBS).select('recipient_user_id').eq('message_id', w.messageId).single()
  assert.equal(data!.recipient_user_id, w.aId, 'the recipient must be unchanged')
})

// ===================================================== C. constraints

test('C1: a duplicate message_id is rejected', { skip }, async () => {
  const w = await setup()
  const { error } = await admin
    .from(JOBS).insert({ message_id: w.messageId, recipient_user_id: w.aId })
  assert.ok(error, 'one message may never have two jobs')
  assert.equal(error!.code, '23505', 'primary key violation')
})

test('C2: an invalid status is rejected', { skip }, async () => {
  const w = await setup()
  const { error } = await admin
    .from(JOBS).update({ status: 'delivered' }).eq('message_id', w.messageId)
  assert.ok(error, 'only the five known states are allowed')
  assert.equal(error!.code, '23514', 'check constraint violation')
})

test('C3: negative attempts are rejected', { skip }, async () => {
  const w = await setup()
  const { error } = await admin.from(JOBS).update({ attempts: -1 }).eq('message_id', w.messageId)
  assert.ok(error)
  assert.equal(error!.code, '23514')
})

test('C4: a nonexistent message_id is rejected by the foreign key', { skip }, async () => {
  const w = await setup()
  const { error } = await admin.from(JOBS).insert({
    message_id: '00000000-0000-4000-8000-000000000000',
    recipient_user_id: w.aId,
  })
  assert.ok(error, 'a job must belong to a real message')
  assert.equal(error!.code, '23503', 'foreign key violation')
})

test('C5: deleting the message cascades its job away', { skip }, async () => {
  const w = await setup()
  // A throwaway message of its own, so the fixture survives for later tests.
  const { data: msg } = await admin
    .from('thread_messages')
    .insert({ thread_id: w.threadId, sender_id: w.adminId, message_text: `${TAG} cascade` })
    .select('id').single()
  await admin.from(JOBS).insert({ message_id: msg!.id, recipient_user_id: w.aId })

  const before = await admin.from(JOBS).select('*', { count: 'exact', head: true }).eq('message_id', msg!.id)
  assert.equal(before.count, 1)

  await admin.from('message_read_status').delete().eq('message_id', msg!.id)
  await admin.from('thread_messages').delete().eq('id', msg!.id)

  const after = await admin.from(JOBS).select('*', { count: 'exact', head: true }).eq('message_id', msg!.id)
  assert.equal(after.count, 0, 'the job must go with its message')
})

// ===================================================== D. INERTNESS

test('D1: creating a new conversation creates NO job', { skip }, async () => {
  const w = await setup()
  // w.aClient, not a fresh sessionFor: A is already authenticated in setup.
  const { data: threadId, error } = await w.aClient.rpc(
    'create_thread_with_message',
    { p_subject: `${TAG} inert-new`, p_recipient_ids: [w.adminId], p_message_text: `${TAG} inert-new` },
  )
  assert.equal(error, null, 'the conversation itself must still work')

  const { data: msgs } = await admin.from('thread_messages').select('id').eq('thread_id', threadId)
  assert.ok((msgs ?? []).length >= 1, 'the message was created')

  const { count } = await admin
    .from(JOBS).select('*', { count: 'exact', head: true })
    .in('message_id', (msgs ?? []).map((m: any) => m.id))
  assert.equal(count, 0, 'Phase 1 must not enqueue anything')
})

test('D2: a reply creates NO job', { skip }, async () => {
  const w = await setup()
  const { data: msg, error } = await w.adminClient
    .from('thread_messages')
    .insert({ thread_id: w.threadId, sender_id: w.adminId, message_text: `${TAG} inert-reply` })
    .select('id').single()
  assert.equal(error, null, 'replying must still work')

  const { count } = await admin
    .from(JOBS).select('*', { count: 'exact', head: true }).eq('message_id', msg!.id)
  assert.equal(count, 0, 'no trigger may exist on thread_messages yet')
})

test('D3: no trigger exists -- proven behaviourally across every insert path', { skip }, async () => {
  // Stronger than reading pg_trigger: if any notification trigger existed on
  // thread_messages, one of these would have produced a row.
  const n = await jobsForTaggedMessages()
  assert.equal(n, 1, 'only the single job tests B1-B3 inserted by hand may exist')
})

test('D4: the messaging RPCs are unchanged and still work', { skip }, async () => {
  const w = await setup()
  // create_thread_with_message still enforces exactly one recipient (H-3B era).
  const { error: twoRecipients } = await w.adminClient.rpc('create_thread_with_message', {
    p_subject: `${TAG} two`, p_recipient_ids: [w.aId, w.bId], p_message_text: `${TAG} two`,
  })
  assert.ok(twoRecipients, 'the one-recipient rule must still hold')

  // A member still cannot open a conversation with another member.
  const { error: memberToMember } = await w.aClient.rpc('create_thread_with_message', {
    p_subject: `${TAG} m2m`, p_recipient_ids: [w.bId], p_message_text: `${TAG} m2m`,
  })
  assert.ok(memberToMember, 'members may only start a conversation with the admin')
})

// ===================================================== E. nothing else was built

test('E1: no worker route exists yet', { skip: false }, () => {
  for (const p of [
    'app/api/messages/notification-worker/route.ts',
    'app/api/messages/notifications/route.ts',
    'app/api/cron/notifications/route.ts',
  ]) {
    assert.ok(!existsSync(p), `${p} must not exist in Phase 1`)
  }
})

test('E2: no cron configuration exists yet', { skip: false }, () => {
  assert.ok(!existsSync('vercel.json'), 'vercel.json must not exist in Phase 1')
})

test('E3: the migration is inert -- no trigger, GUC, or RPC change in its SQL', { skip: false }, () => {
  const sql = readFileSync('supabase/migrations/20260908_002_email_notification_jobs.sql', 'utf8')
  const exec = sql.replace(/--.*$/gm, '')
  for (const forbidden of [
    /create\s+trigger/i,
    /create\s+(or\s+replace\s+)?function/i,
    /set_config/i,
    /current_setting/i,
    /send_tier_broadcast/i,
    /create_thread_with_message/i,
    /alter\s+table\s+public\.thread_messages/i,
    /insert\s+into/i,
    /create\s+policy/i,
    /force\s+row\s+level\s+security/i,
    /email_broadcasts?\b/i,
  ]) {
    assert.ok(!forbidden.test(exec), `Phase 1 migration must not contain ${forbidden}`)
  }
  // And it must contain the things it is supposed to.
  assert.match(exec, /create table public\.email_notification_jobs/i)
  assert.match(exec, /message_id uuid primary key/i)
  assert.match(exec, /on delete cascade/i)
  assert.match(exec, /enable row level security/i)
  assert.match(exec, /revoke all privileges[\s\S]*from authenticated/i)
  assert.match(exec, /grant select, insert on table public\.email_notification_jobs to service_role/i)
  assert.match(exec, /grant update \(/i)
})

test('E4: Phase 1 inline notification behaviour is untouched', { skip: false }, () => {
  const modal = readFileSync('components/MessagesModal.tsx', 'utf8')
  assert.match(modal, /const notifyRecipient = async/, 'M-5 Phase 1 helper still present')
  assert.match(modal, /await notifyRecipient\(/)
  assert.match(modal, /fetch\('\/api\/messages\/notify'/)
  assert.ok(!/email_notification_jobs/.test(modal), 'the client must not know about the queue yet')

  const notify = readFileSync('lib/messageNotify.ts', 'utf8')
  assert.ok(!/email_notification_jobs/.test(notify), 'the notify route must not use the queue yet')
})

// ===================================================== CLEANUP

test('cleanup: every row this suite created is removed', { skip }, async () => {
  const { data: threads } = await admin
    .from('message_threads').select('id').like('subject', `${TAG}%`)
  const ids = (threads ?? []).map((t: any) => t.id)
  if (ids.length) {
    const { data: msgs } = await admin.from('thread_messages').select('id').in('thread_id', ids)
    const mids = (msgs ?? []).map((m: any) => m.id)
    if (mids.length) {
      await admin.from(JOBS).delete().in('message_id', mids)
      await admin.from('message_read_status').delete().in('message_id', mids)
      await admin.from('message_deletions').delete().in('message_id', mids)
      await admin.from('thread_messages').delete().in('id', mids)
    }
    await admin.from('thread_participants').delete().in('thread_id', ids)
    await admin.from('message_threads').delete().in('id', ids)
  }
  const { count } = await admin
    .from('message_threads').select('*', { count: 'exact', head: true }).like('subject', `${TAG}%`)
  assert.equal(count, 0, 'test data must not be left behind')

  const { count: jobs } = await admin.from(JOBS).select('*', { count: 'exact', head: true })
  assert.equal(jobs, 0, 'the queue must be empty again -- Phase 1 leaves it inert')
  world = null
})
