import { test } from 'node:test'
import assert from 'node:assert/strict'
import { institutionHintFromFilename } from './filenameHint.ts'

test('D46: a filename carrying a school name yields a hint', () => {
  assert.equal(institutionHintFromFilename('Montclair Transcript.pdf'), 'Montclair')
  assert.equal(institutionHintFromFilename('Rutgers_Official_Transcript.pdf'), 'Rutgers')
  assert.equal(institutionHintFromFilename('rutgers transcript.pdf'), 'rutgers')
  assert.equal(institutionHintFromFilename('North-Valley-College-transcript.pdf'), 'North Valley')
})

test('D46: a filename that says nothing yields no hint', () => {
  for (const f of ['transcript.pdf', 'final.pdf', 'scan_2.pdf', 'doc.pdf',
                   'official copy.pdf', '2024.pdf', '.pdf', '', null, undefined]) {
    assert.equal(institutionHintFromFilename(f), null, String(f))
  }
})

test('D46: duplicate markers and dates are not part of the hint', () => {
  assert.equal(institutionHintFromFilename('Montclair Transcript (1).pdf'), 'Montclair')
  assert.equal(institutionHintFromFilename('Harborview_transcript_2024.pdf'), 'Harborview')
})

test('D46: the hint is bounded', () => {
  const long = institutionHintFromFilename('A'.repeat(200) + ' transcript.pdf')
  assert.ok(long !== null && long.length <= 60)
})
