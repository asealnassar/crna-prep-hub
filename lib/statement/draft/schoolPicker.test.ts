import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { listSchoolPickerOptions, schoolOptionFromRow } from './schoolPicker.ts'
import type { SchoolOptionRow } from './schoolPicker.ts'
// Imported ONLY to assert the uuid patterns have not drifted apart.
import { UUID } from './http.ts'
// Imported ONLY to prove this projection is NARROWER than the directory's.
import { PUBLIC_SCHOOL_COLUMNS } from '../../schools.ts'

/**
 * NO REAL SUPABASE. The same recording double draftRepo.test.ts and
 * promptRepo.test.ts use, repeated here rather than extracted: it is nine
 * lines, it belongs to the file that asserts against it, and a shared helper
 * would make one test file's needs a constraint on another's.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'

type Reply = { data: unknown; error: unknown }
type Call = unknown[]

function fakeDb(replies: Reply[]): { db: SupabaseClient; log: Call[] } {
  const log: Call[] = []
  let next = 0
  const client = {
    from(table: string) {
      log.push(['from', table])
      const reply = replies[next++] ?? {
        data: null,
        error: { code: 'TEST_NO_REPLY', message: 'the code issued more statements than the test queued' },
      }
      const chain: unknown = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: Reply) => void) => resolve(reply)
          }
          return (...args: unknown[]) => { log.push([String(prop), ...args]); return chain }
        },
      })
      return chain
    },
  }
  return { db: client as unknown as SupabaseClient, log }
}

const row = (over: Partial<SchoolOptionRow> = {}): SchoolOptionRow => ({
  id: A,
  name: 'Example University',
  location_state: 'TX',
  ...over,
})

const ok = (data: unknown): Reply => ({ data, error: null })
const boom: Reply = { data: null, error: { code: '08006', message: 'connection failure' } }

const calls = (log: Call[], name: string) => log.filter((c) => c[0] === name)
const froms = (log: Call[]) => calls(log, 'from').length
const wroteNothing = (log: Call[]) =>
  calls(log, 'update').length === 0 &&
  calls(log, 'insert').length === 0 &&
  calls(log, 'upsert').length === 0 &&
  calls(log, 'delete').length === 0

// ================================================================== the query

test('the projection is EXACTLY id, name, location_state -- and never *', async () => {
  const { db, log } = fakeDb([ok([row()])])
  await listSchoolPickerOptions(db)

  const selected = calls(log, 'select')[0][1] as string
  assert.equal(selected, 'id, name, location_state')
  assert.deepEqual(selected.split(', '), ['id', 'name', 'location_state'])
  assert.equal(selected.includes('*'), false, `a wildcard projection: ${selected}`)
  assert.deepEqual(calls(log, 'from'), [['from', 'schools']])
})

test('NO PAID COLUMN is requested, and none of the directory’s extras either', async () => {
  const { db, log } = fakeDb([ok([row()])])
  await listSchoolPickerOptions(db)
  const selected = calls(log, 'select')[0][1] as string

  // The four lib/schools.ts names as paid.
  for (const paid of [
    'application_deadline', 'gre_requirement', 'application_method', 'website_url',
  ]) {
    assert.equal(selected.includes(paid), false, `${paid} is paid and must not be read`)
  }
  // And the free-but-irrelevant ones a picker has no use for.
  for (const extra of [
    'tuition_total', 'tuition_yearly', 'gpa_requirement', 'icu_experience_months',
    'program_type', 'program_length_months', 'format', 'front_loaded',
    'application_opens_month', 'prerequisites_required', 'prerequisites_not_required',
    'location_city', 'accepts_new_grad_icu',
  ]) {
    assert.equal(selected.includes(extra), false, `${extra} is not a picker's business`)
  }
})

test('the projection is STRICTLY NARROWER than the school directory’s', async () => {
  // getPublicSchools() selects sixteen columns. Reusing it would pull a
  // school's whole free profile into a page that shows a dropdown.
  const directory = PUBLIC_SCHOOL_COLUMNS.split(', ')
  const { db, log } = fakeDb([ok([row()])])
  await listSchoolPickerOptions(db)
  const mine = (calls(log, 'select')[0][1] as string).split(', ')

  assert.equal(directory.length, 16)
  assert.equal(mine.length, 3)
  assert.ok(mine.length < directory.length)
  for (const column of mine) {
    assert.ok(directory.includes(column), `${column} should also be a public column`)
  }
})

test('ordered DETERMINISTICALLY -- name, then id', async () => {
  // Names are unique in the current data but nothing enforces it, and an
  // unbroken tie would let the list shuffle between two renders.
  const { db, log } = fakeDb([ok([row()])])
  await listSchoolPickerOptions(db)
  assert.deepEqual(calls(log, 'order'), [
    ['order', 'name', { ascending: true }],
    ['order', 'id', { ascending: true }],
  ])
})

test('ONE statement, and it writes NOTHING', async () => {
  const { db, log } = fakeDb([ok([row()])])
  const result = await listSchoolPickerOptions(db)
  assert.equal(result.ok, true)
  assert.equal(froms(log), 1)
  assert.ok(wroteNothing(log))
  for (const verb of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
    assert.equal(calls(log, verb).length, 0, `${verb} must never be called`)
  }
})

/**
 * The module's source with commentary removed.
 *
 * The header deliberately discusses select('*') and getPublicSchools() -- it
 * explains why neither is used -- so a word blacklist run over the raw text
 * would match that prose rather than any code. CODE is the view those
 * assertions want, and the guard below proves the stripping kept the code.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('./schoolPicker.ts', import.meta.url)), 'utf8',
)
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')

test('the comment-stripped view kept the code and dropped the prose', () => {
  assert.equal(CODE.includes('export async function listSchoolPickerOptions'), true)
  assert.equal(CODE.includes("const SCHOOL_COLUMNS = 'id, name, location_state'"), true)
  assert.equal(CODE.includes('AND DEFINITELY NOT'), false, 'prose removed')
  assert.equal(CODE.includes('WHY NOT getPublicSchools'), false, 'prose removed')
})

test('the module builds no client and names no service role', () => {
  // Judged on CODE: the header names both anti-patterns on purpose, to say why
  // they are not used.
  for (const forbidden of [
    'createClient', 'SERVICE_ROLE', 'service_role', 'SUPABASE_SERVICE',
    "select('*')", '.insert(', '.update(', '.upsert(', '.delete(', '.rpc(',
    'getPublicSchools',
  ]) {
    assert.equal(CODE.includes(forbidden), false, `${forbidden} must not appear`)
  }
  assert.equal(CODE.includes("const SCHOOLS = 'schools'"), true)
  // The only table it names, and it names it once.
  assert.equal((CODE.match(/\.from\(/g) ?? []).length, 1)
})

// ================================================================ the results

test('a well-formed row becomes exactly three camel-cased fields', async () => {
  const { db } = fakeDb([ok([row()])])
  const result = await listSchoolPickerOptions(db)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(result.value, [{ id: A, name: 'Example University', locationState: 'TX' }])
  assert.deepEqual(Object.keys(result.value[0]).sort(), ['id', 'locationState', 'name'])
})

test('a NULL location_state is accepted -- not every row records one', async () => {
  const { db } = fakeDb([ok([row({ location_state: null })])])
  const result = await listSchoolPickerOptions(db)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value[0].locationState, null)
  assert.equal('locationState' in result.value[0], true)
})

test('the NAME IS PRESERVED exactly -- not trimmed, not tidied', async () => {
  // An institution writes its own name; this module is not entitled to fix it.
  for (const name of [
    "  St. Mary's & Co.  ", 'Université de Montréal', 'UCLA  (Los Angeles)',
    'A'.repeat(300),
  ]) {
    const { db } = fakeDb([ok([row({ name })])])
    const result = await listSchoolPickerOptions(db)
    assert.equal(result.ok, true, name)
    if (!result.ok) return
    assert.equal(result.value[0].name, name)
  }
})

test('MULTIPLE schools all come back, in the order the query gave them', async () => {
  const { db } = fakeDb([ok([
    row({ id: A, name: 'Alpha University', location_state: 'TX' }),
    row({ id: B, name: 'Beta College', location_state: null }),
    row({ id: C, name: 'Gamma School of Nursing', location_state: 'Michigan' }),
  ])])
  const result = await listSchoolPickerOptions(db)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.value.length, 3)
  assert.deepEqual(result.value.map((s) => s.id), [A, B, C])
  assert.deepEqual(result.value.map((s) => s.locationState), ['TX', null, 'Michigan'])
  // The repository does not re-sort: one ordering, decided by the query.
})

test('an option is BUILT, not spread -- a wider row cannot widen it', async () => {
  const wider = {
    ...row(), tuition_total: 90000, gre_requirement: 'none',
    application_deadline: '2026-01-15', website_url: 'https://example.test',
  } as never
  const { db } = fakeDb([ok([wider])])
  const result = await listSchoolPickerOptions(db)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(Object.keys(result.value[0]).sort(), ['id', 'locationState', 'name'])
  const wire = JSON.stringify(result.value)
  for (const leak of ['90000', 'gre', '2026-01-15', 'example.test']) {
    assert.equal(wire.includes(leak), false, `${leak} must never pass through`)
  }
})

test('AN EMPTY ARRAY IS A SUCCESS -- no schools available', async () => {
  const { db } = fakeDb([ok([])])
  const result = await listSchoolPickerOptions(db)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, [])
  assert.equal(Array.isArray(result.value), true)
})

// =============================================================== the refusals

test('AN EMPTY DIRECTORY AND A FAILED READ ARE DIFFERENT ANSWERS', async () => {
  // The distinction the whole result type exists for. "No schools" for a
  // dropped connection would tell an applicant this product knows of no CRNA
  // programmes.
  const { db: empty } = fakeDb([ok([])])
  const none = await listSchoolPickerOptions(empty)
  assert.equal(none.ok, true)
  assert.deepEqual(none.ok && none.value, [])

  const { db: broken } = fakeDb([boom])
  const failed = await listSchoolPickerOptions(broken)
  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.equal(failed.reason, 'read-failed')
  assert.equal('value' in failed, false, 'no empty list may come back')
})

test('NULL DATA IS A FAILURE, not an empty directory', async () => {
  const { db } = fakeDb([ok(null)])
  const result = await listSchoolPickerOptions(db)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'read-failed')
  assert.equal(result.detail, 'NO_ROWS select returned no array')
})

test('a NON-ARRAY response is a failure', async () => {
  for (const data of [undefined, {}, '', 'rows', 0, 42, true, { rows: [] }]) {
    const { db } = fakeDb([ok(data)])
    const result = await listSchoolPickerOptions(db)
    assert.equal(result.ok, false, String(data))
    if (result.ok) return
    assert.equal(result.reason, 'read-failed', String(data))
  }
})

test('a MALFORMED row is data-integrity, never a silent repair', async () => {
  const malformed: readonly Partial<SchoolOptionRow>[] = [
    { id: null }, { id: '' }, { id: 'not-a-uuid' }, { id: `${A}0` },
    { id: A.slice(0, -1) }, { id: 42 as never },
    { name: null }, { name: '' }, { name: '   ' }, { name: '\n\t ' },
    { name: 42 as never }, { name: {} as never },
    { location_state: 42 as never }, { location_state: {} as never },
    { location_state: true as never },
  ]
  for (const over of malformed) {
    const { db } = fakeDb([ok([row(over)])])
    const result = await listSchoolPickerOptions(db)
    assert.equal(result.ok, false, JSON.stringify(over))
    if (result.ok) return
    assert.equal(result.reason, 'data-integrity', JSON.stringify(over))
    assert.equal(result.detail, 'unusable stored row (school-option)')
  }
})

test('an ABSENT column is unusable, not read as a null state', async () => {
  for (const key of ['id', 'name', 'location_state'] as const) {
    const missing = { ...row() }
    delete (missing as Record<string, unknown>)[key]
    const { db } = fakeDb([ok([missing])])
    const result = await listSchoolPickerOptions(db)
    assert.equal(result.ok, false, `missing ${key}`)
  }
})

test('ONE malformed row fails the WHOLE list -- no silent skipping', async () => {
  const { db } = fakeDb([ok([
    row({ id: A, name: 'Alpha University' }),
    row({ id: B, name: '   ' }),                 // the bad one
    row({ id: C, name: 'Gamma School' }),
  ])])
  const result = await listSchoolPickerOptions(db)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'data-integrity')
  assert.equal('value' in result, false, 'no partial list may come back')
})

test('NO REFUSAL CARRIES A DATABASE MESSAGE OR A ROW', async () => {
  const hostile = {
    data: null,
    error: {
      code: '42501', message: 'permission denied for table schools',
      details: 'Failing row contains (…, Example University, 90000, …)',
      hint: 'check the policy',
    },
  }
  for (const reply of [hostile, ok(null), ok([row({ name: '' })])]) {
    const { db } = fakeDb([reply])
    const result = await listSchoolPickerOptions(db)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.deepEqual(Object.keys(result).sort(), ['detail', 'ok', 'reason'])
    const text = JSON.stringify(result)
    for (const leak of ['Failing row', 'check the policy', '90000', 'Example University']) {
      assert.equal(text.includes(leak), false, `${leak} must never be carried`)
    }
  }
})

test('the three answers stay three distinct things', async () => {
  const seen: string[] = []
  for (const reply of [ok(null), boom, ok([row({ name: '' })])]) {
    const { db } = fakeDb([reply])
    const result = await listSchoolPickerOptions(db)
    assert.equal(result.ok, false)
    if (result.ok) return
    seen.push(`${result.reason}:${result.detail}`)
  }
  assert.deepEqual(seen, [
    'read-failed:NO_ROWS select returned no array',
    'read-failed:08006 connection failure',
    'data-integrity:unusable stored row (school-option)',
  ])
})

// ========================================================= the pure normaliser

test('schoolOptionFromRow refuses a non-object without throwing', () => {
  for (const value of [null, undefined, 'row', 0, true, []]) {
    assert.equal(schoolOptionFromRow(value as never), null, String(value))
  }
})

test('schoolOptionFromRow accepts the shape the projection promises', () => {
  assert.deepEqual(schoolOptionFromRow(row()), {
    id: A, name: 'Example University', locationState: 'TX',
  })
})

test('the uuid pattern has NOT drifted from the shared one', () => {
  // SCHOOL_UUID duplicates http.ts's UUID to keep this module dependency-free.
  for (const value of [
    A, A.toUpperCase(), 'c0ffee00-0000-7000-9000-000000000001',
    '', 'x', `${A}0`, A.slice(0, -1), A.replace(/-/g, ''),
  ]) {
    assert.equal(schoolOptionFromRow(row({ id: value })) !== null, UUID.test(value), value)
  }
})
