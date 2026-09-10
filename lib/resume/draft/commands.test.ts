import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TITLE, MAX_BODY_BYTES, MAX_TITLE, duplicateTitle, normaliseTitle,
  parseCommand, planDuplicate,
} from './commands.ts'
import { createResume } from '../model/resume.ts'
import { setContact, setTitle } from '../model/resume.ts'
import type { ResumeV2 } from '../model/types.ts'

const NOW = '2026-09-10T12:00:00.000Z'
const LATER = '2026-09-11T09:30:00.000Z'
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

const sectionIds = (prefix: string, n = 12) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`)

function sample(userId = 'user-1'): ResumeV2 {
  return createResume({
    id: ID_A, userId, title: 'Duke application', sectionIds: sectionIds('s'), now: NOW,
  })
}

// ------------------------------------------------------------- parsing

test('a non-object body is refused', () => {
  for (const body of [null, undefined, 42, 'create', [], true]) {
    assert.equal(parseCommand(body).ok, false, JSON.stringify(body) ?? 'undefined')
  }
})

test('an unknown action is refused rather than defaulted', () => {
  const r = parseCommand({ action: 'drop-table' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /Unknown action/)
})

test('create accepts a title and falls back when it is blank', () => {
  const named = parseCommand({ action: 'create', title: '  Emory  CRNA ' })
  assert.deepEqual(named, { ok: true, command: { kind: 'create', title: 'Emory CRNA' } })

  for (const title of ['', '   ', null, 42, undefined]) {
    const r = parseCommand({ action: 'create', title })
    assert.equal(r.ok, true)
    if (r.ok && r.command.kind === 'create') assert.equal(r.command.title, DEFAULT_TITLE)
  }
})

test('a title is capped and never left as whitespace', () => {
  const long = 'x'.repeat(500)
  const r = parseCommand({ action: 'create', title: long })
  assert.equal(r.ok, true)
  if (r.ok && r.command.kind === 'create') assert.equal(r.command.title.length, MAX_TITLE)
  assert.equal(normaliseTitle('\n\t  \n'), DEFAULT_TITLE)
})

test('ids must look like ids', () => {
  for (const id of ['', 'abc', '1234', ID_A.slice(0, -1), 42, null, `${ID_A} or 1=1`]) {
    assert.equal(parseCommand({ action: 'delete', id }).ok, false, String(id))
  }
  assert.equal(parseCommand({ action: 'delete', id: ID_A }).ok, true)
  assert.equal(parseCommand({ action: 'delete', id: ID_A.toUpperCase() }).ok, true)
})

test('rename requires a valid revision and will not coerce a string', () => {
  const base = { action: 'rename', id: ID_A, title: 'New name' }
  for (const rev of ['3', 0, -1, 1.5, null, undefined, NaN, '']) {
    assert.equal(parseCommand({ ...base, expectedRevision: rev }).ok, false, String(rev))
  }
  const r = parseCommand({ ...base, expectedRevision: 3 })
  assert.deepEqual(r, {
    ok: true,
    command: { kind: 'rename', id: ID_A, title: 'New name', expectedRevision: 3 },
  })
})

test('set-status accepts only the two statuses the constraint allows', () => {
  const base = { action: 'set-status', id: ID_A, expectedRevision: 2 }
  for (const status of ['published', 'DRAFT', '', null, 1, 'archived']) {
    assert.equal(parseCommand({ ...base, status }).ok, false, String(status))
  }
  for (const status of ['draft', 'complete']) {
    const r = parseCommand({ ...base, status })
    assert.equal(r.ok, true, status)
    if (r.ok && r.command.kind === 'set-status') assert.equal(r.command.status, status)
  }
})

test('duplicate requires a valid source id', () => {
  assert.equal(parseCommand({ action: 'duplicate' }).ok, false)
  assert.equal(parseCommand({ action: 'duplicate', sourceId: 'nope' }).ok, false)
  assert.deepEqual(parseCommand({ action: 'duplicate', sourceId: ID_A }), {
    ok: true, command: { kind: 'duplicate', sourceId: ID_A },
  })
})

test('extra fields in a body are ignored, not trusted', () => {
  const r = parseCommand({
    action: 'rename', id: ID_A, title: 'Fine', expectedRevision: 1,
    user_id: 'someone-else', revision: 999, schema_version: 1,
  })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(Object.keys(r.command).sort(), ['expectedRevision', 'id', 'kind', 'title'])
})

test('the body cap is a real bound and far above a real resume', () => {
  assert.ok(MAX_BODY_BYTES > 32 * 1024)
  assert.ok(MAX_BODY_BYTES <= 1024 * 1024)
})

// ----------------------------------------------------------- duplicate

test('duplicating copies the content under new section ids', () => {
  const source = sample()
  const plan = planDuplicate({
    source, actingUserId: 'user-1', newId: ID_B, sectionIds: sectionIds('d'), now: LATER,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return

  assert.equal(plan.resume.id, ID_B)
  assert.equal(plan.resume.sections.length, source.sections.length)
  const sourceIds = new Set(source.sections.map((s) => s.id))
  for (const section of plan.resume.sections) {
    assert.equal(sourceIds.has(section.id), false, 'a copied section must not reuse an id')
  }
  assert.deepEqual(
    plan.resume.sections.map((s) => s.type),
    source.sections.map((s) => s.type),
    'order and types are preserved'
  )
})

test('a duplicate carries the content but not the identity of the original', () => {
  const withContact = setContact(sample(), {
    fullName: 'A N Other', credentials: 'BSN, RN, CCRN', email: 'a@example.test',
    phone: '', city: 'Newark', state: 'NJ', linkedin: '', website: '',
  }, NOW)
  const source: ResumeV2 = { ...withContact, revision: 12, status: 'complete',
    strength: { score: 88, computedAtRevision: 12, computedAt: NOW } }

  const plan = planDuplicate({
    source, actingUserId: 'user-1', newId: ID_B, sectionIds: sectionIds('d'), now: LATER,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return

  assert.deepEqual(plan.resume.contact, source.contact, 'contact is content, and is copied')
  assert.equal(plan.resume.revision, 1, 'a new row starts at revision 1')
  assert.equal(plan.resume.status, 'draft', 'a copy is not complete just because its source was')
  assert.equal(plan.resume.strength, null, 'a score computed for another row means nothing here')
  assert.equal(plan.resume.createdAt, LATER)
  assert.equal(plan.resume.updatedAt, LATER)
})

test('duplicating someone else’s resume is refused even if the read returned it', () => {
  const source = sample('user-1')
  const plan = planDuplicate({
    source, actingUserId: 'user-2', newId: ID_B, sectionIds: sectionIds('d'), now: LATER,
  })
  assert.deepEqual(plan, { ok: false, reason: 'not-owner' })
})

test('a duplicate belongs to the person who asked for it', () => {
  const source = sample('user-1')
  const plan = planDuplicate({
    source, actingUserId: 'user-1', newId: ID_B, sectionIds: sectionIds('d'), now: LATER,
  })
  assert.equal(plan.ok, true)
  if (plan.ok) assert.equal(plan.resume.userId, 'user-1')
})

test('too few section ids is refused rather than silently truncating', () => {
  const source = sample()
  const plan = planDuplicate({
    source, actingUserId: 'user-1', newId: ID_B, sectionIds: ['only-one'], now: LATER,
  })
  assert.deepEqual(plan, { ok: false, reason: 'missing-ids' })
})

test('the copy suffix stays inside the title cap', () => {
  assert.equal(duplicateTitle('Duke'), 'Duke (copy)')
  assert.equal(duplicateTitle('   '), `${DEFAULT_TITLE} (copy)`)
  const long = duplicateTitle('y'.repeat(MAX_TITLE))
  assert.equal(long.length, MAX_TITLE)
  assert.ok(long.endsWith(' (copy)'))
})

test('duplicating a duplicate does not compound past the cap', () => {
  let title = 'z'.repeat(MAX_TITLE - 3)
  for (let i = 0; i < 5; i++) {
    title = duplicateTitle(title)
    assert.ok(title.length <= MAX_TITLE, `iteration ${i}: ${title.length}`)
  }
})

test('a renamed source does not affect an already-planned copy', () => {
  const source = sample()
  const plan = planDuplicate({
    source, actingUserId: 'user-1', newId: ID_B, sectionIds: sectionIds('d'), now: LATER,
  })
  const renamed = setTitle(source, 'Changed', LATER)
  assert.equal(renamed.title, 'Changed')
  if (plan.ok) assert.equal(plan.resume.title, 'Duke application (copy)')
})
