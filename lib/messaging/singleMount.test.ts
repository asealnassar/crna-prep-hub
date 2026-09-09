import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * M-4: exactly one MessagesModal instance for a logged-in user.
 *
 * The component was mounted twice -- globally in ClientProviders, and again
 * behind `{showMessages && ...}` on the dashboard. Because dispatchEvent is
 * synchronous and the local instance mounted only on the render AFTER the
 * event, it never received the first `openMessages` and sat there closed but
 * alive: a second loadThreads() on mount, a second realtime subscription on
 * the shared (isSingleton) client, a second visibilitychange listener, and a
 * second writer to the unread-count context. From the second click onward both
 * instances opened and stacked.
 *
 * Invisible while the panel is a fixed 920px box. Not invisible once M-1 makes
 * it full-screen, which is why this lands first.
 */

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/** Executable text only, so a comment naming the component cannot pass a test. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

/** Every .tsx/.ts under app/ and components/, excluding tests. */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
      const rel = `${dir}/${name}`
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel)
    }
  }
  walk('app')
  walk('components')
  return out
}

const FILES = sourceFiles()

// ------------------------------------------------------------- 1-2: one render site

test('1: exactly one non-test file renders <MessagesModal', () => {
  const renderers = FILES.filter(
    (f) => f !== 'components/MessagesModal.tsx' && /<MessagesModal[\s/>]/.test(codeOnly(read(f))),
  )
  assert.deepEqual(
    renderers,
    ['components/ClientProviders.tsx'],
    `expected exactly one render site, found: ${renderers.join(', ') || 'none'}`,
  )
})

test('1b: the single render site renders it exactly once', () => {
  const src = codeOnly(read('components/ClientProviders.tsx'))
  const renders = [...src.matchAll(/<MessagesModal[\s/>]/g)]
  assert.equal(renders.length, 1, 'ClientProviders must render it once, not twice')
})

test('1c: only one non-test file imports it', () => {
  const importers = FILES.filter(
    (f) => f !== 'components/MessagesModal.tsx' && /import\s+MessagesModal\s+from/.test(codeOnly(read(f))),
  )
  assert.deepEqual(importers, ['components/ClientProviders.tsx'])
})

test('2: ClientProviders holds the single render, gated on an authenticated user', () => {
  const src = codeOnly(read('components/ClientProviders.tsx'))
  assert.match(
    src,
    /\{!loading && user && <MessagesModal userEmail=\{user\.email \|\| ''\} isAdmin=\{isAdmin\} \/>\}/,
    'the global mount and its auth gate must be unchanged',
  )
})

// ---------------------------------------------------- 3-5: the dashboard is clean

test('3: the dashboard has no MessagesModal reference at all', () => {
  const src = read('app/dashboard/page.tsx')
  assert.ok(!/MessagesModal/.test(src), 'no import, no render, not even in a comment')
})

test('4: showMessages / setShowMessages are gone from the dashboard', () => {
  const src = read('app/dashboard/page.tsx')
  assert.ok(!/showMessages/.test(src), 'the state existed only to gate the duplicate')
  assert.ok(!/setShowMessages/.test(src))
})

test('5: the dashboard registers no openMessages listener', () => {
  const src = codeOnly(read('app/dashboard/page.tsx'))
  assert.ok(!/openMessages/.test(src), 'no addEventListener, no handler, no cleanup')
  assert.ok(!/handleOpenMessages/.test(src))
  assert.ok(
    !/removeEventListener\('openMessages'/.test(src),
    'a cleanup must never outlive the handler it references',
  )
})

test('5b: the dashboard effect still runs init() and kept its other logic', () => {
  const src = codeOnly(read('app/dashboard/page.tsx'))
  assert.match(src, /const init = async \(\) => \{/, 'init must survive')
  assert.match(src, /\n\s*init\(\)\n/, 'init must still be called')
  assert.match(src, /from\('user_profiles'\)/, 'profile load intact')
  assert.match(src, /from\('saved_schools'\)/, 'saved schools load intact')
  assert.match(src, /router\.push\('\/login'\)/, 'the unauthenticated redirect intact')
  assert.match(src, /setLoading\(false\)/)
})

// -------------------------------------------- 6: the surviving instance is wired

test('6: the one instance still owns the openMessages listener', () => {
  const src = codeOnly(read('components/MessagesModal.tsx'))
  assert.match(src, /window\.addEventListener\('openMessages' as any, handleOpen\)/)
  assert.match(src, /window\.removeEventListener\('openMessages' as any, handleOpen\)/)
})

test('6b: exactly one dispatcher, and it is the Sidebar button', () => {
  const dispatchers = FILES.filter((f) => /new Event\('openMessages'\)/.test(codeOnly(read(f))))
  assert.deepEqual(dispatchers, ['components/Sidebar.tsx'])
})

test('6c: only the modal itself listens for openMessages', () => {
  const listeners = FILES.filter((f) => /addEventListener\(\s*'openMessages'/.test(codeOnly(read(f))))
  assert.deepEqual(
    listeners,
    ['components/MessagesModal.tsx'],
    'a second listener is what mounted the duplicate',
  )
})

test('6d: only one realtime subscription site and one unread-count writer exist', () => {
  const channels = FILES.filter((f) => /channel\('thread_messages_live'\)/.test(codeOnly(read(f))))
  assert.deepEqual(channels, ['components/MessagesModal.tsx'])

  const writers = FILES.filter((f) => /setGlobalMessagesUnreadCount\(/.test(codeOnly(read(f))))
  assert.deepEqual(writers, ['components/MessagesModal.tsx'], 'one writer to the badge context')
})

// ------------------------------------------------- 7: nothing else was disturbed

test('7: ClientProviders sidebar gating and MessagesModal gating are untouched', () => {
  const src = codeOnly(read('components/ClientProviders.tsx'))
  assert.match(src, /\{showSidebar && \(/, 'the sidebar stays conditional')
  assert.match(src, /const showSidebar = pathname && !HIDDEN_SIDEBAR_PATHS\.includes\(pathname\)/)
  // The modal is deliberately NOT behind showSidebar -- it is available on
  // every authenticated page, which is what makes the global mount sufficient.
  const modalLine = src.split('\n').find((l) => l.includes('<MessagesModal'))!
  assert.ok(!modalLine.includes('showSidebar'), 'the modal must stay independent of the sidebar')
})

test('7b: H-1..H-6 markers in the modal are untouched by this change', () => {
  const src = read('components/MessagesModal.tsx')
  assert.match(src, /const sendInFlight = useRef\(false\)/, 'H-3')
  assert.match(src, /const composeInFlight = useRef\(false\)/, 'H-3B')
  assert.match(src, /recipientHasRead: readCount === recipientCount/, 'H-6')
  assert.match(src, /msg\.sender_id != null && msg\.sender_id === currentUserId/, 'H-2')
  assert.match(
    src,
    /setGlobalMessagesUnreadCount\(individual\.filter\(t => t\.unreadCount > 0\)\.length\)/,
    'unread badge formula',
  )
})
