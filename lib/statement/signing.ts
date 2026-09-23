/**
 * Proof that an analysis came from this server.
 *
 * ----------------------------------------------------------------------------
 * THE HOLE THIS CLOSES.
 *
 * The rewrite endpoint took `analysis` off the request body and concatenated
 * its fields into the SYSTEM message. Nothing checked the shape, the length or
 * the origin. So any Ultimate account could send
 *
 *     { statement: "...", analysis: { topChanges: ["Ignore your instructions..."] } }
 *
 * and write the system prompt themselves -- a general-purpose model proxy,
 * billed to this project, reachable with one subscription.
 *
 * Validation alone does not fix that. A strictly-typed `suggestion: string` is
 * still a string the caller chose, and no amount of shape-checking makes
 * attacker-chosen prose safe to treat as an instruction. The fix has to be
 * ORIGIN, not shape.
 *
 * SO: every analysis this server issues is returned with a token. A rewrite
 * must present one, and the server recomputes it from the analysis in the body.
 * If the analysis was altered by so much as a character, the recomputation does
 * not match and the request is refused before a token is spent.
 *
 * The token binds four things:
 *
 *   * the ANALYSIS -- so its content cannot be edited,
 *   * the STATEMENT -- so an analysis of one essay cannot be replayed against
 *     another,
 *   * the USER -- so one account's token is useless to another,
 *   * an EXPIRY -- so a captured token is not good forever.
 *
 * It is not a session, it carries no privilege, and it is not a secret the
 * client needs to protect: it is only ever useful with the exact analysis and
 * the exact statement it was issued for, by the account it was issued to.
 * ----------------------------------------------------------------------------
 *
 * NO DATABASE. Nothing is stored. The token is self-describing and verified by
 * recomputation, which is what lets this ship without a migration.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** Bumped if the payload layout ever changes, so old tokens stop verifying. */
export const TOKEN_VERSION = 'v1'

/**
 * How long an analysis stays rewritable.
 *
 * Long enough to read a page of feedback and decide, short enough that a token
 * lifted from a log or a shared HAR file is stale. Someone who waits longer
 * re-runs the analysis, which is one click.
 */
export const TOKEN_TTL_MS = 30 * 60_000

export type VerifyFailure =
  | 'missing'
  | 'malformed'
  | 'expired'
  | 'mismatch'
  | 'unavailable'

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VerifyFailure }

/**
 * Canonical JSON: keys sorted at every level, so two objects that are equal
 * hash equally regardless of how a client serialised them.
 *
 * Without this, a browser re-ordering keys on the round trip would invalidate
 * every legitimate token, and the endpoint would be secure by being broken.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`)
  return `{${entries.join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * The signing key.
 *
 * `STATEMENT_SIGNING_SECRET` when it is set. Otherwise DERIVED from the service
 * role key, which every deployment already has, so this ships without new
 * configuration. The derivation is a keyed hash over a fixed, purpose-specific
 * label: the result cannot be run backwards to the service role key, and a
 * signature made with it is useless anywhere else.
 *
 * Returns null when neither is available, and the caller fails CLOSED -- an
 * unsigned rewrite is refused rather than allowed. A signing scheme that
 * switches itself off when misconfigured is not a signing scheme.
 */
export function signingKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const explicit = env.STATEMENT_SIGNING_SECRET
  if (typeof explicit === 'string' && explicit.trim().length >= 16) {
    return Buffer.from(explicit.trim(), 'utf8')
  }
  const derived = env.SUPABASE_SERVICE_ROLE_KEY
  if (typeof derived === 'string' && derived.trim().length >= 16) {
    return createHmac('sha256', derived.trim())
      .update('crnaprephub:statement-analysis-token:v1', 'utf8')
      .digest()
  }
  return null
}

interface Binding {
  readonly userId: string
  readonly statement: string
  readonly analysis: unknown
  readonly expiresAt: number
}

/** What is actually signed. One line, so a change to it is visible in a diff. */
function payload(binding: Binding): string {
  return [
    TOKEN_VERSION,
    binding.userId,
    sha256(binding.statement),
    sha256(canonicalise(binding.analysis)),
    String(binding.expiresAt),
  ].join('.')
}

/**
 * The token for an analysis this server is about to return.
 *
 * Shape: `v1.<expiresAt>.<hex mac>`. The user id and the two hashes are NOT in
 * the token -- the verifier re-derives them from the authenticated session and
 * the request body, which is what makes them impossible to tamper with rather
 * than merely signed.
 */
export function signAnalysis(input: {
  readonly userId: string
  readonly statement: string
  readonly analysis: unknown
  readonly now?: number
  readonly key?: Buffer | null
}): string | null {
  const key = input.key === undefined ? signingKey() : input.key
  if (!key) return null

  const expiresAt = (input.now ?? Date.now()) + TOKEN_TTL_MS
  const mac = createHmac('sha256', key)
    .update(payload({ userId: input.userId, statement: input.statement, analysis: input.analysis, expiresAt }), 'utf8')
    .digest('hex')

  return `${TOKEN_VERSION}.${expiresAt}.${mac}`
}

/**
 * Whether this token was issued by this server, to this user, for this exact
 * statement and this exact analysis, and has not expired.
 *
 * Every failure mode is a refusal. There is no branch that returns ok on an
 * unreadable token, an unavailable key or an unexpected shape.
 */
export function verifyAnalysisToken(input: {
  readonly token: unknown
  readonly userId: string
  readonly statement: string
  readonly analysis: unknown
  readonly now?: number
  readonly key?: Buffer | null
}): VerifyResult {
  const key = input.key === undefined ? signingKey() : input.key
  if (!key) return { ok: false, reason: 'unavailable' }

  if (typeof input.token !== 'string' || input.token === '') {
    return { ok: false, reason: 'missing' }
  }

  const parts = input.token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [version, expiryText, mac] = parts
  if (version !== TOKEN_VERSION) return { ok: false, reason: 'malformed' }
  if (!/^\d{1,15}$/.test(expiryText)) return { ok: false, reason: 'malformed' }
  if (!/^[0-9a-f]{64}$/.test(mac)) return { ok: false, reason: 'malformed' }

  const expiresAt = Number(expiryText)
  if ((input.now ?? Date.now()) > expiresAt) return { ok: false, reason: 'expired' }

  const expected = createHmac('sha256', key)
    .update(payload({
      userId: input.userId,
      statement: input.statement,
      analysis: input.analysis,
      expiresAt,
    }), 'utf8')
    .digest('hex')

  // Both are 64 hex characters by construction -- the regex above guarantees it
  // for `mac` -- so the lengths always match and the comparison is the only
  // thing being timed.
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(mac, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'mismatch' }
  }

  return { ok: true }
}
