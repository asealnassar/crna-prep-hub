import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  OUTPUT_LOCK_COPY, downloadNeedsUpgrade, isOutputLocked, protectComposedOutput, upgradeAfterLock,
} from './outputLock.ts'
import { applyPatch } from './patch.ts'
import { parsePatch } from './parse.ts'
import { previewLoaded } from './cardPreview.ts'
import { PreviewSurface } from '../../../app/resume-studio/components/dashboard/ResumePreview.tsx'
import UpgradeDialog from '../../../app/resume-studio/components/export/UpgradeDialog.tsx'
import {
  canExportDocx, canExportPdf, canFinalize, decideCreateResume, decideExport, resumeLimitFor,
} from '../entitlement.ts'
import { ULTIMATE_RESUME_BENEFITS, UPGRADE_HREF } from '../upgrade.ts'
import { createResume, emptyContact, lockResumeOutput } from '../model/resume.ts'
import { V2_SCHEMA_VERSION, fromRows, toSavePayload } from '../repo/rows.ts'
import type { ResumeRow, SectionRow } from '../repo/rows.ts'
import type { ResumeV2 } from '../model/types.ts'

/**
 * The locked model: everyone builds the whole resume, and Ultimate is what
 * takes the finished file away.
 *
 * The lock is not a tier flag. It is the answer the applicant gave at the
 * upgrade modal after pressing Download -- EITHER answer, "Not now" or
 * "Upgrade to Ultimate" -- and these check that nothing else sets it, that
 * Upgrade cannot leave the page before it is stored, that it survives a save,
 * and that Ultimate ignores it.
 *
 * Upgrade used to be an <a href> that navigated on the spot while only "Not
 * now" locked anything, so pressing it, declining to pay and coming back left
 * the finished resume fully readable. That is the bypass the regression test
 * at the end of this file reproduces end to end.
 */

const NOW = '2026-09-17T09:00:00.000Z'
const LATER = '2026-09-17T10:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

function sample(over: Partial<ResumeV2> = {}): ResumeV2 {
  const base = createResume({ id: 'r1', userId: 'u1', title: 'Duke application', sectionIds: ids(20), now: NOW })
  return { ...base, contact: { ...emptyContact(), fullName: 'Jordan Ellery' }, ...over }
}

/** Save, then read back, the way the repository does. */
function reloaded(resume: ResumeV2): ResumeV2 {
  const payload = JSON.parse(JSON.stringify(toSavePayload(resume))) as ReturnType<typeof toSavePayload>
  const row = {
    ...payload.resume, id: resume.id, user_id: resume.userId, schema_version: V2_SCHEMA_VERSION,
    revision: resume.revision, created_at: resume.createdAt, updated_at: LATER,
  } as unknown as ResumeRow
  const sections = payload.sections.map((s) => ({ ...s, resume_id: resume.id })) as unknown as SectionRow[]
  const { resume: back, issues } = fromRows(row, sections)
  assert.deepEqual(issues, [])
  assert.ok(back)
  return back!
}

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const exportMenu = () => source('../../../app/resume-studio/components/export/ExportMenu.tsx')
const dialog = () => source('../../../app/resume-studio/components/export/UpgradeDialog.tsx')
const studio = () => source('../../../app/resume-studio/components/studio/StudioClient.tsx')
const previewPane = () => source('../../../app/resume-studio/components/studio/PreviewPane.tsx')
const pdfRoute = () => source('../../../app/api/resume-v2/export/pdf/route.ts')
const docxRoute = () => source('../../../app/api/resume-v2/export/docx/route.ts')
const draftRoute = () => source('../../../app/api/resume-v2/draft/route.ts')
const importRoute = () => source('../../../app/api/resume-v2/import/route.ts')

// ------------------------------------------------------------------ 1-6: caps

test('1-5: one resume on Free and Premium, unlimited on Ultimate', () => {
  assert.equal(decideCreateResume({ tier: 'free', currentCount: 0 }).allowed, true)
  assert.equal(decideCreateResume({ tier: 'free', currentCount: 1 }).allowed, false)
  assert.equal(decideCreateResume({ tier: 'premium', currentCount: 0 }).allowed, true)
  assert.equal(decideCreateResume({ tier: 'premium', currentCount: 1 }).allowed, false)
  for (const count of [0, 1, 2, 40]) {
    assert.equal(decideCreateResume({ tier: 'ultimate', currentCount: count }).allowed, true, String(count))
  }
  // Deleting the one they have makes room again: the rule is a count, not a flag.
  assert.equal(decideCreateResume({ tier: 'free', currentCount: 0 }).allowed, true)
})

test('6: creating, duplicating and importing all count against the same limit', () => {
  const draft = draftRoute()
  const create = draft.slice(draft.indexOf("case 'create'"), draft.indexOf("case 'duplicate'"))
  const duplicate = draft.slice(draft.indexOf("case 'duplicate'"), draft.indexOf("case 'rename'"))
  for (const [name, branch] of [['create', create], ['duplicate', duplicate]] as const) {
    assert.match(branch, /const existing = await listResumes\(db, userId\)/, name)
    assert.match(branch, /decideCreateResume\(\{ tier, currentCount: existing\.value\.length \}\)/, name)
    assert.match(branch, /if \(!room\.allowed\) return refused\(room\)/, name)
  }
  // Import counts too, and refuses before anything is created.
  assert.match(importRoute(), /decideCreateResume\(\{ tier, currentCount: existing\.value\.length \}\)/)
  assert.match(importRoute(), /return NextResponse\.json\(\{ error: room\.code, message: room\.message \}, \{ status: 403 \}\)/)
})

// -------------------------------------------------- 7-10: building is not gated

test('7-9: before any download attempt, every tier sees the same clean preview', () => {
  const unlocked = sample()
  for (const tier of ['free', 'premium', 'ultimate']) {
    assert.equal(isOutputLocked(unlocked, tier), false, tier)
  }
  const pane = previewPane()
  // Blur and the overlay are conditional on the lock, never on the tier.
  assert.match(pane, /locked && 'pointer-events-none blur-\[7px\] saturate-50'/)
  assert.match(pane, /\{locked && \(/)
  // And the editor is not mentioned by any of it.
  assert.equal(/EditorPane/.test(pane), false)
})

test('8: the old preview watermark is gone from the Studio', () => {
  const code = `${studio()}\n${previewPane()}`
  for (const gone of ['PREVIEW_WATERMARK', 'needsPreviewWatermark', 'UPGRADE TO ULTIMATE TO FINALIZE', 'watermark=']) {
    assert.equal(code.includes(gone), false, `${gone} survives in the Studio`)
  }
  // The download control is the normal one for everyone, not a locked stand-in.
  const menu = exportMenu()
  assert.equal(/Upgrade to download/.test(menu), false, 'the button still asks for money before it is used')
  assert.equal(/canExportPdf/.test(menu), false, 'the control still branches on the tier')
})

test('10: the composed preview resists copying for a tier that cannot download', () => {
  assert.equal(protectComposedOutput('free'), true)
  assert.equal(protectComposedOutput('premium'), true)
  assert.equal(protectComposedOutput('ultimate'), false)
  const pane = previewPane()
  assert.match(pane, /onCopy=\{protectCopy \? block : undefined\}/)
  assert.match(pane, /onCut=\{protectCopy \? block : undefined\}/)
  assert.match(pane, /onContextMenu=\{protectCopy \? block : undefined\}/)
  assert.match(pane, /onDragStart=\{protectCopy \? block : undefined\}/)
  assert.match(pane, /protectCopy && 'select-none'/)
})

// --------------------------------------------------------- 11-14: downloading

test('11: Ultimate downloads exactly as before', () => {
  assert.equal(downloadNeedsUpgrade('ultimate'), false)
  assert.deepEqual(decideExport('ultimate'), { allowed: true })
  const menu = exportMenu()
  assert.match(menu, /if \(downloadNeedsUpgrade\(tier\)\) \{\s*setUpgrading\(true\)\s*return\s*\}\s*void download\(format\)/)
  assert.match(menu, /const res = await fetch\(ENDPOINTS\[format\]/)
})

test('12-13: a Free or Premium download attempt opens the modal and exports nothing', () => {
  for (const tier of ['free', 'premium']) {
    assert.equal(downloadNeedsUpgrade(tier), true, tier)
    assert.equal(decideExport(tier).allowed, false, tier)
  }
  // Both formats go through the same choice, so PDF and DOCX behave alike.
  const menu = exportMenu()
  assert.match(menu, /onSelect=\{\(\) => choose\(format\)\}/)
  assert.match(menu, /\(\['pdf', 'docx'\] as const\)/)
  // The gate returns before the request: nothing is fetched for these tiers.
  const choose = menu.slice(menu.indexOf('const choose ='), menu.indexOf('const blocked'))
  assert.equal(/fetch\(/.test(choose), false, 'a gated tier still reaches the network')
})

test('14: the modal offers the real upgrade flow, and claims only real benefits', () => {
  const html = renderToStaticMarkup(createElement(UpgradeDialog, {
    open: true, onNotNow: () => {}, onClose: () => {},
  }))
  assert.match(html, /Upgrade to Ultimate/)
  assert.match(html, /Your resume is ready\. Upgrade to Ultimate to download your finished resume\./)
  assert.match(html, /Not now/)
  // It reaches the one pricing flow -- but as a BUTTON, not a link, so the
  // answer is stored first. An href here would also carry middle-click and
  // cmd-click, which leave for /pricing without running any handler at all.
  assert.match(dialog(), /window\.location\.assign\(UPGRADE_HREF\)/, 'it does not use the pricing flow')
  assert.equal(html.includes(`href="${UPGRADE_HREF}"`), false, 'the upgrade action is a link again')
  assert.equal(/<a\s/.test(html), false, 'the dialog has a link that can skip the answer')

  // Every benefit is a rule this codebase enforces, for Ultimate and nobody else.
  const holds: Record<string, (tier: string) => boolean> = {
    'export-pdf': canExportPdf,
    'export-docx': canExportDocx,
    finalize: canFinalize,
    'resume-limit': (tier) => resumeLimitFor(tier) === null,
  }
  for (const benefit of ULTIMATE_RESUME_BENEFITS) {
    const rule = holds[benefit.gate]
    assert.ok(rule, `${benefit.gate} names no rule`)
    assert.equal(rule('ultimate'), true, benefit.label)
    assert.equal(rule('free'), false, benefit.label)
    assert.equal(rule('premium'), false, benefit.label)
    assert.ok(html.includes(benefit.label), benefit.label)
  }
})

// ------------------------------------------------------------- 15-24: the lock

test('15: answering the modal locks the finished resume, either way', () => {
  const locked = applyPatch(sample(), { op: 'output-lock' }, { now: LATER })
  assert.equal(locked.outputLockedAt, LATER)
  assert.equal(isOutputLocked(locked, 'free'), true)
  // ONE handler, wired to BOTH answers. "Not now" stays on the page, so it
  // emits and flushes; Upgrade leaves, so it waits for the queue to land.
  const code = studio()
  assert.match(code, /const lockOutput = useCallback\(\(\) => \{\s*emit\(\{ op: 'output-lock' \}\)\s*flush\(\)\s*\}/)
  assert.match(code, /onNotNow=\{lockOutput\}/)
  assert.match(code, /onUpgrade=\{lockOutputAndWait\}/)
  assert.match(code, /lockOutput\(\); return whenSettled\(\)/, 'Upgrade does not wait for the save')
  // The wait is the real autosave queue, not a second way to persist things.
  assert.equal(/fetch\(/.test(code.slice(code.indexOf('const lockOutput'))), false,
    'the lock got its own request path')
  // A second answer is not a second decision.
  assert.equal(applyPatch(locked, { op: 'output-lock' }, { now: '2026-10-01T00:00:00.000Z' }), locked)
  assert.equal(lockResumeOutput(locked, '2026-10-01T00:00:00.000Z').outputLockedAt, LATER)
})

test('16-18: Escape, the close button and a press outside do not lock anything', () => {
  const code = dialog()
  // Three separate props, and the dismissal is wired to neither answer.
  assert.match(code, /useDismiss\(open, \[panel\], onClose\)/, 'Escape and outside-press must call onClose')
  assert.match(code, /<IconButton icon=\{X\} label="Close"[^>]*onClick=\{onClose\}/)
  assert.match(code, /<Button variant="tertiary" onClick=\{onNotNow\} disabled=\{leaving\}>Not now<\/Button>/)
  assert.equal((code.match(/onNotNow/g) ?? []).length, 3, 'onNotNow is reachable from more than "Not now"')
  assert.equal((code.match(/onUpgrade/g) ?? []).length, 4, 'onUpgrade is reachable from more than Upgrade')
  // onClose does none of the locking, whatever route reaches it.
  const dismissals = code.match(/onClose[^\n]*/g) ?? []
  for (const line of dismissals) {
    assert.equal(/output-lock|onNotNow|onUpgrade|upgradeAfterLock/.test(line), false, line)
  }
  // And the menu only forwards the answers.
  assert.match(exportMenu(), /onClose=\{\(\) => setUpgrading\(false\)\}/)
  assert.match(exportMenu(), /onNotNow=\{\(\) => \{\s*setUpgrading\(false\)\s*onNotNow\?\.\(\)\s*\}\}/)
  assert.match(exportMenu(), /onUpgrade=\{onUpgrade\}/)
})

// ------------------------------------- the upgrade answer, and its ordering

test('the upgrade answer stores the lock BEFORE it leaves for pricing', async () => {
  const order: string[] = []
  const outcome = await upgradeAfterLock({
    lock: async () => { order.push('lock'); return true },
    navigate: () => { order.push('navigate') },
  })
  assert.equal(outcome, 'navigated')
  assert.deepEqual(order, ['lock', 'navigate'])
})

test('an upgrade whose lock did not save does not navigate at all', async () => {
  const landed: string[] = []
  const outcome = await upgradeAfterLock({
    lock: async () => false,
    navigate: () => landed.push(UPGRADE_HREF),
  })
  assert.equal(outcome, 'not-saved')
  assert.deepEqual(landed, [], 'it left for /pricing with the answer unsaved')
})

test('an upgrade whose save has not answered yet waits, rather than navigating', async () => {
  const landed: string[] = []
  let release: (saved: boolean) => void = () => {}
  const pending = upgradeAfterLock({
    lock: () => new Promise<boolean>((resolve) => { release = resolve }),
    navigate: () => landed.push(UPGRADE_HREF),
  })
  // Several turns of the event loop. The old implementation -- navigate now,
  // let the save catch up -- would have gone by this point, which is the bug.
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(landed, [], 'it navigated before the lock was stored')

  release(true)
  assert.equal(await pending, 'navigated')
  assert.deepEqual(landed, [UPGRADE_HREF])
})

test('19-20: a locked resume is unreadable, and still fully editable', () => {
  const locked = lockResumeOutput(sample(), LATER)
  assert.equal(isOutputLocked(locked, 'free'), true)
  const pane = previewPane()
  assert.match(pane, /blur-\[7px\]/)
  // The overlay says what it is and how to undo it, from one set of words the
  // Studio and the dashboard share.
  assert.equal(OUTPUT_LOCK_COPY.title, 'Your resume is ready to download')
  assert.equal(OUTPUT_LOCK_COPY.body, 'Upgrade to Ultimate to unlock your finished resume.')
  assert.equal(OUTPUT_LOCK_COPY.action, 'Upgrade to Ultimate')
  for (const part of ['title', 'body', 'action'] as const) {
    assert.ok(pane.includes(`OUTPUT_LOCK_COPY.${part}`), `the overlay is missing its ${part}`)
  }
  assert.ok(pane.includes('href={UPGRADE_HREF}'), 'the overlay offers no way to upgrade')

  // Editing goes on exactly as before: a lock changes no section, and the
  // editor is passed nothing about it.
  const edited = applyPatch(locked, { op: 'title', value: 'Duke — final' }, { now: LATER })
  assert.equal(edited.title, 'Duke — final')
  assert.equal(edited.outputLockedAt, LATER)
  assert.deepEqual(edited.sections, locked.sections)
  assert.equal(/locked/.test(source('../../../app/resume-studio/components/studio/EditorPane.tsx')), false)
})

test('21-22: the lock survives a save and a reload, without a migration', () => {
  const locked = lockResumeOutput(sample(), LATER)
  const back = reloaded(locked)
  assert.equal(back.outputLockedAt, LATER)
  assert.equal(isOutputLocked(back, 'free'), true)
  // Still there after an ordinary edit is saved on top of it.
  assert.equal(reloaded(applyPatch(back, { op: 'title', value: 'Renamed' }, { now: LATER })).outputLockedAt, LATER)

  // It rides in the reserved meta row -- a JSON payload beside the contact
  // block, not a new column.
  const rows = toSavePayload(locked).sections
  const meta = rows.find((row) => row.section_type === '__meta__')
  assert.ok(meta, 'nothing carries the lock')
  assert.deepEqual(meta!.section_data, { outputLockedAt: LATER })
  // A resume that was never locked writes no such row and reads back unlocked.
  assert.equal(toSavePayload(sample()).sections.some((row) => row.section_type === '__meta__'), false)
  assert.equal(reloaded(sample()).outputLockedAt, null)
})

test('23: a locked resume is obscured on the dashboard too', () => {
  const locked = lockResumeOutput(sample(), LATER)
  const state = previewLoaded(locked, 2)
  const free = renderToStaticMarkup(createElement(PreviewSurface, {
    state, template: 'classic', scale: 0.24, tier: 'free',
  }))
  assert.match(free, /data-preview-state="locked"/)
  assert.match(free, /blur-\[3px\]/)
  // Not the schematic: the card still shows this resume, it just cannot be read.
  assert.match(free, /rd-root/)

  const ultimate = renderToStaticMarkup(createElement(PreviewSurface, {
    state, template: 'classic', scale: 0.24, tier: 'ultimate',
  }))
  assert.match(ultimate, /data-preview-state="real"/)
  assert.equal(/blur-\[3px\]/.test(ultimate), false)
})

test('24: Ultimate ignores a stored lock entirely', () => {
  const locked = lockResumeOutput(sample(), LATER)
  assert.equal(isOutputLocked(locked, 'ultimate'), false)
  assert.equal(downloadNeedsUpgrade('ultimate'), false)
  assert.equal(protectComposedOutput('ultimate'), false)
  // The stored timestamp stays -- it is history -- and does nothing.
  assert.equal(reloaded(locked).outputLockedAt, LATER)
})

// --------------------------------------------------------- 25-28: the bypasses

test('25: the export routes refuse a gated tier themselves', () => {
  for (const [name, code] of [['pdf', pdfRoute()], ['docx', docxRoute()]] as const) {
    assert.match(code, /const entitled = decideExport\(auth\.tier\)/, name)
    assert.match(code, /if \(!entitled\.allowed\)/, name)
  }
  assert.equal(decideExport('free').allowed, false)
  assert.equal(decideExport('premium').allowed, false)
})

test('26: printing a gated preview does not produce the resume', () => {
  const pane = previewPane()
  assert.match(pane, /@media print \{/)
  assert.match(pane, /\[data-composed-output="protected"\] \{ display: none !important; \}/)
  // Only when the tier is gated, and only the document -- the rest of the page
  // prints as it would.
  assert.match(pane, /\{protectCopy && \(\s*<style/)
  assert.equal(/\* \{ display: none/.test(pane), false, 'the print rule reaches beyond the resume')
})

test('27-28: the composed document is protected, the editor is not', () => {
  const pane = previewPane()
  assert.match(pane, /data-composed-output=\{protectCopy \? 'protected' : 'open'\}/)
  // The protection is on the composed document only.
  const editor = source('../../../app/resume-studio/components/studio/EditorPane.tsx')
  for (const guard of ['select-none', 'onCopy', 'onContextMenu', 'onCut']) {
    assert.equal(editor.includes(guard), false, `the editor blocks ${guard}`)
  }
  const sections = source('../../../app/resume-studio/components/sections/SectionEditor.tsx')
  for (const guard of ['select-none', 'onCopy', 'onCut']) {
    assert.equal(sections.includes(guard), false, `a field blocks ${guard}`)
  }
})

test('REGRESSION: Upgrade, then /pricing, then back, does not reveal the resume', async () => {
  // The exact sequence reported from local testing: a Free applicant presses
  // Download, is shown the modal, presses "Upgrade to Ultimate", lands on
  // /pricing, thinks better of paying, and returns to Resume Studio.
  const database: ResumeV2[] = []
  const landed: string[] = []

  let inStudio = sample()
  assert.equal(isOutputLocked(inStudio, 'free'), false, 'something locked it before any answer')

  const outcome = await upgradeAfterLock({
    // What StudioClient does behind the button: apply the patch to the open
    // document, put it through the save, and report that it landed.
    lock: async () => {
      inStudio = applyPatch(inStudio, { op: 'output-lock' }, { now: LATER })
      database.push(reloaded(inStudio))
      return true
    },
    navigate: () => landed.push(UPGRADE_HREF),
  })

  assert.equal(outcome, 'navigated')
  assert.deepEqual(landed, [UPGRADE_HREF])
  assert.equal(database.length, 1, 'the answer never reached the database')

  // Coming back is a fresh read of the stored resume -- Back, a reload, a
  // direct visit and reopening it from the dashboard are all this read.
  const onReturn = database[0]
  assert.equal(onReturn.outputLockedAt, LATER)
  for (const tier of ['free', 'premium']) {
    assert.equal(isOutputLocked(onReturn, tier), true, `${tier} can still read the finished resume`)
  }

  // The dashboard card is the other way back in, and it is obscured too.
  const card = renderToStaticMarkup(createElement(PreviewSurface, {
    state: previewLoaded(onReturn, 2), template: 'classic', scale: 0.24, tier: 'free',
  }))
  assert.match(card, /data-preview-state="locked"/)
  assert.match(card, /blur-\[3px\]/)

  // The document itself is untouched: this locks the finished form, not the work.
  assert.deepEqual(onReturn.sections.map((s) => s.id), sample().sections.map((s) => s.id))
  assert.equal(onReturn.contact.fullName, 'Jordan Ellery')

  // And an Ultimate account reading the very same row is unaffected.
  assert.equal(isOutputLocked(onReturn, 'ultimate'), false)
})

test('the lock crosses the wire as an answer, carrying nothing', () => {
  assert.deepEqual(parsePatch({ op: 'output-lock' }, () => null), { op: 'output-lock' })
  // Nothing from the request survives: no timestamp, no resume id, no tier.
  assert.deepEqual(
    parsePatch({ op: 'output-lock', outputLockedAt: '1999-01-01T00:00:00.000Z', tier: 'ultimate' }, () => null),
    { op: 'output-lock' }
  )
})
