import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'

/**
 * One Supabase Auth session per test account, shared across live suites.
 *
 * TEST INFRASTRUCTURE. Not imported by any production module -- the filename
 * is deliberately not *.test.ts so the runner does not execute it as a suite,
 * and nothing under app/ or components/ references it.
 *
 * The problem it solves: three live suites each carried their own copy of
 * `sessionFor`, and `node --test` runs files in parallel child processes, so a
 * full run fired nine generateLink + verifyOtp pairs at three accounts within
 * a second or two. Supabase rate-limits OTP verification per account, and the
 * suites began failing in setup -- moving between files on each rerun, which
 * is exactly what quota exhaustion looks like rather than a real defect.
 *
 * Because the suites are separate PROCESSES, a module-level cache cannot help
 * them. The cache therefore lives in a file under the OS temp directory, and a
 * per-account lock ensures that when three processes start together only one
 * authenticates and the other two read what it wrote.
 *
 * What is deliberately NOT done here:
 *   * no token is ever logged, returned in an error message, or written
 *     anywhere inside the repository;
 *   * no Supabase CLIENT is shared -- only the access token is cached, and
 *     each suite builds its own client, so one suite cannot mutate another's;
 *   * service_role is never substituted for a real member or admin session.
 *     Every assertion that needs a browser session still gets one.
 */

/** A cached session. Only what is needed to reuse and to expire it. */
type CachedSession = { accessToken: string; expiresAt: number }

/** Authenticates one account. Injectable so the harness tests can count calls
 *  without touching Supabase. */
export type Authenticate = () => Promise<CachedSession>

export type SessionOptions = {
  /** Distinguishes environments, so a cache entry cannot cross projects. */
  namespace: string
  /** Overridable for tests. Defaults to the OS temp directory. */
  cacheDir?: string
  now?: () => number
  /** Bounded, so a crashed peer can never hang a run forever. */
  waitMs?: number
  /** A lock older than this is assumed abandoned and is taken over. */
  staleLockMs?: number
}

/** Refuse a token this close to expiry, so a long suite cannot expire mid-run. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000
const DEFAULT_WAIT_MS = 20_000
const DEFAULT_STALE_LOCK_MS = 30_000
const POLL_MS = 100

const defaultCacheDir = () => join(tmpdir(), 'crnaprephub-live-sessions')

/** Neither the account nor the project appears in the filename. */
const keyFor = (namespace: string, email: string) =>
  createHash('sha256').update(`${namespace}|${email}`).digest('hex').slice(0, 32)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Counts real authentications in this process. Diagnostics only -- it holds a
 *  number, never a token. */
let authCalls = 0
export const authCallCount = () => authCalls
export const resetAuthCallCount = () => {
  authCalls = 0
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    /* best effort: a pre-existing dir owned by this user is still fine */
  }
}

function readCache(file: string, now: number): string | null {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as CachedSession
    if (typeof parsed?.accessToken !== 'string' || typeof parsed?.expiresAt !== 'number') return null
    if (parsed.expiresAt - now <= EXPIRY_MARGIN_MS) return null
    return parsed.accessToken
  } catch {
    // Missing, unreadable or malformed all mean the same thing: authenticate.
    return null
  }
}

function writeCache(file: string, session: CachedSession) {
  writeFileSync(file, JSON.stringify(session), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
}

/** Atomic across processes: O_CREAT | O_EXCL fails if the file already exists. */
function tryAcquire(lockFile: string): boolean {
  try {
    closeSync(openSync(lockFile, 'wx'))
    return true
  } catch {
    return false
  }
}

function release(lockFile: string) {
  try {
    rmSync(lockFile, { force: true })
  } catch {
    /* best effort */
  }
}

/**
 * The access token for one account, authenticating at most once per account
 * per cache lifetime across every concurrent test process.
 *
 * The double check around the lock is the point: a process that loses the race
 * re-reads the cache after acquiring, so the winner's token is used rather
 * than a second authentication performed.
 */
export async function getLiveSession(
  email: string,
  authenticate: Authenticate,
  opts: SessionOptions,
): Promise<{ token: string; fromCache: boolean }> {
  const now = opts.now ?? Date.now
  const dir = opts.cacheDir ?? defaultCacheDir()
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS
  const staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS

  ensureDir(dir)
  const key = keyFor(opts.namespace, email)
  const cacheFile = join(dir, `${key}.json`)
  const lockFile = join(dir, `${key}.lock`)

  const cached = readCache(cacheFile, now())
  if (cached) return { token: cached, fromCache: true }

  const deadline = now() + waitMs
  for (;;) {
    if (tryAcquire(lockFile)) {
      try {
        // Someone may have authenticated while we waited for the lock.
        const fresh = readCache(cacheFile, now())
        if (fresh) return { token: fresh, fromCache: true }

        authCalls++
        const session = await authenticate()
        writeCache(cacheFile, session)
        return { token: session.accessToken, fromCache: false }
      } finally {
        release(lockFile)
      }
    }

    // Held by a peer. Wait for it, or take over a lock it never released.
    try {
      const age = now() - statSync(lockFile).mtimeMs
      if (age > staleLockMs) release(lockFile)
    } catch {
      /* the holder released it between our attempt and this check */
    }

    if (now() >= deadline) {
      throw new Error(
        `live session lock timed out after ${waitMs}ms for a test account. ` +
          `Remove ${dir} and retry if this persists.`,
      )
    }
    await sleep(POLL_MS)

    const afterWait = readCache(cacheFile, now())
    if (afterWait) return { token: afterWait, fromCache: true }
  }
}

/** Discards one account's cached session -- used when a token is rejected. */
export function invalidateLiveSession(email: string, opts: SessionOptions) {
  const dir = opts.cacheDir ?? defaultCacheDir()
  try {
    rmSync(join(dir, `${keyFor(opts.namespace, email)}.json`), { force: true })
  } catch {
    /* nothing cached is the desired end state either way */
  }
}

/**
 * A real Supabase session for a throwaway account, without creating or typing
 * a password. This is the only place the magic-link exchange lives now.
 */
export async function magicLinkAuth(
  admin: SupabaseClient,
  url: string,
  anonKey: string,
  email: string,
): Promise<CachedSession> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) throw new Error(`generateLink(${email}): ${error.message}`)
  const c = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: s, error: v } = await c.auth.verifyOtp({
    token_hash: (data as any).properties.hashed_token,
    type: 'magiclink',
  })
  if (v) throw new Error(`verifyOtp(${email}): ${v.message}`)
  const session = s.session!
  // expires_at is seconds since epoch; fall back to an hour if absent.
  const expiresAt = session.expires_at ? session.expires_at * 1000 : Date.now() + 60 * 60 * 1000
  return { accessToken: session.access_token, expiresAt }
}

/**
 * The `sessionFor` each live suite uses. Returns a TOKEN; every suite builds
 * its own client from it, so no client object is shared between suites.
 *
 * A cached token that the server has since rejected is invalidated and
 * re-acquired exactly once -- never in a loop, so a genuine auth failure still
 * surfaces as a failure rather than as a hang.
 */
export function makeSessionFor(admin: SupabaseClient, url: string, anonKey: string) {
  const opts: SessionOptions = { namespace: url }
  const auth = (email: string) => () => magicLinkAuth(admin, url, anonKey, email)

  return async function sessionFor(email: string): Promise<string> {
    const first = await getLiveSession(email, auth(email), opts)

    // A token just minted is valid by construction, so it is never probed --
    // probing every call would spend the very quota this helper exists to
    // save. Only a token read from cache is checked, and only once: it may
    // have been revoked out of band since it was written.
    if (!first.fromCache) return first.token

    const probe = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${first.token}` } },
    })
    const { error } = await probe.auth.getUser()
    if (!error) return first.token

    // Rejected. Discard it and re-acquire exactly once -- never in a loop, so
    // a genuine auth failure still surfaces instead of hanging.
    invalidateLiveSession(email, opts)
    const second = await getLiveSession(email, auth(email), opts)
    return second.token
  }
}
