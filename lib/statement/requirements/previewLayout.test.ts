import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WHERE THE PREVIEW SITS IN THE TREE, asserted by walking the tree.
 *
 * THE BUG THIS FILE EXISTS FOR. LibraryClient's root is `flex`, and its one
 * child is the column holding the whole page -- `min-w-0 flex-1`, which is
 * what lets the page reflow when the nav collapses. The preview was rendered
 * as a SECOND child of that flex row, which made it a column BESIDE the page:
 * it claimed its own width and `flex-1` shrank the real content to fit,
 * squeezing the hero, the three step cards and the draft library into narrow
 * strips. Every CSS class involved was individually correct; only the nesting
 * was wrong, which is why no class-matching assertion caught it.
 *
 * SO THESE ASSERTIONS ARE ABOUT DEPTH, not about classes.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const stripTs = (source: string) => source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

const LIBRARY = stripTs(read('../../../app/statement-studio/components/LibraryClient.tsx'))
const PREVIEW = stripTs(read('../../../app/statement-studio/components/RequirementPreview.tsx'))
const CHECKLIST = stripTs(read('../../../app/statement-studio/components/RequirementChecklist.tsx'))

/**
 * The `<div>` nesting depth at which a tag first appears, counted from the
 * flex root. Self-closing and closing tags are handled; other elements are
 * ignored, because the flex layout is made of divs.
 */
function divDepthOf(source: string, needle: string): number | null {
  const rootAt = source.indexOf('<div className="flex min-h-screen')
  assert.notEqual(rootAt, -1, 'the flex root must exist')
  let depth = 0
  const tokens = /<div\b|<\/div>|<main\b|<\/main>/g
  const target = source.indexOf(needle, rootAt)
  if (target === -1) return null
  tokens.lastIndex = rootAt
  let match: RegExpExecArray | null
  while ((match = tokens.exec(source)) !== null) {
    if (match.index >= target) break
    if (match[0] === '<div' || match[0] === '<main') depth += 1
    else depth -= 1
  }
  return depth
}

test('THE FLEX ROOT HAS EXACTLY ONE LAYOUT CHILD', () => {
  // The content column. A second child becomes a column beside the page, and
  // `flex-1` then shrinks the real content to make room for it.
  //
  // SELF-CLOSING TAGS MUST BE DETECTED, and two earlier versions of this
  // walker did not. The first also counted <RequirementPreview />; the second
  // stopped counting components but still treated the hero's self-closing
  // <div ... /> gradient overlays as openings. Either way depth never unwound,
  // the second child landed at the wrong depth, and the test passed against
  // the buggy nesting. A non-vacuity check caught it both times.
  const rootAt = LIBRARY.indexOf('<div className="flex min-h-screen')
  assert.notEqual(rootAt, -1)
  const after = LIBRARY.slice(rootAt)
  let depth = 0
  const children: string[] = []
  const tokens = /<(div|main|aside|section)\b[^>]*>|<\/(div|main|aside|section)>/g
  let match: RegExpExecArray | null
  let sawSelfClosing = false
  while ((match = tokens.exec(after)) !== null) {
    const tag = match[0]
    if (tag.startsWith('</')) {
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (tag.endsWith('/>')) { sawSelfClosing = true; continue }
    depth += 1
    if (depth === 2) children.push(match[1]!)
  }
  assert.equal(sawSelfClosing, true, 'precondition: the walker met a self-closing tag')
  assert.deepEqual(children, ['div'],
    `the flex root's layout children are: ${children.join(', ')}`)
})

test('THE SIBLING FORM IS GONE', () => {
  // The exact shape of the regression, named so it cannot come back quietly:
  // a preview rendered as `{requirementsPreview && (...)}` after the content
  // column's closing tag rather than inside it.
  assert.doesNotMatch(LIBRARY, /\{requirementsPreview && \(/)
  assert.doesNotMatch(LIBRARY, /\{fixturesPreview && \(/)
  // THE CONDITION WIDENED WHEN THE REAL CATALOG ARRIVED -- ?preview=requirements
  // shows the 63 imported sets and ?preview=fixtures shows the eight shapes --
  // but the FORM is the thing this test defends: still one ternary, still
  // replacing the library rather than appearing after it.
  assert.match(LIBRARY, /\{requirementsPreview \|\| fixturesPreview \? \(/)
  // And no second centring wrapper, which is what narrowed it further.
  assert.doesNotMatch(LIBRARY, /max-w-6xl/)
})

test('THE PREVIEW IS INSIDE THE CONTENT COLUMN, at the same depth as the library', () => {
  const previewDepth = divDepthOf(LIBRARY, '<RequirementPreview')
  const libraryDepth = divDepthOf(LIBRARY, '{/* ====')
  assert.notEqual(previewDepth, null, 'the preview must be rendered')
  // The library's own <main> is the yardstick: both <main>s are children of
  // the content column, so the preview sits exactly where the library does.
  const mainDepths = [...LIBRARY.matchAll(/<main\b/g)].map((m) => divDepthOf(LIBRARY, m[0]))
  assert.equal(mainDepths.length, 2, 'one <main> for the library, one for the preview')
  assert.ok(previewDepth! >= 2, 'the preview is not a sibling of the content column')
  assert.equal(libraryDepth, null)
})

test('IT REPLACES THE LIBRARY RATHER THAN SITTING BESIDE IT', () => {
  assert.match(LIBRARY, /\{requirementsPreview \|\| fixturesPreview \? \(/)
  // Two <main>s, and they are the two arms of one conditional -- so exactly
  // one renders.
  assert.equal((LIBRARY.match(/<main\b/g) ?? []).length, 2)
  assert.equal((LIBRARY.match(/<\/main>/g) ?? []).length, 2)
  const branchAt = LIBRARY.indexOf('{requirementsPreview ? (')
  const elseAt = LIBRARY.indexOf(') : (', branchAt)
  assert.ok(elseAt > branchAt, 'there is an else arm')
  // The preview is in the TRUE arm and the hero is in the FALSE arm.
  assert.ok(LIBRARY.indexOf('<RequirementPreview') > branchAt)
  assert.ok(LIBRARY.indexOf('<RequirementPreview') < elseAt)
  assert.ok(LIBRARY.indexOf('DeskScene') > elseAt)
})

test('BOTH ARMS USE THE SAME CONTAINER, so centring and padding cannot diverge', () => {
  const container = 'className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10"'
  assert.equal((LIBRARY.split(container).length - 1), 2,
    'the preview and the library share one container spec')
})

test('WITHOUT THE PARAMETER THE APPROVED LAYOUT IS THE ORIGINAL MARKUP', () => {
  // Not a reconstruction of it: the hero, the steps and the library are still
  // the same elements, inside the false arm.
  for (const landmark of ['DeskScene', 'visible.map(', 'STEPS.map(', 'draftTally(']) {
    assert.ok(LIBRARY.includes(landmark), landmark)
  }
  assert.equal((LIBRARY.match(/<h1/g) ?? []).length, 1, 'one page title')
})

test('the sidebar reservation is untouched', () => {
  assert.match(LIBRARY, /sidebarCollapsed \? 'lg:ml-20' : 'lg:ml-64'/)
  assert.match(LIBRARY, /min-w-0 flex-1/)
  // And nothing in the new components reaches for it.
  for (const [name, source] of [['preview', PREVIEW], ['checklist', CHECKLIST]] as const) {
    assert.doesNotMatch(source, /SidebarContext|useSidebarCollapsed|lg:ml-|fixed inset-y/, name)
  }
})

// ===================================================== responsive behaviour

test('NOTHING IN THE PREVIEW CAN OVERFLOW ITS COLUMN', () => {
  // A fixed width, a min-width or a viewport width inside a max-w container is
  // how a card ends up wider than the page and brings a sideways scroll.
  for (const [name, source] of [['preview', PREVIEW], ['checklist', CHECKLIST]] as const) {
    assert.doesNotMatch(source, /\bw-\[\d|\bmin-w-\[\d|\bw-screen\b|\bmin-w-max\b/, name)
    assert.doesNotMatch(source, /overflow-x-visible|whitespace-nowrap/, name)
    assert.doesNotMatch(source, /\babsolute\b|\bfixed\b/, `${name} stays in flow`)
  }
})

test('the preview’s own wrappers add no width of their own', () => {
  // It inherits the column's max-width; a second max-w here would narrow it
  // again, which is what the old mx-auto max-w-6xl wrapper did.
  // THE ROOT ONLY. A max-w-* on a PARAGRAPH is a readable line length and is
  // wanted -- an earlier version of this test banned the class outright and
  // failed on max-w-2xl on the notice text, which is good typography rather
  // than a layout constraint.
  const rootOpen = PREVIEW.indexOf('<section')
  const root = PREVIEW.slice(rootOpen, PREVIEW.indexOf('>', rootOpen))
  assert.ok(root.length > 20, 'the root element was found')
  assert.doesNotMatch(root, /max-w-/)
  assert.doesNotMatch(PREVIEW, /mx-auto/)
})

test('every multi-column block collapses on a narrow viewport', () => {
  // Each grid/flex row that could squeeze must either wrap or be
  // single-column by default with a breakpoint for wider screens.
  const rows = [...CHECKLIST.matchAll(/className="([^"]*\b(?:flex|grid)\b[^"]*)"/g)]
    .map((m) => m[1]!)
  assert.ok(rows.length > 0)
  for (const row of rows) {
    const multiColumn = /\bgrid-cols-\d|\bflex\b(?![-\w])/.test(row)
    if (!multiColumn) continue
    const safe = row.includes('flex-wrap')
      || row.includes('grid-cols-1')
      || row.includes('flex-col')
      || !row.includes('grid-cols-')
    assert.ok(safe, `this row can squeeze on a narrow viewport: ${row}`)
  }
})

test('long school wording wraps rather than clipping', () => {
  // The prompt and the research text are the two long strings on screen.
  assert.match(CHECKLIST, /whitespace-pre-wrap/)
  assert.doesNotMatch(CHECKLIST, /truncate|text-ellipsis|overflow-hidden/)
})

// ===================================================== the demo controls

test('THE PREVIEW’S CONTROLS ARE VISIBLY NOT APPLICANT ACTIONS', () => {
  assert.match(PREVIEW, /demo: true/)
  assert.match(CHECKLIST, /actions\.demo === true \? 'Start \(preview only\)' : 'Start'/)
  // The demo button is NOT the blue primary.
  const demoBranch = CHECKLIST.slice(CHECKLIST.indexOf('className={actions.demo === true'))
  const firstArm = demoBranch.slice(0, demoBranch.indexOf(': \''))
  assert.match(firstArm, /border-dashed/)
  assert.doesNotMatch(firstArm, /bg-blue-600/)
})

test('a demo card offers no link to open, because there is nothing to open', () => {
  assert.match(CHECKLIST, /Continue \(preview only\)/)
  // It is a span, not an anchor to a dead href.
  const branch = CHECKLIST.slice(CHECKLIST.indexOf("actions.demo === true ? ("),
    CHECKLIST.indexOf('<a\n'))
  assert.match(branch, /<span/)
  assert.doesNotMatch(branch, /<a\b/)
})

test('THE DEMO DOES NOT CLAIM A DRAFT EXISTS', () => {
  assert.match(CHECKLIST, /No draft exists\./)
  // The real card still reports its real word count.
  assert.match(CHECKLIST, /words saved/)
})

test('the applicant-facing checklist keeps the primary button', () => {
  // demo defaults to undefined, so the New Draft dialog's cards are unchanged.
  assert.match(CHECKLIST, /readonly demo\?: boolean/)
  assert.doesNotMatch(CHECKLIST, /demo: true/, 'the component never sets it itself')
  const dialog = stripTs(read('../../../app/statement-studio/components/NewDraftDialog.tsx'))
  assert.doesNotMatch(dialog, /demo:/, 'the real creation flow passes no demo flag')
})

// ===================================================== still gated

test('THE PREVIEW IS STILL ADMIN-ONLY AND DEVELOPMENT-ONLY', () => {
  const page = stripTs(read('../../../app/statement-studio/page.tsx'))
  assert.match(page, /nodeEnv: process\.env\.NODE_ENV/)
  assert.match(page, /isAdmin: isAdminEmail\(auth\.email\)/)
  assert.match(page, /requested: requirementsPreviewRequested\(params\[PASTE_PREVIEW_PARAM\]\)/)
  assert.ok(page.indexOf('statementStudioAccess') < page.indexOf('requirementsPreview'))
  assert.match(LIBRARY, /requirementsPreview = false/)
})

test('THE PREVIEW STILL WRITES NOTHING AND CALLS NOTHING', () => {
  assert.doesNotMatch(PREVIEW, /fetch\(|\/api\/|createClient|supabase/i)
  // CALL SHAPES, NOT WORDS. `updatedAt` contains "update", and an earlier
  // version of this assertion failed on it -- reporting a write where there
  // was only a field name.
  assert.doesNotMatch(PREVIEW, /[.](insert|upsert|update|delete|rpc)[(]/)
  assert.match(PREVIEW, /setStarted\(\(current\)/, 'local state only')
})
