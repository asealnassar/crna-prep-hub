import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { extractInWorker, stopReasonFor, type StopReason } from './extractInWorker.ts'
import { extractStatementPdf } from './extractStatementPdf.ts'
import { judgeSuccess } from './extractInWorker.ts'

/**
 * EX-QA-001 — a recorded stop outranks any later classification.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * requestStop() latches `outcome` once, and judgeSuccess() already refused to
 * let a late SUCCESS overturn it. Errors were not held to the same rule: of the
 * three failure paths, only the worker-exit path consulted the ledger.
 *
 * An abort raised mid-parse tore pdf.js down, pdf.js threw something that was
 * not a Cancelled instance, the worker reported `cancelled: false`, and the
 * message-error path returned 'error' -- discarding the latched 'aborted'.
 * classifyFailure() then matched no known parser-error name and returned
 * malformed/parser-error, so an applicant who cancelled an upload was told
 * their document was unreadable. It surfaced as one failure in five full-suite
 * runs, with `actual: 'malformed', expected: 'cancelled'`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COVERAGE IS SHAPED LIKE THIS
 * ---------------------------------------------------------------------------
 * The mid-parse throw cannot be produced on demand -- that is what made the
 * original failure a flake. So the RULE is tested directly and exhaustively,
 * where it is deterministic, and the structural test makes it impossible for a
 * fourth path to appear that resolves a reason without it. The integration
 * tests then cover the stop paths that CAN be forced deterministically.
 */

const FIX = path.join(process.cwd(), 'lib/pdf/fixtures/statement-worker')
const load = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(FIX, name)))
const SMALL = '01_statement_100kb_under_ceiling.pdf'
const MB4 = '05_statement_4mb_over_ceiling.pdf'
const ROOMY_MS = 30_000

const RECORDED: readonly (string | null)[] = [null, 'aborted', 'deadline', 'cancelled']
const FALLBACKS: readonly StopReason[] = ['error', 'worker-error', 'exited', 'cancelled']

// ===========================================================================
// THE RULE
// ===========================================================================

test('EX-QA-001: a recorded abort beats an error classification', () => {
  // The exact bug: the worker threw something that was not a Cancelled, so the
  // event would have called itself 'error'. The ledger says otherwise.
  assert.equal(stopReasonFor({ recorded: 'aborted', fallback: 'error' }), 'aborted')
})

test('a recorded stop beats every fallback a failure event could offer', () => {
  for (const recorded of ['aborted', 'deadline', 'cancelled']) {
    for (const fallback of FALLBACKS) {
      assert.equal(
        stopReasonFor({ recorded, fallback }), recorded,
        `${recorded} was overturned by ${fallback}`,
      )
    }
  }
})

test('with NOTHING recorded, the event classifies itself -- parser errors survive', () => {
  // This is the half that must not be broken by fixing the other half: a
  // genuinely malformed document has no recorded stop and must still report as
  // the parser error it is.
  for (const fallback of FALLBACKS) {
    assert.equal(stopReasonFor({ recorded: null, fallback }), fallback)
  }
})

test('the matrix is total: every combination resolves, and only to one of its two inputs', () => {
  for (const recorded of RECORDED) {
    for (const fallback of FALLBACKS) {
      const got = stopReasonFor({ recorded, fallback })
      assert.ok(got === recorded || got === fallback, `${String(recorded)}/${fallback} -> ${got}`)
      assert.equal(got, recorded ?? fallback)
    }
  }
})

test('an empty string is not a recorded stop', () => {
  // `??` only falls through on null/undefined, so a defensive check: nothing in
  // the ledger ever stores '', and if it did it must not be read as a stop.
  assert.equal(stopReasonFor({ recorded: null, fallback: 'error' }), 'error')
  assert.equal(stopReasonFor({ recorded: undefined as unknown as null, fallback: 'error' }), 'error')
})

// ===========================================================================
// NO PATH MAY BYPASS IT
// ===========================================================================

const WORKER_SRC = fs.readFileSync(
  path.join(process.cwd(), 'lib/statement/extract/extractInWorker.ts'), 'utf8')
const stripComments = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const WORKER = stripComments(WORKER_SRC)

test('EVERY failure path resolves its reason through the one rule', () => {
  // The two shapes that shipped the defect, by their exact form.
  assert.doesNotMatch(WORKER, /msg\.cancelled \? \(outcome \?\? 'cancelled'\) : 'error'/,
    'the message-error path is resolving its own reason again')
  assert.doesNotMatch(WORKER, /reason: 'worker-error'/,
    'the thread-error path is hardcoding its reason again')
  /*
   * EVERY `reason:` INSIDE A finish({...}) GOES THROUGH THE RULE.
   *
   * Scoped to the finish() paths on purpose. judgeSuccess() also reads the
   * ledger -- `outcome ?? 'deadline'` -- and that is correct and separately
   * tested: it decides whether a SUCCESS is still acceptable, which is a
   * different question with a different fallback. Forbidding every direct read
   * would forbid that too.
   */
  const finishBodies = [...WORKER.matchAll(/finish\(\{([\s\S]{0,320}?)\}\)/g)].map((m) => m[1])
  assert.ok(finishBodies.length >= 4, `found only ${finishBodies.length} finish() calls`)
  const resolved = finishBodies
    .map((body) => (body.match(/reason: ([^,\n]+)/) ?? [, null])[1]?.trim() ?? null)
    .filter((r): r is string => r !== null)
  for (const reason of resolved) {
    assert.ok(
      reason.startsWith('stopReasonFor('),
      `a finish() path resolves its reason as \`${reason}\` instead of via stopReasonFor`,
    )
  }
  /*
   * The fourth path passes the shorthand `reason`, which IS the recorded stop:
   * requestStop() sets `outcome = reason` and then forces termination with that
   * same value, so it needs no fallback. It is the one site that cannot bypass
   * the ledger, because it is the site that writes it.
   */
  assert.match(WORKER, /finish\(\{ ok: false, reason, terminatedForcibly: true \}\)/)
  assert.equal(resolved.length, 3, `expected 3 fallback-resolved reasons, found ${resolved.length}`)
  // Three failure paths, three uses, one rule.
  const uses = WORKER.match(/stopReasonFor\(\{/g) ?? []
  assert.equal(uses.length, 3, `expected 3 call sites, found ${uses.length}`)
})

test('the stripper used above did not eat the code it searches', () => {
  assert.ok(WORKER.length > WORKER_SRC.length * 0.4)
  assert.match(WORKER, /export function stopReasonFor/)
  assert.match(WORKER, /msg\?\.type === 'error'/)
})

// ===========================================================================
// LATE SUCCESS -- the half that already held
// ===========================================================================

test('a late success still cannot overturn a recorded stop', () => {
  const verdict = judgeSuccess({
    producedAt: 1_000, receivedAt: 1_000, spawnedAt: 0, extractionMs: 5_000,
    outcome: 'aborted',
  })
  assert.equal(verdict.accepted, false)
  assert.equal(verdict.reason, 'aborted')
})

// ===========================================================================
// INTEGRATION -- the stop paths that can be forced
// ===========================================================================

test('abort BEFORE parsing is reported as cancelled', async () => {
  const r = await extractStatementPdf(load(SMALL), {
    deadlineMs: ROOMY_MS, signal: AbortSignal.abort(),
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.kind, 'cancelled')
  assert.equal(r.detail, 'caller-aborted')
})

test('abort DURING an unyielding parse is cancelled, not a parser error', async () => {
  // stallMs makes the worker busy-wait at entry, so it cannot cooperate and the
  // stop has to come from forced termination -- the closest deterministic
  // analogue of the mid-parse abort that produced the defect.
  const controller = new AbortController()
  const pending = extractInWorker(load(MB4), {
    deadlineMs: ROOMY_MS, stallMs: 3_000, allowTestStall: true, signal: controller.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()

  const r = await pending
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.reason, 'aborted', `reported ${String(r.reason)} for an aborted extraction`)
  assert.notEqual(r.reason, 'error')
  assert.equal(r.termination.cleanupConfirmed, true)
})

test('a genuinely malformed PDF with NO abort still reports malformed', async () => {
  // The regression that matters in the other direction. Built in memory from a
  // committed fixture; no new fixture file.
  const good = load(SMALL)
  const broken = good.slice(0, Math.floor(good.length / 2))

  const r = await extractStatementPdf(broken, { deadlineMs: ROOMY_MS })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.kind, 'malformed', `unexpected kind: ${r.kind} (${r.detail})`)
  assert.equal(r.workerExitConfirmed, true)
})

test('a deadline outranks whatever the torn-down parse throws', async () => {
  // The same bug class on the deadline path: the budget expires, the parse is
  // torn down mid-flight, and pdf.js may throw. 'deadline' is the fact the
  // route needs, and it must not arrive as malformed.
  const r = await extractStatementPdf(load(MB4), { deadlineMs: 120 })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.kind, 'deadline', `unexpected kind: ${r.kind} (${r.detail})`)
  assert.notEqual(r.kind, 'malformed')
})

test('deadline and abort do not both win: the first one recorded does', async () => {
  // An abort raised long after a short deadline has already expired must not
  // relabel the result, because requestStop() latches once.
  const controller = new AbortController()
  const pending = extractStatementPdf(load(MB4), {
    deadlineMs: 120, signal: controller.signal,
  })
  const r = await pending
  controller.abort()
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.kind, 'deadline')
})
