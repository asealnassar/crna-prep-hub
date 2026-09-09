import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { claimJobs } from './notificationClaim.ts'
import { LEASE_MS } from './notificationWorker.ts'
import { makeSessionFor } from './liveSession.test-helper.ts'

/**
 * The claim/lease mechanism, against the REAL database.
 *
 * The pure worker suite covers sending, retry and idempotency with injected
 * fakes. What it cannot cover is whether PostgREST's conditional UPDATE
 * actually serialises two workers racing for one row -- that is a property of
 * the database, not of the decision logic, and it is the one thing standing
 * between this queue and duplicate emails once cron is switched on.
 *
 * This calls the production claimJobs, not a copy of it. A reimplementation
 * would prove that A claim works, never that THE claim works.
 *
 * ---------------------------------------------------------------------------
 * HOW THE REAL PRODUCTION JOB IS KEPT OUT
 * ---------------------------------------------------------------------------
 * The queue holds at least one genuine unsent obligation. It is excluded by
 * the production predicate itself, not by a convention this file follows:
 * claimJobs filters `next_attempt_at <= now`, and every call here passes a
 * `now` in 2021. Real jobs carry a 2026 next_attempt_at, so no query in this
 * file can return one. Test fixtures are explicitly dated 2020 to sit inside
 * that window.
 *
 * Nothing here sends email or invokes the worker route.
 */

const TAG = `MSGCLAIM-TEST-${process.pid}-${Date.now()}`
const A_EMAIL = 'testusera@gmail.com'
const ADMIN_EMAIL = 'asealnassar@gmail.com'
const JOBS = 'email_notification_jobs'

/** Every claim in this file runs "as of" 2021. Real jobs are dated 2026. */
const AS_OF = Date.parse('2021-01-01T00:00:00.000Z')
/** Fixtures sit before it, so only they are ever eligible. */
const FIXTURE_DUE = new Date(Date.parse('2020-01-01T00:00:00.000Z')).toISOString()

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

const db: SupabaseClient = enabled
  ? createClient(SUPA!, SERVICE!, { auth: { autoRefreshToken: false, persistSession: false } })
  : (null as any)
const sessionFor = enabled ? makeSessionFor(db, SUPA!, ANON!) : (null as any)
const asUser = (token: string) =>
  createClient(SUPA!, ANON!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

/** The real job(s), captured before anything runs and compared after. */
type Snapshot = Record<string, Record<string, unknown>>
let baseline: Snapshot | null = null
const FIELDS = 'message_id, status, attempts, sent_at, lease_owner, lease_expires_at, last_error, next_attempt_at'

async function snapshotReal(): Promise<Snapshot> {
  const { data } = await db.from(JOBS).select(FIELDS)
  const out: Snapshot = {}
  for (const r of (data ?? []) as any[]) {
    if (String(r.message_id).startsWith('fixture')) continue
    out[r.message_id] = r
  }
  return out
}

/** A tagged thread whose message the Phase 2 trigger enqueues for us. */
async function makeFixture(label: string): Promise<string> {
  const adminTok = await sessionFor(ADMIN_EMAIL)
  const { data: aRow } = await db.from('user_profiles').select('id').eq('email', A_EMAIL).single()
  const { data: threadId, error } = await asUser(adminTok).rpc('create_thread_with_message', {
    p_subject: `${TAG} ${label}`,
    p_recipient_ids: [aRow!.id],
    p_message_text: `${TAG} ${label}`,
  })
  if (error) throw new Error(`fixture ${label}: ${error.message}`)

  const { data: msg } = await db
    .from('thread_messages').select('id').eq('thread_id', threadId as string).single()

  // Dated into the eligibility window this suite uses. next_attempt_at is one
  // of the seven columns service_role may update.
  const { error: dateErr } = await db
    .from(JOBS).update({ next_attempt_at: FIXTURE_DUE }).eq('message_id', msg!.id)
  if (dateErr) throw new Error(`fixture ${label} date: ${dateErr.message}`)
  return msg!.id
}

const jobRow = async (messageId: string) => {
  const { data } = await db.from(JOBS).select(FIELDS).eq('message_id', messageId).single()
  return data as any
}

// ============================================================ 0. the guard

test('0: the real production job is invisible to every claim here', { skip }, async () => {
  baseline = await snapshotReal()
  const realIds = Object.keys(baseline)
  assert.ok(realIds.length >= 1, 'there is a genuine job to protect')

  for (const id of realIds) {
    const due = Date.parse(String(baseline[id].next_attempt_at))
    assert.ok(
      due > AS_OF,
      `real job ${id.slice(0, 8)} must fall outside this suite's window`,
    )
  }

  // And prove it: a claim as-of 2021 with no fixtures returns nothing at all.
  const claimed = await claimJobs(db, 'guard-probe', AS_OF)
  assert.deepEqual(claimed, [], 'the production predicate excludes every real job')
})

// ============================================================ 1. the race

test('1: two concurrent claimers race for ONE job -- exactly one wins', { skip }, async () => {
  const messageId = await makeFixture('race')

  const [a, b] = await Promise.all([
    claimJobs(db, 'worker-A', AS_OF),
    claimJobs(db, 'worker-B', AS_OF),
  ])

  const mine = (rows: any[]) => rows.filter((r) => r.message_id === messageId)
  const winners = mine(a).length + mine(b).length
  assert.equal(winners, 1, '*** exactly one claimant may acquire the lease ***')
  assert.ok(
    (mine(a).length === 1) !== (mine(b).length === 1),
    'and the other must get zero rows back',
  )

  const row = await jobRow(messageId)
  assert.equal(row.status, 'sending', 'the winner marked it in flight')
  assert.ok(['worker-A', 'worker-B'].includes(row.lease_owner), 'exactly one owner recorded')
  assert.equal(row.attempts, 0, 'claiming performs no attempt')
  assert.equal(row.sent_at, null, 'and sends nothing')
})

// ============================================================ 2. fresh lease

test('2: a currently valid lease cannot be stolen', { skip }, async () => {
  const messageId = await makeFixture('fresh')

  const first = await claimJobs(db, 'worker-holder', AS_OF)
  assert.equal(first.filter((r) => r.message_id === messageId).length, 1, 'held')
  const held = await jobRow(messageId)
  assert.equal(held.lease_owner, 'worker-holder')

  // A peer arriving while the lease is live -- 30s later, well inside LEASE_MS.
  const second = await claimJobs(db, 'worker-thief', AS_OF + 30_000)
  assert.equal(
    second.filter((r) => r.message_id === messageId).length, 0,
    'a live lease must repel a second claimant',
  )
  const after = await jobRow(messageId)
  assert.equal(after.lease_owner, 'worker-holder', 'the owner is unchanged')
  assert.equal(after.lease_expires_at, held.lease_expires_at, 'and so is the expiry')
})

// ============================================================ 3. stale lease

test('3: an expired lease is reclaimable, but only after it expires', { skip }, async () => {
  const messageId = await makeFixture('stale')

  await claimJobs(db, 'worker-dead', AS_OF)
  const held = await jobRow(messageId)
  assert.equal(held.lease_owner, 'worker-dead')

  // One millisecond before expiry: still theirs.
  const early = await claimJobs(db, 'worker-next', AS_OF + LEASE_MS - 1)
  assert.equal(early.filter((r) => r.message_id === messageId).length, 0, 'not yet')
  assert.equal((await jobRow(messageId)).lease_owner, 'worker-dead')

  // Past expiry: a dead worker must not wedge the job forever.
  const late = await claimJobs(db, 'worker-next', AS_OF + LEASE_MS + 1000)
  assert.equal(late.filter((r) => r.message_id === messageId).length, 1, 'reclaimed')
  const after = await jobRow(messageId)
  assert.equal(after.lease_owner, 'worker-next', 'ownership moved only after expiry')
  assert.equal(after.attempts, 0, 'reclaiming still performs no attempt')
})

// ============================================================ 4. eligibility

test('4: only due, unfinished jobs are claimable', { skip }, async () => {
  const messageId = await makeFixture('eligibility')

  // (a) not yet due.
  await db.from(JOBS)
    .update({ status: 'pending', lease_owner: null, lease_expires_at: null,
              next_attempt_at: new Date(AS_OF + 60_000).toISOString() })
    .eq('message_id', messageId)
  let got = await claimJobs(db, 'worker-e', AS_OF)
  assert.equal(got.filter((r) => r.message_id === messageId).length, 0, 'a future job waits')

  // (b) terminal states are never reclaimed.
  for (const status of ['sent', 'failed', 'uncertain']) {
    await db.from(JOBS)
      .update({ status, lease_owner: null, lease_expires_at: null, next_attempt_at: FIXTURE_DUE })
      .eq('message_id', messageId)
    got = await claimJobs(db, 'worker-e', AS_OF)
    assert.equal(
      got.filter((r) => r.message_id === messageId).length, 0,
      `${status} must not be claimable`,
    )
  }

  // (c) pending and due IS claimable -- so the negatives above mean something.
  await db.from(JOBS)
    .update({ status: 'pending', lease_owner: null, lease_expires_at: null, next_attempt_at: FIXTURE_DUE })
    .eq('message_id', messageId)
  got = await claimJobs(db, 'worker-e', AS_OF)
  assert.equal(got.filter((r) => r.message_id === messageId).length, 1, 'due work is taken')

  // (d) a stranded 'sending' row is recoverable once its lease lapses.
  await db.from(JOBS)
    .update({ status: 'sending', lease_owner: 'gone', lease_expires_at: new Date(AS_OF - 1).toISOString() })
    .eq('message_id', messageId)
  got = await claimJobs(db, 'worker-e', AS_OF)
  assert.equal(got.filter((r) => r.message_id === messageId).length, 1, 'sending + expired is claimable')
})

// ============================================================ 5. cleanup

test('5: fixtures are removed and the real job is byte-for-byte unchanged', { skip }, async () => {
  const { data: threads } = await db
    .from('message_threads').select('id').like('subject', `${TAG}%`)
  const ids = (threads ?? []).map((t: any) => t.id)
  if (ids.length) {
    const { data: msgs } = await db.from('thread_messages').select('id').in('thread_id', ids)
    const mids = (msgs ?? []).map((m: any) => m.id)
    if (mids.length) {
      // service_role holds no DELETE on the queue: the jobs go by cascade when
      // their messages do, which is the approved mechanism.
      await db.from('message_read_status').delete().in('message_id', mids)
      await db.from('message_deletions').delete().in('message_id', mids)
      await db.from('thread_messages').delete().in('id', mids)

      const { count: leftJobs } = await db
        .from(JOBS).select('*', { count: 'exact', head: true }).in('message_id', mids)
      assert.equal(leftJobs, 0, 'every tagged job went with its message')
    }
    await db.from('thread_participants').delete().in('thread_id', ids)
    await db.from('message_threads').delete().in('id', ids)
  }

  const { count: leftThreads } = await db
    .from('message_threads').select('*', { count: 'exact', head: true }).like('subject', `${TAG}%`)
  assert.equal(leftThreads, 0, 'no tagged thread survives')

  // The whole point: every field of every real job, compared to the snapshot
  // taken before any claim ran.
  assert.ok(baseline, 'a baseline was captured')
  const after = await snapshotReal()
  assert.deepEqual(
    Object.keys(after).sort(), Object.keys(baseline!).sort(),
    'no real job appeared or vanished',
  )
  for (const id of Object.keys(baseline!)) {
    for (const field of ['status', 'attempts', 'sent_at', 'lease_owner', 'lease_expires_at', 'last_error', 'next_attempt_at']) {
      assert.deepEqual(
        after[id][field], baseline![id][field],
        `real job ${id.slice(0, 8)} field ${field} must be untouched`,
      )
    }
  }
})

// ============================================================ 6. shape

test('6: the suite exercises production code, not a copy', { skip: false }, () => {
  const route = readFileSync(
    new URL('../../app/api/messages/notification-worker/route.ts', import.meta.url).pathname, 'utf8')
  assert.match(route, /import \{ claimJobs \} from '@\/lib\/messaging\/notificationClaim'/,
    'the route uses the same function this suite calls')
  assert.ok(!/async function claimJobs/.test(route), 'and holds no second copy of it')

  const self = readFileSync(new URL('./notificationClaim.test.ts', import.meta.url).pathname, 'utf8')
  assert.ok(!self.includes('notification-worker\''), 'the worker route is never invoked')
  assert.ok(!self.includes('CRON' + '_SECRET'), 'and no secret is set')
  assert.ok(!self.includes('new ' + 'Resend'), 'no provider is contacted')
})
