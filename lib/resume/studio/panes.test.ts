import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DESKTOP_MIN_WIDTH, initialPaneState, setViewport, showPane, togglePane,
  toggleLabel, viewportFor, visiblePanes,
} from './panes.ts'

const mobile = { viewport: 'mobile' as const, active: 'edit' as const }
const desktop = { viewport: 'desktop' as const, active: 'edit' as const }

test('the breakpoint decides the viewport', () => {
  assert.equal(viewportFor(DESKTOP_MIN_WIDTH), 'desktop')
  assert.equal(viewportFor(DESKTOP_MIN_WIDTH - 1), 'mobile')
  assert.equal(viewportFor(390), 'mobile')
  assert.equal(viewportFor(1440), 'desktop')
  assert.equal(viewportFor(0), 'mobile')
})

test('desktop shows the editor and the preview at once', () => {
  assert.deepEqual(visiblePanes(desktop), { edit: true, preview: true, toggleable: false })
})

test('desktop shows both regardless of which pane was last active', () => {
  assert.deepEqual(visiblePanes({ ...desktop, active: 'preview' }), {
    edit: true, preview: true, toggleable: false,
  })
})

test('mobile shows one pane and offers the toggle', () => {
  assert.deepEqual(visiblePanes(mobile), { edit: true, preview: false, toggleable: true })
  assert.deepEqual(visiblePanes(togglePane(mobile)), { edit: false, preview: true, toggleable: true })
})

test('the toggle alternates and returns', () => {
  const once = togglePane(mobile)
  assert.equal(once.active, 'preview')
  assert.equal(togglePane(once).active, 'edit')
})

test('every section stays editable on a phone — the editor is always reachable', () => {
  // Decision 13 as the user settled it: mobile is a layout answer, not a
  // reduced feature set. There must be no mobile state that can only preview.
  let state = mobile
  for (let i = 0; i < 6; i++) {
    const panes = visiblePanes(state)
    assert.ok(panes.edit || panes.toggleable, 'the editor became unreachable')
    state = togglePane(state)
  }
})

test('a new Studio opens on the editor', () => {
  assert.equal(initialPaneState(390).active, 'edit')
  assert.equal(initialPaneState(1440).active, 'edit')
  assert.equal(initialPaneState(390).viewport, 'mobile')
  assert.equal(initialPaneState(1440).viewport, 'desktop')
})

test('resizing does not lose the applicant’s place', () => {
  // A soft keyboard opening is a resize. Losing the pane would be its own bug.
  const onPreview = togglePane(mobile)
  const widened = setViewport(onPreview, 'desktop')
  assert.equal(widened.active, 'preview')
  assert.equal(setViewport(widened, 'mobile').active, 'preview')
})

test('setting the viewport it already has changes nothing', () => {
  assert.equal(setViewport(mobile, 'mobile'), mobile)
  assert.equal(setViewport(desktop, 'desktop'), desktop)
})

test('a pane can be selected directly, for the toggle’s two buttons', () => {
  assert.equal(showPane(mobile, 'preview').active, 'preview')
  assert.equal(showPane(mobile, 'edit').active, 'edit')
  assert.equal(showPane(mobile, 'edit'), mobile, 'selecting the current pane is a no-op')
})

test('the toggle names where it goes, not where it is', () => {
  assert.equal(toggleLabel(mobile), 'Preview')
  assert.equal(toggleLabel(togglePane(mobile)), 'Edit')
})

test('pane state is never mutated', () => {
  const before = JSON.stringify(mobile)
  togglePane(mobile)
  setViewport(mobile, 'desktop')
  showPane(mobile, 'preview')
  assert.equal(JSON.stringify(mobile), before)
})
