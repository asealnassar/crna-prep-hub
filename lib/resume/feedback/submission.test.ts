import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  FEEDBACK_TYPES, MAX_FEEDBACK_LENGTH, V2_SOURCE, checkFeedback, feedbackMessage, feedbackRow,
  feedbackSourceLabel, feedbackSourceOf, feedbackTypeOf,
} from './submission.ts'
import { FeedbackDialog } from '../../../app/resume-studio/components/feedback/FeedbackButton.tsx'

/**
 * Feedback from V2 rides the system that already exists: one row in
 * `interview_feedback`, the two columns V1 writes, and the product named in the
 * message the way V1 names it. These check that it is that row, that it says
 * V2, and that nothing from anybody's resume is in it.
 */

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const button = () => source('../../../app/resume-studio/components/feedback/FeedbackButton.tsx')
const dashboard = () => source('../../../app/resume-studio/components/dashboard/DashboardClient.tsx')
const studio = () => source('../../../app/resume-studio/components/studio/StudioClient.tsx')
// The feedback queue moved out of the analytics page and into its own panel
// when the dashboard was rebuilt. Same table, same filter, same helpers.
const analytics = () => source('../../../app/admin/analytics/components/Queues.tsx')
const v1Page = () => source('../../../app/feedback/page.tsx')

const dialog = (open = true) =>
  renderToStaticMarkup(createElement(FeedbackDialog, {
    open, surface: 'studio' as const, tier: 'ultimate', template: 'modern', onClose: () => {},
  }))

// ------------------------------------------------- 1-2: where it is offered

test('1: the dashboard offers Feedback & suggestions, and it opens the modal', () => {
  const code = dashboard()
  assert.match(code, /<FeedbackButton surface="dashboard" tier=\{tier\} \/>/)
  // Secondary: it sits beside the one primary, which stays New resume.
  assert.match(code, /<FeedbackButton surface="dashboard"[^>]*\/>\s*<Button\s+variant="primary"/)
  assert.equal((code.match(/variant="primary"/g) ?? []).length, 1)
  const control = button()
  assert.match(control, /Feedback &amp; suggestions/)
  assert.match(control, /onClick=\{\(\) => setOpen\(true\)\}/)
  assert.match(control, /<FeedbackDialog\s+open=\{open\}/)
  // Quiet by design -- never the purple call to action.
  assert.match(control, /buttonClass\('tertiary', 'sm'\)/)
  assert.equal(/variant="primary"/.test(control), false, 'the feedback control is a primary button')
})

test('2: the Studio toolbar offers the same control', () => {
  const code = studio()
  assert.match(code, /<FeedbackButton surface="studio" tier=\{tier\} template=\{resume\.template\} compact=\{compact\} \/>/)
  // Both toolbars: the desktop row of actions, and the phone row.
  assert.match(code, /\{feedbackControl\(false\)\}/)
  assert.match(code, /\{feedbackControl\(true\)\}/)
})

test('the modal is a real dialog, titled as asked', () => {
  const html = dialog()
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  assert.match(html, /Help us improve Resume Builder/)
  assert.match(html, /Send feedback/)
  for (const option of FEEDBACK_TYPES) assert.ok(html.includes(option.label), option.label)
  assert.equal(dialog(false), '', 'the dialog renders when it is closed')
  const code = button()
  assert.match(code, /useDismiss\(open, \[panel\], onClose\)/)
  assert.match(code, /onKeyDown=\{trapTab\}/)
  assert.match(code, /opener\?\.focus\?\.\(\)/)
})

// ----------------------------------------------------------- 3: validation

test('3: an empty message cannot be sent', () => {
  for (const empty of ['', '   ', '\n\t ']) {
    const checked = checkFeedback(empty)
    assert.equal(checked.ok, false, JSON.stringify(empty))
  }
  assert.deepEqual(checkFeedback('  the preview zoom sticks  '), { ok: true, message: 'the preview zoom sticks' })
  assert.equal(checkFeedback('x'.repeat(MAX_FEEDBACK_LENGTH + 1)).ok, false, 'an unbounded message was accepted')
  assert.equal(checkFeedback('x'.repeat(MAX_FEEDBACK_LENGTH)).ok, true)

  const code = button()
  // The button is disabled on an empty message, and the check runs again on send.
  assert.match(code, /disabled=\{sending \|\| message\.trim\(\) === ''\}/)
  assert.match(code, /const checked = checkFeedback\(message\)/)
  assert.match(code, /if \(!checked\.ok\) \{\s*setError\(checked\.error\)\s*return/)
  // And one request at a time.
  assert.match(code, /if \(status === 'sending'\) return/)
  assert.match(code, /maxLength=\{MAX_FEEDBACK_LENGTH\}/)
})

// --------------------------------------------- 4-7: what is stored, and where

test('4: a submission is the same row V1 writes, in the same table', () => {
  const row = feedbackRow({
    email: 'morgan.avery@example.test', type: 'issue', message: 'The preview zoom sticks at 50%.',
    surface: 'studio', template: 'modern', tier: 'ultimate',
  })
  assert.deepEqual(Object.keys(row).sort(), ['message', 'user_email'])
  assert.equal(row.user_email, 'morgan.avery@example.test')
  assert.ok(row.message.endsWith('The preview zoom sticks at 50%.'))
  assert.equal(feedbackRow({ email: null, type: 'other', message: 'x', surface: 'dashboard' }).user_email, 'anonymous')

  // The write itself: the existing table, through the existing browser client.
  const code = button()
  assert.match(code, /from\('interview_feedback'\)/)
  assert.match(code, /\.insert\(feedbackRow\(\{/)
  assert.match(code, /from '@\/lib\/supabase-browser'/)
  // Which is exactly what V1's feedback page does.
  assert.match(v1Page(), /from\('interview_feedback'\)\.insert\(\{/)
})

test('5: every submission says it is Resume Builder V2', () => {
  const row = feedbackRow({ email: 'a@b.test', type: 'suggestion', message: 'More templates please.', surface: 'dashboard' })
  assert.ok(row.message.startsWith(`[${V2_SOURCE}]`), row.message)
  assert.equal(feedbackSourceOf(row.message), 'v2')
  // V1's own tag still reads as V1, and interview feedback as neither.
  assert.equal(feedbackSourceOf('[Resume Builder] older feedback'), 'v1')
  assert.equal(feedbackSourceOf('just a message'), null)
  assert.equal(feedbackSourceLabel('v2'), 'Resume Builder V2')
  assert.equal(feedbackSourceLabel('v1'), 'Resume Builder V1')
})

test('6: the type the applicant chose is stored and reads back', () => {
  for (const option of FEEDBACK_TYPES) {
    const row = feedbackRow({ email: 'a@b.test', type: option.key, message: 'Something happened.', surface: 'studio' })
    assert.ok(row.message.includes(option.label), option.key)
    assert.equal(feedbackTypeOf(row.message), option.label)
  }
  // Context that is about the product, not the person.
  const withContext = feedbackMessage({ type: 'issue', message: 'x', surface: 'studio', template: 'compact', tier: 'premium' })
  assert.match(withContext, /^\[Resume Builder V2\] Issue \/ Bug · Studio · Compact · Tier: premium\n\nx$/)
  // Absent context is left out rather than guessed.
  assert.match(feedbackMessage({ type: 'other', message: 'x', surface: 'dashboard' }), /^\[Resume Builder V2\] Other · Dashboard\n\nx$/)
})

test('7: nothing from the resume is sent with it', () => {
  const row = feedbackRow({
    email: 'a@b.test', type: 'issue', surface: 'studio', template: 'classic', tier: 'free',
    message: 'The bullet editor lost focus.',
  })
  // The row is the tag plus what was typed -- there is nowhere else for
  // anything to travel, and nothing else is read.
  assert.equal(row.message, `[${V2_SOURCE}] Issue / Bug · Studio · Classic · Tier: free\n\nThe bullet editor lost focus.`)

  const code = button()
  for (const reach of ['resume.sections', 'resume.contact', 'bullets', 'planDocument', 'summary.text', 'importedFrom']) {
    assert.equal(code.includes(reach), false, `the dialog reaches for ${reach}`)
  }
  // It is handed labels, never a document.
  assert.equal(/ResumeV2/.test(code), false, 'the dialog takes a whole resume')
  assert.match(studio(), /template=\{resume\.template\}/, 'the Studio should pass the template name only')
})

// ------------------------------------------------------- 8: what it says back

test('8: success and failure are both said out loud', () => {
  const code = button()
  assert.match(code, /Thanks — your feedback was sent\./)
  assert.match(code, /role="status"/)
  assert.match(code, /setStatus\('sent'\)/)
  assert.match(code, /catch \{\s*setStatus\('failed'\)\s*setError\('That did not send\. Please try again\.'\)/)
  assert.match(code, /role="alert"/)
  assert.match(code, /\{sending \? 'Sending…' : 'Send feedback'\}/)
  assert.match(code, /aria-busy=\{sending\}/)
  // A failure leaves the message where it was, so nothing typed is lost.
  assert.equal(/setMessage\(''\)/.test(code.slice(code.indexOf('const send ='))), false)
})

// ------------------------------------------------------- 9: on the Analytics page

test('9: Analytics tells a V2 submission apart from the rest', () => {
  const code = analytics()
  // Same table, same list -- no second analytics path.
  assert.match(code, /from\('interview_feedback'\)/)
  assert.match(code, /feedbackSourceOf\(item\.message\)/)
  assert.match(code, /\{feedbackSourceLabel\(source\)\}/)
  assert.match(code, /feedbackTypeOf\(item\.message\)/)
  // A filter beside the list, counting each product.
  assert.match(code, /\['v2', 'Resume Builder V2'\]/)
  assert.match(code, /\['v1', 'Resume Builder V1'\]/)
  assert.match(code, /const visibleFeedback = feedbackSource === 'all'/)

  // And the thing it reads is what a submission writes.
  const row = feedbackRow({ email: 'a@b.test', type: 'suggestion', message: 'Let me reorder sections.', surface: 'dashboard', tier: 'ultimate' })
  assert.equal(feedbackSourceOf(row.message), 'v2')
  assert.equal(feedbackTypeOf(row.message), 'Suggestion')
  assert.equal(feedbackSourceLabel(feedbackSourceOf(row.message)), 'Resume Builder V2')
})
