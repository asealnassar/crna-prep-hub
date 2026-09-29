import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAX_CONCURRENT_PDF_EXTRACTIONS, createPdfCapacity, pdfCapacity } from './capacity.ts'

/**
 * The per-process PDF capacity gate.
 *
 * PURE. No worker, no PDF, no fixture, no HTTP. Every test builds its own gate
 * with createPdfCapacity(), so nothing here can be affected by another test or
 * leave state behind -- which is also why the production gate needs no reset hook.
 */

test('capacity: the approved candidate policy is one slot', () => {
  assert.equal(MAX_CONCURRENT_PDF_EXTRACTIONS, 1)
  assert.deepEqual(pdfCapacity.snapshot(), { limit: 1, active: 0, available: 1, fenced: false })
})

test('capacity: the first caller gets the one slot', () => {
  const gate = createPdfCapacity()
  const first = gate.tryAcquire()
  assert.equal(first.admitted, true)
  assert.deepEqual(gate.snapshot(), { limit: 1, active: 1, available: 0, fenced: false })
})

test('capacity: a second simultaneous caller is refused immediately', () => {
  const gate = createPdfCapacity()
  const first = gate.tryAcquire()
  const second = gate.tryAcquire()

  assert.equal(first.admitted, true)
  assert.equal(second.admitted, false)
  if (!second.admitted) assert.equal(second.reason, 'at-capacity')
  // Refused, not queued: there is no promise to await and no slot reserved.
  assert.equal(gate.snapshot().active, 1)
})

test('capacity: admission is atomic — no await can interleave the check and the take', () => {
  // THE BEHAVIOURAL HALF. Both calls happen in one synchronous run of this
  // function, with nothing between them. If tryAcquire() were async, or awaited
  // internally, both could observe a free slot and both take it.
  const gate = createPdfCapacity()
  const results = [gate.tryAcquire(), gate.tryAcquire(), gate.tryAcquire()]
  assert.equal(results.filter((r) => r.admitted).length, 1, 'more than one caller was admitted')
  assert.equal(gate.snapshot().active, 1)

  // THE STRUCTURAL HALF. The property above holds only because the function does
  // not yield. Asserted against the source so a later `await` cannot quietly
  // reintroduce the race while these tests keep passing.
  const source = readFileSync(fileURLToPath(new URL('./capacity.ts', import.meta.url)), 'utf8')
  const body = source.slice(source.indexOf('tryAcquire(): Admission {'), source.indexOf('snapshot(): CapacitySnapshot'))
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\bawait\b/, 'tryAcquire must not await')
  assert.doesNotMatch(code, /async\s+tryAcquire/, 'tryAcquire must not be async')
})

test('capacity: a confirmed worker exit returns the slot', () => {
  const gate = createPdfCapacity()
  const admission = gate.tryAcquire()
  assert.equal(admission.admitted, true)
  if (!admission.admitted) return

  admission.slot.release('exit-confirmed')
  assert.deepEqual(gate.snapshot(), { limit: 1, active: 0, available: 1, fenced: false })

  // And the next caller can have it.
  assert.equal(gate.tryAcquire().admitted, true)
})

test('capacity: an UNCONFIRMED exit fences the gate and never returns the slot', () => {
  const gate = createPdfCapacity()
  const admission = gate.tryAcquire()
  assert.equal(admission.admitted, true)
  if (!admission.admitted) return

  admission.slot.release('exit-unconfirmed')

  // The slot is deliberately still held: the thread it stands for may still be
  // running, still holding somebody's document.
  const snap = gate.snapshot()
  assert.equal(snap.fenced, true)
  assert.equal(snap.active, 1, 'an unconfirmed exit must not decrement')
  assert.equal(snap.available, 0)

  // And the refusal says WHY, distinctly from ordinary contention.
  const next = gate.tryAcquire()
  assert.equal(next.admitted, false)
  if (!next.admitted) assert.equal(next.reason, 'unconfirmed-worker')
})

test('capacity: fencing survives a gate with more than one slot', () => {
  // The fence is not merely "the one slot is held". With three slots, two free,
  // an unconfirmed exit must still stop the process taking more PDF work.
  const gate = createPdfCapacity(3)
  const a = gate.tryAcquire()
  assert.equal(a.admitted, true)
  if (!a.admitted) return
  assert.equal(gate.snapshot().available, 2)

  a.slot.release('exit-unconfirmed')

  const next = gate.tryAcquire()
  assert.equal(next.admitted, false)
  if (!next.admitted) assert.equal(next.reason, 'unconfirmed-worker')
})

test('capacity: releasing twice cannot corrupt the counter', () => {
  const gate = createPdfCapacity()
  const admission = gate.tryAcquire()
  assert.equal(admission.admitted, true)
  if (!admission.admitted) return

  admission.slot.release('exit-confirmed')
  admission.slot.release('exit-confirmed')
  admission.slot.release('exit-confirmed')

  // Never below zero, and never more available than the limit.
  const snap = gate.snapshot()
  assert.equal(snap.active, 0)
  assert.equal(snap.available, 1)
  assert.ok(snap.active >= 0)
})

test('capacity: a second release cannot un-fence a fenced gate', () => {
  const gate = createPdfCapacity()
  const admission = gate.tryAcquire()
  assert.equal(admission.admitted, true)
  if (!admission.admitted) return

  admission.slot.release('exit-unconfirmed')
  // A `finally` that somehow ran twice must not undo the fence.
  admission.slot.release('exit-confirmed')

  assert.equal(gate.snapshot().fenced, true)
  assert.equal(gate.tryAcquire().admitted, false)
})

test('capacity: independent gates do not share state', () => {
  const a = createPdfCapacity()
  const b = createPdfCapacity()
  const held = a.tryAcquire()
  assert.equal(held.admitted, true)
  assert.equal(a.snapshot().available, 0)
  // b is untouched, which is what makes these tests isolated.
  assert.equal(b.snapshot().available, 1)
  assert.equal(b.tryAcquire().admitted, true)
})

test('capacity: an invalid limit falls back to one rather than to zero or infinity', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    const gate = createPdfCapacity(bad)
    assert.equal(gate.snapshot().limit, 1, `limit for ${String(bad)}`)
    assert.equal(gate.tryAcquire().admitted, true, `first acquire for ${String(bad)}`)
    assert.equal(gate.tryAcquire().admitted, false, `second acquire for ${String(bad)}`)
  }
})

test('capacity: the module states that it is per-process, not global', () => {
  // A documentation assertion, deliberately. The single most likely way for this
  // safeguard to be misunderstood is for someone to read the counter as a
  // platform-wide limit, and the comment saying otherwise is load-bearing.
  const source = readFileSync(fileURLToPath(new URL('./capacity.ts', import.meta.url)), 'utf8')
  assert.match(source, /PER-PROCESS LIMIT\. IT IS NOT A GLOBAL LIMIT/)
  assert.match(source, /Vercel runs many instances/)
})
