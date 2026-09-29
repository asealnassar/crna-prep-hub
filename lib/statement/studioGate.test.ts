import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MODE,
  STATEMENT_STUDIO_HIDDEN_BODY,
  STATEMENT_STUDIO_MODE_ENV,
  parseStatementStudioMode,
  statementStudioAccess,
  statementStudioMode,
  type StatementStudioMode,
} from './studioGate.ts'

/**
 * Two things are proved here.
 *
 * PART 1 runs the gate. It is pure, so every case is a call.
 *
 * PART 2 reads the page. A React Server Component cannot be imported under
 * `node --test`: app/statement-studio/[id]/page.tsx imports next/navigation,
 * and next has no exports map, so ESM cannot resolve the extensionless
 * specifier -- the same wall that made test/tsx-hooks.mjs redirect next/server
 * to next/server.js. Rather than widen the loader for one page, the page's
 * structural guarantees are asserted against its source, which is the
 * convention lib/privacy/privacyPage.test.ts already uses for app/privacy.
 *
 * WHAT PART 2 IS AND IS NOT. It is a guard against the shell being changed into
 * something it must not be -- a query above the gate, an editable field, a
 * service-role client, a leaked error detail. It is not a runtime proof. The
 * page body is straight-line async code whose refusals throw, so source order
 * is execution order today; a future rewrite into branches would need real
 * invocation to check. That is recorded, not papered over.
 */

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const read = (relative: string) => readFileSync(path(relative), 'utf8')

const GATE = read('./studioGate.ts')
const LAYOUT = read('../../app/statement-studio/layout.tsx')

/**
 * Part 2 asserts what the shell must NOT contain, and the shell's own comments
 * name several of those things in order to say why they are absent. Asserting
 * against the raw text would fail on the explanation. So the comments come off
 * first, and every assertion below reads the code.
 *
 * The stripping is regex-shallow: it would damage a string literal containing
 * a comment opener. The page has none, and the first test checks that the
 * stripped source still parses as the same program.
 */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

const PAGE = stripComments(read('../../app/statement-studio/[id]/page.tsx'))

const internal: StatementStudioMode = 'internal'
const general: StatementStudioMode = 'general'

// ---------------------------------------------------------------- PART 1: gate

test('internal mode: only a signed-in admin is let through', () => {
  assert.deepEqual(
    statementStudioAccess({ isAdmin: true, isAuthenticated: true, mode: internal }),
    { allowed: true }
  )
})

test('general mode: every signed-in user is let through, admin or not', () => {
  assert.deepEqual(
    statementStudioAccess({ isAdmin: false, isAuthenticated: true, mode: general }),
    { allowed: true }
  )
  assert.deepEqual(
    statementStudioAccess({ isAdmin: true, isAuthenticated: true, mode: general }),
    { allowed: true }
  )
})

test('an anonymous visitor never reaches the Studio, in either mode', () => {
  for (const mode of [internal, general]) {
    const access = statementStudioAccess({ isAdmin: false, isAuthenticated: false, mode })
    assert.equal(access.allowed, false, `${mode} admitted an anonymous visitor`)
  }
})

test('an anonymous visitor cannot be admitted by claiming to be an admin', () => {
  for (const mode of [internal, general]) {
    const access = statementStudioAccess({ isAdmin: true, isAuthenticated: false, mode })
    assert.equal(access.allowed, false, `${mode} trusted isAdmin over isAuthenticated`)
  }
})

test('internal mode tells an anonymous probe nothing, not even to sign in', () => {
  const access = statementStudioAccess({ isAdmin: false, isAuthenticated: false, mode: internal })
  assert.deepEqual(access, { allowed: false, status: 404, reason: 'hidden' })
})

test('general mode asks an anonymous visitor to sign in, because the Studio is live', () => {
  const access = statementStudioAccess({ isAdmin: false, isAuthenticated: false, mode: general })
  assert.deepEqual(access, { allowed: false, status: 401, reason: 'sign-in' })
})

test('a signed-in non-admin in internal mode gets a 404, never a 403', () => {
  const access = statementStudioAccess({ isAdmin: false, isAuthenticated: true, mode: internal })
  assert.deepEqual(access, { allowed: false, status: 404, reason: 'hidden' })
  // Stated so it cannot be softened by accident. Asserted against the decision
  // itself and not the file, because the file explains in prose why 403 is wrong.
  assert.doesNotMatch(statementStudioAccess.toString(), /403/)
  assert.deepEqual(new Set(GATE.match(/status: [0-9]{3}/g)), new Set(['status: 401', 'status: 404']))
})

test('nothing but a true boolean opens the admin path in internal mode', () => {
  for (const claim of ['yes', 1, {}, [], 'true', 'admin']) {
    const access = statementStudioAccess({
      isAdmin: claim as unknown as boolean,
      isAuthenticated: true,
      mode: internal,
    })
    assert.equal(access.allowed, false, `${JSON.stringify(claim)} was treated as admin`)
  }
})

test('nothing but a true boolean satisfies the authentication check', () => {
  for (const claim of ['yes', 1, {}, [], 'true']) {
    const hidden = statementStudioAccess({
      isAdmin: true,
      isAuthenticated: claim as unknown as boolean,
      mode: internal,
    })
    assert.equal(hidden.allowed, false, `${JSON.stringify(claim)} passed as authenticated`)

    // In general mode the same non-boolean must land on sign-in, not on access.
    const live = statementStudioAccess({
      isAdmin: false,
      isAuthenticated: claim as unknown as boolean,
      mode: general,
    })
    assert.deepEqual(live, { allowed: false, status: 401, reason: 'sign-in' })
  }
})

test('an unrecognised mode value behaves as internal, not as general', () => {
  for (const raw of ['v2', 'beta', 'on', 'true', '1', 'GENERALLY', 'general,beta', '', ' ']) {
    assert.equal(parseStatementStudioMode(raw), 'internal', `"${raw}" opened the Studio`)
  }
  assert.equal(parseStatementStudioMode(undefined), 'internal')
  assert.equal(parseStatementStudioMode(null), 'internal')
})

test('the mode is unset by default, so a forgotten flag hides the Studio', () => {
  assert.equal(DEFAULT_MODE, 'internal')
  const blocked = statementStudioAccess({
    isAdmin: false,
    isAuthenticated: true,
    mode: DEFAULT_MODE,
  })
  assert.equal(blocked.allowed, false)
})

test('the flag is matched exactly, after trimming and lowercasing', () => {
  for (const raw of ['general', 'GENERAL', ' General ', '\tgeneral\n']) {
    assert.equal(parseStatementStudioMode(raw), 'general', `"${raw}" should release the Studio`)
  }
})

test('statementStudioMode reads exactly the statement flag, and nothing else', () => {
  assert.equal(STATEMENT_STUDIO_MODE_ENV, 'STATEMENT_STUDIO_MODE')

  const before = process.env[STATEMENT_STUDIO_MODE_ENV]
  try {
    delete process.env[STATEMENT_STUDIO_MODE_ENV]
    assert.equal(statementStudioMode(), 'internal')

    process.env[STATEMENT_STUDIO_MODE_ENV] = 'general'
    assert.equal(statementStudioMode(), 'general')

    process.env[STATEMENT_STUDIO_MODE_ENV] = 'yes'
    assert.equal(statementStudioMode(), 'internal')
  } finally {
    if (before === undefined) delete process.env[STATEMENT_STUDIO_MODE_ENV]
    else process.env[STATEMENT_STUDIO_MODE_ENV] = before
  }

  // One variable, read in one place, and it is that variable.
  assert.deepEqual(GATE.match(/process\.env\[[^\]]*\]/g), [
    'process.env[STATEMENT_STUDIO_MODE_ENV]',
  ])
})

test('the decision function never reads the environment', () => {
  assert.doesNotMatch(
    statementStudioAccess.toString(),
    /process\.env/,
    'the decision must be taken from its arguments alone'
  )
})

test('the gate is not wired to the resume rollout flag', () => {
  // Prose may name RESUME_BUILDER_MODE to explain why; code may not touch it.
  assert.doesNotMatch(GATE, /^import/m, 'the gate should import nothing at all')
  assert.doesNotMatch(GATE, /resumeBuilderMode|resumeV2Access/)
  assert.doesNotMatch(GATE, /process\.env\[?\.?['"]?RESUME/)
})

test('the gate reads exactly three things, so tier cannot enter', () => {
  // A word blacklist is the wrong instrument here -- /pro/ matches "prompt".
  // This is the precise claim instead: the decision consults isAdmin,
  // isAuthenticated and mode, and nothing else exists for it to consult.
  const body = statementStudioAccess.toString()
  assert.doesNotMatch(body, /\btier\b/i)
  assert.deepEqual([...new Set(body.match(/input\.[A-Za-z]+/g))].sort(), [
    'input.isAdmin',
    'input.isAuthenticated',
    'input.mode',
  ])
})

test('the hidden body is neutral: it names nothing at all', () => {
  assert.deepEqual(STATEMENT_STUDIO_HIDDEN_BODY, { error: 'Not found.', code: 'not-found' })

  const text = JSON.stringify(STATEMENT_STUDIO_HIDDEN_BODY).toLowerCase()
  for (const word of [
    // The approved list: nothing about what kind of endpoint refused the caller.
    'draft', 'statement', 'studio', 'admin', 'internal', 'upload', 'extract',
    'forbidden', 'permission',
    // And nothing about the gate itself.
    'beta', 'general', 'flag', 'mode', 'denied', 'role', 'hidden', '403',
  ]) {
    assert.equal(text.includes(word), false, `the hidden body must not say "${word}"`)
  }
})

test('the hidden body is the ONLY response body the gate defines', () => {
  // The gate decides access; the routes map that decision onto responses. This
  // one shared body is the deliberate exception, and it exists so that all five
  // Studio endpoints answer a blocked caller identically rather than by three
  // copies of a literal happening to agree.
  assert.deepEqual(GATE.match(/export const [A-Z_]*BODY/g), [
    'export const STATEMENT_STUDIO_HIDDEN_BODY',
  ])
})

// ---------------------------------------------------------------- PART 2: page

test('stripping the comments leaves the program intact', () => {
  // Cheap proof that the regexes above removed commentary and nothing else:
  // every statement the later tests look for is still here, and no comment
  // opener survived to hide code from them.
  for (const kept of [
    /^import \{ notFound, redirect \} from 'next\/navigation'$/m,
    /^export const dynamic = 'force-dynamic'$/m,
    /^export default async function StatementStudioPage\(\{$/m,
    /^\}$/m,
  ]) {
    assert.match(PAGE, kept)
  }
  assert.doesNotMatch(PAGE, /\/\*|\*\/|^[ \t]*\/\//m)
})

test('the shell is a server component, with no client bundle', () => {
  assert.doesNotMatch(PAGE, /['"]use client['"]/)
  assert.doesNotMatch(PAGE, /\buseState\b|\buseEffect\b|\buseRef\b/)
})

test('force-dynamic is declared rather than inferred', () => {
  assert.match(PAGE, /export const dynamic = 'force-dynamic'/)
})

test('the statement gate is applied, not the resume one', () => {
  assert.match(PAGE, /from '@\/lib\/statement\/studioGate'/)
  assert.match(PAGE, /statementStudioAccess\(\{/)
  assert.match(PAGE, /mode: statementStudioMode\(\)/)
  // Coupling is judged on import lines; the comments may compare the two pages.
  assert.doesNotMatch(PAGE, /^import[^\n]*lib\/resume/m)
})

test('the gate and the id check both precede the draft read', () => {
  const gate = PAGE.indexOf('statementStudioAccess({')
  const refuse = PAGE.indexOf('notFound()')
  const idCheck = PAGE.indexOf('isDraftId(id)')
  const query = PAGE.indexOf('readDraft(db')

  for (const [name, at] of [
    ['the gate call', gate],
    ['a refusal', refuse],
    ['the id check', idCheck],
    ['the read', query],
  ] as const) {
    assert.notEqual(at, -1, `${name} is missing from the shell`)
  }

  assert.ok(gate < query, 'the draft is read before the gate decides')
  assert.ok(refuse < query, 'nothing is refused before the draft is read')
  assert.ok(idCheck < query, 'a malformed id reaches the database')

  // Exactly one read, so the ordering above cannot be true of one call and
  // false of another.
  assert.equal(PAGE.split('readDraft(').length - 1, 1)
})

test('the draft is read through the repository, never off the table', () => {
  assert.match(PAGE, /from '@\/lib\/statement\/draft\/draftRepo'/)
  assert.doesNotMatch(PAGE, /\.from\(/)
  assert.doesNotMatch(PAGE, /statement_drafts/)
  assert.doesNotMatch(PAGE, /\.select\(|\.eq\(|\.maybeSingle\(/)
})

test('the id validator is shared with the draft API, not re-written', () => {
  assert.match(PAGE, /from '@\/lib\/statement\/draft\/http'/)
  assert.doesNotMatch(PAGE, /\[0-9a-f\]\{8\}/, 'a second uuid pattern would drift from the first')
})

test('the page never holds the service role key', () => {
  assert.doesNotMatch(PAGE, /SERVICE_ROLE/i)
  assert.match(PAGE, /NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  assert.match(PAGE, /Authorization: `Bearer \$\{token\}`/)
})

test('absence and invisibility end the same way, and a fault does not', () => {
  // readDraft() uses maybeSingle() with no user_id filter, so an RLS-hidden row
  // and an absent row are both 'not-found'. This is the branch that keeps them
  // indistinguishable to the reader.
  assert.match(PAGE, /read\.reason === 'not-found'\) notFound\(\)/)
  assert.match(PAGE, /throw new Error\(UNREADABLE\)/)
})

test('a failed read tells the reader nothing about why', () => {
  assert.doesNotMatch(PAGE, /read\.detail|\.detail\b/)
  assert.doesNotMatch(PAGE, /JSON\.stringify\(read|String\(read/)
  // The one message a reader can see is a fixed constant.
  assert.match(PAGE, /const UNREADABLE = 'This draft could not be opened\.'/)
})

test('the shell has no editable control and no interaction', () => {
  for (const forbidden of [
    /<input\b/,
    /<textarea\b/,
    /<form\b/,
    /<button\b/,
    /<select\b/,
    /contentEditable/i,
    /onChange|onSubmit|onClick|onInput|onKeyDown/,
  ]) {
    assert.doesNotMatch(PAGE, forbidden, `the read-only shell must not contain ${forbidden}`)
  }
})

test('the shell does not reach the draft API, or autosave, from anywhere', () => {
  assert.doesNotMatch(PAGE, /\bfetch\(/)
  assert.doesNotMatch(PAGE, /\/api\/statement/)
  assert.doesNotMatch(PAGE, /^import[^\n]*(autosave|draft\/save)/m)
})

test('the draft is rendered as escaped text, whitespace preserved', () => {
  assert.doesNotMatch(PAGE, /dangerouslySetInnerHTML/)
  assert.match(PAGE, /\{draft\.title\}/)
  assert.match(PAGE, /\{draft\.essay\}/)
  assert.match(PAGE, /whitespace-pre-wrap/)
})

test('the route is not indexable while it is unreleased', () => {
  assert.match(LAYOUT, /index: false/)
  assert.match(LAYOUT, /follow: true/)
})

test('the library page does not exist yet', () => {
  // Step 2 is the editor shell only. /statement-studio itself must still 404.
  assert.equal(existsSync(path('../../app/statement-studio/page.tsx')), false)
})
