import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTACT_SECTION_TYPE, V2_SCHEMA_VERSION, contactRowId, fromRows, toSavePayload,
} from './rows.ts'
import type { ResumeRow, SectionRow } from './rows.ts'
import { DEFAULT_SECTION_TYPES, addSection, createResume, moveSection, setContact, setSectionVisibility } from '../model/resume.ts'
import { createSection } from '../model/sections.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { planDocument } from '../document/plan.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

const NOW = '2026-09-10T10:00:00.000Z'
const SAVED = '2026-09-10T12:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `sec-${i}`)

function newResume(): ResumeV2 {
  return createResume({
    id: 'r1', userId: 'u1', title: 'My Resume',
    sectionIds: ids(DEFAULT_SECTION_TYPES.length), now: NOW,
  })
}

/**
 * What the database holds after create_resume_v2 / save_resume_v2 have run.
 *
 * The write side is SQL now, so there is no TypeScript function to call here.
 * This models what those functions store -- payload fields as given, plus the
 * columns the SERVER sets: user_id, schema_version, revision and both
 * timestamps. That the SQL really does set exactly those is asserted
 * separately, against the migration text, in migration.test.ts.
 */
function storedBy(resume: ResumeV2, serverNow = SAVED): { row: ResumeRow; sections: SectionRow[] } {
  const payload = toSavePayload(resume)
  return {
    row: {
      ...payload.resume,
      id: resume.id,
      user_id: resume.userId,
      schema_version: V2_SCHEMA_VERSION,
      revision: resume.revision,
      created_at: resume.createdAt,
      updated_at: serverNow,
    } as unknown as ResumeRow,
    sections: payload.sections.map((row) => ({
      ...row,
      resume_id: resume.id,
      created_at: serverNow,
      updated_at: serverNow,
    })) as unknown as SectionRow[],
  }
}

/** Round-trips a resume through storage and back. */
function roundTrip(resume: ResumeV2): ResumeV2 {
  const { row, sections } = storedBy(resume)
  const { resume: back, issues } = fromRows(row, sections)
  assert.deepEqual(issues, [], 'a clean round trip reports no issues')
  assert.ok(back)
  return back!
}

// -------------------------------------------------------------- round trip

test('a resume survives the round trip intact', () => {
  const original = newResume()
  const back = roundTrip(original)
  assert.equal(back.id, original.id)
  assert.equal(back.userId, original.userId)
  assert.equal(back.title, original.title)
  assert.equal(back.template, original.template)
  assert.equal(back.status, original.status)
  assert.equal(back.revision, original.revision)
  assert.equal(back.schemaVersion, 2)
  assert.deepEqual(back.sections.map((s) => s.type), original.sections.map((s) => s.type))
})

test('section content survives, including authored text provenance', () => {
  const original = newResume()
  const summary = original.sections.find((s) => s.type === 'summary')!
  const withText: ResumeV2 = {
    ...original,
    sections: original.sections.map((s) =>
      s.id === summary.id ? ({ ...s, text: createAuthoredText('imported line', 'import') } as ResumeSectionV2) : s
    ),
  }
  const back = roundTrip(withText)
  const restored = back.sections.find((s) => s.type === 'summary')
  assert.ok(restored && restored.type === 'summary')
  if (restored?.type !== 'summary') return
  assert.equal(restored.text.accepted, 'imported line')
  assert.equal(restored.text.originalOrigin, 'import', 'provenance is not flattened')
  assert.equal(restored.text.originalSource, 'imported line')
})

test('the contact block round-trips without needing columns', () => {
  const original = setContact(newResume(), {
    fullName: 'A. Nurse', credentials: 'RN, BSN, CCRN', email: 'a@example.com',
    phone: '555-0100', city: 'Sacramento', state: 'CA', linkedin: '', website: '',
  }, SAVED)
  const back = roundTrip(original)
  assert.equal(back.contact.fullName, 'A. Nurse')
  assert.equal(back.contact.credentials, 'RN, BSN, CCRN')
  assert.equal(back.contact.linkedin, '', 'empty fields survive as empty, not missing')
})

// ------------------------------------------------------------------ order

test('display order is written to order_index from array position', () => {
  const resume = newResume()
  const rows = storedBy(resume).sections
  const real = rows.filter((r) => r.section_type !== CONTACT_SECTION_TYPE)
  assert.deepEqual(real.map((r) => r.order_index), real.map((_, i) => i))
})

test('a reorder is persisted and read back in the new order', () => {
  const resume = newResume()
  const movedId = resume.sections[4].id
  const reordered = moveSection(resume, movedId, 0, SAVED)
  const back = roundTrip(reordered)
  assert.equal(back.sections[0].id, movedId)
  assert.deepEqual(back.sections.map((s) => s.id), reordered.sections.map((s) => s.id))
})

test('rows arriving out of order are sorted by order_index, not by arrival', () => {
  const resume = newResume()
  const rows = storedBy(resume).sections
  const shuffled = [...rows].reverse()
  const { resume: back } = fromRows(
    storedBy(resume).row, shuffled
  )
  assert.deepEqual(back?.sections.map((s) => s.type), resume.sections.map((s) => s.type))
})

test('the contact row sorts ahead of every section and never becomes one', () => {
  const rows = storedBy(newResume()).sections
  const contact = rows.find((r) => r.section_type === CONTACT_SECTION_TYPE)!
  assert.equal(contact.order_index, -1)
  const back = roundTrip(newResume())
  assert.ok(!back.sections.some((s) => (s.type as string) === CONTACT_SECTION_TYPE))
})

test('the contact row id is deterministic so it upserts rather than duplicating', () => {
  const resume = newResume()
  const a = storedBy(resume).sections.find((r) => r.section_type === CONTACT_SECTION_TYPE)
  const b = storedBy(resume).sections.find((r) => r.section_type === CONTACT_SECTION_TYPE)
  assert.equal(a?.id, b?.id)
  assert.equal(a?.id, contactRowId(resume.id))
})

// ------------------------------------------------------------ visibility

test('hidden sections round-trip as hidden, keeping their data', () => {
  const resume = newResume()
  const hidden = setSectionVisibility(resume, resume.sections[1].id, false, SAVED)
  const back = roundTrip(hidden)
  assert.equal(back.sections[1].visible, false)
  assert.equal(back.sections.length, resume.sections.length, 'nothing dropped')
})

test('a null visible column reads as visible, so V1 rows are not hidden', () => {
  const resume = newResume()
  const rows = storedBy(resume).sections
  const nulled = rows.map((r) => ({ ...r, visible: null }))
  const { resume: back } = fromRows(storedBy(resume).row, nulled)
  assert.ok(back!.sections.every((s) => s.visible), 'defaults to visible')
})

test('a custom label round-trips, and its absence stays null', () => {
  const resume = addSection(newResume(), 'custom', 'c1', SAVED, { label: 'Military Service' })
  const back = roundTrip(resume)
  const custom = back.sections.find((s) => s.id === 'c1')!
  assert.equal(custom.label, 'Military Service')
  assert.equal(back.sections[0].label, null, 'unlabelled stays null, not empty string')
})

/** A stored resume whose summary row carries a label saved before the heading was fixed. */
function storedWithSummaryLabel(label: string): { row: ResumeRow; sections: SectionRow[] } {
  const resume = newResume()
  const written: ResumeV2 = {
    ...resume,
    sections: resume.sections.map((s) =>
      s.type === 'summary'
        ? ({ ...s, text: createAuthoredText('Six years in a medical ICU.') } as ResumeSectionV2)
        : s
    ),
  }
  const { row, sections } = storedBy(written)
  return { row, sections: sections.map((r) => (r.section_type === 'summary' ? { ...r, label } : r)) }
}

test('a stored summary label is read back and written back untouched', () => {
  // Fixing the heading is a rendering rule, not a data migration: the value
  // stays in the row, and saving the resume sends it back exactly as it was.
  const { row, sections } = storedWithSummaryLabel('About Me')
  const { resume: back } = fromRows(row, sections)
  assert.equal(back!.sections.find((s) => s.type === 'summary')!.label, 'About Me', 'dropped on read')
  const saved = toSavePayload(back!).sections.find((r) => r.section_type === 'summary')!
  assert.equal(saved.label, 'About Me', 'rewritten on save')
})

test('a stored summary label never reaches the rendered heading', () => {
  const { row, sections } = storedWithSummaryLabel('About Me')
  const { resume: back } = fromRows(row, sections)
  const block = planDocument(back!).blocks.find((b) => b.sectionType === 'summary')
  assert.equal(block?.heading, 'Professional Summary')
})

// -------------------------------------------------- generation separation

test('a V1 row is not readable as V2 and is reported, not guessed at', () => {
  const row = { ...(storedBy(newResume()).row), schema_version: 1 }
  const { resume, issues } = fromRows(row, [])
  assert.equal(resume, null, 'V2 does not read V1 rows')
  assert.equal(issues[0]?.kind, 'wrong-schema-version')
  assert.match(issues[0]!.detail, /schema_version=1/)
})

test('a missing schema_version reads as V1, not as V2', () => {
  const row = { ...(storedBy(newResume()).row), schema_version: null }
  assert.equal(fromRows(row, []).resume, null)
})

test('the client cannot choose the generation marker', () => {
  // create_resume_v2 hardcodes schema_version = 2 and the payload has no say.
  // That the SQL really does so is asserted in migration.test.ts.
  const { resume: parent } = toSavePayload(newResume())
  assert.ok(!('schema_version' in parent))
  assert.equal(V2_SCHEMA_VERSION, 2)
})

test('a null resume row yields nothing without throwing', () => {
  const { resume, issues } = fromRows(null, [])
  assert.equal(resume, null)
  assert.deepEqual(issues, [])
})

// ------------------------------------------------------- malformed rows

test('an unknown section type is dropped and reported, never rendered blank', () => {
  const resume = newResume()
  const rows = storedBy(resume).sections
  const withJunk: SectionRow[] = [
    ...rows,
    { id: 'junk', resume_id: 'r1', section_type: 'not_a_real_type', section_data: {}, order_index: 99, visible: true, label: null },
  ]
  const { resume: back, issues } = fromRows(storedBy(resume).row, withJunk)
  assert.equal(back?.sections.length, resume.sections.length, 'the junk row is not a section')
  assert.equal(issues[0]?.kind, 'unknown-section-type')
  assert.equal(issues[0]?.detail, 'not_a_real_type')
})

test('a malformed payload is dropped and reported rather than becoming an empty section', () => {
  const resume = newResume()
  const rows = storedBy(resume).sections
  const broken = rows.map((r, i) => (i === 0 ? { ...r, section_data: 'not an object' } : r))
  const { resume: back, issues } = fromRows(storedBy(resume).row, broken)
  assert.equal(back?.sections.length, resume.sections.length - 1)
  assert.ok(issues.some((x) => x.kind === 'malformed-payload'))
})

test('null and array payloads are treated as malformed, not as objects', () => {
  const resume = newResume()
  const base = storedBy(resume).row
  for (const payload of [null, [], 42]) {
    const rows: SectionRow[] = [
      { id: 's', resume_id: 'r1', section_type: 'summary', section_data: payload, order_index: 0, visible: true, label: null },
    ]
    const { resume: back, issues } = fromRows(base, rows)
    assert.equal(back?.sections.length, 0, JSON.stringify(payload))
    assert.equal(issues[0]?.kind, 'malformed-payload')
  }
})

test('a malformed contact payload leaves an empty contact rather than throwing', () => {
  const resume = newResume()
  const rows: SectionRow[] = [
    { id: 'r1', resume_id: 'r1', section_type: CONTACT_SECTION_TYPE, section_data: 'broken', order_index: -1, visible: true, label: null },
  ]
  const { resume: back, issues } = fromRows(storedBy(resume).row, rows)
  assert.equal(back?.contact.fullName, '')
  assert.ok(issues.some((x) => x.kind === 'malformed-payload' && x.detail === 'contact'))
})

// -------------------------------------------------------------- defaults

test('an unrecognised template or status falls back rather than failing', () => {
  const row = {
    ...(storedBy(newResume()).row),
    template_id: 'creative', status: 'archived',
  }
  const { resume: back } = fromRows(row, [])
  assert.equal(back?.template, 'classic', 'retired templates do not survive as values')
  assert.equal(back?.status, 'draft')
})

test('revision is never read below 1', () => {
  const base = storedBy(newResume()).row
  for (const value of [0, -5, null, 'nonsense']) {
    const { resume: back } = fromRows({ ...base, revision: value as never }, [])
    assert.ok((back?.revision ?? 0) >= 1, String(value))
  }
})

test('an absent strength score reads as null, not as zero', () => {
  const base = storedBy(newResume()).row
  assert.equal(fromRows(base, []).resume?.strength, null)
  const scored = { ...base, strength_score: 0, strength_revision: 4, strength_computed_at: NOW }
  assert.equal(fromRows(scored, []).resume?.strength?.score, 0, 'a real zero is kept')
})

// ------------------------------------------------------------ updated_at

test('updated_at is the server’s to set, and the client cannot send one', () => {
  // No trigger maintains it, so both RPCs stamp now() themselves -- which also
  // means a client cannot backdate a save or drift on a skewed clock.
  const { resume: parent, sections } = toSavePayload(newResume())
  assert.ok(!('updated_at' in parent))
  for (const row of sections) assert.ok(!('updated_at' in row), String(row.section_type))
})

test('a stored updated_at is read back exactly as the server wrote it', () => {
  const back = fromRows(storedBy(newResume(), '2027-04-01T00:00:00.000Z').row, [])
  assert.equal(back.resume?.updatedAt, '2027-04-01T00:00:00.000Z')
})

test('all fifteen section types survive the round trip', () => {
  let resume = newResume()
  const present = new Set(resume.sections.map((s) => s.type))
  let i = 0
  for (const type of ['other_clinical', 'quality_improvement', 'research', 'organizations',
    'awards', 'volunteer', 'publications', 'custom'] as const) {
    if (present.has(type)) continue
    resume = addSection(resume, type, `extra-${i++}`, SAVED)
  }
  const back = roundTrip(resume)
  assert.equal(new Set(back.sections.map((s) => s.type)).size, 15)
  assert.deepEqual(back.sections.map((s) => s.type), resume.sections.map((s) => s.type))
})

test('mapping never mutates the resume it is given', () => {
  const resume = newResume()
  const snapshot = JSON.stringify(resume)
  toSavePayload(resume)
  const { row, sections } = storedBy(resume)
  fromRows(row, sections)
  assert.equal(JSON.stringify(resume), snapshot)
})

// ------------------------------------------------------- RPC save payload

test('the save payload omits every server-authoritative field', () => {
  const { resume: parent, sections } = toSavePayload(newResume())
  // The function stamps these itself; a client must not be able to set them.
  for (const key of ['revision', 'updated_at', 'created_at', 'id', 'user_id', 'schema_version']) {
    assert.ok(!(key in parent), `parent payload must not carry ${key}`)
  }
  for (const row of sections) {
    for (const key of ['resume_id', 'updated_at', 'created_at']) {
      assert.ok(!(key in row), `section payload must not carry ${key}`)
    }
  }
})

test('the save payload carries what the function needs and nothing more', () => {
  const { resume: parent } = toSavePayload(newResume())
  assert.deepEqual(Object.keys(parent).sort(), [
    'status', 'strength_computed_at', 'strength_revision', 'strength_score',
    'template_id', 'title',
  ])
})

test('save payload section order matches array position', () => {
  const resume = moveSection(newResume(), newResume().sections[3].id, 0, SAVED)
  const { sections } = toSavePayload(resume)
  const real = sections.filter((r) => r.section_type !== CONTACT_SECTION_TYPE)
  assert.deepEqual(real.map((r) => r.order_index), real.map((_, i) => i))
})

test('the contact row rides in the save payload with a fixed position', () => {
  const { sections } = toSavePayload(newResume())
  const contact = sections.find((r) => r.section_type === CONTACT_SECTION_TYPE)
  assert.ok(contact, 'contact is part of the same atomic write')
  assert.equal(contact!.order_index, -1)
  assert.equal(contact!.id, contactRowId('r1'))
})

test('a strength score is sent as null when absent, not omitted', () => {
  const { resume: parent } = toSavePayload(newResume())
  assert.equal(parent.strength_score, null)
  assert.equal(parent.strength_revision, null)
})

test('a section created but never populated still round-trips', () => {
  const empty = createSection('awards', 'a1')
  const resume: ResumeV2 = { ...newResume(), sections: [empty] }
  const back = roundTrip(resume)
  assert.equal(back.sections.length, 1)
  assert.equal(back.sections[0].type, 'awards')
})
