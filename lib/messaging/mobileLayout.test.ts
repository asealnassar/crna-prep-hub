import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * M-1: full-screen Messages below `lg`.
 *
 * The panel was `fixed bottom-0 left-64 h-[85vh] w-[920px]` at every width,
 * with no responsive class anywhere in the file. It occupied x 256..1176
 * always, so a 375px phone saw 119px of it -- 12.9% -- and the thread pane,
 * which starts at x=596, was off-screen at every phone width and unreachable
 * (the panel is fixed with overflow-hidden inside, so nothing could scroll to
 * it). The 256px offset was reserving room for a sidebar that translates
 * itself off-screen below `lg`.
 *
 * These tests read the shipped classes and model the resulting geometry.
 */

const SRC = readFileSync(new URL('../../components/MessagesModal.tsx', import.meta.url), 'utf8')
/** Executable text only, so a comment describing the old layout cannot pass a test. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
/** JSX comments too -- the panel carries a long one. */
const jsx = code.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')

/**
 * The panel's className template literal.
 *
 * Anchored on h-[100dvh], which only the panel carries -- the backdrop is also
 * `fixed inset-0`, so that string alone selects the wrong element.
 */
const panel = (() => {
  const i = jsx.indexOf('h-[100dvh]')
  assert.ok(i > -1, 'the panel must be locatable')
  return jsx.slice(jsx.lastIndexOf('`', i) + 1, jsx.indexOf('`', i))
})()

const SIDEBAR_OFFSET = 256 // left-64
const DESKTOP_MAX = 920 // lg:max-w-[920px]
const LG = 1024

/** Resulting panel box for a viewport width, from the classes above. */
function geometry(vw: number) {
  if (vw < LG) return { left: 0, width: vw } // inset-0 + w-full
  // lg: left-64 right-0 w-auto max-w-[920px] -> fills, capped.
  return { left: SIDEBAR_OFFSET, width: Math.min(DESKTOP_MAX, vw - SIDEBAR_OFFSET) }
}

// ----------------------------------------------------------- 1-2: mobile is unprefixed

test('1: the panel has no unprefixed left-64', () => {
  assert.ok(!/(^|\s)left-64/.test(panel), 'the sidebar offset must not apply below lg')
  assert.match(panel, /lg:left-64/, 'and must still apply at lg')
})

test('2: the panel has no unprefixed w-[920px]', () => {
  assert.ok(!/(^|\s)w-\[920px\]/.test(panel), 'the fixed desktop width must not apply below lg')
})

// -------------------------------------------------------------- 3-5: desktop geometry

test('3: desktop keeps its sidebar offset behind lg:', () => {
  assert.match(panel, /lg:left-64/)
  assert.equal(geometry(1440).left, 256)
})

test('4: desktop reaches 920px once there is room', () => {
  assert.match(panel, /lg:max-w-\[920px\]/)
  for (const vw of [1176, 1280, 1440, 1920]) {
    assert.equal(geometry(vw).width, 920, `${vw}px must render the full 920`)
  }
})

test('5: 1024-1175px cannot extend past the viewport', () => {
  for (let vw = 1024; vw <= 1175; vw++) {
    const g = geometry(vw)
    assert.ok(g.left + g.width <= vw, `${vw}px overflows by ${g.left + g.width - vw}px`)
  }
  // The old geometry did overflow across that whole band.
  assert.ok(256 + 920 > 1175, 'the pre-fix box provably clipped at 1175px')
  assert.equal(geometry(1024).width, 768)
  assert.equal(geometry(1175).width, 919)
})

// ------------------------------------------------------------ 6-9: the mobile classes

test('6: mobile uses inset-0, and lg un-pins the sides it must not keep', () => {
  assert.match(panel, /(^|\s)inset-0/)
  assert.match(panel, /lg:inset-auto/)
  assert.match(panel, /lg:top-auto/, 'desktop is bottom-anchored, not full height')
  assert.match(panel, /lg:bottom-0/)
})

test('7: mobile uses w-full, desktop returns to auto width', () => {
  assert.match(panel, /(^|\s)w-full/)
  assert.match(panel, /lg:w-auto/, 'auto width lets left+right+max-width govern')
  assert.match(panel, /lg:right-0/)
})

test('8: mobile uses h-[100dvh]', () => {
  assert.match(panel, /h-\[100dvh\]/, 'dynamic viewport height shrinks with the keyboard')
})

test('9: desktop retains lg:h-[85vh]', () => {
  assert.match(panel, /lg:h-\[85vh\]/)
  assert.ok(!/(^|\s)h-\[85vh\]/.test(panel), '85vh must not apply on a phone')
})

// ------------------------------------------------------- 10: derived view precedence

/** The component's rule, verbatim. */
const viewFor = (showCompose: boolean, selectedThread: unknown) =>
  showCompose ? 'compose' : selectedThread ? 'thread' : 'inbox'

test('10: mobileView precedence is compose > thread > inbox', () => {
  assert.equal(viewFor(true, { id: 't' }), 'compose', 'compose outranks an open thread')
  assert.equal(viewFor(true, null), 'compose')
  assert.equal(viewFor(false, { id: 't' }), 'thread')
  assert.equal(viewFor(false, null), 'inbox')

  assert.match(
    code,
    /showCompose \? 'compose' : selectedThread \? 'thread' : 'inbox'/,
    'the component must use this exact precedence',
  )
  assert.ok(
    !/useState.*mobileView|const \[mobileView/.test(code),
    'the view must be derived, never stored',
  )
})

// -------------------------------------------------- 11-13: pane visibility

const paneClasses = (marker: string) => {
  const i = jsx.indexOf(marker)
  assert.ok(i > -1, `pane not found: ${marker}`)
  return jsx.slice(i, jsx.indexOf('`}>', i))
}
const inboxPane = paneClasses("mobileView === 'inbox' ? 'flex' : 'hidden'")
const rightPane = paneClasses("mobileView === 'inbox' ? 'hidden' : 'flex'")

test('11: the inbox pane is full width and shown only for inbox below lg', () => {
  assert.match(inboxPane, /w-full/)
  assert.match(inboxPane, /lg:w-\[340px\]/, 'desktop keeps the 340px list')
  assert.ok(!/(^|\s)w-\[340px\]/.test(inboxPane), 'the 340px list must not constrain a phone')
  assert.match(inboxPane, /lg:flex/)
})

test('12: the thread/compose pane is hidden while the phone is on the inbox', () => {
  assert.match(rightPane, /lg:flex/)
  assert.match(rightPane, /flex-1/, 'desktop still fills the remaining width')
})

test('13: both panes are present in the desktop layout', () => {
  // Whatever mobileView says, lg:flex restores both at >= 1024.
  for (const pane of [inboxPane, rightPane]) assert.match(pane, /lg:flex/)
})

// --------------------------------------------------------- 14-17: back controls

/** Both Back controls, selected by their handler rather than by source order:
 *  the compose branch is rendered before the thread branch in the ternary. */
const backButtons = [...jsx.matchAll(/aria-label="Back to conversations"/g)].map((m) => {
  const start = jsx.lastIndexOf('<button', m.index!)
  return jsx.slice(start, jsx.indexOf('</button>', m.index!))
})

const threadBack = backButtons.find((b) => /setSelectedThread\(null\)/.test(b))
const composeBack = backButtons.find((b) => /setShowCompose\(false\)/.test(b))

test('14/15: the thread Back is lg:hidden and clears selectedThread', () => {
  assert.ok(threadBack, 'a Back control must return from a thread')
  assert.match(threadBack!, /lg:hidden/, 'desktop keeps both panes and must not show it')
  assert.match(threadBack!, /onClick=\{\(\) => setSelectedThread\(null\)\}/)
  assert.ok(!/setShowCompose/.test(threadBack!), 'it must not also touch compose')
})

test('16/17: the compose Back is lg:hidden and clears showCompose', () => {
  assert.equal(backButtons.length, 2, 'one Back in the thread header, one in compose')
  assert.ok(composeBack, 'a Back control must return from compose')
  assert.match(composeBack!, /lg:hidden/)
  assert.match(composeBack!, /onClick=\{\(\) => setShowCompose\(false\)\}/)
  assert.ok(!/setSelectedThread/.test(composeBack!), 'it must not also clear the thread')
})

test('17b: each Back sits inside its own branch of the right pane', () => {
  const composeBranch = jsx.indexOf('showCompose ? (')
  const threadBranch = jsx.indexOf(') : selectedThread ? (', composeBranch)
  const emptyBranch = jsx.indexOf(') : (', threadBranch)
  assert.ok(composeBranch > -1 && threadBranch > composeBranch && emptyBranch > threadBranch)

  const at = (b: string) => jsx.indexOf(b)
  assert.ok(
    at(composeBack!) > composeBranch && at(composeBack!) < threadBranch,
    'the compose Back must live in the compose header',
  )
  assert.ok(
    at(threadBack!) > threadBranch && at(threadBack!) < emptyBranch,
    'the thread Back must live in the thread header',
  )
})

// ------------------------------------------------- 18-22: nothing else disturbed

test('18: the existing close (X) button remains', () => {
  assert.match(jsx, /onClick=\{\(\) => setIsOpen\(false\)\}/, 'the header X still closes')
})

test('19: thread delete behaviour is unchanged', () => {
  assert.match(jsx, /confirm\('Delete this conversation\?'\)/)
  assert.match(jsx, /deleteThread\(selectedThread\.id\)/)
})

test('20: H-3 / H-3B locks are untouched', () => {
  assert.match(code, /const sendInFlight = useRef\(false\)/)
  assert.match(code, /const composeInFlight = useRef\(false\)/)
  assert.match(code, /if \(sendInFlight\.current\) return/)
  assert.match(code, /if \(composeInFlight\.current\) return/)
  assert.match(code, /alert\('Your reply could not be sent\. Please try again\.'\)/)
})

test('21: H-6 read progress and the unread badge are untouched', () => {
  assert.match(code, /recipientHasRead: readCount === recipientCount/)
  assert.match(code, /\$\{readCount\} \/ \$\{recipientCount\} read/)
  assert.match(
    code,
    /setGlobalMessagesUnreadCount\(individual\.filter\(t => t\.unreadCount > 0\)\.length\)/,
  )
  assert.match(code, /msg\.sender_id != null && msg\.sender_id === currentUserId/, 'H-2')
})

test('22: no visualViewport or keyboard listener was added', () => {
  assert.ok(!/visualViewport/.test(SRC), 'explicitly out of scope for this stage')
  assert.ok(!/'keyboard|keyboardWillShow|resize'/.test(code))
})

// ---------------------------------------------------- 23-25: geometry and stacking

test('23: nothing extends beyond the viewport at any tested width', () => {
  for (const vw of [375, 390, 430, 768, 1024]) {
    const g = geometry(vw)
    assert.equal(g.left, vw < LG ? 0 : 256, `${vw}px left edge`)
    assert.ok(g.left + g.width <= vw, `${vw}px overflows`)
    if (vw < LG) assert.equal(g.width, vw, `${vw}px must be exactly full-width`)
  }
  // What the old geometry did at those widths, for contrast.
  for (const vw of [375, 390, 430]) {
    assert.ok(256 + 920 > vw, 'the pre-fix panel ran off every phone viewport')
  }
})

test('24: at >= 1200px the desktop box is what it always was', () => {
  const g = geometry(1200)
  assert.equal(g.left, 256)
  assert.equal(g.width, 920)
  assert.equal(g.left + g.width, 1176, 'identical to the pre-fix box')
  assert.match(panel, /lg:rounded-tl-3xl/, 'and keeps its rounded top corners')
  assert.match(panel, /lg:rounded-tr-3xl/)
})

test('25: mobile stacks above the sidebar hamburger, desktop stacking unchanged', () => {
  const sidebar = readFileSync(new URL('../../components/Sidebar.tsx', import.meta.url), 'utf8')
  assert.match(sidebar, /lg:hidden fixed top-4 left-4 z-50/, 'the hamburger is z-50 below lg')

  assert.match(panel, /z-\[60\]/, 'the panel must outrank it while open')
  assert.match(panel, /lg:z-50/, 'desktop keeps its original z-50')
})
