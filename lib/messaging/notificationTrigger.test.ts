import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { makeSessionFor } from './liveSession.test-helper.ts'

/**
 * M-5 Phase 2: the trigger fills email_notification_jobs, and a tier broadcast
 * fills nothing.
 *
 * The exclusion is the point of this suite. send_tier_broadcast does not
 * insert anything itself -- it calls create_thread_with_message in a loop, so
 * a broadcast message is byte for byte a normal admin-to-member message and
 * nothing in thread_messages says which it is. Without the transaction-local
 * GUC, every broadcast recipient would get a durable job, and once a worker
 * exists that is a second email to an entire tier on top of the batch
 * system's.
 *
 * Nothing here sends email: no worker exists yet, and no test calls
 * /api/messages/broadcast, /api/messages/notify, or Resend. The broadcast is
 * RPC-only, against the isolated security-test cohort.
 */

const TAG = `MSGTRIG-TEST-${process.pid}-${Date.now()}`
const A_EMAIL = 'testusera@gmail.com'
const B_EMAIL = 'testuserb@gmail.com'
const CONTROL_EMAIL = 'lasttest@gmail.com'
const ADMIN_EMAIL = 'asealnassar@gmail.com'
const TEST_TIER = 'security-test'
const JOBS = 'email_notification_jobs'

function loadEnv() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* env may come from the shell */ }
}
loadEnv()

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const enabled = process.env.MESSAGING_SECURITY_TESTS === '1' && !!SUPA && !!ANON && !!SERVICE
const skip = enabled ? false : 'set MESSAGING_SECURITY_TESTS=1 with Supabase credentials'

const admin: SupabaseClient = enabled
  ? createClient(SUPA!, SERVICE!, { auth: { autoRefreshToken: false, persistSession: false } })
  : (null as any)
const sessionFor = enabled ? makeSessionFor(admin, SUPA!, ANON!) : (null as any)
const asUser = (token: string) =>
  createClient(SUPA!, ANON!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

type World = { aId: string; bId: string; controlId: string; adminId: string; adminTok: string }
let world: World | null = null

/** Also the cohort safety gate: a broadcast reaches whoever is in the tier. */
async function setup(): Promise<World> {
  if (world) return world
  const { data: rows } = await admin
    .from('user_profiles').select('id, email, subscription_tier')
    .in('email', [A_EMAIL, B_EMAIL, CONTROL_EMAIL, ADMIN_EMAIL])
  const by = new Map((rows ?? []).map((r: any) => [r.email, r]))

  const { data: inTier } = await admin
    .from('user_profiles').select('email').eq('subscription_tier', TEST_TIER)
  const members = (inTier ?? []).map((r: any) => r.email).sort()
  const expected = [A_EMAIL, B_EMAIL].sort()
  if (JSON.stringify(members) !== JSON.stringify(expected)) {
    throw new Error(
      `UNSAFE COHORT: '${TEST_TIER}' holds [${members.join(', ')}], expected [${expected.join(', ')}]. ` +
        'Refusing to broadcast.',
    )
  }
  if (by.get(CONTROL_EMAIL)?.subscription_tier !== 'free') throw new Error('control must be free')
  if (by.get(ADMIN_EMAIL)?.subscription_tier === TEST_TIER) throw new Error('admin must not be in the tier')

  world = {
    aId: by.get(A_EMAIL)!.id, bId: by.get(B_EMAIL)!.id,
    controlId: by.get(CONTROL_EMAIL)!.id, adminId: by.get(ADMIN_EMAIL)!.id,
    adminTok: await sessionFor(ADMIN_EMAIL),
  }
  return world
}

const counts = async () => {
  const one = async (t: string) => {
    const { count } = await admin.from(t).select('*', { count: 'exact', head: true })
    return count ?? 0
  }
  return {
    jobs: await one(JOBS),
    broadcasts: await one('email_broadcasts'),
    batches: await one('email_broadcast_batches'),
  }
}

/** Jobs belonging to a specific set of messages. */
async function jobsFor(messageIds: string[]): Promise<number> {
  if (!messageIds.length) return 0
  const { count } = await admin
    .from(JOBS).select('*', { count: 'exact', head: true }).in('message_id', messageIds)
  return count ?? 0
}

const msgsIn = async (threadIds: string[]) => {
  if (!threadIds.length) return [] as string[]
  const { data } = await admin.from('thread_messages').select('id').in('thread_id', threadIds)
  return (data ?? []).map((m: any) => m.id)
}

// ===================================================== 0. the trigger exists

test('0: the trigger exists -- a normal message enqueues', { skip }, async () => {
  const w = await setup()
  const { data: threadId, error } = await asUser(w.adminTok).rpc('create_thread_with_message', {
    p_subject: `${TAG} exists`, p_recipient_ids: [w.aId], p_message_text: `${TAG} exists`,
  })
  assert.equal(error, null)
  const ids = await msgsIn([threadId as string])
  assert.equal(
    await jobsFor(ids), 1,
    'no job was created -- apply 20260909_000 before running this suite',
  )
})

// ===================================================== 1-2. normal paths enqueue

test('1: a new Admin -> member conversation creates exactly one job', { skip }, async () => {
  const w = await setup()
  const { data: threadId } = await asUser(w.adminTok).rpc('create_thread_with_message', {
    p_subject: `${TAG} new-convo`, p_recipient_ids: [w.aId], p_message_text: `${TAG} new-convo`,
  })
  const ids = await msgsIn([threadId as string])
  assert.equal(ids.length, 1, 'exactly one message')
  assert.equal(await jobsFor(ids), 1, 'exactly one job')

  const { data: job } = await admin
    .from(JOBS).select('recipient_user_id, status, attempts').eq('message_id', ids[0]).single()
  assert.equal(job!.recipient_user_id, w.aId, 'addressed to the counterpart, not the sender')
  assert.equal(job!.status, 'pending')
  assert.equal(job!.attempts, 0)
})

test('2: a reply creates exactly one further job', { skip }, async () => {
  const w = await setup()
  const { data: threadId } = await asUser(w.adminTok).rpc('create_thread_with_message', {
    p_subject: `${TAG} reply`, p_recipient_ids: [w.aId], p_message_text: `${TAG} opening`,
  })
  const before = await msgsIn([threadId as string])
  assert.equal(await jobsFor(before), 1)

  // The member replies, through the same RLS path the browser uses.
  const aClient = asUser(await sessionFor(A_EMAIL))
  const { data: reply, error } = await aClient
    .from('thread_messages')
    .insert({ thread_id: threadId, sender_id: w.aId, message_text: `${TAG} reply body` })
    .select('id').single()
  assert.equal(error, null, 'the reply itself must still work')

  assert.equal(await jobsFor([reply!.id]), 1, 'the reply enqueues one job')
  const { data: job } = await admin
    .from(JOBS).select('recipient_user_id').eq('message_id', reply!.id).single()
  assert.equal(job!.recipient_user_id, w.adminId, 'addressed to the admin this time')
})

// ===================================================== 3. THE BOUNDARY

test('3: a real tier broadcast creates ZERO notification jobs', { skip }, async () => {
  const w = await setup()
  const before = await counts()
  const subject = `${TAG} broadcast`

  const { data: recipients, error } = await asUser(w.adminTok).rpc('send_tier_broadcast', {
    p_subject: subject, p_message_text: `${TAG} broadcast body`, p_tier: TEST_TIER,
  })
  assert.equal(error, null)
  assert.equal(recipients, 2, 'exactly the two cohort members')

  const { data: threads } = await admin.from('message_threads').select('id').eq('subject', subject)
  const tids = (threads ?? []).map((t: any) => t.id)
  assert.equal(tids.length, 2, 'one private thread per recipient')

  const ids = await msgsIn(tids)
  assert.equal(ids.length, 2, 'two messages')
  assert.equal(await jobsFor(ids), 0, '*** THE BOUNDARY: a broadcast must enqueue nothing ***')

  const after = await counts()
  assert.equal(after.jobs, before.jobs, 'the queue did not grow at all')
  assert.equal(after.broadcasts, before.broadcasts, 'email_broadcasts unchanged')
  assert.equal(after.batches, before.batches, 'email_broadcast_batches unchanged')
})

// ===================================================== 4. the GUC must not leak

test('4: a normal message right after a broadcast still enqueues', { skip }, async () => {
  const w = await setup()
  // The broadcast in test 3 has already run on this connection pool.
  const { data: threadId } = await asUser(w.adminTok).rpc('create_thread_with_message', {
    p_subject: `${TAG} after-broadcast`,
    p_recipient_ids: [w.aId],
    p_message_text: `${TAG} after-broadcast`,
  })
  const ids = await msgsIn([threadId as string])
  assert.equal(
    await jobsFor(ids), 1,
    'the GUC is transaction-local -- it must not suppress the next request',
  )

  // And once more, to prove it is not an alternating artefact.
  const { data: second } = await asUser(w.adminTok).rpc('create_thread_with_message', {
    p_subject: `${TAG} after-broadcast-2`,
    p_recipient_ids: [w.bId],
    p_message_text: `${TAG} after-broadcast-2`,
  })
  assert.equal(await jobsFor(await msgsIn([second as string])), 1)
})

// ===================================================== 5-6. no recipient, no job

test('5: a message with a NULL sender enqueues nothing', { skip }, async () => {
  const w = await setup()
  const { data: t } = await admin
    .from('message_threads').insert({ subject: `${TAG} null-sender`, created_by: w.adminId })
    .select('id').single()
  await admin.from('thread_participants')
    .insert([{ thread_id: t!.id, user_id: w.adminId }, { thread_id: t!.id, user_id: w.aId }])

  const { data: m, error } = await admin
    .from('thread_messages')
    .insert({ thread_id: t!.id, sender_id: null, message_text: `${TAG} system` })
    .select('id').single()
  assert.equal(error, null, 'a null-sender message is still insertable')
  assert.equal(await jobsFor([m!.id]), 0, 'nobody to attribute the email to')
})

test('6: a thread without exactly one counterpart enqueues nothing', { skip }, async () => {
  const w = await setup()

  // (a) single-participant, the shape of the eleven known malformed threads.
  const { data: solo } = await admin
    .from('message_threads').insert({ subject: `${TAG} solo`, created_by: w.adminId })
    .select('id').single()
  await admin.from('thread_participants').insert({ thread_id: solo!.id, user_id: w.adminId })
  const { data: m1 } = await admin
    .from('thread_messages')
    .insert({ thread_id: solo!.id, sender_id: w.adminId, message_text: `${TAG} solo` })
    .select('id').single()
  assert.equal(await jobsFor([m1!.id]), 0, 'no counterpart, no job')

  // (b) three participants -- ambiguous, so the trigger declines to guess.
  const { data: trio } = await admin
    .from('message_threads').insert({ subject: `${TAG} trio`, created_by: w.adminId })
    .select('id').single()
  await admin.from('thread_participants').insert([
    { thread_id: trio!.id, user_id: w.adminId },
    { thread_id: trio!.id, user_id: w.aId },
    { thread_id: trio!.id, user_id: w.bId },
  ])
  const { data: m2 } = await admin
    .from('thread_messages')
    .insert({ thread_id: trio!.id, sender_id: w.adminId, message_text: `${TAG} trio` })
    .select('id').single()
  assert.equal(await jobsFor([m2!.id]), 0, 'two counterparts is not exactly one')
})

// ===================================================== 7. cleanup

test('7: every tagged fixture and job is removed', { skip }, async () => {
  const { data: threads } = await admin
    .from('message_threads').select('id').like('subject', `${TAG}%`)
  const ids = (threads ?? []).map((t: any) => t.id)
  if (ids.length) {
    const mids = await msgsIn(ids)
    if (mids.length) {
      await admin.from(JOBS).delete().in('message_id', mids)
      await admin.from('message_read_status').delete().in('message_id', mids)
      await admin.from('message_deletions').delete().in('message_id', mids)
      await admin.from('thread_messages').delete().in('id', mids)
    }
    await admin.from('thread_participants').delete().in('thread_id', ids)
    await admin.from('message_threads').delete().in('id', ids)
  }

  const { count: left } = await admin
    .from('message_threads').select('*', { count: 'exact', head: true }).like('subject', `${TAG}%`)
  assert.equal(left, 0, 'no tagged thread survives')

  const { count: jobs } = await admin.from(JOBS).select('*', { count: 'exact', head: true })
  assert.equal(jobs, 0, 'the queue is empty again -- no worker exists to drain it')

  // The cohort and the control are unchanged by this suite.
  const { data: tiers } = await admin
    .from('user_profiles').select('email, subscription_tier')
    .in('email', [A_EMAIL, B_EMAIL, CONTROL_EMAIL, ADMIN_EMAIL])
  const by = new Map((tiers ?? []).map((r: any) => [r.email, r.subscription_tier]))
  assert.equal(by.get(A_EMAIL), TEST_TIER)
  assert.equal(by.get(B_EMAIL), TEST_TIER)
  assert.equal(by.get(CONTROL_EMAIL), 'free', 'the control account is untouched')
  assert.notEqual(by.get(ADMIN_EMAIL), TEST_TIER)

  const c = await counts()
  assert.equal(c.broadcasts, 3, 'email_broadcasts at baseline')
  assert.equal(c.batches, 7, 'email_broadcast_batches at baseline')
  world = null
})
