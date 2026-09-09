import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * M-2: the desktop panel sits against whichever sidebar is actually there.
 *
 * The offset was an unconditional `lg:left-64`, so collapsing the sidebar to
 * 80px left a 176px gap between it and the panel. Seventeen other files
 * already solve this with `${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'}`;
 * MessagesModal was the last consumer of sidebar geometry not following it.
 *
 * The M-1 width rule is what makes this safe to change: width comes from
 * `right-0` + `max-w-[920px]`, not a fixed 920, so it absorbs whatever the
 * left offset is instead of pushing the right edge off screen.
 *
 * The app-wide mount-time desync -- Sidebar re-mounts with isCollapsed=false
 * without telling the context -- is deliberately NOT addressed here. It
 * already affects those seventeen files and is its own issue.
 */

const ROOT = new URL('../../', import.meta.url).pathname
const SRC = readFileSync(join(ROOT, 'components/MessagesModal.tsx'), 'utf8')
/** Executable text only, so a comment cannot satisfy an assertion. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const jsx = code.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')

/** The panel's className template literal, anchored on the one class only it has. */
const panel = (() => {
  const i = jsx.indexOf('h-[100dvh]')
  assert.ok(i > -1, 'the panel must be locatable')
  return jsx.slice(jsx.lastIndexOf('`', i) + 1, jsx.indexOf('`', i))
})()

const EXPANDED = 256 // w-64 / left-64  = 16rem
const COLLAPSED = 80 // w-20 / left-20  =  5rem
const MAXW = 920
const LG = 1024

/** Desktop box for a viewport width and sidebar state. */
const geometry = (vw: number, collapsed: boolean) => {
  const left = collapsed ? COLLAPSED : EXPANDED
  return { left, width: Math.min(MAXW, vw - left) }
}

// ---------------------------------------------------------------- 1: the hook

test('1: the component destructures sidebarCollapsed from the hook it already calls', () => {
  assert.match(
    code,
    /const \{ setMessagesUnreadCount: setGlobalMessagesUnreadCount, sidebarCollapsed \} =\s*useSidebarCollapsed\(\)/,
    'one added destructure -- no new import, no new state',
  )
  assert.match(code, /import \{ useSidebarCollapsed \} from '@\/lib\/SidebarContext'/)
  assert.ok(
    !/useState[^\n]*sidebarCollapsed|const \[sidebarCollapsed/.test(code),
    'the collapsed state must come from the shared context, never a local copy',
  )
})

// ------------------------------------------------------------ 2-4: the offset

test('2: no unconditional desktop offset remains on the panel', () => {
  const offsets = [...panel.matchAll(/lg:left-\d+/g)].map((m) => m[0])
  assert.deepEqual(
    offsets.sort(),
    ['lg:left-20', 'lg:left-64'],
    'both offsets must be present, and only inside the ternary',
  )
  assert.match(
    panel,
    /\$\{sidebarCollapsed \? 'lg:left-20' : 'lg:left-64'\}/,
    'the offset must be conditional on the shared state',
  )
  // Neither may appear outside the interpolation.
  const outside = panel.replace(/\$\{[^}]*\}/g, ' ')
  assert.ok(!/lg:left-/.test(outside), 'no bare lg:left-* may survive next to the ternary')
})

test('3: the expanded state keeps the existing 256px offset', () => {
  assert.match(panel, /'lg:left-64'/)
  assert.equal(geometry(1440, false).left, 256)
})

test('4: the collapsed state uses the 80px offset', () => {
  assert.match(panel, /'lg:left-20'/)
  assert.equal(geometry(1440, true).left, 80)
})

test('4b: the offsets match the sidebar widths they align to', () => {
  const sidebar = readFileSync(join(ROOT, 'components/Sidebar.tsx'), 'utf8')
  assert.match(
    sidebar,
    /\$\{isCollapsed \? 'w-20' : 'w-64'\}/,
    'the sidebar is w-20 collapsed / w-64 expanded -- left-20 / left-64 mirror it',
  )
})

// ------------------------------------------------------ 5-6: M-1 geometry intact

test('5: the mobile classes are untouched', () => {
  for (const c of ['inset-0', 'w-full', 'h-\\[100dvh\\]', 'z-\\[60\\]', 'rounded-none']) {
    assert.match(panel, new RegExp(`(^|\\s)${c}`), `${c} must still apply below lg`)
  }
})

test('6: the M-1 desktop width rule is unchanged', () => {
  for (const c of ['lg:right-0', 'lg:w-auto', 'lg:max-w-\\[920px\\]', 'lg:h-\\[85vh\\]', 'lg:z-50']) {
    assert.match(panel, new RegExp(c.replace(/\\\\/g, '\\')))
  }
  assert.ok(!/(^|\s)w-\[920px\]/.test(panel), 'never a hard desktop width')
  assert.match(panel, /lg:inset-auto/)
  assert.match(panel, /lg:top-auto/)
  assert.match(panel, /lg:bottom-0/)
})

// ------------------------------------------------------- 7-9: geometry in both states

test('7: neither state overflows at any tested width', () => {
  for (const vw of [1024, 1175, 1176, 1280, 1440]) {
    for (const collapsed of [false, true]) {
      const g = geometry(vw, collapsed)
      assert.ok(
        g.left + g.width <= vw,
        `${vw}px ${collapsed ? 'collapsed' : 'expanded'} overflows by ${g.left + g.width - vw}px`,
      )
    }
  }
})

test('7b: no overflow anywhere across the whole desktop range', () => {
  for (let vw = LG; vw <= 2560; vw += 1) {
    for (const collapsed of [false, true]) {
      const g = geometry(vw, collapsed)
      assert.ok(g.left + g.width <= vw, `${vw}px ${collapsed ? 'collapsed' : 'expanded'}`)
    }
  }
})

test('8: collapsed reaches the full 920px wherever there is room', () => {
  assert.equal(geometry(1000, true).width, 920, 'collapsed needs only 1000px')
  for (const vw of [1024, 1175, 1176, 1280, 1440]) {
    assert.equal(geometry(vw, true).width, 920, `${vw}px collapsed must be full width`)
  }
})

test('9: expanded behaviour is exactly what M-1 shipped', () => {
  assert.equal(geometry(1024, false).width, 768)
  assert.equal(geometry(1175, false).width, 919)
  for (const vw of [1176, 1280, 1440]) {
    const g = geometry(vw, false)
    assert.equal(g.left, 256)
    assert.equal(g.width, 920)
    assert.equal(g.left + g.width, 1176, 'the original desktop box, unchanged')
  }
})

// ------------------------------------------------------------- 10: the built CSS

/** Newest built stylesheet, if a build has been run. */
const builtCss = (() => {
  const dir = join(ROOT, '.next/static')
  if (!existsSync(dir)) return null
  const found: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.css')) found.push(p)
    }
  }
  walk(dir)
  return found.length ? readFileSync(found[0], 'utf8') : null
})()

test(
  '10: the build emits .lg\\:left-20{left:5rem}',
  { skip: builtCss ? false : 'no production build present (run next build)' },
  () => {
    const css = builtCss!
    const m = /@media \(min-width:1024px\)\{/.exec(css)
    assert.ok(m, 'the lg media block must exist')
    const lg = css.slice(m.index + m[0].length)

    assert.ok(
      lg.includes('.lg\\:left-20{left:5rem}'),
      'lg:left-20 is a class this repo has never used before -- it must be emitted',
    )
    assert.ok(lg.includes('.lg\\:left-64{left:16rem}'), 'and the expanded offset must survive')
    // Both must live inside the media query, never in the base layer.
    const base = css.slice(0, m.index)
    assert.ok(!base.includes('.lg\\:left-20{'), 'must not leak into the mobile layer')
  },
)

// -------------------------------------------------- 11-12: nothing else disturbed

test('11: the existing transition is unchanged', () => {
  assert.match(panel, /transition-all duration-300 ease-out/)
  assert.match(panel, /transform/)
  assert.match(panel, /lg:rounded-tl-3xl/)
  assert.match(panel, /lg:rounded-tr-3xl/)
})

test('12: navigation state and messaging logic are untouched', () => {
  assert.match(
    code,
    /showCompose \? 'compose' : selectedThread \? 'thread' : 'inbox'/,
    'M-1 mobileView derivation',
  )
  assert.match(code, /onClick=\{\(\) => setSelectedThread\(null\)\}/, 'thread Back')
  assert.match(code, /onClick=\{\(\) => setShowCompose\(false\)\}/, 'compose Back')
  assert.match(code, /const sendInFlight = useRef\(false\)/, 'H-3')
  assert.match(code, /const composeInFlight = useRef\(false\)/, 'H-3B')
  assert.match(code, /recipientHasRead: readCount === recipientCount/, 'H-6')
  assert.match(code, /msg\.sender_id != null && msg\.sender_id === currentUserId/, 'H-2')
  assert.match(
    code,
    /setGlobalMessagesUnreadCount\(individual\.filter\(t => t\.unreadCount > 0\)\.length\)/,
    'unread badge',
  )
})

test('12b: the deferred mount-time desync was not touched', () => {
  const sidebar = readFileSync(join(ROOT, 'components/Sidebar.tsx'), 'utf8')
  const ctx = readFileSync(join(ROOT, 'lib/SidebarContext.tsx'), 'utf8')
  // Still exactly one push to the context, still only from the toggle.
  assert.equal(
    [...sidebar.matchAll(/onCollapsedChange\?\.\(/g)].length,
    1,
    'no mount-time sync was added -- that is a separate issue',
  )
  assert.match(sidebar, /const \[isCollapsed, setIsCollapsed\] = useState\(false\)/)
  assert.match(ctx, /const \[sidebarCollapsed, setSidebarCollapsed\] = useState\(false\)/)
})
