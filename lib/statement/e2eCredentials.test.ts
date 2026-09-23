import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  accessTokenFromCookieHeader, decideCredentials, looksLikeSupabaseSession,
  modeString, normaliseCookie, permissionsAreSafe,
} from './e2eCredentials.ts'

const COOKIE = 'sb-abcdefgh-auth-token=%5B%22jwt-value%22%2C%22refresh%22%5D'
const file = (contents: string | null, mode = 0o600) => ({ exists: true, mode, contents })

// =====================================================================
// --cookie is refused, not deprecated
// =====================================================================

test('--cookie is refused outright', () => {
  const result = decideCredentials({ sawCookieFlag: true, path: '/tmp/c', file: file(COOKIE) })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'cookie-flag-forbidden')
})

test('--cookie is refused even when a perfectly good file is also supplied', () => {
  // By the time this runs the value is already in their shell history. The
  // refusal is what stops them doing it again tomorrow.
  const result = decideCredentials({ sawCookieFlag: true, path: '/tmp/c', file: file(COOKIE, 0o600) })
  assert.equal(result.ok, false)
})

test('the refusal explains the replacement and the cleanup', () => {
  const result = decideCredentials({ sawCookieFlag: true, path: null, file: null })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /--cookie-file/)
  assert.match(result.message, /chmod 600/)
  assert.match(result.message, /shell history/)
})

test('the script offers no --cookie path at all', () => {
  // Asserted against the script itself: a flag that still works is a flag
  // people keep using.
  const script = readFileSync(
    fileURLToPath(new URL('../../scripts/verify-statement-e2e.mjs', import.meta.url)), 'utf8')
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(code, /args\.get\(['"]cookie['"]\)\s*\?\?/, 'the script still reads --cookie as a value')
  assert.ok(code.includes('cookie-file'), 'the script does not offer --cookie-file')
})

// =====================================================================
// Permissions
// =====================================================================

test('only owner-readable files are accepted', () => {
  for (const mode of [0o600, 0o400, 0o700, 0o000]) {
    assert.equal(permissionsAreSafe(mode), true, modeString(mode))
  }
  // 0644 is the common default and is exactly the problem.
  for (const mode of [0o644, 0o640, 0o604, 0o666, 0o777, 0o660, 0o606]) {
    assert.equal(permissionsAreSafe(mode), false, modeString(mode))
  }
})

test('a group- or world-readable file is refused with the fix', () => {
  const result = decideCredentials({ sawCookieFlag: false, path: '/tmp/c', file: file(COOKIE, 0o644) })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'insecure-permissions')
  assert.match(result.message, /644/)
  assert.match(result.message, /chmod 600/)
})

test('the mode is rendered as three octal digits', () => {
  assert.equal(modeString(0o600), '600')
  assert.equal(modeString(0o644), '644')
  assert.equal(modeString(0o7), '007')
  assert.equal(modeString(0o100644), '644', 'the file-type bits are masked off')
})

// =====================================================================
// The token never appears in a message
// =====================================================================

test('no refusal ever quotes the cookie', () => {
  // A failing run should be safe to paste into a chat or an issue.
  const secret = 'sb-proj-auth-token=SUPERSECRETVALUE123456'
  const cases = [
    { sawCookieFlag: true, path: '/tmp/c', file: file(secret) },
    { sawCookieFlag: false, path: '/tmp/c', file: file(secret, 0o644) },
    { sawCookieFlag: false, path: '/tmp/c', file: file('', 0o600) },
    { sawCookieFlag: false, path: '/tmp/c', file: file('not-a-cookie=1', 0o600) },
    { sawCookieFlag: false, path: '/tmp/c', file: { exists: true, mode: 0o600, contents: null } },
    { sawCookieFlag: false, path: null, file: null },
  ]
  for (const input of cases) {
    const result = decideCredentials(input)
    if (result.ok) continue
    assert.doesNotMatch(result.message, /SUPERSECRETVALUE/, JSON.stringify(input.file?.contents))
    assert.doesNotMatch(result.message, /auth-token=/)
  }
})

// =====================================================================
// Normalising what was pasted
// =====================================================================

test('every shape a person actually pastes is accepted', () => {
  const want = 'sb-abc-auth-token.0=one; sb-abc-auth-token.1=two'
  for (const pasted of [
    want,
    `${want}\n`,
    `  ${want}  `,
    `cookie: ${want}`,
    `Cookie: ${want}`,
    `COOKIE:${want}`,
    `'${want}'`,
    `"${want}"`,
    `-H 'cookie: ${want}'`,
    `-H "cookie: ${want}"`,
    `${want};`,
    `${want}\r\n`,
  ]) {
    assert.equal(normaliseCookie(pasted), want, JSON.stringify(pasted))
  }
})

test('a cookie wrapped across lines is rejoined', () => {
  assert.equal(
    normaliseCookie('sb-abc-auth-token.0=one;\nsb-abc-auth-token.1=two'),
    'sb-abc-auth-token.0=one; sb-abc-auth-token.1=two'
  )
})

test('an empty or whitespace-only file is refused', () => {
  for (const contents of ['', '   ', '\n\n', '\r\n']) {
    const result = decideCredentials({ sawCookieFlag: false, path: '/tmp/c', file: file(contents) })
    assert.equal(result.ok, false, JSON.stringify(contents))
    if (result.ok) continue
    assert.equal(result.code, 'empty')
  }
})

test('pasting the wrong cookie is named rather than left to look like a broken feature', () => {
  for (const contents of ['session=abc; theme=dark', '_ga=GA1.1.2; cph_consent=v1:1:1', 'sb-abc-refresh=x']) {
    const result = decideCredentials({ sawCookieFlag: false, path: '/tmp/c', file: file(contents) })
    assert.equal(result.ok, false, contents)
    if (result.ok) continue
    assert.equal(result.code, 'not-a-supabase-cookie')
  }
})

test('a real Supabase cookie is recognised in both split and whole forms', () => {
  assert.equal(looksLikeSupabaseSession('sb-abc-auth-token=x'), true)
  assert.equal(looksLikeSupabaseSession('other=1; sb-abc-auth-token.0=x; sb-abc-auth-token.1=y'), true)
  assert.equal(looksLikeSupabaseSession('sbx-auth=1'), false)
})

test('a well-formed file is accepted and returns the normalised header', () => {
  const result = decideCredentials({
    sawCookieFlag: false, path: '/tmp/c', file: file(`cookie: ${COOKIE}\n`, 0o600),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.cookie, COOKIE)
})

test('a missing file is refused', () => {
  for (const input of [
    { sawCookieFlag: false, path: null, file: null },
    { sawCookieFlag: false, path: '/tmp/nope', file: { exists: false, mode: 0o600, contents: null } },
  ]) {
    const result = decideCredentials(input)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.code, 'no-file')
  }
})

// =====================================================================
// Extracting the JWT — mirrors lib/apiAuth.readAccessToken
// =====================================================================

test('the array payload shape yields the access token', () => {
  const cookie = `sb-proj-auth-token=${encodeURIComponent(JSON.stringify(['the-jwt', 'refresh']))}`
  assert.equal(accessTokenFromCookieHeader(cookie), 'the-jwt')
})

test('the object payload shape yields the access token', () => {
  const cookie = `sb-proj-auth-token=${encodeURIComponent(JSON.stringify({ access_token: 'the-jwt' }))}`
  assert.equal(accessTokenFromCookieHeader(cookie), 'the-jwt')
})

test('a split cookie is reassembled in name order, not paste order', () => {
  const payload = JSON.stringify(['a-long-jwt-value', 'refresh'])
  const encoded = encodeURIComponent(payload)
  const half = Math.floor(encoded.length / 2)
  // Deliberately out of order, as a browser may hand them over.
  const cookie = `sb-p-auth-token.1=${encoded.slice(half)}; other=x; sb-p-auth-token.0=${encoded.slice(0, half)}`
  assert.equal(accessTokenFromCookieHeader(cookie), 'a-long-jwt-value')
})

test('the base64- prefixed form is decoded', () => {
  const payload = JSON.stringify(['b64-jwt', 'refresh'])
  const cookie = `sb-p-auth-token=base64-${Buffer.from(payload, 'utf8').toString('base64')}`
  assert.equal(accessTokenFromCookieHeader(cookie), 'b64-jwt')
})

test('unrelated cookies are ignored', () => {
  const cookie = `theme=dark; sb-p-auth-token=${encodeURIComponent(JSON.stringify(['jwt']))}; _ga=1`
  assert.equal(accessTokenFromCookieHeader(cookie), 'jwt')
})

test('anything malformed yields null rather than throwing', () => {
  for (const cookie of [
    '', 'nonsense', 'sb-p-auth-token=', 'sb-p-auth-token=not-json',
    'sb-p-auth-token=base64-!!!!', 'sb-p-auth-token=%7Bbroken',
    'sb-p-auth-token=' + encodeURIComponent(JSON.stringify([42])),
    'sb-p-auth-token=' + encodeURIComponent(JSON.stringify({ nope: 1 })),
    'sb-p-auth-token=' + encodeURIComponent(JSON.stringify(null)),
  ]) {
    let token
    assert.doesNotThrow(() => { token = accessTokenFromCookieHeader(cookie) }, cookie)
    assert.equal(token, null, cookie)
  }
})
