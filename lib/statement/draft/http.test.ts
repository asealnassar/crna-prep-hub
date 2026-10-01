import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INVALID_ID_BODY, MALFORMED_JSON_BODY, NOT_AN_OBJECT_BODY, NOT_FOUND_BODY,
  SERVER_ERROR_BODY, UNAUTHENTICATED_BODY, UUID, VALIDATION_MESSAGES,
  checkBodyShape, conflictBody, isDraftId, isServerFault, publicDraft,
  statusForRepo, statusForValidation, validationBody,
} from './http.ts'
import type { DraftRefusal } from './validate.ts'
import type { DraftRepoRefusal } from './draftRepo.ts'
import type { StatementDraft } from './rows.ts'

/**
 * The decision table, tested without a request.
 *
 * This is the half of the API that `npm test` actually discovers: the route
 * files live under app/, which the `lib/**\/*.test.ts` glob does not reach, so
 * every rule worth regression-proofing lives here.
 */

// --------------------------------------------------------------------- the id

test('id: a well-formed UUID is accepted, in either case', () => {
  assert.equal(isDraftId('d1e2f3a4-0000-4000-8000-000000000001'), true)
  assert.equal(isDraftId('D1E2F3A4-0000-4000-8000-000000000001'), true)
})

test('id: anything that is not a UUID string is refused', () => {
  for (const bad of [
    '', 'not-a-uuid', '123', 'd1e2f3a4-0000-4000-8000', 'd1e2f3a4-0000-4000-8000-0000000000012',
    'g1e2f3a4-0000-4000-8000-000000000001', ' d1e2f3a4-0000-4000-8000-000000000001',
    undefined, null, 42, {}, [], ['d1e2f3a4-0000-4000-8000-000000000001'], true,
  ]) {
    assert.equal(isDraftId(bad), false, JSON.stringify(bad))
  }
})

test('id: the pattern is the one the resume route already uses', () => {
  assert.equal(UUID.source, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
})

// ------------------------------------------------------------------- the body

test('body: a plain object is usable', () => {
  const result = checkBodyShape({ title: 't', essay: 'e' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.body, { title: 't', essay: 'e' })
})

test('body: an empty object is usable -- its fields are the validator’s problem', () => {
  assert.equal(checkBodyShape({}).ok, true)
})

test('body: valid JSON that is not an object is refused', () => {
  // All of these parse. None of them is a request body.
  for (const value of [null, [], ['a'], 'a string', 42, 0, true, false]) {
    const result = checkBodyShape(value)
    assert.equal(result.ok, false, JSON.stringify(value))
    if (result.ok) continue
    assert.equal(result.code, 'not-an-object')
  }
})

test('body: an ARRAY is refused explicitly, not treated as a fieldless object', () => {
  // typeof [] === 'object' and [].title is undefined, so without the Array check
  // an array would be reported as a missing title -- true, but the wrong reason.
  assert.equal(checkBodyShape([]).ok, false)
  assert.equal(checkBodyShape([{ title: 't' }]).ok, false)
})

test('body: nothing is coerced', () => {
  const result = checkBodyShape({ title: 42, essay: null, expectedRevision: '4' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // Passed through exactly as parsed, for the validator to refuse.
  assert.equal(result.body.title, 42)
  assert.equal(result.body.essay, null)
  assert.equal(result.body.expectedRevision, '4')
})

// ------------------------------------------------- validation -> status

test('validation: a malformed FIELD is 400, unacceptable CONTENT is 422', () => {
  // The same line app/api/statement/extract/route.ts draws: 'no-file' is 400,
  // 'text-too-long' is 422.
  assert.equal(statusForValidation('invalid-title'), 400)
  assert.equal(statusForValidation('invalid-essay'), 400)
  assert.equal(statusForValidation('invalid-revision'), 400)
  assert.equal(statusForValidation('title-too-long'), 422)
  assert.equal(statusForValidation('essay-too-long'), 422)
})

test('validation: every refusal code has a status and a message', () => {
  // A new code added to the validator must not fall through to undefined.
  const codes: DraftRefusal[] = [
    'invalid-title', 'title-too-long', 'invalid-essay', 'essay-too-long', 'invalid-revision',
  ]
  for (const code of codes) {
    const status = statusForValidation(code)
    assert.ok(status === 400 || status === 422, `${code} -> ${status}`)
    assert.equal(typeof VALIDATION_MESSAGES[code], 'string')
    assert.ok(VALIDATION_MESSAGES[code].length > 0, code)
  }
  assert.deepEqual(Object.keys(VALIDATION_MESSAGES).sort(), [...codes].sort())
})

test('validation: the body keeps the machine code and never the rejected text', () => {
  const body = validationBody('essay-too-long', 20_050)
  assert.equal(body.code, 'essay-too-long')
  assert.equal(body.characters, 20_050)
  assert.equal(body.error, VALIDATION_MESSAGES['essay-too-long'])
  assert.deepEqual(Object.keys(body).sort(), ['characters', 'code', 'error'])
})

test('validation: the count key is omitted when there is no count', () => {
  const body = validationBody('invalid-title')
  assert.equal('characters' in body, false)
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error'])
})

// ------------------------------------------------------ repository -> status

test('repo: not-found is 404 and conflict is 409', () => {
  assert.equal(statusForRepo('not-found'), 404)
  assert.equal(statusForRepo('conflict'), 409)
})

test('repo: THERE IS NO 403 -- a hidden row is the same 404 as a missing one', () => {
  // RLS makes another user's draft invisible, so the repository cannot tell
  // absent from forbidden, and must not: a 403 would confirm the id exists.
  const statuses = new Set(
    (['not-found', 'conflict', 'data-integrity', 'create-failed', 'read-failed',
      'list-failed', 'update-failed', 'delete-failed'] as DraftRepoRefusal[])
      .map(statusForRepo),
  )
  assert.equal(statuses.has(403), false)
})

test('repo: every failure reason is a 500, including data-integrity', () => {
  for (const reason of [
    'create-failed', 'read-failed', 'list-failed', 'update-failed', 'delete-failed',
    'data-integrity',
  ] as DraftRepoRefusal[]) {
    assert.equal(statusForRepo(reason), 500, reason)
    assert.equal(isServerFault(reason), true, reason)
  }
})

test('repo: an answer is not a server fault, so it is not logged as one', () => {
  assert.equal(isServerFault('not-found'), false)
  assert.equal(isServerFault('conflict'), false)
})

// --------------------------------------------------------------- the bodies

test('conflict: carries the stored revision and nothing else about the row', () => {
  const body = conflictBody(7)
  assert.equal(body.code, 'conflict')
  assert.equal(body.storedRevision, 7)
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'storedRevision'])
  // No title, no essay: a caller who lost the race is told the revision moved,
  // not what it moved to.
  assert.equal('essay' in body, false)
  assert.equal('title' in body, false)
  assert.equal('draft' in body, false)
})

test('the 5xx body is a CONSTANT, so no database message can be interpolated', () => {
  assert.deepEqual(SERVER_ERROR_BODY, {
    error: 'Something went wrong saving your draft. Please try again.',
    code: 'server-error',
  })
  // Nothing in it names a table, a column, a Postgres code or an internal word.
  const text = JSON.stringify(SERVER_ERROR_BODY)
  for (const leak of ['statement_drafts', 'revision', 'postgres', 'PGRST', 'detail', 'constraint']) {
    assert.equal(text.toLowerCase().includes(leak.toLowerCase()), false, leak)
  }
})

test('every fixed body carries a machine code and a human message', () => {
  for (const body of [
    UNAUTHENTICATED_BODY, NOT_FOUND_BODY, SERVER_ERROR_BODY,
    MALFORMED_JSON_BODY, NOT_AN_OBJECT_BODY, INVALID_ID_BODY,
  ]) {
    assert.equal(typeof body.code, 'string')
    assert.ok(/^[a-z-]+$/.test(body.code), `code is not a plain word: ${body.code}`)
    assert.ok(body.error.length > 0)
  }
})

test('the not-found body says nothing about ownership', () => {
  const text = JSON.stringify(NOT_FOUND_BODY).toLowerCase()
  for (const leak of ['forbidden', 'another', 'owner', 'permission', 'access']) {
    assert.equal(text.includes(leak), false, leak)
  }
})

// ---------------------------------------------------------- the public draft

const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000003'
const PROMPT = 'c0ffee00-0000-4000-8000-000000000004'

/** A GENERIC draft: no prompt, four explicit nulls. */
const stored: StatementDraft = {
  id: 'd1e2f3a4-0000-4000-8000-000000000001',
  userId: 'u1e2f3a4-0000-4000-8000-000000000002',
  title: 'Draft one',
  essay: 'Opening line.',
  revision: 3,
  createdAt: '2026-09-29T12:00:00.000Z',
  updatedAt: '2026-09-29T12:30:00.000Z',
  schoolId: null,
  promptId: null,
  promptText: null,
  statedMaxWords: null,
}

/** The same draft with a prompt snapshot on it. */
const withPrompt: StatementDraft = {
  ...stored,
  schoolId: SCHOOL,
  promptId: PROMPT,
  promptText: 'Why have you chosen nurse anaesthesia?',
  statedMaxWords: 500,
}

test('publicDraft: drops userId and keeps exactly the TEN client fields', () => {
  const result = publicDraft(stored)
  assert.deepEqual(Object.keys(result).sort(), [
    'createdAt', 'essay', 'id', 'promptId', 'promptText', 'revision',
    'schoolId', 'statedMaxWords', 'title', 'updatedAt',
  ])
  assert.equal(Object.keys(result).length, 10)
  assert.equal('userId' in result, false)
  assert.equal(JSON.stringify(result).includes(stored.userId), false)
})

test('publicDraft: EXPOSES all four prompt fields when a prompt is chosen', () => {
  const result = publicDraft(withPrompt)
  assert.equal(result.schoolId, SCHOOL)
  assert.equal(result.promptId, PROMPT)
  assert.equal(result.promptText, 'Why have you chosen nurse anaesthesia?')
  assert.equal(result.statedMaxWords, 500)
})

test('publicDraft: a GENERIC draft serialises four EXPLICIT nulls', () => {
  // Present and null, never omitted: four absent keys are indistinguishable
  // from a server too old to send them.
  const result = publicDraft(stored)
  const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>
  for (const key of ['schoolId', 'promptId', 'promptText', 'statedMaxWords']) {
    assert.equal(key in parsed, true, `${key} must survive serialisation`)
    assert.equal(parsed[key], null, `${key} must be null, not absent`)
  }
  assert.equal(Object.keys(parsed).length, 10)
})

test('publicDraft: a chosen prompt with no stated limit keeps a null limit', () => {
  const result = publicDraft({ ...withPrompt, statedMaxWords: null })
  assert.equal(result.promptId, PROMPT)
  assert.equal(result.statedMaxWords, null)
  assert.equal('statedMaxWords' in result, true)
})

test('publicDraft: BUILT, not spread -- an added column cannot leak through it', () => {
  // A wider stored object must not widen the response.
  const wider = { ...stored, secretColumn: 'internal', user_id: stored.userId } as StatementDraft
  const result = publicDraft(wider)
  assert.equal('secretColumn' in result, false)
  assert.equal('user_id' in result, false)
  assert.equal(JSON.stringify(result).includes('internal'), false)
})

test('publicDraft: the essay IS returned in full -- this is the read path', () => {
  const long = 'x'.repeat(19_999)
  const result = publicDraft({ ...stored, essay: long })
  assert.equal(result.essay, long)
  assert.equal(result.essay.length, 19_999)
})
