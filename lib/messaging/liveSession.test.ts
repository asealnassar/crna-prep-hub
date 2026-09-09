import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  getLiveSession,
  invalidateLiveSession,
  authCallCount,
  resetAuthCallCount,
  type SessionOptions,
} from './liveSession.test-helper.ts'

/**
 * The live-session cache itself. No network: the authenticator is injected, so
 * every assertion here is about the caching, locking and expiry logic rather
 * than about Supabase.
 *
 * Why this exists: three live suites each carried their own magic-link
 * exchange, and node --test runs files in parallel PROCESSES, so a full run
 * fired nine OTP verifications at three accounts in a second or two. Supabase
 * throttled them and the failures moved between suites on each rerun.
 */

const REPO = resolve(new URL('../../', import.meta.url).pathname)
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')
const HELPER = 'lib/messaging/liveSession.test-helper.ts'
const LIVE_SUITES = [
  'lib/messaging/security.test.ts',
  'lib/messaging/restoreOnReply.test.ts',
  'lib/messaging/notificationJobs.test.ts',
]

/** A scratch cache dir per test, so tests cannot see each other's entries. */
function scratch(): SessionOptions {
  return { namespace: 'https://test.example', cacheDir: mkdtempSync(join(tmpdir(), 'lsc-')) }
}

/** A counting authenticator. Returns a distinct fake token per account. */
function counter(expiresInMs = 60 * 60 * 1000) {
  const calls: string[] = []
  const make = (email: string) => async () => {
    calls.push(email)
    return { accessToken: `token-for-${email}`, expiresAt: Date.now() + expiresInMs }
  }
  return { calls, make }
}

// ------------------------------------------------- 1-5: the duplication is gone

test('1: exactly one shared session helper exists', () => {
  assert.ok(existsSync(join(REPO, HELPER)), 'the shared helper must exist')
  const owners = LIVE_SUITES.filter((f) => /async function sessionFor/.test(read(f)))
  assert.deepEqual(owners, [], 'no live suite may define its own sessionFor')

  const exchanges = [...LIVE_SUITES, HELPER].filter((f) => /generateLink|verifyOtp/.test(read(f)))
  assert.deepEqual(exchanges, [HELPER], 'the magic-link exchange must live in exactly one file')
})

for (const [i, suite] of LIVE_SUITES.entries()) {
  test(`${i + 2}: ${suite.split('/').pop()} uses the shared helper`, () => {
    const src = read(suite)
    assert.match(src, /import \{ makeSessionFor \} from '\.\/liveSession\.test-helper\.ts'/)
    assert.match(src, /const sessionFor = makeSessionFor\(admin, URL!, ANON!\)/)
    assert.ok(!/async function sessionFor/.test(src), 'the local copy must be gone')
  })
}

test('5: the three redundant authentication call sites are gone', () => {
  const sec = read('lib/messaging/security.test.ts')
  // The realtime tests take a token; they must use the one already in world.
  assert.match(sec, /receivesRealtime\(w\.aToken,/)
  assert.match(sec, /receivesRealtime\(w\.bToken,/)
  assert.ok(
    !/receivesRealtime\(await sessionFor\(/.test(sec),
    'realtime must not re-authenticate an account already in world',
  )

  const jobs = read('lib/messaging/notificationJobs.test.ts')
  assert.ok(
    !/asUser\(await sessionFor\(/.test(jobs),
    'D1 must reuse w.aClient rather than authenticating A again',
  )
  assert.match(jobs, /w\.aClient\.rpc\(\s*'create_thread_with_message'/)

  // Six call sites remain, three distinct accounts -> three authentications.
  const sites = LIVE_SUITES.reduce(
    (n, f) => n + [...read(f).matchAll(/[^e]sessionFor\(/g)].length,
    0,
  )
  assert.equal(sites, 6, 'six requests across the suites, deduplicated by the cache')
})

// ------------------------------------------------- 6-8: caching and expiry

test('6: a repeated request for the same account is served from cache', async () => {
  const opts = scratch()
  const { calls, make } = counter()
  resetAuthCallCount()

  const a = await getLiveSession('a@example.test', make('a@example.test'), opts)
  const b = await getLiveSession('a@example.test', make('a@example.test'), opts)
  const c = await getLiveSession('a@example.test', make('a@example.test'), opts)

  assert.equal(calls.length, 1, 'one authentication for three requests')
  assert.equal(authCallCount(), 1)
  assert.equal(a.token, b.token)
  assert.equal(b.token, c.token)
  assert.equal(a.fromCache, false, 'the first mints')
  assert.equal(b.fromCache, true, 'the rest read')
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

test('7: different accounts never share a token', async () => {
  const opts = scratch()
  const { calls, make } = counter()
  const a = await getLiveSession('a@example.test', make('a@example.test'), opts)
  const b = await getLiveSession('b@example.test', make('b@example.test'), opts)
  const admin = await getLiveSession('admin@example.test', make('admin@example.test'), opts)

  assert.equal(calls.length, 3, 'three accounts, three authentications')
  assert.equal(new Set([a.token, b.token, admin.token]).size, 3, 'tokens must be distinct')
  assert.equal(a.token, 'token-for-a@example.test', 'an account gets its OWN token')
  assert.equal(admin.token, 'token-for-admin@example.test', 'admin is never served to a member')
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

test('8: an expired or near-expiry cached token is not reused', async () => {
  const opts = scratch()
  // Expires in one minute -- inside the five-minute safety margin.
  const soon = counter(60 * 1000)
  const first = await getLiveSession('a@example.test', soon.make('a@example.test'), opts)
  assert.equal(first.fromCache, false)

  const second = await getLiveSession('a@example.test', soon.make('a@example.test'), opts)
  assert.equal(second.fromCache, false, 'a token near expiry must be re-minted, not reused')
  assert.equal(soon.calls.length, 2)

  // A comfortably-valid token IS reused.
  const long = counter(60 * 60 * 1000)
  const opts2 = scratch()
  await getLiveSession('a@example.test', long.make('a@example.test'), opts2)
  const again = await getLiveSession('a@example.test', long.make('a@example.test'), opts2)
  assert.equal(again.fromCache, true)
  assert.equal(long.calls.length, 1)

  rmSync(opts.cacheDir!, { recursive: true, force: true })
  rmSync(opts2.cacheDir!, { recursive: true, force: true })
})

test('8b: a corrupt cache entry is treated as a miss, not a crash', async () => {
  const opts = scratch()
  const { calls, make } = counter()
  await getLiveSession('a@example.test', make('a@example.test'), opts)
  const file = readdirSync(opts.cacheDir!).find((f) => f.endsWith('.json'))!
  writeFileSync(join(opts.cacheDir!, file), 'not json at all')

  const after = await getLiveSession('a@example.test', make('a@example.test'), opts)
  assert.equal(after.fromCache, false)
  assert.equal(calls.length, 2)
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

test('8c: invalidate discards one account without touching the others', async () => {
  const opts = scratch()
  const { calls, make } = counter()
  await getLiveSession('a@example.test', make('a@example.test'), opts)
  await getLiveSession('b@example.test', make('b@example.test'), opts)
  assert.equal(calls.length, 2)

  invalidateLiveSession('a@example.test', opts)
  const a = await getLiveSession('a@example.test', make('a@example.test'), opts)
  const b = await getLiveSession('b@example.test', make('b@example.test'), opts)
  assert.equal(a.fromCache, false, 'A was invalidated')
  assert.equal(b.fromCache, true, 'B was not')
  assert.equal(calls.length, 3)
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

// ------------------------------------------------- 9-10: where it lives, what it says

test('9: the cache lives outside the repository', async () => {
  const src = read(HELPER)
  assert.match(src, /tmpdir\(\)/, 'the default cache dir must come from the OS temp directory')
  assert.ok(!/process\.cwd\(\)|__dirname/.test(src), 'never a path inside the repo')

  const opts = scratch()
  const { make } = counter()
  await getLiveSession('a@example.test', make('a@example.test'), opts)
  assert.ok(opts.cacheDir!.startsWith(tmpdir()), 'cache written under the OS temp directory')
  assert.ok(!opts.cacheDir!.startsWith(REPO), 'never inside the working tree')

  // And nothing cache-shaped was written into the repo.
  assert.ok(!existsSync(join(REPO, 'crnaprephub-live-sessions')))
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

test('9b: cache filenames reveal neither the account nor the project', async () => {
  const opts = scratch()
  const { make } = counter()
  await getLiveSession('a@example.test', make('a@example.test'), opts)
  const names = readdirSync(opts.cacheDir!)
  for (const n of names) {
    assert.ok(!n.includes('a@example.test'), 'the email must not appear in the filename')
    assert.ok(!n.includes('example'), 'nor the namespace')
    assert.match(n, /^[0-9a-f]{32}\.(json|lock)$/, 'a hash, nothing else')
  }
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

test('10: the helper never logs a token or a session object', () => {
  const src = read(HELPER)
  const logs = [...src.matchAll(/console\.[a-z]+\([^)]*\)/g)].map((m) => m[0])
  assert.deepEqual(logs, [], 'the helper must not log at all')
  // Nor may it leak a token through a thrown message.
  assert.ok(
    !/throw new Error\([^)]*(accessToken|access_token|token\b)/.test(src),
    'a token must never appear in an error message',
  )
  // The counter is a number, never a secret.
  assert.match(src, /export const authCallCount = \(\) => authCalls/)
})

// ------------------------------------------------- 11: the inter-process lock

test('11: a per-account lock stops concurrent duplicate authentication', async () => {
  const opts = scratch()
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  const slow = async () => {
    calls++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 60))
    inFlight--
    return { accessToken: 'shared-token', expiresAt: Date.now() + 3600_000 }
  }

  // Five racing requests for ONE account, exactly as three test processes do.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => getLiveSession('a@example.test', slow, opts)),
  )
  assert.equal(calls, 1, 'exactly one authentication despite five concurrent requests')
  assert.equal(maxInFlight, 1, 'never two authentications in flight at once')
  assert.equal(new Set(results.map((r) => r.token)).size, 1, 'all callers get the same token')
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

test('11b: waiting is bounded and fails loudly rather than hanging', async () => {
  const opts = { ...scratch(), waitMs: 300, staleLockMs: 10 * 60 * 1000 }
  const { make } = counter()
  // A lock nobody will ever release, and not yet old enough to be stolen.
  const key = readdirSync(opts.cacheDir!)
  writeFileSync(join(opts.cacheDir!, 'x.lock'), '')
  // Recreate the real lock name by minting once, then locking that key.
  const { calls, make: m2 } = counter()
  await getLiveSession('a@example.test', m2('a@example.test'), opts)
  const jsonName = readdirSync(opts.cacheDir!).find((f) => f.endsWith('.json'))!
  const lockName = jsonName.replace('.json', '.lock')
  rmSync(join(opts.cacheDir!, jsonName))
  writeFileSync(join(opts.cacheDir!, lockName), '')

  await assert.rejects(
    () => getLiveSession('a@example.test', make('a@example.test'), opts),
    /lock timed out after 300ms/,
    'a stuck peer must produce a clear error, never an infinite loop',
  )
  assert.equal(calls.length, 1, 'and must not authenticate behind the lock')
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

test('11c: an abandoned lock is taken over rather than blocking forever', async () => {
  const opts = { ...scratch(), waitMs: 5000, staleLockMs: 1 }
  const { calls, make } = counter()
  await getLiveSession('a@example.test', make('a@example.test'), opts)
  const jsonName = readdirSync(opts.cacheDir!).find((f) => f.endsWith('.json'))!
  rmSync(join(opts.cacheDir!, jsonName))
  writeFileSync(join(opts.cacheDir!, jsonName.replace('.json', '.lock')), '')

  const got = await getLiveSession('a@example.test', make('a@example.test'), opts)
  assert.equal(got.fromCache, false)
  assert.equal(calls.length, 2, 'the stale lock was reclaimed and the work done')
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})

// ------------------------------------------------- 12-14: nothing was weakened

test('12: each suite still builds its own client from the token', () => {
  const src = read(HELPER)
  assert.match(src, /Promise<string>/, 'sessionFor returns a token, not a client')
  assert.ok(
    !/export .*(sharedClient|cachedClient)/.test(src),
    'no Supabase client may be shared between suites',
  )
  for (const f of LIVE_SUITES) {
    const s = read(f)
    assert.match(s, /const asUser = \((token|t): string\) =>/, `${f} builds its own clients`)
    assert.match(s, /createClient\(URL!, ANON!/, `${f} uses its own anon clients`)
  }
})

test('13: the live assertions are intact -- nothing removed or mocked', () => {
  const sec = read('lib/messaging/security.test.ts')
  assert.match(sec, /realtime must obey the same boundary as SELECT/)
  assert.match(sec, /send_tier_broadcast must not be reachable without a session/)
  assert.ok(!/mock|stub|fake/i.test(sec.replace(/\/\*[\s\S]*?\*\//g, '')), 'no mocking crept in')

  const jobs = read('lib/messaging/notificationJobs.test.ts')
  assert.match(jobs, /admin SELECT must be refused/)
  // Was /Phase 1 must not enqueue anything/, which D1-D3 legitimately removed
  // when Phase 2's trigger made it false. Re-anchored on an assertion that
  // still exists, so this keeps proving the suite carries real checks.
  assert.match(jobs, /the worker must be able to record an obligation/)

  const restore = read('lib/messaging/restoreOnReply.test.ts')
  assert.match(restore, /bClient/, 'the member session is still used')
})

test('14: no permission assertion was switched to service_role', () => {
  const jobs = read('lib/messaging/notificationJobs.test.ts')
  // The three "cannot touch it" tests must use browser clients, never `admin`.
  for (const marker of ['A2: an ordinary authenticated member', 'A3: the ADMIN browser session']) {
    const start = jobs.indexOf(marker)
    assert.ok(start > -1, `${marker} must still exist`)
    const body = jobs.slice(start, jobs.indexOf('})', jobs.indexOf('async ()', start)))
    assert.ok(/w\.(aClient|adminClient)\.from\(JOBS\)/.test(body), 'must use a real browser session')
    assert.ok(!/\badmin\.from\(JOBS\)/.test(body), 'service_role must not stand in for a browser')
  }
})

test('15: three distinct accounts cost exactly three authentications', async () => {
  const opts = scratch()
  const { calls, make } = counter()
  // The real call pattern: 6 requests across the suites, 3 accounts.
  const pattern = [
    'a@example.test', 'b@example.test', // security setup
    'b@example.test', // restoreOnReply setup
    'a@example.test', 'b@example.test', 'admin@example.test', // notificationJobs setup
  ]
  for (const email of pattern) await getLiveSession(email, make(email), opts)

  assert.equal(pattern.length, 6, 'six requests, matching the suites')
  assert.equal(calls.length, 3, 'three underlying authentications')
  assert.deepEqual(
    [...new Set(calls)].sort(),
    ['a@example.test', 'admin@example.test', 'b@example.test'],
    'one per distinct account',
  )
  rmSync(opts.cacheDir!, { recursive: true, force: true })
})
