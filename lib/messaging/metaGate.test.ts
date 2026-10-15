/**
 * QA-012: the inbox stops hammering an endpoint that is failing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_META_BACKOFF_CEILING_MS, DEFAULT_META_BACKOFF_MS, createMetaGate,
} from './metaGate.ts'

const MODAL = readFileSync(
  fileURLToPath(new URL('../../components/MessagesModal.tsx', import.meta.url)), 'utf8')

test('QA-012 a healthy endpoint is never gated', () => {
  const gate = createMetaGate({ now: () => 1_000 })
  for (let i = 0; i < 50; i += 1) {
    assert.equal(gate.mayRequest(), true)
    gate.succeeded()
  }
  assert.equal(gate.failures(), 0)
  assert.equal(gate.nextAllowedAt(), null)
})

test('QA-012 the first failure blocks the next request, and grows', () => {
  let now = 0
  const gate = createMetaGate({ now: () => now })
  assert.equal(gate.failed(), true, 'the first failure of a run is worth a line')
  assert.equal(gate.mayRequest(), false)
  // The nine-in-48ms burst: every one of them is refused.
  for (let ms = 0; ms < 48; ms += 6) { now = ms; assert.equal(gate.mayRequest(), false) }

  now = DEFAULT_META_BACKOFF_MS
  assert.equal(gate.mayRequest(), true, 'the backoff ends, it does not give up')
  assert.equal(gate.failed(), false, 'and the second failure is not logged again')
  assert.equal(gate.mayRequest(), false)
  now += DEFAULT_META_BACKOFF_MS
  assert.equal(gate.mayRequest(), false, 'the second wait is longer than the first')
  now += DEFAULT_META_BACKOFF_MS
  assert.equal(gate.mayRequest(), true)
})

test('QA-012 the backoff is capped, so a long outage still retries', () => {
  let now = 0
  const gate = createMetaGate({ now: () => now })
  for (let i = 0; i < 200; i += 1) gate.failed()
  const due = gate.nextAllowedAt()
  assert.ok(due !== null)
  assert.ok(due - now <= DEFAULT_META_BACKOFF_CEILING_MS, `${due - now}ms exceeds the ceiling`)
  now = due
  assert.equal(gate.mayRequest(), true)
})

test('QA-012 one success clears everything', () => {
  let now = 0
  const gate = createMetaGate({ now: () => now })
  gate.failed(); gate.failed(); gate.failed()
  assert.equal(gate.mayRequest(), false)
  gate.succeeded()
  assert.equal(gate.failures(), 0)
  assert.equal(gate.mayRequest(), true)
  assert.equal(gate.failed(), true, 'and the next failure is a new run, so it logs')
})

test('QA-012 the modal uses the gate, single-flight, and logs once', () => {
  /*
   * STRUCTURAL, because this component cannot be imported under node --test.
   * The rules are asserted as the shapes that implement them.
   */
  // THE SHARED GATE, not a per-component one: held in a ref it died with the
  // component, and this modal remounts, so every remount got a clean slate and
  // was allowed another request and another log line.
  assert.match(MODAL, /import \{ inboxMetaGate, inboxMetaInFlight, setInboxMetaInFlight \}/)
  assert.doesNotMatch(MODAL, /useRef\(createMetaGate/)
  // SINGLE FLIGHT: a second caller awaits the first request.
  assert.match(MODAL, /const pending = inboxMetaInFlight<typeof empty>\(\)/)
  assert.match(MODAL, /if \(pending !== null\) return pending/)
  // BACKOFF: a blocked caller degrades instead of requesting.
  assert.match(MODAL, /if \(!inboxMetaGate\.mayRequest\(\)\) return empty/)
  // AND THE LOG IS CONDITIONAL on it being the first failure of a run.
  assert.match(MODAL, /if \(inboxMetaGate\.failed\(\)\) \{/)
  assert.match(MODAL, /inboxMetaGate\.succeeded\(\)/)
  // THE SLOT IS ALWAYS RELEASED, or one failure would wedge the inbox forever.
  assert.match(MODAL, /finally \{\s*\n\s*setInboxMetaInFlight\(null\)/)
})

test('QA-012 nothing here reads the environment or a message body', () => {
  // The cure must not be keyed on development, on a status code's meaning or
  // on what the route happened to say. Hammering a failing endpoint is wrong
  // everywhere.
  // EXECUTABLE TEXT ONLY: the comment above explains what went wrong and names
  // the variable that was missing, which is the opposite of keying on it.
  const SRC = readFileSync(fileURLToPath(new URL('./metaGate.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
  assert.doesNotMatch(SRC, /NODE_ENV|process\.env/)
  assert.doesNotMatch(SRC, /Server configuration|SERVICE_ROLE|500/)
})

test('QA-012 the gate outlives the component that uses it', () => {
  // A remount must not reset the backoff: the endpoint's health is a fact
  // about the server, not about any component's lifetime.
  const SRC = readFileSync(fileURLToPath(new URL('./metaGate.ts', import.meta.url)), 'utf8')
  assert.match(SRC, /export const inboxMetaGate = createMetaGate\(\)/)
  assert.match(SRC, /^let inFlight: Promise<unknown> \| null = null$/m)
})
