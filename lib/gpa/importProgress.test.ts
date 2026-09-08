import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  IDLE_IMPORT, IMPORT_STAGES, advance, beginImport, blockedUploadReason, canStartImport,
  cancelImport, classifyFailure, destinationLine, elapsedMs, fail, failureCopy, formatElapsed,
  isRetryable, noteAttempt, reassuranceFor, stageList, statusAnnouncement, succeed,
  KEEP_PAGE_OPEN, type ImportState,
} from './importProgress.ts'
import { ALLOWED_METRIC_KEYS, importMetrics, recordImport, recentImports, clearImports } from './importTelemetry.ts'

const UI_PATH = path.join(process.cwd(), 'app/gpa-calculator/components/ImportProgress.tsx')
const readUi = () => fs.readFileSync(UI_PATH, 'utf8')
/** The component with its prose stripped, so comments cannot satisfy a test. */
const uiCode = () => readUi().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const T0 = 1_700_000_000_000
const start = (over: Partial<Parameters<typeof beginImport>[0]> = {}): ImportState =>
  beginImport({ destination: 'separate', now: T0, ...over })

// ------------------------------------------------------------- the transition
test('PROGRESS: idle becomes running only when analysis really begins', () => {
  assert.equal(IDLE_IMPORT.phase, 'idle')
  assert.equal(IDLE_IMPORT.startedAt, null)
  assert.equal(canStartImport(IDLE_IMPORT), true)

  const s = start({ fileName: 'transcript.pdf', analysisName: 'Rutgers' })
  assert.equal(s.phase, 'running')
  assert.equal(s.stage, 'received')
  assert.equal(s.startedAt, T0, 'the clock starts with the analysis, not with the click')
  assert.equal(s.attempts, 0, 'no request has been made yet')
})

test('PROGRESS: stages only move forward, and only while running', () => {
  let s = advance(start(), 'analyzing')
  assert.equal(s.stage, 'analyzing')
  assert.equal(advance(s, 'reading').stage, 'analyzing', 'never backwards')
  const done = succeed(s, T0 + 1000)
  assert.equal(advance(done, 'importing').stage, 'importing',
    'a finished import is not re-staged')
})

test('PROGRESS: success and failure both leave the running state', () => {
  const s = advance(start(), 'importing')
  const ok = succeed(s, T0 + 30_000)
  assert.equal(ok.phase, 'success')
  assert.equal(ok.endedAt, T0 + 30_000)
  assert.equal(ok.failure, null)
  assert.equal(canStartImport(ok), true, 'another transcript may be uploaded again')

  const bad = fail(s, 'timeout', T0 + 30_000)
  assert.equal(bad.phase, 'error')
  assert.equal(bad.failure, 'timeout')
  assert.equal(canStartImport(bad), true)
})

test('PROGRESS: cancelling before analysis leaves no trace', () => {
  const s = cancelImport()
  assert.deepEqual(s, IDLE_IMPORT)
  assert.equal(s.startedAt, null, 'no timer was ever started')
  assert.equal(s.attempts, 0, 'no analyzer request was made')
})

// -------------------------------------------------------------------- timer
test('TIMER: elapsed is measured from the real start', () => {
  const s = start()
  assert.equal(elapsedMs(s, T0 + 18_000), 18_000)
  assert.equal(elapsedMs(IDLE_IMPORT, T0 + 18_000), 0)
})

test('TIMER: a finished import freezes at its real duration', () => {
  const s = succeed(start(), T0 + 42_000)
  assert.equal(elapsedMs(s, T0 + 999_000), 42_000, 'the clock stops when the work stops')
})

test('TIMER: formatting is minutes and seconds, never a countdown', () => {
  assert.equal(formatElapsed(0), '0:00')
  assert.equal(formatElapsed(7_400), '0:07')
  assert.equal(formatElapsed(18_000), '0:18')
  assert.equal(formatElapsed(67_000), '1:07')
  assert.equal(formatElapsed(134_000), '2:14')
  assert.equal(formatElapsed(754_000), '12:34')
  assert.equal(formatElapsed(-5), '0:00')
})

// ------------------------------------------------------------- reassurance
test('REASSURANCE: the message changes at real thresholds', () => {
  assert.match(reassuranceFor(0), /can take a few minutes/i)
  assert.match(reassuranceFor(39_000), /can take a few minutes/i)
  assert.match(reassuranceFor(40_000), /still working/i)
  assert.match(reassuranceFor(79_000), /still working/i)
  assert.match(reassuranceFor(80_000), /don’t upload it again/i)
  assert.match(reassuranceFor(150_000), /validating the coursework/i)
})

test('REASSURANCE: nothing promises a deadline or calls the process stuck', () => {
  for (const ms of [0, 40_000, 80_000, 150_000, 600_000]) {
    const text = reassuranceFor(ms)
    assert.ok(!/stuck|frozen|failed|almost done|nearly|any second/i.test(text), text)
    assert.ok(!/\d+\s*(seconds|minutes) (left|remaining)/i.test(text), text)
  }
})

// ------------------------------------------------------- no fake progress
test('HONESTY: there is no percentage anywhere in the progress model', () => {
  const states = [IDLE_IMPORT, start(), advance(start(), 'analyzing'),
                  succeed(start(), T0 + 1), fail(start(), 'timeout', T0 + 1)]
  for (const s of states) {
    for (const value of Object.values(s)) {
      assert.ok(typeof value !== 'number' || !(value > 0 && value <= 100 && String(value).includes('%')))
    }
    assert.ok(!JSON.stringify(s).includes('%'))
    assert.ok(!('percent' in s) && !('progress' in s), 'no percentage field exists')
  }
  for (const ms of [0, 40_000, 80_000, 150_000]) assert.ok(!/%/.test(reassuranceFor(ms)))
  // And the UI cannot render one, because the component never receives one.
  assert.ok(!/%\s*complete|percent|\bwidth:\s*\$\{/i.test(uiCode()), 'no percentage or growing bar')
})

test('HONESTY: stages are only marked done once they are genuinely past', () => {
  const s = advance(start(), 'analyzing')
  const list = stageList(s)
  assert.deepEqual(list.map(x => x.status), ['done', 'done', 'active', 'pending', 'pending'])
  // A failure never leaves the stage it died in looking complete.
  const dead = stageList(fail(s, 'service', T0 + 1))
  assert.equal(dead.find(x => x.id === 'analyzing')!.status, 'pending')
  assert.equal(dead.filter(x => x.status === 'done').length, 2)
})

test('HONESTY: nothing offers background processing', () => {
  assert.match(KEEP_PAGE_OPEN, /keep this page open/i)
  assert.ok(!/we.{0,3}ll (notify|email|let you know)|in the background|leave this page/i.test(uiCode()))
})

// ------------------------------------------------------------ failure copy
test('FAILURE: a timeout says the file is fine', () => {
  const c = failureCopy('timeout')
  assert.match(c.message, /took longer than expected/i)
  assert.match(c.message, /your transcript file is okay/i)
  assert.equal(c.canRetry, true)
})

test('FAILURE: an upstream failure is not blamed on the file', () => {
  for (const kind of ['service', 'network'] as const) {
    const c = failureCopy(kind)
    assert.equal(c.canRetry, true)
    assert.ok(!/unreadable|couldn’t read|not enough text/i.test(c.message), kind)
  }
  assert.match(failureCopy('service').message, /on our side, not your file/i)
})

test('FAILURE: an unreadable PDF gets its own copy, and no pointless retry', () => {
  const c = failureCopy('unreadable')
  assert.match(c.message, /couldn’t read enough text/i)
  assert.equal(c.canRetry, false, 'the same bytes would fail the same way')
  assert.equal(c.secondary, 'Choose Another File')
})

test('FAILURE: a failure after a successful analysis never offers to re-analyze', () => {
  const c = failureCopy('limit')
  assert.equal(c.canRetry, false, 'retrying would spend a second analysis on a read document')
  assert.equal(c.secondary, undefined)
  assert.match(c.message, /existing analyses were not changed/i)
})

test('FAILURE: every kind is classified from what the pipeline actually saw', () => {
  assert.equal(classifyFailure({ status: 504 }), 'timeout')
  assert.equal(classifyFailure({ name: 'AbortError' }), 'timeout')
  assert.equal(classifyFailure({ status: 502 }), 'service')
  assert.equal(classifyFailure({ status: 503 }), 'service')
  assert.equal(classifyFailure({ status: 500 }), 'service')
  assert.equal(classifyFailure({ status: 422, imageOnly: true }), 'unreadable')
  assert.equal(classifyFailure({ status: 422 }), 'unreadable')
  assert.equal(classifyFailure({ status: 415 }), 'unreadable')
  assert.equal(classifyFailure({ status: 413 }), 'too-large')
  assert.equal(classifyFailure({ status: 401 }), 'not-allowed')
  assert.equal(classifyFailure({ message: 'Failed to fetch' }), 'network')
  assert.equal(classifyFailure({ message: 'Load failed' }), 'network')
  assert.equal(classifyFailure({ message: 'something else' }), 'unknown')
  // A scanned document is unreadable even when the status suggests a timeout.
  assert.equal(classifyFailure({ status: 504, imageOnly: true }), 'unreadable')
})

test('FAILURE: only the kinds worth repeating are retryable', () => {
  assert.deepEqual(
    (['timeout', 'service', 'network', 'unknown', 'unreadable', 'too-large', 'not-allowed', 'limit'] as const)
      .filter(isRetryable),
    ['timeout', 'service', 'network', 'unknown'])
})

// -------------------------------------------------------- duplicate uploads
test('DUPLICATES: a running import blocks another upload, and says why', () => {
  const running = start()
  assert.equal(canStartImport(running), false)
  assert.equal(blockedUploadReason(running), 'Transcript analysis in progress')
  for (const done of [succeed(running, T0 + 1), fail(running, 'timeout', T0 + 1), IDLE_IMPORT]) {
    assert.equal(canStartImport(done), true)
    assert.equal(blockedUploadReason(done), null, 'nothing stays disabled once the work stops')
  }
})

test('DUPLICATES: a retry is a repeat of the same import, not a second one', () => {
  // Retrying reuses the destination that was already chosen, so the user is
  // never asked twice and the answer cannot drift between attempts.
  const chosen = start({ destination: 'combine', analysisName: 'Rutgers' })
  const failed = fail(advance(chosen, 'analyzing'), 'timeout', T0 + 60_000)
  const again = beginImport({
    destination: failed.destination!, analysisName: failed.analysisName, now: T0 + 70_000,
  })
  assert.equal(again.destination, 'combine')
  assert.equal(again.analysisName, 'Rutgers')
  assert.equal(again.startedAt, T0 + 70_000, 'the timer restarts')
  assert.equal(again.endedAt, null)
  assert.equal(again.failure, null, 'the old error is cleared')
  assert.equal(again.attempts, 0)
  assert.equal(canStartImport(again), false, 'and it cannot be submitted twice')
})

// ------------------------------------------------------------ D47 wording
test('D47: combine wording says the existing analysis is not touched', () => {
  const line = destinationLine(start({ destination: 'combine', analysisName: 'Rutgers' }))
  assert.match(line, /“Rutgers” will remain unchanged/)
  assert.match(line, /new combined analysis will be created/)
  assert.ok(!/re-?analy/i.test(line), 'the existing analysis is never re-analyzed')
})

test('D47: separate and fill wording claim nothing about other analyses', () => {
  assert.match(destinationLine(start({ destination: 'separate' })), /for a new analysis/i)
  assert.match(
    destinationLine(start({ destination: 'fill', analysisName: 'Untitled Analysis' })),
    /for “Untitled Analysis”/)
})

// ------------------------------------------------------------ announcements
test('A11Y: the announcement carries stages, never the elapsed time', () => {
  const s = advance(start(), 'analyzing')
  const said = statusAnnouncement(s)
  assert.match(said, /Analyzing coursework/i)
  assert.ok(!/\d+:\d\d/.test(said), 'no timer value is ever announced')
  assert.equal(statusAnnouncement(IDLE_IMPORT), '')
  assert.equal(statusAnnouncement(succeed(s, T0 + 1)), 'Transcript analyzed.')
  assert.match(statusAnnouncement(fail(s, 'timeout', T0 + 1)), /couldn’t finish/i)
})

test('A11Y: the announcement is stable while only the clock moves', () => {
  const s = advance(start(), 'analyzing')
  // Same stage at 1s and at 90s: an assistive technology hears it once.
  assert.equal(statusAnnouncement(s), statusAnnouncement({ ...s }))
  assert.notEqual(statusAnnouncement(s), statusAnnouncement(advance(s, 'validating')))
})

test('A11Y: the timer is hidden from assistive technology in the UI', () => {
  const ui = readUi()
  // The elapsed value is rendered inside an aria-hidden element...
  assert.match(ui, /aria-hidden[\s\S]{0,200}formatElapsed\(ms\)/)
  // ...and the live region holds the stage announcement only.
  assert.match(ui, /aria-live="polite">\{statusAnnouncement\(state\)\}/)
  assert.ok(!/aria-live[\s\S]{0,120}formatElapsed/.test(ui), 'the timer is never a live region')
  // Motion is opt-out everywhere it is used.
  const spins = ui.match(/animate-spin/g) ?? []
  const reduced = ui.match(/motion-reduce:animate-none/g) ?? []
  assert.equal(spins.length, reduced.length, 'every animation respects reduced motion')
})

// ------------------------------------------------------------------ stages
test('STAGES: the list is the honest one the client can observe', () => {
  assert.deepEqual(IMPORT_STAGES.map(s => s.id),
    ['received', 'reading', 'analyzing', 'validating', 'importing'])
  // Nothing claims to see inside the analyzer request.
  for (const s of IMPORT_STAGES) {
    assert.ok(!/institution detection|prompt|token|model/i.test(s.label + s.detail), s.id)
  }
})

// ------------------------------------------------------------- telemetry
test('METRICS: a finished import records duration, attempts and outcome', () => {
  clearImports()
  let s = start({ destination: 'combine', analysisName: 'Rutgers', fileName: 'secret-name.pdf' })
  s = noteAttempt(s)
  s = noteAttempt(s, 'structural')
  s = succeed(advance(s, 'importing'), T0 + 64_000)
  const m = importMetrics(s, T0 + 64_000, { courses: 45, pages: 3, promptTokens: 12_000, completionTokens: 900 })
  assert.equal(m.durationMs, 64_000)
  assert.equal(m.attempts, 2)
  assert.equal(m.structuralRetry, true)
  assert.equal(m.scaleRetry, false)
  assert.equal(m.outcome, 'success')
  assert.equal(m.failure, null)
  assert.equal(m.courses, 45)
  assert.equal(m.promptTokens, 12_000)
  recordImport(m)
  assert.equal(recentImports().length, 1)
})

test('METRICS: a failure records how far it got and why it stopped', () => {
  const s = fail(noteAttempt(advance(start(), 'analyzing')), 'timeout', T0 + 120_000)
  const m = importMetrics(s, T0 + 120_000)
  assert.equal(m.outcome, 'failure')
  assert.equal(m.failure, 'timeout')
  assert.equal(m.stage, 'analyzing')
  assert.equal(m.attempts, 1)
})

test('METRICS: nothing from the transcript can reach the record', () => {
  const s = succeed(start({ fileName: 'Jane Doe Rutgers transcript.pdf', analysisName: 'Jane Doe' }), T0 + 5)
  const m = importMetrics(s, T0 + 5, { courses: 27 })
  for (const key of Object.keys(m)) {
    assert.ok((ALLOWED_METRIC_KEYS as readonly string[]).includes(key), `unexpected field: ${key}`)
  }
  const serialized = JSON.stringify(m)
  assert.ok(!/Jane Doe/.test(serialized), 'no name, file name or transcript text')
  assert.ok(!/pdf/i.test(serialized))
  assert.ok(!/key|token_|authorization|sk-/i.test(serialized.replace(/Tokens/g, '')))
})

// ------------------------------------------------ how the page wires it up
const PAGE = path.join(process.cwd(), 'app/gpa-calculator/page.tsx')
const pageCode = () => fs.readFileSync(PAGE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('WIRING: the destination is settled before any analysis begins', () => {
  const code = pageCode()
  const ask = code.indexOf('await askDestination()')
  const begin = code.indexOf('beginImport({')
  assert.ok(ask > 0 && begin > 0)
  assert.ok(ask < begin,
    'the user answers first, so the panel can say what will happen and a retry can repeat it')
})

test('WIRING: retry reuses the stored destination instead of asking again', () => {
  const code = pageCode()
  const retry = code.slice(code.indexOf('const retryImport ='), code.indexOf('const runImport ='))
  assert.ok(retry.includes('pendingImport.current'), 'the same file and destination are reused')
  assert.ok(!retry.includes('askDestination'), 'the user is never asked twice')
  assert.ok(retry.includes('canStartImport(importState)'), 'and it cannot double-submit')
})

test('WIRING: every path that opens the file picker is guarded', () => {
  const code = pageCode()
  const picker = code.slice(code.indexOf('const openTranscriptPicker'))
    .slice(0, 400)
  assert.match(picker, /if \(!canStartImport\(importState\)\) return/)
  const handler = code.slice(code.indexOf('const handleTranscriptUpload'))
    .slice(0, 700)
  assert.match(handler, /if \(!canStartImport\(importState\)\) return/,
    'a change event that arrives anyway is refused too')
})

test('WIRING: a retry of a failed import cannot duplicate coursework', () => {
  // Nothing is written until the very end of the pipeline, so a failed attempt
  // leaves the open analysis exactly as it was and the retry starts from the
  // same place -- it cannot accumulate.
  const code = pageCode()
  const run = code.slice(code.indexOf('const runImport ='), code.indexOf('const saveCalculation'))
  const importing = run.indexOf("push(advance(st, 'importing'))")
  assert.ok(importing > 0)
  for (const write of ['setCourses(prev =>', 'await createAnalysis(']) {
    const at = run.indexOf(write)
    assert.ok(at > importing, `${write} happens only after the pipeline has succeeded`)
  }
  assert.equal(run.split('setCourses(prev =>').length - 1, 1, 'one write, one place')
})

// ------------------------------------------------------ D36 naming wiring
test('WIRING: the analysis is smart-named only after institutions are resolved', () => {
  const code = pageCode()
  const run = code.slice(code.indexOf('const runImport ='), code.indexOf('const saveCalculation'))
  const resolved = run.indexOf('setInstitutions(liveInstitutions)')
  const named = run.indexOf('smartAnalysisName({')
  assert.ok(resolved > 0 && named > 0)
  assert.ok(named > resolved, 'the name comes from resolved institution rows, not raw analyzer text')
  assert.equal(run.split('smartAnalysisName({').length - 1, 1, 'named once, so the name cannot flicker')
})

test('WIRING: smart naming reads resolved data and calls no API of its own', () => {
  const code = pageCode()
  const run = code.slice(code.indexOf('const runImport ='), code.indexOf('const saveCalculation'))
  const block = run.slice(run.indexOf('smartAnalysisName({'), run.indexOf('smartAnalysisName({') + 500)
  assert.ok(block.includes('namesIn(fresh)'), 'names come from the resolved institution rows')
  assert.ok(!/fetch\(|analyze-transcript/.test(block), 'no second analyzer pass just to pick a name')
  // The analyzer is called in exactly one place, and it is not this one.
  assert.equal(run.split("fetch('/api/analyze-transcript'").length - 1, 1)
})

test('WIRING: the standalone path still names a new analysis at creation', () => {
  const code = pageCode()
  const run = code.slice(code.indexOf("if (destination === 'separate')"), code.indexOf("// 'fill'"))
  assert.match(run, /analysisNameFromInstitutions\(namesIn\(coursesWithIds\)\)/)
})

test('WIRING: D47 combine naming is untouched by the naming fix', () => {
  const code = pageCode()
  // A combined analysis is still named by the combine planner, not by the
  // transcript-naming path, and no source analysis is renamed anywhere.
  assert.match(code, /planCombineWithNewCourses\(\{/)
  assert.match(code, /createAnalysis\(plan\.name, \{/)
  const run = code.slice(code.indexOf('const runImport ='), code.indexOf('const saveCalculation'))
  const combine = run.slice(run.indexOf("if (destination === 'combine')"), run.indexOf("if (destination === 'separate')"))
  assert.ok(!combine.includes('renameAnalysis'), 'combining never renames an existing analysis')
  assert.ok(!combine.includes('smartAnalysisName'), 'the combined name comes from the planner')
})
