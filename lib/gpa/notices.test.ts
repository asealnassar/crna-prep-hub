import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scopedTo, noticeFor, belongsTo, dropIfForeign } from './notices.ts'

const HARBOR = 'a-harbor'
const COMBINED = 'a-meridian-ridgeview'

/** The exact notice that leaked across analyses during UAT. */
const harborImport = () => scopedTo(HARBOR, {
  title: 'Transcript analyzed',
  lines: ['Created “HARBOR MEDICAL UNIVERSITY” with 7 course(s). Your original analyses are unchanged.'],
})

/** A model of the page's transient notice state, exercised the way it runs. */
function workspace() {
  let current: string | null = null
  let importNote = null as ReturnType<typeof harborImport>
  let combineNotice: ReturnType<typeof scopedTo<string>> = null

  /** The effect that runs whenever the open analysis changes. */
  const onSwitch = () => {
    importNote = dropIfForeign(importNote, current)
    combineNotice = dropIfForeign(combineNotice, current)
  }
  return {
    open(id: string) { current = id; onSwitch() },
    importInto(id: string, value: NonNullable<ReturnType<typeof harborImport>>['value']) {
      importNote = scopedTo(id, value)
    },
    combineInto(id: string, message: string) {
      // What the page does: the new analysis is created and selected, the
      // switch effect runs, and only then is the notice posted.
      current = id
      onSwitch()
      combineNotice = scopedTo(id, message)
    },
    visible() {
      return {
        importNote: noticeFor(importNote, current),
        combineNotice: noticeFor(combineNotice, current),
      }
    },
  }
}

// ------------------------------------------------------------ the mechanism
test('D54: a notice records the analysis it is about', () => {
  const n = scopedTo(HARBOR, 7)
  assert.equal(n!.analysisId, HARBOR)
  assert.equal(n!.value, 7)
  assert.equal(belongsTo(n, HARBOR), true)
  assert.equal(belongsTo(n, COMBINED), false)
})

test('D54: a notice with no analysis is never shown', () => {
  assert.equal(scopedTo(null, 'x'), null)
  assert.equal(scopedTo('', 'x'), null)
  assert.equal(scopedTo('   ', 'x'), null)
  assert.equal(noticeFor(null, HARBOR), null)
})

test('D54: a notice is only rendered on its own analysis', () => {
  const n = scopedTo(HARBOR, 'Created “HARBOR MEDICAL UNIVERSITY” with 7 course(s).')
  assert.match(noticeFor(n, HARBOR)!, /HARBOR MEDICAL/)
  assert.equal(noticeFor(n, COMBINED), null)
  assert.equal(noticeFor(n, null), null)
})

test('D54: moving away drops it; staying keeps the very same object', () => {
  const n = scopedTo(HARBOR, 7)
  assert.equal(dropIfForeign(n, COMBINED), null)
  assert.equal(dropIfForeign(n, HARBOR), n, 'no pointless state write on every switch')
  assert.equal(dropIfForeign(null, HARBOR), null)
})

// -------------------------------------------------------- the reported bug
test('D54: importing A shows A’s notice', () => {
  const w = workspace()
  w.open(HARBOR)
  w.importInto(HARBOR, harborImport()!.value)
  assert.match(w.visible().importNote!.lines[0], /HARBOR MEDICAL UNIVERSITY/)
})

test('D54: switching to another analysis leaves that notice behind', () => {
  const w = workspace()
  w.open(HARBOR)
  w.importInto(HARBOR, harborImport()!.value)
  w.open(COMBINED)
  assert.equal(w.visible().importNote, null)
})

test('D54: combining shows the NEW analysis’s notice, not the old import', () => {
  // The reported sequence: import Harbor, then combine two other transcripts.
  const w = workspace()
  w.open(HARBOR)
  w.importInto(HARBOR, harborImport()!.value)
  w.combineInto(COMBINED,
    'Created “MERIDIAN + RIDGEVIEW” with 47 course(s). Your original analyses are unchanged.')

  const seen = w.visible()
  assert.equal(seen.importNote, null, 'Harbor’s 7-course notice is gone')
  assert.match(seen.combineNotice!, /MERIDIAN \+ RIDGEVIEW.*47 course/)
  assert.ok(!/HARBOR|\b7 course/.test(seen.combineNotice!))
})

test('D54: switching back does not resurrect the old notice', () => {
  const w = workspace()
  w.open(HARBOR)
  w.importInto(HARBOR, harborImport()!.value)
  w.combineInto(COMBINED, 'Created “MERIDIAN + RIDGEVIEW” with 47 course(s).')
  w.open(HARBOR)
  assert.equal(w.visible().importNote, null, 'read once, left behind for good')
  assert.equal(w.visible().combineNotice, null, 'and the combine notice does not follow either')
})

test('D54: a new import on the analysis in hand still shows', () => {
  const w = workspace()
  w.open(HARBOR)
  w.importInto(HARBOR, harborImport()!.value)
  w.open(COMBINED)
  assert.equal(w.visible().importNote, null)
  w.importInto(COMBINED, { title: 'Transcript analyzed', lines: ['Created “RIDGEVIEW” with 12 course(s).'] })
  assert.match(w.visible().importNote!.lines[0], /RIDGEVIEW.*12 course/)
})

test('D54: a fresh page shows no notice for any analysis', () => {
  // Nothing transient is persisted, so a reload starts silent.
  const w = workspace()
  w.open(HARBOR)
  assert.deepEqual(w.visible(), { importNote: null, combineNotice: null })
  w.open(COMBINED)
  assert.deepEqual(w.visible(), { importNote: null, combineNotice: null })
})

test('D54: a notice written while another analysis was open never flashes in', () => {
  // Defence against an async write landing after the user has already moved.
  const w = workspace()
  w.open(COMBINED)
  w.importInto(HARBOR, harborImport()!.value)
  assert.equal(w.visible().importNote, null, 'scoping catches it even before any switch')
})

// ------------------------------------------------------------- the wiring
const PAGE = path.join(process.cwd(), 'app/gpa-calculator/page.tsx')
const pageCode = () => fs.readFileSync(PAGE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('D54: every transient notice is scoped when written', () => {
  const code = pageCode()
  for (const setter of ['setImportFlash(', 'setImportNote(', 'setCombineNotice(', 'setImportReview(']) {
    const writes = code.split(setter).slice(1)
      .map(rest => rest.slice(0, 40))
      // The clearing forms are not scoped writes.
      .filter(rest => !/^(null\)|n =>)/.test(rest.trim()))
    assert.ok(writes.length > 0, setter)
    for (const w of writes) {
      assert.ok(/scopedTo\(|pendingReview \?/.test(w), `${setter}${w}`)
    }
  }
})

test('D54: every transient notice is gated on the analysis when rendered', () => {
  const code = pageCode()
  for (const state of ['importFlash', 'importNote', 'combineNotice', 'importReview']) {
    assert.match(code, new RegExp(`noticeFor\\(${state}, currentId\\)`), state)
  }
  // And none is rendered by reaching into the wrapper directly.
  assert.ok(!/\{importNote\.(title|lines)/.test(code))
  assert.ok(!/\{combineNotice\}/.test(code))
  assert.ok(!/\{importReview\.(message|checks)/.test(code))
})

test('D54: switching analyses drops foreign notices', () => {
  const code = pageCode()
  const effect = code.slice(code.indexOf('setImportFlash(n => dropIfForeign'))
    .slice(0, 400)
  for (const state of ['setImportFlash', 'setImportNote', 'setCombineNotice',
                       'setImportReview', 'setScaleNotes']) {
    assert.ok(effect.includes(`${state}(n => dropIfForeign(n, currentId))`), state)
  }
  assert.match(code, /setScaleNotes\(n => dropIfForeign\(n, currentId\)\)\s*\n\s*\}, \[currentId\]\)/)
})
