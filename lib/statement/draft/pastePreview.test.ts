import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PASTE_PREVIEW_PARAM,
  PASTE_PREVIEW_VALUE,
  pasteOptionVisible,
  pasteSubmissionAllowed,
  pastePreviewAllowed,
  pastePreviewRequested,
  REVIEW_PREVIEW_VALUE,
  reviewPreviewRequested,
  REQUIREMENTS_PREVIEW_VALUE,
  requirementsPreviewRequested,
} from './pastePreview.ts'

const dev = { nodeEnv: 'development', isAdmin: true, requested: true }

test('preview needs ALL THREE conditions', () => {
  assert.equal(pastePreviewAllowed(dev), true)
  assert.equal(pastePreviewAllowed({ ...dev, nodeEnv: 'production' }), false)
  assert.equal(pastePreviewAllowed({ ...dev, isAdmin: false }), false)
  assert.equal(pastePreviewAllowed({ ...dev, requested: false }), false)
})

test('A QUERY PARAMETER ALONE AUTHORISES NOTHING', () => {
  // The only browser-controlled input of the three, and never sufficient.
  for (const env of ['production', 'test', undefined, '', 'Development', 'dev']) {
    assert.equal(
      pastePreviewAllowed({ nodeEnv: env, isAdmin: true, requested: true }), false,
      `NODE_ENV=${String(env)} must not allow preview`,
    )
  }
  // Nor can a non-admin ask for it, even in development.
  assert.equal(pastePreviewAllowed({ ...dev, isAdmin: false }), false)
})

test('every condition is compared to an exact value', () => {
  // A truthy-but-wrong flag must not open preview.
  for (const notTrue of [1, 'true', {}, [], 'yes']) {
    assert.equal(pastePreviewAllowed({ ...dev, isAdmin: notTrue as never }), false)
    assert.equal(pastePreviewAllowed({ ...dev, requested: notTrue as never }), false)
  }
})

test('only the exact parameter value is a request', () => {
  assert.equal(PASTE_PREVIEW_PARAM, 'preview')
  assert.equal(pastePreviewRequested(PASTE_PREVIEW_VALUE), true)
  for (const other of ['', 'true', '1', 'on', 'prompt', 'Prompt-Paste', ' prompt-paste',
                       'prompt-paste ', undefined, null, true, 1, {}]) {
    assert.equal(pastePreviewRequested(other), false, `${String(other)} is not a request`)
  }
})

test('a repeated parameter is ambiguous and therefore refused', () => {
  // Next hands ?preview=a&preview=b over as an array. An ambiguous
  // authorisation request is refused rather than resolved.
  assert.equal(pastePreviewRequested([PASTE_PREVIEW_VALUE]), false)
  assert.equal(pastePreviewRequested([PASTE_PREVIEW_VALUE, 'other']), false)
})

test('the paste option is drawn when the feature is on OR under preview', () => {
  assert.equal(pasteOptionVisible({ submissionsEnabled: true, pastePreview: false }), true)
  assert.equal(pasteOptionVisible({ submissionsEnabled: false, pastePreview: true }), true)
  assert.equal(pasteOptionVisible({ submissionsEnabled: false, pastePreview: false }), false)
})

test('PREVIEW CAN NEVER PERMIT A SUBMISSION, and has no parameter to try', () => {
  // The guarantee is the signature: there is no argument through which preview
  // could influence this answer, so no caller can pass one.
  assert.equal(pasteSubmissionAllowed({ submissionsEnabled: false }), false)
  assert.equal(pasteSubmissionAllowed({ submissionsEnabled: true }), true)
  // Even handed a preview flag it does not read, the answer is unchanged.
  assert.equal(
    pasteSubmissionAllowed({ submissionsEnabled: false, pastePreview: true } as never), false,
  )
  assert.equal(pasteSubmissionAllowed.length, 1, 'one argument, and it is the rollout state')
})

test('the two gates are separate functions reading separate things', () => {
  // Drawing the screens and running the backend are different questions, and
  // nothing in this module lets an answer to the first reach the second.
  const source = pasteSubmissionAllowed.toString()
  assert.equal(source.includes('pastePreview'), false)
  assert.equal(source.includes('preview'), false)
})

test('the analyser preview is a second VALUE, not a second gate', () => {
  // The same three conditions decide both; only the screens differ.
  assert.equal(REVIEW_PREVIEW_VALUE, 'analysis')
  assert.equal(reviewPreviewRequested(REVIEW_PREVIEW_VALUE), true)
  for (const other of ['', 'true', PASTE_PREVIEW_VALUE, 'Analysis', ' analysis',
                       undefined, null, true, {}, ['analysis']]) {
    assert.equal(reviewPreviewRequested(other), false, String(other))
  }
})

test('asking for one preview does not grant the other', () => {
  assert.equal(pastePreviewRequested(REVIEW_PREVIEW_VALUE), false)
  assert.equal(reviewPreviewRequested(PASTE_PREVIEW_VALUE), false)
})

test('the analyser preview still needs development and an administrator', () => {
  const requested = reviewPreviewRequested('analysis')
  assert.equal(pastePreviewAllowed({ nodeEnv: 'production', isAdmin: true, requested }), false)
  assert.equal(pastePreviewAllowed({ nodeEnv: 'development', isAdmin: false, requested }), false)
  assert.equal(pastePreviewAllowed({ nodeEnv: 'development', isAdmin: true, requested }), true)
})

test('the requirement preview is a THIRD value, not a third gate', () => {
  assert.equal(REQUIREMENTS_PREVIEW_VALUE, 'requirements')
  assert.equal(requirementsPreviewRequested(REQUIREMENTS_PREVIEW_VALUE), true)
  for (const other of ['', 'true', PASTE_PREVIEW_VALUE, REVIEW_PREVIEW_VALUE, 'Requirements',
    ' requirements', undefined, null, true, {}, ['requirements']]) {
    assert.equal(requirementsPreviewRequested(other), false, String(other))
  }
})

test('THE THREE PREVIEW VALUES ARE MUTUALLY EXCLUSIVE', () => {
  const values = [PASTE_PREVIEW_VALUE, REVIEW_PREVIEW_VALUE, REQUIREMENTS_PREVIEW_VALUE]
  assert.equal(new Set(values).size, 3)
  for (const [name, read] of [
    [PASTE_PREVIEW_VALUE, pastePreviewRequested],
    [REVIEW_PREVIEW_VALUE, reviewPreviewRequested],
    [REQUIREMENTS_PREVIEW_VALUE, requirementsPreviewRequested],
  ] as const) {
    assert.equal(read(name), true, name)
    for (const other of values.filter((v) => v !== name)) {
      assert.equal(read(other), false, `${other} must not request ${name}`)
    }
  }
})

test('the requirement preview still needs development AND an administrator', () => {
  const requested = requirementsPreviewRequested('requirements')
  assert.equal(pastePreviewAllowed({ nodeEnv: 'production', isAdmin: true, requested }), false)
  assert.equal(pastePreviewAllowed({ nodeEnv: 'development', isAdmin: false, requested }), false)
  assert.equal(pastePreviewAllowed({ nodeEnv: 'development', isAdmin: true, requested }), true)
})
