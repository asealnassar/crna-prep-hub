import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NO_PREVIEW, previewAborted, previewDocument, previewFailed, previewLoaded, previewLoading,
  shouldLoadPreview,
} from './cardPreview.ts'
import ResumePreview, {
  DocumentMiniature, PreviewLoadError, PreviewSurface, loadPreviewResume,
} from '../../../app/resume-studio/components/dashboard/ResumePreview.tsx'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import { PAGE_WIDTH_PX } from '../document/pages.ts'
import type { ResumeSectionV2, ResumeTemplate, ResumeV2 } from '../model/types.ts'
import type { ResumeSummary } from '../draft/summary.ts'
import type { PreviewState } from './cardPreview.ts'

/**
 * The dashboard card's thumbnail is the applicant's own resume, drawn by the
 * one canonical renderer -- not a picture of it, and not a second renderer that
 * could drift from the page it claims to show.
 */

const NOW = '2026-09-17T09:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

function sample(template: ResumeTemplate = 'classic'): ResumeV2 {
  const base = createResume({ id: 'r1', userId: 'u1', title: 'Duke application', sectionIds: ids(20), now: NOW })
  return {
    ...base,
    template,
    contact: {
      ...emptyContact(), fullName: 'Jordan Ellery', credentials: 'BSN, RN, CCRN',
      email: 'jordan.ellery@example.test', phone: '555-0142', city: 'Newark', state: 'NJ',
    },
    sections: [
      { ...createSection('summary', 'sm'), text: createAuthoredText('Critical care nurse of six years.') } as ResumeSectionV2,
      {
        ...createSection('education', 'ed'),
        entries: [{
          id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
          location: 'Newark, NJ', graduationDate: resumeDateFromParts(2019, 5),
          overallGpa: parseGpa('3.85', true), scienceGpa: parseGpa(''), honors: '',
        }],
      } as ResumeSectionV2,
      {
        ...createSection('critical_care', 'cc'),
        positions: [{
          ...createClinicalPosition('p1', {
            employer: 'University Hospital', role: 'Registered Nurse', unit: 'Medical ICU',
            location: 'Newark, NJ',
            dates: { start: resumeDateFromParts(2021, 3), end: { kind: 'absent' }, isCurrent: true },
          }),
          bullets: [createBullet('Titrated vasoactive infusions for unstable patients.')],
        }],
      } as ResumeSectionV2,
    ],
  }
}

const summary = (over: Partial<ResumeSummary> = {}): ResumeSummary => ({
  id: 'r1', title: 'Duke application', status: 'draft', template: 'classic',
  revision: 4, updatedAt: NOW, createdAt: NOW, ...over,
})

const miniature = (resume: ResumeV2, scale = 0.23) =>
  renderToStaticMarkup(createElement(DocumentMiniature, { resume, scale }))

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const preview = () => source('../../../app/resume-studio/components/dashboard/ResumePreview.tsx')
const card = () => source('../../../app/resume-studio/components/dashboard/ResumeCard.tsx')
const route = () => source('../../../app/api/resume-v2/draft/route.ts')

// ------------------------------------------------------- 1-3: what is drawn

test('1: the thumbnail is the applicant’s own resume, not a diagram of one', () => {
  const html = miniature(sample())
  for (const written of [
    'Jordan Ellery', 'BSN, RN, CCRN', 'Critical care nurse of six years.',
    'University Hospital', 'Titrated vasoactive infusions for unstable patients.', 'Rutgers University',
  ]) {
    assert.ok(html.includes(written), `"${written}" is not in the thumbnail`)
  }
  // The renderer itself, with the document's own classes -- not a copy of it.
  assert.ok(html.includes('rd-root'))
  assert.ok(html.includes('rd-page'))
  assert.match(preview(), /<ResumeDocument resume=\{resume\} template=\{resume\.template\} includeStyles=\{false\} \/>/)
  assert.match(preview(), /from '@\/components\/resume-document\/ResumeDocument'/)
})

test('2: the resume is drawn in its own template', () => {
  for (const template of ['classic', 'modern', 'compact'] as const) {
    const html = miniature(sample(template))
    assert.ok(html.includes(`data-template="${template}"`), template)
  }
  // Modern's two columns and Compact's inline headings survive the shrinking:
  // the stylesheet is the document's, not the card's.
  assert.ok(miniature(sample('modern')).includes('data-layout="sidebar"'))
  assert.ok(miniature(sample('compact')).includes('data-heading-style="inline"'))
  assert.match(preview(), /\$\{fontFaceCss\(\)\}\\n\$\{DOCUMENT_CSS\}/)
})

test('3: only the first page shows, and the page itself is never resized', () => {
  const html = miniature(sample())
  // A page-shaped frame that clips: anything past page one is cut off by it.
  assert.match(html, /aspect-\[17\/22\][^"]*overflow-hidden/)
  // The page is drawn at its real width and scaled, so the layout is the
  // printed layout rather than a narrow reflow of it.
  assert.ok(html.includes(`width:${PAGE_WIDTH_PX}px`), 'the page was resized instead of scaled')
  assert.ok(html.includes('transform:scale(0.23)'))
  assert.ok(html.includes('origin-top-left'))
})

// ------------------------------------------------- 4-5: while and when it fails

test('4: until the resume arrives, the card shows the schematic', () => {
  // Effects do not run in this render, so this is exactly the first paint:
  // nothing fetched, nothing measured.
  const html = renderToStaticMarkup(createElement(ResumePreview, { resume: summary() }))
  assert.equal(html.includes('rd-root'), false, 'a document was drawn before one was read')
  assert.ok(html.includes('aspect-[17/22]'), 'there is no page-shaped placeholder')
  assert.match(html, /data-preview-state="loading"/, 'the first paint does not say it is loading')
  assert.match(preview(), /if \(!resume \|\| scale <= 0\) return schematic/)
})

test('5: a read that fails leaves the card whole', () => {
  const failed = previewFailed(NO_PREVIEW, 4)
  assert.equal(previewDocument(failed), null, 'a failed read must fall back to the schematic')
  // And a failure after a good read keeps what was already drawn.
  const drawn = previewLoaded(sample(), 4)
  assert.equal(previewDocument(previewFailed(drawn, 5)), drawn.resume)
  // The component treats an abort as neither success nor failure -- and knows
  // an abort whichever shape the runtime throws it in.
  const code = preview()
  assert.match(code, /if \(isAbort\(error\)\) return\b/)
  assert.match(code, /error instanceof DOMException \? error\.name === 'AbortError' : \(error as Error \| null\)\?\.name === 'AbortError'/)
})

// ------------------------------------------------- 6-7: the card around it

test('6: the card still opens from anywhere on it, including the thumbnail', () => {
  const code = card()
  assert.match(code, /<ResumePreview resume=\{resume\} tier=\{tier\} \/>/)
  assert.match(code, /after:absolute after:inset-0/, 'the card-wide link is gone')
  // The miniature takes no clicks, so a press on it reaches the link beneath.
  assert.ok(miniature(sample()).includes('pointer-events-none'))
})

test('7: the miniature is decorative and holds nothing a keyboard can reach', () => {
  const html = miniature(sample())
  assert.match(html, /<div aria-hidden="true"/)
  for (const focusable of ['<a ', '<button', '<input', 'tabindex', 'href=']) {
    assert.equal(html.includes(focusable), false, `the thumbnail contains ${focusable}`)
  }
})

// ------------------------------------------------------- 8: what is read, when

test('8: a card off the screen reads nothing', () => {
  const unseen = { visible: false, revision: 4 }
  assert.equal(shouldLoadPreview(NO_PREVIEW, unseen), false, 'an offscreen card fetched')
  assert.equal(shouldLoadPreview(previewLoaded(sample(), 3), unseen), false)
  // Seen: once, and not again while that read is in flight.
  assert.equal(shouldLoadPreview(NO_PREVIEW, { visible: true, revision: 4 }), true)
  assert.equal(shouldLoadPreview(previewLoading(NO_PREVIEW), { visible: true, revision: 4 }), false)
  // Read once per revision: an untouched resume is not read again...
  const ready = previewLoaded(sample(), 4)
  assert.equal(shouldLoadPreview(ready, { visible: true, revision: 4 }), false)
  // ...and an edited one is, so the thumbnail follows the document.
  assert.equal(shouldLoadPreview(ready, { visible: true, revision: 5 }), true)
  // A failure waits for a change rather than retrying into the same wall.
  const failed = previewFailed(NO_PREVIEW, 4)
  assert.equal(shouldLoadPreview(failed, { visible: true, revision: 4 }), false)
  assert.equal(shouldLoadPreview(failed, { visible: true, revision: 5 }), true)
})

test('the card watches for itself and tidies up after itself', () => {
  const code = preview()
  assert.match(code, /new IntersectionObserver\(/)
  assert.match(code, /rootMargin: '300px'/)
  assert.equal((code.match(/observer\.disconnect\(\)/g) ?? []).length, 3, 'an observer is left running')
  assert.match(code, /return \(\) => \{\s*abort\.abort\(\)/, 'an in-flight read is not cancelled on unmount')
  // No screenshots, no PDF, no stored image: the browser draws the page.
  for (const heavy of [/toDataURL/, /canvas/i, /puppeteer/i, /\/export/, /base64/i]) {
    assert.equal(heavy.test(code), false, `the thumbnail path uses ${heavy}`)
  }
})

// ------------------------------------------- the chain, from response to page

/** The route's own response shape, served to the real loader. */
function servingResume(resume: ResumeV2 | null, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(resume ? JSON.stringify({ resume }) : 'not json', {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const surface = (state: PreviewState, template = 'classic', scale = 0.24) =>
  renderToStaticMarkup(createElement(PreviewSurface, { state, template, scale }))

test('a resume that loads replaces the schematic with the real page', async () => {
  const served = sample('modern')
  const stub = servingResume(served)
  try {
    // The real loader, against the real response shape...
    const loaded = await loadPreviewResume('r1')
    assert.equal(stub.calls.length, 1, 'the card did not ask for the resume')
    assert.equal(stub.calls[0].url, '/api/resume-v2/draft?id=r1')
    assert.equal((stub.calls[0].init as RequestInit & { cache?: string })?.cache, 'no-store')

    // ...straight into the state the card draws from, and the surface itself.
    const html = surface(previewLoaded(loaded, 4), 'modern')
    assert.ok(html.includes('data-preview-state="real"'), 'the card is still showing the schematic')
    assert.equal(html.includes('data-preview-state="fallback"'), false)
    assert.equal(html.includes('data-preview-state="loading"'), false)
    // The applicant's own resume, drawn by the document renderer.
    for (const written of ['Jordan Ellery', 'University Hospital', 'Titrated vasoactive infusions for unstable patients.']) {
      assert.ok(html.includes(written), `"${written}" never reached the card`)
    }
    assert.ok(html.includes('rd-root'))
    assert.ok(html.includes('data-template="modern"'))
  } finally {
    stub.restore()
  }
})

test('two resumes do not draw the same thumbnail', () => {
  const one = surface(previewLoaded(sample('classic'), 1), 'classic')
  const other = surface(previewLoaded({ ...sample('compact'), contact: { ...sample().contact, fullName: 'Sam Okafor' } }, 1), 'compact')
  assert.notEqual(one, other)
  assert.ok(one.includes('Jordan Ellery') && !one.includes('Sam Okafor'))
  assert.ok(other.includes('Sam Okafor') && !other.includes('Jordan Ellery'))
})

test('the card waits on the schematic, and falls back to it when a read fails', () => {
  assert.match(surface(NO_PREVIEW), /data-preview-state="loading"/)
  assert.match(surface(previewLoading(NO_PREVIEW)), /data-preview-state="loading"/)
  assert.match(surface(previewFailed(NO_PREVIEW, 4)), /data-preview-state="fallback"/)
  // Measured at nothing is not "real" either: a page cannot be scaled into no width.
  assert.match(surface(previewLoaded(sample(), 4), 'classic', 0), /data-preview-state="loading"/)
  for (const html of [surface(NO_PREVIEW), surface(previewFailed(NO_PREVIEW, 4))]) {
    assert.equal(html.includes('rd-root'), false, 'a document was drawn with nothing to draw')
  }
})

test('each stage of a failed read is named, and none of them is a resume', async () => {
  for (const [status, stage] of [[404, 'status'], [500, 'status']] as const) {
    const stub = servingResume(sample(), status)
    try {
      await assert.rejects(loadPreviewResume('r1'), (error: unknown) => {
        assert.ok(error instanceof PreviewLoadError)
        assert.equal((error as PreviewLoadError).stage, stage)
        assert.match((error as Error).message, /^HTTP \d{3}$/, 'the message says more than the status')
        return true
      })
    } finally {
      stub.restore()
    }
  }

  // A 200 that is not a resume is a parse failure, not a blank card.
  const malformed = servingResume(null)
  try {
    await assert.rejects(loadPreviewResume('r1'), (error: unknown) =>
      error instanceof PreviewLoadError && error.stage === 'parse')
  } finally {
    malformed.restore()
  }

  // Nothing logged carries the applicant's words.
  const code = preview()
  assert.match(code, /console\.warn\(`\[resume preview\] \$\{stage\}: \$\{detail\}`\)/)
  assert.match(code, /if \(process\.env\.NODE_ENV === 'production'\) return/)
  for (const stage of ['observer', 'fetch', 'status', 'parse', 'render']) {
    assert.ok(code.includes(`'${stage}'`), `no stage named ${stage}`)
  }
})

test('a cancelled read leaves the card able to ask again', () => {
  // Cancelled mid-flight -- a remount, or a revision that moved on -- must not
  // strand the card on 'loading', because nothing asks again from there.
  const cancelled = previewAborted(previewLoading(NO_PREVIEW))
  assert.equal(cancelled.status, 'idle')
  assert.equal(shouldLoadPreview(cancelled, { visible: true, revision: 4 }), true)
  // A refresh cancelled after something was already drawn keeps what is drawn.
  const drawn = previewLoaded(sample(), 4)
  const refreshing = previewAborted(previewLoading(drawn))
  assert.equal(refreshing.status, 'ready')
  assert.equal(previewDocument(refreshing), drawn.resume)
  assert.equal(shouldLoadPreview(refreshing, { visible: true, revision: 5 }), true)
  // Settled states are untouched.
  assert.deepEqual(previewAborted(drawn), drawn)
  assert.match(preview(), /setState\(previewAborted\)/)
})

test('the read is not torn down by the state change that starts it', () => {
  // THE DEFECT THIS FILE EXISTS FOR. The load effect used to list `state` among
  // its dependencies, so setting "loading" re-ran it, and the re-run's cleanup
  // aborted the request it had just made. Every card stayed on the schematic.
  const code = preview()
  const effect = code.slice(code.indexOf('const abort = new AbortController()'))
  const deps = /\}, \[([^\]]*)\]\)/.exec(effect)
  assert.ok(deps, 'the load effect has no dependency list')
  assert.equal(deps[1].replace(/\s+/g, ' ').trim(), 'seen, resume.id, resume.revision')
  assert.equal(/\bstate\b/.test(deps[1]), false, 'the load effect still re-runs when its own state changes')
  // The state it decides on is read through a ref instead.
  assert.match(code, /const current = useRef\(state\)/)
  assert.match(code, /shouldLoadPreview\(current\.current, \{ visible: seen, revision \}\)/)
})

test('one resume is read the same way the Studio reads it, behind the same gate', () => {
  const code = route()
  const get = code.slice(code.indexOf('export async function GET'), code.indexOf('export async function POST'))
  assert.match(get, /const admitted = await admit\(\)/)
  assert.ok(get.indexOf('admit()') < get.indexOf('searchParams'), 'the gate runs after the id is read')
  assert.match(get, /UUID\.test\(id\)/, 'any string is passed to the database')
  assert.match(get, /await readResume\(db, id\)/, 'the read does not use the shared repository function')
  assert.match(get, /if \(!read\.value\.resume\) return NextResponse\.json\(\{ error: 'not-found' \}, \{ status: 404 \}\)/)
  assert.equal(/service.?role/i.test(get), false, 'the read escapes the caller’s own client')
})
