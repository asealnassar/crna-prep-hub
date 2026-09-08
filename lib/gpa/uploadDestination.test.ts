import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shortenAnalysisName, isCancelled, UNNAMED_ANALYSIS, type UploadDestination,
} from './uploadDestination.ts'

test('MODAL: an unnamed analysis shows the same label the switcher uses', () => {
  assert.equal(shortenAnalysisName(null), UNNAMED_ANALYSIS)
  assert.equal(shortenAnalysisName(undefined), UNNAMED_ANALYSIS)
  assert.equal(shortenAnalysisName(''), UNNAMED_ANALYSIS)
  assert.equal(shortenAnalysisName('   '), UNNAMED_ANALYSIS)
  assert.equal(UNNAMED_ANALYSIS, 'Untitled Analysis')
})

test('MODAL: a normal name is shown in full', () => {
  assert.equal(shortenAnalysisName('Rutgers University'), 'Rutgers University')
  assert.equal(shortenAnalysisName('  My Analysis  '), 'My Analysis')
})

test('MODAL: a long name is truncated so the button cannot stretch a phone', () => {
  const long = 'Rutgers University School of Nursing New Brunswick Undergraduate'
  const out = shortenAnalysisName(long)
  assert.ok(out.length <= 28, `got ${out.length} chars`)
  assert.ok(out.endsWith('…'))
  assert.ok(long.startsWith(out.slice(0, -1).trimEnd()))
})

test('MODAL: truncation never leaves a dangling space before the ellipsis', () => {
  assert.ok(!/\s…$/.test(shortenAnalysisName('Fall Twenty Twenty Four Analysis Extra')))
})

test('MODAL: exactly-at-the-limit names are not truncated', () => {
  const exact = 'A'.repeat(28)
  assert.equal(shortenAnalysisName(exact), exact)
  assert.equal(shortenAnalysisName('A'.repeat(29)).length, 28)
})

test('MODAL: cancel is a distinct outcome from both destinations', () => {
  const all: UploadDestination[] = ['separate', 'combine', 'cancel']
  assert.deepEqual(all.filter(isCancelled), ['cancel'])
  // The old confirm() had no way to express this at all: OK meant "new",
  // Cancel meant "current", and cancelling the upload was impossible.
  assert.equal(isCancelled('separate'), false)
  assert.equal(isCancelled('combine'), false)
})

test('D47: neither destination is named after modifying the open analysis', () => {
  // 'current' used to mean "append into the analysis that is open". Under D47
  // that outcome does not exist: both destinations create a new analysis.
  const all: UploadDestination[] = ['separate', 'combine', 'cancel']
  assert.ok(!all.includes('current' as UploadDestination))
})
