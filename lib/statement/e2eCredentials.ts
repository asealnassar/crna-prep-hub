/**
 * Credential handling for the live end-to-end script.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN THE SCRIPT. Because it is the part
 * that can leak a session token, and the part that can leak a session token is
 * the part that should have tests.
 *
 * ----------------------------------------------------------------------------
 * THE RULE: A SESSION TOKEN NEVER TOUCHES argv.
 *
 * The first version of the script took `--cookie '<value>'`. That puts a live
 * session token in three places at once:
 *
 *   1. ~/.zsh_history, indefinitely,
 *   2. the process table, readable by `ps` for the whole run,
 *   3. terminal scrollback, and from there into any screenshot or paste.
 *
 * So `--cookie` is not deprecated here, it is REFUSED -- with an error that
 * explains the replacement. A flag that still works is a flag people keep
 * using.
 *
 * The token is read from a file instead, and the file's permissions are
 * checked before it is read. A world-readable file holding a session token is
 * the same problem wearing a different hat.
 * ----------------------------------------------------------------------------
 *
 * NOTHING HERE EVER PUTS THE TOKEN IN A MESSAGE. Every refusal describes the
 * shape of the problem and never the value, so a failing run can be pasted into
 * a chat, an issue or a terminal recording without leaking anything.
 */

export type CredentialRefusal =
  | 'cookie-flag-forbidden'
  | 'no-file'
  | 'unreadable'
  | 'insecure-permissions'
  | 'empty'
  | 'not-a-supabase-cookie'

export type CredentialResult =
  | { readonly ok: true; readonly cookie: string }
  | { readonly ok: false; readonly code: CredentialRefusal; readonly message: string }

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Whether a file's mode keeps its contents to its owner.
 *
 * `mode & 0o077` is every group and other bit. Zero means nobody else can read
 * it. Anything else -- 0644 being the common default -- means the token is
 * readable by any process running as any other user on the machine.
 */
export function permissionsAreSafe(mode: number): boolean {
  return (mode & 0o077) === 0
}

/** Rendered into the refusal so the fix is `chmod 600 <path>`, not a guess. */
export function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

// ---------------------------------------------------------------------------
// Normalising what was pasted
// ---------------------------------------------------------------------------

/**
 * A cookie header, however it was copied.
 *
 * People paste what their tools give them, and the tools give several shapes:
 * a bare `a=1; b=2`, DevTools' `cookie: a=1`, or a line lifted out of
 * "Copy as cURL" complete with `-H` and quotes. All three mean the same thing,
 * and failing on two of them just teaches people to hand-edit a secret in a
 * text editor, which is worse.
 */
export function normaliseCookie(raw: string): string {
  let value = String(raw ?? '')
    // Whole-file paste: join physical lines, since a copied header may wrap.
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .trim()

  // `-H 'cookie: ...'` or `-H "cookie: ..."` from Copy as cURL.
  const curl = /^-H\s+(['"])([\s\S]*)\1$/.exec(value)
  if (curl) value = curl[2].trim()

  // Surrounding quotes from a careful paste.
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
  if (quoted) value = quoted[2].trim()

  // A leading `Cookie:` header name.
  value = value.replace(/^cookie\s*:\s*/i, '').trim()

  // A trailing semicolon is legal but untidy, and confuses a visual diff.
  return value.replace(/;\s*$/, '')
}

/**
 * Whether this looks like a Supabase session at all.
 *
 * Pasting the wrong cookie is a normal mistake, and its symptom without this
 * check is a wall of 401s that looks like the feature is broken. Naming it
 * here costs one regex and saves an hour.
 */
export function looksLikeSupabaseSession(cookie: string): boolean {
  return /(^|;\s*)sb-[^=;\s]*auth-token(\.\d+)?=/.test(cookie)
}

// ---------------------------------------------------------------------------
// The access token inside it
// ---------------------------------------------------------------------------

/**
 * The JWT carried by the session cookie, or null.
 *
 * Deliberately mirrors lib/apiAuth.readAccessToken: the same split `.0`/`.1`
 * reassembly, the same `base64-` prefix, the same two payload shapes. The
 * script needs it to read the caller's OWN ledger rows through PostgREST under
 * RLS -- which is how the end-to-end run verifies that usage was recorded
 * without ever being handed a service-role key.
 *
 * Returns null rather than throwing on anything malformed. A script that
 * crashes on a bad paste tells you less than one that says "no token in here".
 */
export function accessTokenFromCookieHeader(cookie: string): string | null {
  const parts: { name: string; value: string }[] = []
  for (const pair of String(cookie ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    const name = pair.slice(0, at).trim()
    if (!/^sb-.*auth-token(\.\d+)?$/.test(name)) continue
    parts.push({ name, value: pair.slice(at + 1).trim() })
  }
  if (parts.length === 0) return null

  parts.sort((a, b) => a.name.localeCompare(b.name))
  let raw = parts.map((p) => p.value).join('')

  if (raw.startsWith('base64-')) {
    try {
      raw = Buffer.from(raw.slice(7), 'base64').toString('utf-8')
    } catch {
      return null
    }
  }

  const extract = (text: string): string | null => {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return typeof parsed[0] === 'string' ? parsed[0] : null
    return typeof parsed?.access_token === 'string' ? parsed.access_token : null
  }

  try {
    return extract(decodeURIComponent(raw))
  } catch {
    try {
      return extract(raw)
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface FileFacts {
  /** False when the path does not exist or is not a regular file. */
  readonly exists: boolean
  /** st_mode & 0o777. */
  readonly mode: number
  /** File contents, or null when it could not be read. */
  readonly contents: string | null
}

/**
 * The cookie, or a refusal — decided from facts, so it is testable without a
 * filesystem.
 *
 * `sawCookieFlag` is checked FIRST and unconditionally. Someone who passes both
 * `--cookie` and `--cookie-file` has already leaked the value into their shell
 * history by the time this runs; the refusal is what stops them doing it again
 * tomorrow, so it fires even though a perfectly good file was also supplied.
 */
export function decideCredentials(input: {
  readonly sawCookieFlag: boolean
  readonly path: string | null
  readonly file: FileFacts | null
}): CredentialResult {
  if (input.sawCookieFlag) {
    return {
      ok: false,
      code: 'cookie-flag-forbidden',
      message:
        '--cookie is not supported: a session token passed as an argument is written to your shell history and is visible to `ps` for the whole run.\n' +
        'Put it in a file instead:\n' +
        '  touch ~/.cph-cookie && chmod 600 ~/.cph-cookie\n' +
        '  (paste the cookie header into it with your editor)\n' +
        '  node scripts/verify-statement-e2e.mjs --tier free --cookie-file ~/.cph-cookie\n' +
        'If you already ran a --cookie command, clear that history entry and sign out of that session.',
    }
  }

  if (!input.path || !input.file || !input.file.exists) {
    return {
      ok: false,
      code: 'no-file',
      message: '--cookie-file <path> is required, and must point at a readable file.',
    }
  }

  if (!permissionsAreSafe(input.file.mode)) {
    return {
      ok: false,
      code: 'insecure-permissions',
      message:
        `That file is mode ${modeString(input.file.mode)}, so other users on this machine can read your session token.\n` +
        'Fix it with:  chmod 600 <path>',
    }
  }

  if (input.file.contents === null) {
    return { ok: false, code: 'unreadable', message: 'That file could not be read.' }
  }

  const cookie = normaliseCookie(input.file.contents)
  if (cookie === '') {
    return { ok: false, code: 'empty', message: 'That file is empty.' }
  }

  if (!looksLikeSupabaseSession(cookie)) {
    return {
      ok: false,
      code: 'not-a-supabase-cookie',
      message:
        'That does not contain a Supabase auth cookie. Expected at least one cookie named like `sb-<project>-auth-token` (it may be split into `.0` and `.1`).',
    }
  }

  return { ok: true, cookie }
}
