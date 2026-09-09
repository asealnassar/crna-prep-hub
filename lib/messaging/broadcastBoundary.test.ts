import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { makeSessionFor } from './liveSession.test-helper.ts'

/**
 * The broadcast boundary: what send_tier_broadcast does, proven against the
 * real RPC rather than a model.
 *
 * Durable-email Phase 2 will add an AFTER INSERT trigger on thread_messages
 * plus a transaction-local GUC that send_tier_broadcast sets to suppress it.
 * Get that wrong and every broadcast recipient is emailed twice -- once by the
 * batch system, once by the new worker. This suite is the guard that has to
 * exist BEFORE that RPC is edited.
 *
 * Testing it needs a real broadcast, and the RPC selects recipients by tier.
 * Every product tier is populated -- free 424, ultimate 126, premium 16 -- so
 * a hidden 'security-test' tier holds throwaway accounts only.
 *
 * TWO INDEPENDENT REASONS NO EMAIL CAN BE SENT HERE:
 *
 *   1. send_tier_broadcast contains no email logic. It inserts threads and
 *      messages and returns a count. Email is a SEPARATE client-initiated POST
 *      to /api/messages/broadcast, which this suite never makes.
 *   2. That route pins ALLOWED_TIERS = ['free','premium','ultimate'] and
 *      returns 400 for anything else -- before it constructs a database client
 *      -- so even a mistaken call with 'security-test' is inert. Test 10 pins
 *      that as a permanent safety property.
 */

const TAG = `MSGBCAST-TEST-${process.pid}-${Date.now()}`
const A_EMAIL = 'testusera@gmail.com'
const B_EMAIL = 'testuserb@gmail.com'
const CONTROL_EMAIL = 'lasttest@gmail.com'
const ADMIN_EMAIL = 'asealnassar@gmail.com'
const TEST_TIER = 'security-test'
const COHORT = [A_EMAIL, B_EMAIL].sort()

function loadEnv() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* env may come from the shell */ }
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

const sessionFor = enabled ? makeSessionFor(admin, URL!, ANON!) : (null as any)
const asUser = (token: string) =>
  createClient(URL!, ANON!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

// ===================================================================
// STATIC -- always run, no network, no auth
// ===================================================================

// global.URL, not URL: the Supabase URL constant above shadows the class.
const read = (p: string) =>
  readFileSync(new global.URL(`../../${p}`, import.meta.url).pathname, 'utf8')

test('S1: the email route still refuses any tier outside the three real ones', () => {
  const route = read('app/api/messages/broadcast/route.ts')
  assert.match(
    route,
    /const ALLOWED_TIERS = \['free', 'premium', 'ultimate'\] as const/,
    'ALLOWED_TIERS is a deliberate safety barrier and must stay exactly three',
  )
  assert.ok(
    !/security-test/.test(route),
    'the test tier must never appear in the email route -- that is the whole barrier',
  )
  assert.match(route, /if \(!ALLOWED_TIERS\.includes\(tier as Tier\)\)/)
})

test('S2: the tier check precedes any database or email work', () => {
  const route = read('app/api/messages/broadcast/route.ts')
  const check = route.indexOf('ALLOWED_TIERS.includes(tier as Tier)')
  const db = route.indexOf('const db = serviceClient()')
  const resend = route.indexOf('resend.batch.send')
  assert.ok(check > -1 && db > check, 'a rejected tier must not reach a database client')
  assert.ok(resend > db, 'nor anything near Resend')
})

test('S3: the migration widens exactly one constraint by exactly one value', () => {
  const sql = read('supabase/migrations/20260908_003_user_profiles_security_test_tier.sql')
  const exec = sql.replace(/--.*$/gm, '')
  assert.match(exec, /drop constraint user_profiles_subscription_tier_check/)
  assert.match(exec, /'security-test'::text/)
  assert.match(exec, /begin;/)
  assert.match(exec, /commit;/)
  // Nothing else on the table may move.
  for (const forbidden of [/alter column/i, /drop column/i, /add column/i, /create index/i,
                           /drop index/i, /create policy/i, /drop policy/i, /grant /i,
                           /revoke /i, /update public\.user_profiles/i, /insert into/i, /delete from/i]) {
    assert.ok(!forbidden.test(exec), `the migration must not contain ${forbidden}`)
  }
  // Exactly two ALTER statements: the drop and the add.
  assert.equal([...exec.matchAll(/alter table public\.user_profiles/g)].length, 2)
})

test('S4: the type union stays closed and gains only the test tier', () => {
  const types = read('lib/types.ts')
  assert.match(types, /subscription_tier: 'free' \| 'premium' \| 'ultimate' \| 'security-test'/)
  assert.ok(!/subscription_tier: string/.test(types), 'never widened to string')
})

test('S5: the admin tier selector still offers only the three product tiers', () => {
  const modal = read('components/MessagesModal.tsx')
  const opts = [...modal.matchAll(/<option value="([a-z-]+)">/g)].map((m) => m[1])
  assert.deepEqual(opts, ['free', 'premium', 'ultimate'], 'the test tier must not be selectable')
})

// ===================================================================
// LIVE -- gated on credentials AND on the cohort being correctly assigned
// ===================================================================

type Cohort = { ready: boolean; reason: string; aId: string; bId: string; controlId: string; adminId: string }
let cohortMemo: Cohort | null = null

/**
 * The safety gate. A broadcast reaches whoever is in the tier, so this refuses
 * to proceed unless the tier holds EXACTLY the two approved accounts.
 *
 * An empty tier means the cohort has not been assigned yet -- that is a skip.
 * A tier holding anything else is a hard failure: something unexpected is in
 * there and it must be looked at by a person, never cleaned up automatically.
 */
async function cohort(): Promise<Cohort> {
  if (cohortMemo) return cohortMemo
  const { data: rows } = await admin
    .from('user_profiles').select('id, email, subscription_tier')
    .in('email', [A_EMAIL, B_EMAIL, CONTROL_EMAIL, ADMIN_EMAIL])
  const by = new Map((rows ?? []).map((r: any) => [r.email, r]))

  const { data: inTier } = await admin
    .from('user_profiles').select('email').eq('subscription_tier', TEST_TIER)
  const members = (inTier ?? []).map((r: any) => r.email).sort()

  let ready = false
  let reason = ''
  if (members.length === 0) {
    reason = `no account is in '${TEST_TIER}' yet -- assign the cohort first`
  } else if (JSON.stringify(members) !== JSON.stringify(COHORT)) {
    // Deliberately NOT a skip: an unexpected occupant must stop the run.
    throw new Error(
      `UNSAFE COHORT: '${TEST_TIER}' holds ${members.length} account(s) [${members.join(', ')}], ` +
        `expected exactly [${COHORT.join(', ')}]. Refusing to broadcast. Investigate manually.`,
    )
  } else if (by.get(CONTROL_EMAIL)?.subscription_tier !== 'free') {
    throw new Error(`UNSAFE COHORT: the control account must be 'free'`)
  } else if (by.get(ADMIN_EMAIL)?.subscription_tier === TEST_TIER) {
    throw new Error('UNSAFE COHORT: the admin must never be in the test tier')
  } else {
    ready = true
  }

  cohortMemo = {
    ready,
    reason,
    aId: by.get(A_EMAIL)?.id,
    bId: by.get(B_EMAIL)?.id,
    controlId: by.get(CONTROL_EMAIL)?.id,
    adminId: by.get(ADMIN_EMAIL)?.id,
  }
  return cohortMemo
}

const counts = async () => {
  const one = async (t: string) => {
    const { count } = await admin.from(t).select('*', { count: 'exact', head: true })
    return count ?? 0
  }
  return {
    threads: await one('message_threads'),
    messages: await one('thread_messages'),
    broadcasts: await one('email_broadcasts'),
    batches: await one('email_broadcast_batches'),
    jobs: await one('email_notification_jobs'),
  }
}

// ------------------------------------------------- authorization (no cohort needed)

test('1: the admin may call send_tier_broadcast', { skip }, async () => {
  const c = await cohort()
  // Authorization only -- an empty tier broadcasts to nobody, which is the
  // safest possible probe and needs no cohort.
  const { data, error } = await asUser(await sessionFor(ADMIN_EMAIL)).rpc('send_tier_broadcast', {
    p_subject: `${TAG} authz`, p_message_text: `${TAG} authz`, p_tier: '__nobody__',
  })
  assert.equal(error, null, 'the admin must be authorized')
  assert.equal(data, 0, 'and an unmatched tier must reach nobody')
  assert.ok(c.adminId, 'admin resolved')
})

test('2: an ordinary member is denied', { skip }, async () => {
  const { error } = await asUser(await sessionFor(CONTROL_EMAIL)).rpc('send_tier_broadcast', {
    p_subject: `${TAG} member`, p_message_text: `${TAG} member`, p_tier: TEST_TIER,
  })
  assert.ok(error, 'only the admin may broadcast')
})

test('3: anon is denied', { skip }, async () => {
  const { error } = await anon.rpc('send_tier_broadcast', {
    p_subject: `${TAG} anon`, p_message_text: `${TAG} anon`, p_tier: TEST_TIER,
  })
  assert.ok(error, 'a broadcast must require a session')
})

// ------------------------------------------------- the cohort gate

test('4: the test tier holds exactly the two approved accounts', { skip }, async () => {
  const c = await cohort()
  if (!c.ready) {
    console.log(`  (cohort not assigned: ${c.reason})`)
    return
  }
  const { data } = await admin
    .from('user_profiles').select('email').eq('subscription_tier', TEST_TIER)
  assert.deepEqual((data ?? []).map((r: any) => r.email).sort(), COHORT)
})

// ------------------------------------------------- the real broadcast

test('5-9: an RPC-only broadcast reaches the cohort and nothing else', { skip }, async () => {
  const c = await cohort()
  if (!c.ready) {
    console.log(`  (skipped: ${c.reason})`)
    return
  }

  const before = await counts()
  const subject = `${TAG} broadcast`

  const { data: recipients, error } = await asUser(await sessionFor(ADMIN_EMAIL)).rpc(
    'send_tier_broadcast',
    { p_subject: subject, p_message_text: `${TAG} body`, p_tier: TEST_TIER },
  )
  assert.equal(error, null, 'the broadcast RPC must succeed')

  // 5. exact tier matching -- two recipients, the cohort, nobody else
  assert.equal(recipients, 2, 'exactly the two cohort members')

  const { data: threads } = await admin
    .from('message_threads').select('id, created_by').eq('subject', subject)
  assert.equal((threads ?? []).length, 2, 'one thread per recipient')

  const ids = (threads ?? []).map((t: any) => t.id)
  const { data: parts } = await admin
    .from('thread_participants').select('thread_id, user_id').in('thread_id', ids)

  // 6-7. one PRIVATE two-party thread each, never a shared group thread
  for (const id of ids) {
    const members = (parts ?? []).filter((p: any) => p.thread_id === id).map((p: any) => p.user_id)
    assert.equal(members.length, 2, 'exactly admin + one member')
    assert.ok(members.includes(c.adminId), 'the admin is a participant')
  }
  const recipientsSeen = (parts ?? []).map((p: any) => p.user_id).filter((u: string) => u !== c.adminId)
  assert.deepEqual([...recipientsSeen].sort(), [c.aId, c.bId].sort(), 'exactly A and B')
  assert.ok(!recipientsSeen.includes(c.controlId), 'the free control account received nothing')

  // 8-9. no email machinery was touched
  const after = await counts()
  assert.equal(after.broadcasts, before.broadcasts, 'email_broadcasts unchanged')
  assert.equal(after.batches, before.batches, 'email_broadcast_batches unchanged')
  assert.equal(after.jobs, before.jobs, 'no notification jobs -- the trigger does not exist yet')
  assert.equal(after.threads, before.threads + 2)
  assert.equal(after.messages, before.messages + 2)
})

// ------------------------------------------------- the email route barrier

test('10-11: the email route rejects the test tier with 400 and sends nothing', { skip }, async () => {
  const c = await cohort()
  const before = await counts()

  const token = await sessionFor(ADMIN_EMAIL)
  const ref = new global.URL(URL!).hostname.split('.')[0]
  const session = { access_token: token }
  const res = await fetch('https://www.crnaprephub.com/api/messages/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`,
    },
    body: JSON.stringify({
      tier: TEST_TIER,
      requestKey: '00000000-0000-4000-8000-000000000000',
      subject: `${TAG} must-not-send`,
      message: `${TAG} must-not-send`,
    }),
  })
  assert.equal(res.status, 400, 'the test tier must be refused by the email route')
  const body = await res.json().catch(() => ({}))
  assert.equal(body.error, 'Invalid tier')

  const after = await counts()
  assert.equal(after.broadcasts, before.broadcasts, 'no broadcast row was created')
  assert.equal(after.batches, before.batches, 'no batch was planned, so no Resend call')
  assert.ok(c.adminId)
})

// ------------------------------------------------- cleanup

test('12-13: only this run\'s fixtures are removed, and no profile was touched', { skip }, async () => {
  const { data: threads } = await admin
    .from('message_threads').select('id').like('subject', `${TAG}%`)
  const ids = (threads ?? []).map((t: any) => t.id)
  if (ids.length) {
    const { data: msgs } = await admin.from('thread_messages').select('id').in('thread_id', ids)
    const mids = (msgs ?? []).map((m: any) => m.id)
    if (mids.length) {
      await admin.from('email_notification_jobs').delete().in('message_id', mids)
      await admin.from('message_read_status').delete().in('message_id', mids)
      await admin.from('message_deletions').delete().in('message_id', mids)
      await admin.from('thread_messages').delete().in('id', mids)
    }
    await admin.from('thread_participants').delete().in('thread_id', ids)
    await admin.from('message_threads').delete().in('id', ids)
  }

  const { count: left } = await admin
    .from('message_threads').select('*', { count: 'exact', head: true }).like('subject', `${TAG}%`)
  assert.equal(left, 0, 'this run left nothing behind')

  // Pre-existing throwaway conversations must survive -- they carry other tags.
  const { count: others } = await admin
    .from('message_threads').select('*', { count: 'exact', head: true }).like('subject', 'MSGSEC-TEST%')
  assert.ok(others !== null, 'other suites\' fixtures are not our business to delete')

  // 13. no profile was modified by this suite.
  const { data: tiers } = await admin
    .from('user_profiles').select('email, subscription_tier')
    .in('email', [A_EMAIL, B_EMAIL, CONTROL_EMAIL, ADMIN_EMAIL])
  const by = new Map((tiers ?? []).map((r: any) => [r.email, r.subscription_tier]))
  assert.equal(by.get(CONTROL_EMAIL), 'free', 'the control account is untouched')
  assert.notEqual(by.get(ADMIN_EMAIL), TEST_TIER, 'the admin is untouched')

  const { count: realTiers } = await admin
    .from('user_profiles').select('*', { count: 'exact', head: true })
    .in('subscription_tier', ['free', 'premium', 'ultimate'])
  assert.ok((realTiers ?? 0) > 500, 'the real member population is intact')
})
