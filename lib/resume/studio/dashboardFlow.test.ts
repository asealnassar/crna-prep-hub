import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * One way to start a resume.
 *
 * There used to be a "New resume" button and, beside it, an Import column --
 * two controls for one intention, and the applicant had to understand the
 * difference before they had done anything. Now the intention comes first and
 * the choice is made inside it.
 *
 * Checked as source, the way the other editor suites are: comments stripped, so
 * prose about a control can never satisfy an assertion about one.
 */

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const dashboard = () => source('../../../app/resume-studio/components/dashboard/DashboardClient.tsx')
const dialog = () => source('../../../app/resume-studio/components/dashboard/NewResumeDialog.tsx')
const tile = () => source('../../../app/resume-studio/components/import/UploadTile.tsx')
const card = () => source('../../../app/resume-studio/components/dashboard/ResumeCard.tsx')

// ------------------------------------------------------- one entry point

test('New resume opens the choice rather than creating immediately', () => {
  const code = dashboard()
  assert.match(code, /onClick=\{\(\) => setChoosing\(true\)\}/, 'the button does not open the chooser')
  assert.match(code, /<NewResumeDialog/, 'the chooser is never rendered')
})

test('the standalone Import card is gone from the dashboard', () => {
  const code = dashboard()
  assert.equal(code.includes('<UploadTile'), false, 'the dashboard still mounts the import tile itself')
  assert.equal(code.includes('import-heading'), false, 'the Import column heading is still there')
  assert.equal(/title="Import"/.test(code), false, 'an Import group heading survives')
})

test('the dialog offers exactly the two ways to begin', () => {
  const code = dialog()
  assert.match(code, /Start from scratch/)
  assert.match(code, /Upload existing resume/)
  assert.match(code, /How would you like to start\?/)
})

test('starting from scratch still creates a blank resume the way it always did', () => {
  // Same command, same endpoint, same reload. Only the control that fires it moved.
  const code = dashboard()
  assert.match(code, /onStartFromScratch=\{\(\) => \{[\s\S]*?command\(\{ action: 'create' \}, null\)/)
})

test('uploading reveals the existing import tile, not a new one', () => {
  const code = dialog()
  assert.match(code, /<UploadTile/)
  assert.match(code, /onImported=\{onImported\}/, 'a finished import does not refresh the list')
  assert.match(code, /setStep\('upload'\)/)
})

test('the import workflow itself is untouched', () => {
  // PDF, Word and paste, the same refusals, and a review before anything exists.
  const code = tile()
  assert.match(code, /accept="\.pdf,\.docx/, 'the file types changed')
  assert.match(code, /Paste resume text/)
  assert.match(code, /kind: 'reviewing'/, 'review-before-create is gone')
  assert.match(code, /onCancel=\{\(\) => setState\(\{ kind: 'idle' \}\)\}/)
  assert.match(code, /MAX_UPLOAD_BYTES/, 'the file size limit is gone')
  assert.match(code, /action: 'create'/, 'explicit creation is gone')
})

// ------------------------------------------------------- the cards

test('the page keeps its heading, one purple button, and both groups', () => {
  const code = dashboard()
  assert.match(code, />Resume Studio</)
  assert.match(code, /Build, improve, and export your CRNA resume\./)
  // One primary: the header's. The empty state repeats the action quietly.
  assert.equal((code.match(/variant="primary"/g) ?? []).length, 1)
  assert.match(code, /title="Drafts"\s+count=\{drafts\.length\}/)
  assert.match(code, /title="Complete" count=\{complete\.length\}/)
  assert.match(code, /<Badge tone=\{tone\}>\{count\}<\/Badge>/, 'the group count badge is gone')
  // Two columns on a desktop, one on a phone.
  assert.equal((code.match(/grid gap-\d+ sm:grid-cols-2/g) ?? []).length, 2)
})

test('the workspace is off-white and the header leads the page', () => {
  const code = dashboard()
  assert.equal(/#F7F8FC/.test(code), false, 'the blue-grey wash is still the workspace')
  assert.match(code, /bg-\[#FAFAFB\]/, 'the workspace is not the off-white')
  // The title outranks everything else on the page.
  const heading = /text-\[(\d+)px\] font-semibold leading-tight tracking-\[-0\.02em\] text-slate-900">Resume Studio/.exec(code)
  assert.ok(heading && Number(heading[1]) >= 32, 'the page title is no larger than it was')
  assert.match(code, /<h2 id=\{id\} className="text-xl font-semibold/, 'the group headings are not the second rank')
  // The app shell around it is untouched.
  assert.match(code, /\$\{sidebarCollapsed \? 'lg:ml-20' : 'lg:ml-64'\} pt-16 lg:pt-0/)
})

test('a strip under the header says what the page is for, and claims nothing extra', () => {
  const code = dashboard()
  assert.match(code, /<IntroStrip \/>/, 'the intro strip is not on the page')
  assert.match(code, /Create a standout resume for your CRNA journey\./)
  assert.match(code, /Choose a template, add your real experience, and keep it ready to send\./)
  assert.match(code, /\['Professional templates', 'CRNA-focused guidance', 'Live resume preview'\]/)
  // Free and Premium read this page too: exporting and finalising are Ultimate's.
  for (const claim of [/export/i, /finali[sz]e/i, /unlimited/i]) {
    assert.equal(claim.test(code.slice(code.indexOf('function IntroStrip'))), false, `the strip claims ${claim}`)
  }
  // One small strip on the card surface, not a coloured banner.
  assert.match(code, /rounded-2xl border border-slate-200 bg-white px-5 py-4/)
})

test('sorting is offered only when there is something to sort, and it really sorts', () => {
  const code = dashboard()
  assert.match(code, /const \[sort, setSort\] = useState<ResumeSort>\('edited'\)/)
  assert.match(code, /groupByStatus\(resumes, sort\)/, 'the chosen order is not applied')
  assert.match(code, /resumes\.length > 1 \? \(/, 'the control shows with nothing to sort')
  assert.match(code, /<label htmlFor="sort-resumes"[^>]*>Sort by:<\/label>/)
  assert.match(code, /RESUME_SORTS\.map/)
})

test('an empty group is a panel that looks planned for, not a leftover sentence', () => {
  const code = dashboard()
  assert.match(code, /<EmptyGroup\s+icon=\{CircleCheck\}\s+tone="complete"\s+title="No completed resumes yet"/)
  assert.match(code, /body="Mark a resume complete when it is ready to send, and it will wait here\."/)
  assert.equal(/Nothing marked complete yet/.test(code), false, 'the loose sentence is still there')
  assert.equal(/>No drafts\.</.test(code), false, 'the drafts group still ends in a bare sentence')
  // Contained, with its own quiet surface and an icon.
  assert.match(code, /<Card tone="muted" className="flex flex-col items-center px-6 py-10 text-center">/)
  assert.match(code, /<Icon className="h-5 w-5" aria-hidden="true" \/>/)
})

test('the card leads with a page preview that is a third of it', () => {
  const code = card()
  const preview = /<div className="relative w-\[(\d+)%\] shrink-0 self-start">\s*<ResumePreview/.exec(code)
  assert.ok(preview, 'the preview is not the first thing in the card')
  const width = Number(preview[1])
  assert.ok(width >= 35 && width <= 40, `the preview is ${width}% of the card, not 35-40%`)
  assert.equal(/h-32/.test(code), false, 'the old fixed preview band is still there')
  assert.equal(/min-h-\[2\.6rem\]/.test(code), false, 'the title still reserves empty space')
})

test('the card shows what it knows and writes nothing to fill the space', () => {
  const code = card()
  // No excerpt, and no template blurb standing in for one: the list carries
  // neither, and describing someone's resume is not ours to do.
  assert.equal(/TEMPLATES/.test(code), false, 'the template blurb is back on the card')
  assert.equal((code.match(/<p className/g) ?? []).length, 1, 'the card grew a second paragraph')
  assert.match(code, /flex min-w-0 flex-1 flex-col justify-center/, 'the text block is not balanced against the preview')
  assert.match(code, /text-\[17px\] font-semibold leading-snug tracking-tight/, 'the title is not the strongest thing on the card')
  // Open carries the accent; the menu sits beside it, both at the foot.
  assert.match(code, /className=\{openAction\}/)
  assert.match(code, /bg-violet-50 px-3\.5 text-sm font-semibold text-violet-700/)
  assert.match(code, /<SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" \/>/)
})

test('a finished resume is marked in green, and nothing else on the card is', () => {
  const code = card()
  assert.match(code, /\{complete && \(\s*<span className="absolute -right-1\.5 -top-1\.5[^"]*bg-emerald-500/)
  assert.match(code, /<span className="sr-only">Complete<\/span>/, 'the green mark says nothing to a screen reader')
  assert.equal((code.match(/emerald/g) ?? []).length, 1, 'green is being used for something other than complete')
})

test('the card answers the pointer and the keyboard', () => {
  const code = card()
  assert.match(code, /hover:-translate-y-px hover:border-slate-300 hover:shadow-/)
  assert.match(code, /focus-within:border-violet-300 focus-within:ring-2 focus-within:ring-violet-600\/10/)
})

test('the card says what the resume is in one line from the tested labels', () => {
  const code = card()
  assert.match(code, /dashboardMeta\(resume, Date\.now\(\)\)\.join\(' · '\)/)
  // The group heading says Draft or Complete; the card does not say it again.
  assert.equal(/statusLabel/.test(code), false, 'the status pill is back inside the card')
  assert.equal(/CircleDashed/.test(code), false, 'the draft pill icon is still imported')
})

test('a Strength score appears only when there is one, and is never computed here', () => {
  const code = card()
  assert.match(code, /const strength = strengthLabel\(resume\.strength\)/)
  assert.match(code, /\{strength && <Badge tone="accent">\{strength\}<\/Badge>\}/)
})

test('pressing anywhere on the card opens the resume, and the controls still work', () => {
  const code = card()
  // The title's link is stretched across the card...
  assert.match(code, /after:absolute after:inset-0/)
  // ...and everything that is not "open" sits above the overlay.
  assert.match(code, /className="relative z-10 mt-\d+ flex items-center gap-2"/)
  assert.match(code, /className=\{cx\(field\.control, 'relative z-10/, 'the rename field is under the overlay')
  assert.match(code, /aria-label=\{`Open \$\{resume\.title\}`\}/, 'the Open button is gone')
  assert.match(code, /<Menu/, 'the overflow menu is gone')
})

// ------------------------------------------------------- accessibility

test('the dialog is a real dialog', () => {
  const code = dialog()
  assert.match(code, /role="dialog"/)
  assert.match(code, /aria-modal="true"/)
  assert.match(code, /aria-labelledby=\{titleId\}/)
})

test('Escape and a press outside both close it', () => {
  assert.match(dialog(), /useDismiss\(open, \[panel\], onClose\)/)
})

test('focus moves in on open and back out on close', () => {
  const code = dialog()
  assert.match(code, /firstAction\.current\?\.focus\(\)/, 'focus never enters the dialog')
  assert.match(code, /opener\?\.focus\?\.\(\)/, 'focus is never returned to what opened it')
})

test('Tab stays inside the dialog while it is open', () => {
  const code = dialog()
  assert.match(code, /onKeyDown=\{trapTab\}/)
  assert.match(code, /event\.key !== 'Tab'/)
  assert.match(code, /event\.shiftKey/, 'shift-tab escapes backwards out of the dialog')
})

test('there is always a visible way out', () => {
  const code = dialog()
  assert.match(code, /label="Close"/)
  assert.match(code, /Back to the start options/, 'the upload step cannot go back')
})
