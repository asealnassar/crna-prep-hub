import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ImportReviewPanel from '../../../app/resume-studio/components/studio/ImportReviewPanel.tsx'
import {
  dismissImportItem, importItemsOf, placeImportItem, placementFor, placementGroups, suggestedPlacement,
} from './importItems.ts'
import type { ImportPlacement } from './importItems.ts'
import { applyPatch, applyPatches } from './patch.ts'
import type { StudioPatch } from './patch.ts'
import { parsePatch } from './parse.ts'
import { draftFromPlan } from '../import/draft.ts'
import { buildImportPlan, parseOrganised } from '../import/organise.ts'
import { sourceFromText } from '../import/source.ts'
import { V2_SCHEMA_VERSION, fromRows, toSavePayload } from '../repo/rows.ts'
import type { ResumeRow, SectionRow } from '../repo/rows.ts'
import { planDocument, textOf } from '../document/plan.ts'
import { docxContentLines } from '../export/docx.ts'
import { documentHtml } from '../export/pdf.ts'
import { isImportReviewSection, pendingImportItems } from '../model/importReview.ts'
import type { ClinicalPosition, CustomEntry, ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * "Imported items to review": what an import could not place, from creation to
 * the applicant's decision about each line.
 *
 * The promise the review screen makes is that nothing from their document is
 * lost -- so these follow the items through create, save and reload, check
 * they never reach a printed page, and check that only the applicant moves or
 * removes one.
 */

const NOW = '2026-09-17T09:00:00.000Z'
const LATER = '2026-09-17T09:05:00.000Z'
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const DOCUMENT = [
  'Morgan Avery, RN',
  'morgan.avery@example.test',
  'EXPERIENCE',
  'Harborview Heart Institute | Riverton, NJ',
  'Registered Nurse, Cardiothoracic ICU | Jan 2021 – Present',
  '• Titrate vasoactive and sedation infusions to hemodynamic goals',
  'Keystone Staffing Partners | Easton, NJ',
  'Travel ICU Nurse | Mar 2019 – Dec 2020',
  '• Completed contracts across three medical ICUs',
  'Unlisted Community Hospital | 2016 – 2018',
  '• Floated to the step-down unit during surges',
  'VOLUNTEER',
  'Free clinic triage volunteer, 2018',
  'EDUCATION',
  'Northfield University',
  'Nursing GPA: 3.8',
].join('\n')

const ORGANISED = parseOrganised({
  contact: { fullName: 'Morgan Avery', credentials: 'RN', email: 'morgan.avery@example.test' },
  summary: '',
  positions: [
    { employer: 'Harborview Heart Institute', role: 'Registered Nurse', unit: 'Cardiothoracic ICU', location: 'Riverton, NJ', dates: 'Jan 2021 – Present', bullets: [] },
    { employer: 'Keystone Staffing Partners', role: 'Travel ICU Nurse', unit: '', location: 'Easton, NJ', dates: 'Mar 2019 – Dec 2020', bullets: [] },
  ],
  education: [{ degree: '', field: '', institution: 'Northfield University', location: '', graduated: '' }],
  certifications: [], licenses: [], entries: [], unmapped: [],
})

const UNPLACED = [
  'Unlisted Community Hospital | 2016 – 2018',
  '• Floated to the step-down unit during surges',
  'Free clinic triage volunteer, 2018',
  'Nursing GPA: 3.8',
]

/** Create: what the import route builds, with UUIDs as the route issues them. */
function created(): ResumeV2 {
  return draftFromPlan({
    plan: buildImportPlan(ORGANISED, sourceFromText(DOCUMENT, 'pdf')),
    userId: 'u1',
    title: 'Imported resume',
    ids: { resumeId: U(9000), pool: Array.from({ length: 400 }, (_, i) => U(i + 1)) },
    now: NOW,
    importedFrom: { importId: U(9001), sourceFormat: 'pdf', documentFingerprint: 'f', importedAt: NOW, originalRetained: false },
  })
}

/** Save then reload: the rows create_resume_v2 / save_resume_v2 store, read back through JSON. */
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

const itemsOf = (resume: ResumeV2) => pendingImportItems(resume).map((item) => item.detail.accepted)
const positionsOf = (resume: ResumeV2): ClinicalPosition[] =>
  resume.sections.flatMap((s) => (s.type === 'critical_care' ? [...s.positions] : []))
const itemByText = (resume: ResumeV2, text: string): CustomEntry => {
  const item = pendingImportItems(resume).find((entry) => entry.detail.accepted === text)
  assert.ok(item, `no item "${text}"`)
  return item!
}
const reviewIdOf = (resume: ResumeV2) => importItemsOf(resume)!.reviewId

// --------------------------------------------------------------- 8: persistence

test('8: unresolved items survive create, save and reload, exactly as imported', () => {
  const resume = created()
  assert.deepEqual(itemsOf(resume), UNPLACED)

  const review = resume.sections.find(isImportReviewSection)
  assert.ok(review && review.type === 'custom')
  assert.equal(review.importReview, true)
  assert.equal(review.visible, false)
  for (const item of review.entries) {
    assert.equal(item.detail.originalSource, item.detail.accepted, 'the imported text was altered')
    assert.equal(item.detail.originalOrigin, 'import')
    assert.ok(item.importItem, 'where the item came from was not recorded')
  }

  // Reloaded: flag, text, provenance and suggestions all intact.
  const back = reloaded(resume)
  assert.deepEqual(back.sections.find(isImportReviewSection), review)

  // Saved again after an unrelated edit, and reloaded again: still all there.
  const edited = applyPatch(back, { op: 'contact', field: 'phone', value: '555-0188' }, { now: LATER })
  assert.deepEqual(itemsOf(reloaded(edited)), UNPLACED)

  // A placement is saved as a placement: the rest stay waiting after reload.
  const moved = applyPatch(edited, {
    op: 'import-item-dismiss', sectionId: reviewIdOf(edited), entryId: itemByText(edited, 'Nursing GPA: 3.8').id,
  }, { now: LATER })
  assert.deepEqual(itemsOf(reloaded(moved)), UNPLACED.slice(0, 3))
})

test('suggestions point where each line sat in the document', () => {
  const resume = created()
  const [header, bullet, volunteer, gpa] = pendingImportItems(resume)
  assert.deepEqual(header.importItem?.suggestion, { kind: 'none' })
  // Under a job the organiser did not recognise: a bullet, job left to the applicant.
  assert.deepEqual(bullet.importItem?.suggestion, { kind: 'bullet', positionId: null })
  assert.equal(suggestedPlacement(bullet, resume), '')
  assert.equal(suggestedPlacement(volunteer, resume), 'new:volunteer')
  const education = resume.sections.find((s) => s.type === 'education')!
  assert.equal(suggestedPlacement(gpa, resume), `section:${education.id}`)
})

// --------------------------------------------------------------- 9: never printed

test('9: unresolved items never reach the preview, the PDF or the Word file', async () => {
  const resume = created()
  // Even if the list were somehow made visible.
  const forced: ResumeV2 = {
    ...resume,
    sections: resume.sections.map((s) => (isImportReviewSection(s) ? ({ ...s, visible: true } as ResumeSectionV2) : s)),
  }
  for (const candidate of [resume, forced]) {
    const printed = [
      ...textOf(planDocument(candidate)),
      ...docxContentLines(candidate),
      await documentHtml(candidate),
    ].join('\n')
    for (const text of [...UNPLACED.map((line) => line.replace(/^• /, '')), 'Imported — needs review']) {
      assert.equal(printed.includes(text), false, `"${text}" was rendered`)
    }
    assert.ok(printed.includes('Harborview Heart Institute'), 'the resume itself did not render')
  }
})

// ------------------------------------------------------- 10-11: placing an item

test('10: an unresolved clinical bullet goes to the position the applicant chooses', () => {
  const resume = created()
  const item = itemByText(resume, '• Floated to the step-down unit during surges')
  const [harborview, keystone] = positionsOf(resume)
  const section = resume.sections.find((s) => s.type === 'critical_care')!

  // Not the first job: the one they picked.
  const placed = applyPatch(resume, {
    op: 'import-item-place', sectionId: reviewIdOf(resume), entryId: item.id,
    target: { kind: 'bullet', sectionId: section.id, positionId: keystone.id },
  }, { now: LATER })

  const [harborviewAfter, keystoneAfter] = positionsOf(placed)
  assert.deepEqual(harborviewAfter.bullets, harborview.bullets, 'another job was touched')
  assert.equal(keystoneAfter.bullets.length, keystone.bullets.length + 1)
  const bullet = keystoneAfter.bullets[keystoneAfter.bullets.length - 1]
  // The applicant's words, still marked imported -- without the extractor's
  // glyph, which the resume's own bullet would otherwise double.
  assert.equal(bullet.accepted, 'Floated to the step-down unit during surges')
  assert.equal(bullet.originalSource, 'Floated to the step-down unit during surges')
  assert.equal(bullet.originalOrigin, 'import')
  assert.equal(bullet.origin, 'import')
  // And it prints there now, once, as a bullet of that job.
  const printed = textOf(planDocument(placed))
  assert.ok(printed.includes('Floated to the step-down unit during surges'))
  assert.equal(printed.some((line) => line.startsWith('•')), false, 'a bullet glyph was printed as text')

  // A line with no glyph moves as the very object it was.
  const plain = itemByText(resume, 'Free clinic triage volunteer, 2018')
  const asBullet = placeImportItem(resume, reviewIdOf(resume), plain.id,
    { kind: 'bullet', sectionId: section.id, positionId: harborview.id }, LATER)
  assert.deepEqual(positionsOf(asBullet)[0].bullets.at(-1), plain.detail)
})

test('11: a placed item leaves the list, in the same edit that places it', () => {
  const resume = created()
  const reviewId = reviewIdOf(resume)
  const volunteer = itemByText(resume, 'Free clinic triage volunteer, 2018')

  const placed = placeImportItem(resume, reviewId, volunteer.id, {
    kind: 'entry', sectionType: 'volunteer', sectionId: U(7001), entryId: U(7002),
  }, LATER)
  assert.equal(placed.revision, resume.revision + 1, 'placing is one edit')
  assert.equal(itemsOf(placed).includes('Free clinic triage volunteer, 2018'), false)
  assert.equal(itemsOf(placed).length, UNPLACED.length - 1)
  const section = placed.sections.find((s) => s.id === U(7001))
  assert.ok(section && section.type === 'volunteer')
  assert.equal(section.entries[0].detail.accepted, 'Free clinic triage volunteer, 2018')
  assert.equal(section.entries[0].detail.originalOrigin, 'import')
  // A new section lands with the resume's sections, ahead of the list.
  assert.ok(placed.sections.indexOf(section) < placed.sections.findIndex(isImportReviewSection))

  // Into the summary: created when there is none, appended when there is one.
  const first = pendingImportItems(placed)[0]
  const summarised = placeImportItem(placed, reviewId, first.id, { kind: 'summary', sectionId: U(7003) }, LATER)
  const summary = summarised.sections[0]
  assert.ok(summary.type === 'summary')
  assert.equal(summary.text.accepted, 'Unlisted Community Hospital | 2016 – 2018')
  const second = pendingImportItems(summarised)[0]
  const appended = placeImportItem(summarised, reviewId, second.id, { kind: 'summary', sectionId: summary.id }, LATER)
  const appendedSummary = appended.sections[0]
  assert.ok(appendedSummary.type === 'summary')
  assert.equal(appendedSummary.text.accepted,
    'Unlisted Community Hospital | 2016 – 2018 Floated to the step-down unit during surges')
  assert.equal(appended.sections.filter((s) => s.type === 'summary').length, 1)

  // The last item placed takes the empty list with it.
  const last = pendingImportItems(appended)[0]
  const done = placeImportItem(appended, reviewId, last.id, {
    kind: 'entry', sectionType: 'education', sectionId: U(9999), entryId: U(7004),
  }, LATER)
  assert.equal(done.sections.some(isImportReviewSection), false)
  assert.equal(importItemsOf(done), null)
  const education = done.sections.filter((s) => s.type === 'education')
  assert.equal(education.length, 1, 'a second Education section was created')
})

// ------------------------------------------------------- 12: dismissing an item

test('12: only an explicit dismissal removes an item, and nothing else does', () => {
  const resume = created()
  const reviewId = reviewIdOf(resume)
  const critical = resume.sections.find((s) => s.type === 'critical_care')!
  const [harborview] = positionsOf(resume)

  // Ordinary editing, including of neighbouring sections, never touches the list.
  const ordinary: StudioPatch[] = [
    { op: 'title', value: 'Renamed' },
    { op: 'template', template: 'modern' },
    { op: 'contact', field: 'fullName', value: 'Morgan A. Avery' },
    { op: 'bullet-add', sectionId: critical.id, positionId: harborview.id },
    { op: 'section-move', sectionId: critical.id, toIndex: 0 },
    { op: 'section-visible', sectionId: critical.id, visible: false },
  ]
  assert.deepEqual(itemsOf(applyPatches(resume, ordinary, { now: LATER })), UNPLACED)

  // A placement that no longer adds up leaves everything as it was -- the item included.
  const item = pendingImportItems(resume)[1]
  const impossible: ImportPlacement[] = [
    { kind: 'bullet', sectionId: critical.id, positionId: U(8888) },
    { kind: 'bullet', sectionId: reviewId, positionId: harborview.id },
    { kind: 'summary', sectionId: critical.id },
    { kind: 'entry', sectionType: 'custom', sectionId: U(8889), entryId: U(8890) },
    { kind: 'entry', sectionType: 'volunteer', sectionId: critical.id, entryId: U(8891) },
  ]
  for (const target of impossible) {
    assert.equal(placeImportItem(resume, reviewId, item.id, target, LATER), resume, JSON.stringify(target))
  }

  // Dismissal removes the one item addressed, and only that one.
  const dismissed = dismissImportItem(resume, reviewId, item.id, LATER)
  assert.deepEqual(itemsOf(dismissed), UNPLACED.filter((_, i) => i !== 1))
  assert.equal(dismissImportItem(dismissed, reviewId, item.id, LATER), dismissed, 'a repeat dismissal changed something')
  // It cannot be aimed at an ordinary custom section's entries.
  assert.equal(dismissImportItem(resume, critical.id, item.id, LATER), resume)
})

test('the server accepts placements as ids only, and refuses anything else', () => {
  const typeOf = () => null
  const place = (target: unknown) => parsePatch({ op: 'import-item-place', sectionId: U(1), entryId: U(2), target }, typeOf)

  assert.deepEqual(place({ kind: 'bullet', sectionId: U(3), positionId: U(4) }), {
    op: 'import-item-place', sectionId: U(1), entryId: U(2), target: { kind: 'bullet', sectionId: U(3), positionId: U(4) },
  })
  assert.ok(place({ kind: 'summary', sectionId: U(3) }))
  assert.ok(place({ kind: 'entry', sectionType: 'certifications', sectionId: U(3), entryId: U(4) }))
  // Text never crosses the boundary: it is read from the stored item.
  const withText = place({ kind: 'summary', sectionId: U(3), text: 'Invented summary' })
  assert.deepEqual(withText && withText.op === 'import-item-place' ? withText.target : null, { kind: 'summary', sectionId: U(3) })

  for (const bad of [
    null, 'summary', { kind: 'bullet', sectionId: U(3) }, { kind: 'summary', sectionId: 'not-a-uuid' },
    { kind: 'entry', sectionType: 'summary', sectionId: U(3), entryId: U(4) },
    { kind: 'entry', sectionType: 'critical_care', sectionId: U(3), entryId: U(4) },
    { kind: 'teleport', sectionId: U(3) },
  ]) {
    assert.equal(place(bad), null, JSON.stringify(bad))
  }
  assert.ok(parsePatch({ op: 'import-item-dismiss', sectionId: U(1), entryId: U(2) }, typeOf))
  assert.equal(parsePatch({ op: 'import-item-dismiss', sectionId: U(1) }, typeOf), null)
})

test('the editor offers every real destination and resolves a stale one to nothing', () => {
  const resume = created()
  const groups = placementGroups(resume)
  const values = groups.flatMap((g) => g.options.map((o) => o.value))
  const critical = resume.sections.find((s) => s.type === 'critical_care')!
  for (const position of positionsOf(resume)) assert.ok(values.includes(`bullet:${critical.id}:${position.id}`))
  assert.ok(values.includes('summary'))
  assert.ok(values.includes('new:volunteer'))
  assert.equal(values.some((v) => v.includes(reviewIdOf(resume))), false, 'the list offered itself as a destination')

  let n = 5000
  const newId = () => U(n++)
  assert.deepEqual(placementFor(`bullet:${critical.id}:${U(4242)}`, resume, newId), null)
  assert.deepEqual(placementFor('new:volunteer', resume, newId), {
    kind: 'entry', sectionType: 'volunteer', sectionId: U(5000), entryId: U(5001),
  })
})

// ------------------------------------------------------------ the Studio itself

test('the panel renders every waiting line verbatim, with its suggestion pre-selected', () => {
  const resume = created()
  const render = (r: ResumeV2) => renderToStaticMarkup(createElement(ImportReviewPanel, {
    resume: r, newId: () => U(1), emit: () => {}, onFlush: () => {},
  }))
  const html = render(resume)
  assert.ok(html.includes('Imported items to review (4)'))
  assert.ok(html.includes('will not appear on your resume or in downloads until you place them'))
  for (const line of UNPLACED) {
    const escaped = line.replace(/&/g, '&amp;')
    assert.ok(html.includes(`>${escaped}</p>`), `"${line}" is not shown as imported`)
  }
  assert.equal((html.match(/>Place</g) ?? []).length, 4)
  assert.equal((html.match(/>Dismiss</g) ?? []).length, 4)
  // The volunteer line is pre-set to the section it sat under; nothing is placed until "Place".
  assert.match(html, /<option value="new:volunteer" selected="">/)
  assert.equal(html.includes('>Remove<'), false, 'a removal is offered before anyone asked to dismiss')

  // Nothing to review, no panel.
  let empty = resume
  for (const item of pendingImportItems(resume)) empty = dismissImportItem(empty, reviewIdOf(resume), item.id, LATER)
  assert.equal(render(empty), '')
})

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the editor shows the list as its own panel, never as a resume section', () => {
  const pane = source('../../../app/resume-studio/components/studio/EditorPane.tsx')
  assert.ok(pane.includes('<ImportReviewPanel'))
  assert.match(pane, /resume\.sections\.filter\(\(section\) => !isImportReviewSection\(section\)\)/)
  assert.match(pane, /\{sections\.map\(\(section, index\) => \(/)

  const panel = source('../../../app/resume-studio/components/studio/ImportReviewPanel.tsx')
  assert.ok(panel.includes('Imported items to review ({items.length})'))
  assert.match(panel, /if \(!found\) return null/)
})

test('12: dismissing takes a second, deliberate click in the editor', () => {
  const panel = source('../../../app/resume-studio/components/studio/ImportReviewPanel.tsx')
  // "Dismiss" only asks; the dismissal is sent from the confirmation's "Remove".
  assert.match(panel, /onClick=\{\(\) => setConfirming\(true\)\}>\s*Dismiss/)
  const dismissals = panel.match(/op: 'import-item-dismiss'/g) ?? []
  assert.equal(dismissals.length, 1)
  assert.match(panel, /\{confirming && \([\s\S]*onClick=\{onDismiss\}[\s\S]*Remove[\s\S]*Keep it/)
  assert.equal((panel.match(/onClick=\{onDismiss\}/g) ?? []).length, 1, 'dismissal is reachable other than by confirming')
})

test('the review screen describes what creating actually does', () => {
  const review = source('../../../app/resume-studio/components/import/ImportReview.tsx')
  assert.ok(review.includes('Imported items to review'))
  assert.equal(/hidden section/i.test(review), false, 'the review screen still promises a hidden section')
})
