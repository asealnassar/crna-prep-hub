import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SAVE_MESSAGES, saveEventFrom } from './save.ts'
import { reduce, initialState, nextAction, DEFAULT_AUTOSAVE } from '../../resume/draft/autosave.ts'

/**
 * Pure. No request, no clock of its own, no React.
 *
 * TWO PROPERTIES ARE ASSERTED THROUGHOUT, because they are the reasons this
 * module exists rather than a few inline conditionals in the driver:
 *
 *   NO REVISION IS EVER INVENTED -- a value that cannot be read produces a
 *   failure, never a 1 and never a locally-incremented number.
 *
 *   NOTHING THE SERVER SAID IS PASSED ON -- every `reason` is one of the five
 *   fixed strings in SAVE_MESSAGES, checked by identity, so an echoed essay or
 *   Postgres detail could not slip through unnoticed.
 *
 * The last section feeds real events into the untouched autosave engine, because
 * the contract this module targets is that engine's, and a mapping that produced
 * a shape `reduce()` mishandled would pass every test above and still be wrong.
 */

const AT = 1_759_000_000_000

const event = (status: number, body: unknown) => saveEventFrom({ status, body, at: AT })
const ok = (revision: unknown) => ({ draft: { id: 'd', title: 't', essay: 'e', revision } })

/** Every fixed message, for identity checks. */
const MESSAGES = Object.values(SAVE_MESSAGES)

// ------------------------------------------------------------------- success

test('200 with a numeric revision succeeds, carrying the SERVER’s number', () => {
  const result = event(200, ok(2))
  assert.deepEqual(result, { type: 'save-succeeded', at: AT, revision: 2 })
})

test('any 2xx succeeds, matching what Response.ok means', () => {
  for (const status of [200, 201, 204, 299]) {
    const result = event(status, ok(7))
    assert.equal(result.type, 'save-succeeded', String(status))
    if (result.type !== 'save-succeeded') continue
    assert.equal(result.revision, 7)
  }
})

test('200 with a STRING revision succeeds -- defence in depth, not the contract', () => {
  // The route serialises publicDraft(), whose revision is already a normalised
  // number, so JSON carries a number. This branch exists in case a bigint ever
  // reaches the wire as text.
  const result = event(200, ok('42'))
  assert.equal(result.type, 'save-succeeded')
  if (result.type !== 'save-succeeded') return
  assert.equal(result.revision, 42)
  assert.equal(typeof result.revision, 'number')
})

test('200 at the top of the safe range succeeds -- no upper bound is applied here', () => {
  // A stored revision may legitimately be MAX_SAFE_INTEGER. The refusal for an
  // un-incrementable revision belongs to the NEXT save, not to reading this one.
  const result = event(200, ok(Number.MAX_SAFE_INTEGER))
  assert.equal(result.type, 'save-succeeded')
  if (result.type !== 'save-succeeded') return
  assert.equal(result.revision, Number.MAX_SAFE_INTEGER)
})

test('a malformed success body is a NON-retryable failure, never a fabricated success', () => {
  // The write may have landed and only the reply was unreadable. Retrying would
  // re-send a now-stale expectedRevision and manufacture a conflict; claiming
  // success would report a revision nobody read.
  for (const body of [
    {}, null, undefined, [], 'ok', 42, true,
    { draft: null }, { draft: 'x' }, { draft: [] }, { draft: {} },
    { draft: { revision: null } }, { draft: { revision: 0 } },
    { draft: { revision: -1 } }, { draft: { revision: 1.5 } },
    { draft: { revision: '1.5' } }, { draft: { revision: 'abc' } },
    { draft: { revision: '' } }, { draft: { revision: Number.MAX_SAFE_INTEGER + 1 } },
    { revision: 2 },              // top-level, not nested: not the contract
    { draft: { Revision: 2 } },   // wrong case
  ]) {
    const result = event(200, body)
    assert.equal(result.type, 'save-failed', JSON.stringify(body))
    if (result.type !== 'save-failed') continue
    assert.equal(result.retryable, false)
    assert.equal(result.reason, SAVE_MESSAGES.unreadable)
  }
})

// ------------------------------------------------------------------ conflict

test('409 with a valid storedRevision is a conflict carrying only that number', () => {
  const result = event(409, { code: 'conflict', storedRevision: 5, error: 'This draft was saved somewhere else.' })
  assert.deepEqual(result, { type: 'conflict', at: AT, storedRevision: 5 })
  // No title, no essay, no server prose.
  assert.equal(Object.keys(result).sort().join(','), 'at,storedRevision,type')
})

test('409 with a string storedRevision is normalised', () => {
  const result = event(409, { code: 'conflict', storedRevision: '5' })
  assert.equal(result.type, 'conflict')
  if (result.type !== 'conflict') return
  assert.equal(result.storedRevision, 5)
  assert.equal(typeof result.storedRevision, 'number')
})

test('409 keys on the STATUS, not on `code`', () => {
  // The stored revision is the value the editor needs. Requiring `code` would
  // discard it whenever the code was unexpected.
  const result = event(409, { storedRevision: 9 })
  assert.equal(result.type, 'conflict')
  if (result.type === 'conflict') assert.equal(result.storedRevision, 9)
})

test('a malformed 409 is a NON-retryable failure, never conflict-at-1', () => {
  for (const body of [
    {}, null, undefined, [], 'conflict', 409,
    { code: 'conflict' },
    { code: 'conflict', storedRevision: null },
    { code: 'conflict', storedRevision: 0 },
    { code: 'conflict', storedRevision: -5 },
    { code: 'conflict', storedRevision: 1.5 },
    { code: 'conflict', storedRevision: '1.5' },
    { code: 'conflict', storedRevision: 'abc' },
    { code: 'conflict', storedRevision: '' },
    { code: 'conflict', storedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { storedrevision: 5 },  // wrong case
  ]) {
    const result = event(409, body)
    assert.equal(result.type, 'save-failed', JSON.stringify(body))
    if (result.type !== 'save-failed') continue
    assert.equal(result.retryable, false)
    assert.notEqual(result.type, 'conflict')
  }
})

// ------------------------------------------------------------- known failures

test('401 is a non-retryable failure that names the expired session', () => {
  const result = event(401, { error: 'You must be signed in to work on a statement.', code: 'unauthenticated' })
  assert.deepEqual(result, {
    type: 'save-failed', at: AT, retryable: false, reason: SAVE_MESSAGES.expired,
  })
  assert.match(result.reason, /session expired/i)
})

test('404 is a non-retryable failure that names the missing draft', () => {
  const result = event(404, { error: 'That draft could not be found.', code: 'not-found' })
  assert.equal(result.type, 'save-failed')
  if (result.type !== 'save-failed') return
  assert.equal(result.retryable, false)
  assert.equal(result.reason, SAVE_MESSAGES.missing)
})

test('400 and 422 are non-retryable refusals with a fixed message', () => {
  for (const [status, serverBody] of [
    [400, { error: 'Give the draft a title.', code: 'invalid-title' }],
    [400, { error: 'That request body is not a JSON object.', code: 'not-an-object' }],
    [400, { error: 'That draft version is not one this editor can save against.', code: 'invalid-revision' }],
    [422, { error: 'That is longer than a saved statement may be.', code: 'essay-too-long', characters: 20_050 }],
  ] as const) {
    const result = event(status, serverBody)
    assert.equal(result.type, 'save-failed', String(status))
    if (result.type !== 'save-failed') continue
    assert.equal(result.retryable, false)
    assert.equal(result.reason, SAVE_MESSAGES.refused)
  }
})

test('5xx is the only RETRYABLE outcome', () => {
  for (const status of [500, 502, 503, 504, 599]) {
    const result = event(status, { error: 'Something went wrong saving your draft.', code: 'server-error' })
    assert.equal(result.type, 'save-failed', String(status))
    if (result.type !== 'save-failed') continue
    assert.equal(result.retryable, true, String(status))
    assert.equal(result.reason, SAVE_MESSAGES.server)
  }
})

test('every non-5xx failure is non-retryable', () => {
  for (const status of [400, 401, 403, 404, 405, 409, 410, 415, 418, 422, 429, 499]) {
    const result = event(status, {})
    assert.equal(result.type, 'save-failed', String(status))
    if (result.type !== 'save-failed') continue
    assert.equal(result.retryable, false, `${status} must not retry`)
  }
})

test('an unexpected status stops rather than retrying', () => {
  // 429 is not produced by this route today; it lands here deliberately.
  for (const status of [301, 418, 429, 451]) {
    const result = event(status, {})
    assert.equal(result.type, 'save-failed')
    if (result.type !== 'save-failed') continue
    assert.equal(result.reason, SAVE_MESSAGES.refused)
    assert.equal(result.retryable, false)
  }
})

// ------------------------------------------------------------------- leakage

test('LEAKAGE: nothing the server said is ever reflected in the event', () => {
  const ESSAY = 'MY-SECRET-ESSAY-PHRASE-ariadne-in-the-trauma-bay'
  const DETAIL = '23514 new row violates check constraint; failing row contains (' + ESSAY + ')'

  // Every hostile body a response could carry, across every status.
  const hostile = [
    { error: DETAIL, code: 'x', detail: DETAIL, essay: ESSAY, draft: { essay: ESSAY, revision: 2 } },
    { error: ESSAY, storedRevision: 5, essay: ESSAY, title: ESSAY },
    { message: DETAIL, hint: DETAIL, essay: ESSAY },
  ]
  for (const status of [200, 400, 401, 404, 409, 422, 500, 503]) {
    for (const body of hostile) {
      const serialised = JSON.stringify(event(status, body))
      assert.equal(serialised.includes(ESSAY), false, `${status}: essay leaked`)
      assert.equal(serialised.includes('23514'), false, `${status}: Postgres code leaked`)
      assert.equal(serialised.includes('check constraint'), false, `${status}: SQL detail leaked`)
      assert.equal(serialised.includes('failing row'), false, `${status}: row detail leaked`)
    }
  }
})

test('LEAKAGE: every failure reason is one of the five fixed strings, by identity', () => {
  for (const status of [301, 400, 401, 403, 404, 409, 418, 422, 429, 500, 503]) {
    for (const body of [{}, null, { error: 'anything at all' }, { reason: 'or this' }]) {
      const result = event(status, body)
      if (result.type !== 'save-failed') continue
      assert.ok(
        MESSAGES.includes(result.reason as typeof MESSAGES[number]),
        `${status} produced an unlisted reason: ${result.reason}`,
      )
    }
  }
})

test('LEAKAGE: a success carries the revision and nothing else', () => {
  const result = event(200, { draft: { revision: 3, essay: 'the whole essay', title: 'Draft one' } })
  assert.deepEqual(result, { type: 'save-succeeded', at: AT, revision: 3 })
  assert.equal(JSON.stringify(result).includes('essay'), false)
  assert.equal(JSON.stringify(result).includes('Draft one'), false)
})

// ------------------------------------------------- no fallback, ever

test('NO REVISION FALLBACK TO 1, on any path', () => {
  // The single reason this module exists rather than `Number(body.revision) || 1`.
  for (const [status, body] of [
    [200, { draft: { revision: null } }],
    [200, { draft: { revision: 'abc' } }],
    [200, {}],
    [409, { code: 'conflict' }],
    [409, { code: 'conflict', storedRevision: 'abc' }],
    [409, {}],
  ] as const) {
    const result = event(status, body)
    assert.equal(result.type, 'save-failed', `${status} ${JSON.stringify(body)}`)
    // Neither field exists on a failure, so neither can be 1.
    assert.equal('revision' in result, false)
    assert.equal('storedRevision' in result, false)
  }
})

test('the timestamp is passed through untouched on every path', () => {
  for (const status of [200, 400, 401, 404, 409, 500]) {
    const result = saveEventFrom({ status, body: ok(2), at: 12_345 })
    assert.equal(result.at, 12_345, String(status))
  }
})

// ------------------------------- the events really drive the untouched engine

test('the produced events are accepted by the real autosave engine', () => {
  // The contract this module targets is lib/resume/draft/autosave.ts's. A shape
  // that reduce() mishandled would pass every assertion above and still be wrong,
  // so the three events are fed to the engine unmodified.
  let s = initialState(1)
  s = reduce(s, { type: 'edited', at: AT })
  s = reduce(s, { type: 'save-started', at: AT + 1 })

  // success advances the revision to the SERVER's number
  const success = event(200, ok(2))
  const saved = reduce(s, success)
  assert.equal(saved.status, 'saved')
  assert.equal(saved.revision, 2)

  // a retryable failure backs off rather than stopping
  const retryable = event(503, {})
  const retrying = reduce(s, retryable)
  assert.equal(retrying.status, 'retrying')
  assert.equal(retrying.error, SAVE_MESSAGES.server)

  // a non-retryable failure stops immediately
  const terminal = reduce(s, event(401, {}))
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error, SAVE_MESSAGES.expired)
  assert.deepEqual(nextAction(terminal, AT + 99_999, DEFAULT_AUTOSAVE), { kind: 'idle' })

  // a conflict freezes, carrying the stored revision
  const conflicted = reduce(s, event(409, { code: 'conflict', storedRevision: 5 }))
  assert.equal(conflicted.status, 'conflict')
  assert.equal(conflicted.storedRevision, 5)
  assert.deepEqual(nextAction(conflicted, AT + 99_999, DEFAULT_AUTOSAVE), { kind: 'idle' })
  // And the revision is NOT advanced by a conflict.
  assert.equal(conflicted.revision, 1)
})

test('a conflict event does not carry the engine’s Resume-specific wording onward', () => {
  // autosave.ts:209 sets `error` to a sentence about a resume. describe() never
  // reads `error` in the conflict branch, so it is not user-visible -- this test
  // records that the adapter contributes nothing to it either way.
  const conflicted = reduce(
    initialState(1),
    event(409, { code: 'conflict', storedRevision: 5 }),
  )
  assert.equal(conflicted.status, 'conflict')
  // The adapter's own event carries no `error` field at all.
  assert.equal('error' in event(409, { storedRevision: 5 }), false)
})
