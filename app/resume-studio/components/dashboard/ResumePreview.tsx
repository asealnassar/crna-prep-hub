'use client'

import { Component, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import ResumeDocument from '@/components/resume-document/ResumeDocument'
import { DOCUMENT_CSS } from '@/lib/resume/document/css'
import { fontFaceCss } from '@/lib/resume/document/fonts'
import { PAGE_WIDTH_PX } from '@/lib/resume/document/pages'
import {
  NO_PREVIEW, previewAborted, previewDocument, previewFailed, previewLoaded, previewLoading,
  shouldLoadPreview,
} from '@/lib/resume/studio/cardPreview'
import type { PreviewState } from '@/lib/resume/studio/cardPreview'
import { isOutputLocked } from '@/lib/resume/studio/outputLock'
import type { ResumeSummary } from '@/lib/resume/draft/summary'
import type { ResumeV2 } from '@/lib/resume/model/types'
import { cx } from '../ui'
import { TemplateThumb, asTemplate } from '../studio/TemplatePicker'

/**
 * A dashboard card's thumbnail: the applicant's own resume, in miniature.
 *
 * THE SAME RENDERER THE PDF USES. This draws `ResumeDocument` -- the one
 * canonical renderer, with the template's real stylesheet -- scaled down to the
 * card. There is no second thumbnail renderer to drift from the document, no
 * screenshot to store and invalidate, and no Chromium invoked to make a picture
 * of a page the browser can draw itself.
 *
 * READ WHEN SEEN, ONCE PER REVISION. The list response carries no section
 * content, so each card reads its own resume -- but only when it scrolls into
 * view, and only again when the server's revision has moved. See
 * lib/resume/studio/cardPreview.ts for the rules and the tests for them.
 *
 * THE FALLBACK IS A STATE, NOT A HIDING PLACE. A card that is loading or that
 * failed shows the template schematic, so it always looks like a document --
 * and in development it says on the console WHICH stage failed, because a
 * silent fallback once made a broken read look like a design decision.
 * `data-preview-state` says the same thing to a test.
 *
 * DECORATIVE. The page inside is hidden from assistive technology and takes no
 * pointer events: the card's own link names the resume and receives the click,
 * including a click that lands on the miniature.
 */
export default function ResumePreview({
  resume,
  tier,
}: {
  resume: ResumeSummary
  /** A locked resume's thumbnail is obscured too -- see PreviewSurface. */
  tier?: string | null
}) {
  const box = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<PreviewState>(NO_PREVIEW)
  const [seen, setSeen] = useState(false)
  const [scale, setScale] = useState(0)

  // Read through a ref, never through this effect's dependencies: an effect
  // that re-runs when the state it just set changes would tear down -- and
  // abort -- the very request it had started. That defect left every card
  // permanently "loading", which looked exactly like a design that had always
  // been schematic.
  const current = useRef(state)
  current.current = state

  // Nothing is read for a card the applicant has not scrolled to. The margin
  // starts the read just before it arrives, so the page is there when it does.
  useEffect(() => {
    const element = box.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      warnPreview('observer', 'IntersectionObserver unavailable; reading immediately')
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The page is 816px wide whatever the card is, so the card measures itself
  // and scales the page to fit.
  useEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setScale(element.clientWidth / PAGE_WIDTH_PX)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      if (element.clientWidth === 0) warnPreview('render', 'no width to scale the page into')
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const revision = resume.revision
    if (!shouldLoadPreview(current.current, { visible: seen, revision })) return

    const abort = new AbortController()
    setState(previewLoading)

    loadPreviewResume(resume.id, abort.signal)
      .then((document) => {
        if (!abort.signal.aborted) setState(previewLoaded(document, revision))
      })
      .catch((error: unknown) => {
        // An abort is this card unmounting or moving on, not a failure.
        if (isAbort(error)) return
        warnPreview(error instanceof PreviewLoadError ? error.stage : 'fetch', describe(error))
        setState((previous) => previewFailed(previous, revision))
      })

    return () => {
      abort.abort()
      // A cancelled read must not leave the card on 'loading', or it would
      // never ask again -- see previewAborted.
      setState(previewAborted)
    }
  }, [seen, resume.id, resume.revision])

  return (
    <div ref={box} className="relative w-full">
      <PreviewSurface state={state} template={String(resume.template)} scale={scale} tier={tier} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reading one resume
// ---------------------------------------------------------------------------

export type PreviewStage = 'observer' | 'fetch' | 'status' | 'parse' | 'render'

/** A read that got somewhere before it failed, and says where. */
export class PreviewLoadError extends Error {
  constructor(readonly stage: Extract<PreviewStage, 'fetch' | 'status' | 'parse'>, message: string) {
    super(message)
    this.name = 'PreviewLoadError'
  }
}

const isAbort = (error: unknown) =>
  error instanceof DOMException ? error.name === 'AbortError' : (error as Error | null)?.name === 'AbortError'

const describe = (error: unknown) => (error instanceof Error ? error.message : 'unknown error')

/**
 * Says on the console, in development only, which stage of a thumbnail failed.
 *
 * The stage and a status code -- never a line of anybody's resume. A dashboard
 * console is not a place for someone's employment history.
 */
export function warnPreview(stage: PreviewStage, detail: string): void {
  if (process.env.NODE_ENV === 'production') return
  console.warn(`[resume preview] ${stage}: ${detail}`)
}

/**
 * One resume, read from the route the Studio page reads: fetch, status, parse.
 *
 * Throws `PreviewLoadError` naming the stage that failed, so the card can say
 * so rather than falling back silently.
 */
export async function loadPreviewResume(id: string, signal?: AbortSignal): Promise<ResumeV2> {
  let response: Response
  try {
    response = await fetch(`/api/resume-v2/draft?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    })
  } catch (error) {
    if (isAbort(error)) throw error
    throw new PreviewLoadError('fetch', 'request did not reach the server')
  }

  if (!response.ok) throw new PreviewLoadError('status', `HTTP ${response.status}`)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new PreviewLoadError('parse', 'response was not JSON')
  }

  const resume = (body as { resume?: unknown } | null)?.resume as ResumeV2 | undefined
  if (!resume || typeof resume !== 'object' || !Array.isArray(resume.sections) || !resume.contact) {
    throw new PreviewLoadError('parse', 'response carried no resume')
  }
  return resume
}

// ---------------------------------------------------------------------------
// Drawing it
// ---------------------------------------------------------------------------

/**
 * What the card shows for the state it is in.
 *
 * `data-preview-state` is the same answer in a form a test can read: 'real'
 * once the resume is drawn, 'loading' until then, 'fallback' when the read or
 * the render failed.
 */
export function PreviewSurface({
  state,
  template,
  scale,
  tier,
}: {
  state: PreviewState
  template: string
  scale: number
  /** Decides whether a locked resume's page may be read here. */
  tier?: string | null
}) {
  const resume = previewDocument(state)
  const schematic = (
    <div data-preview-state={state.status === 'failed' ? 'fallback' : 'loading'}>
      <TemplateThumb template={asTemplate(template)} />
    </div>
  )
  if (!resume || scale <= 0) return schematic

  // A resume whose finished output is locked is not readable here either. The
  // schematic would say LESS than a blurred page, but it would also be a
  // different document -- so the real page is drawn and obscured.
  const locked = isOutputLocked(resume, tier)

  return (
    <PreviewBoundary fallback={<div data-preview-state="fallback"><TemplateThumb template={asTemplate(template)} /></div>}>
      <div data-preview-state={locked ? 'locked' : 'real'}>
        <DocumentMiniature resume={resume} scale={scale} locked={locked} />
      </div>
    </PreviewBoundary>
  )
}

/** A document that cannot be drawn falls back to the schematic instead of taking the dashboard down. */
class PreviewBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    warnPreview('render', describe(error))
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * One page of a resume, scaled into the space it is given.
 *
 * The frame is the page; everything past the first page's height is clipped,
 * because a card shows what the resume opens with.
 */
export function DocumentMiniature({
  resume,
  scale,
  locked = false,
  className,
}: {
  resume: ResumeV2
  /** Page pixels to card pixels. The page itself is never resized. */
  scale: number
  /** Obscured, because this account cannot have the finished document. */
  locked?: boolean
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        'pointer-events-none aspect-[17/22] w-full select-none overflow-hidden rounded-[0.35em]',
        'bg-white shadow-[0_1px_3px_rgba(15,23,42,0.12)] ring-1 ring-slate-200',
        locked && 'blur-[3px] saturate-50',
        className
      )}
    >
      <div
        className="origin-top-left"
        style={{ width: `${PAGE_WIDTH_PX}px`, transform: `scale(${scale})` }}
      >
        <ResumeDocument resume={resume} template={resume.template} includeStyles={false} />
      </div>
    </div>
  )
}

/**
 * The document stylesheet and its fonts, once for the whole page.
 *
 * Every miniature renders with `includeStyles={false}` and shares this, rather
 * than each card carrying its own copy of the same stylesheet.
 */
export function DocumentStyles() {
  return <style dangerouslySetInnerHTML={{ __html: `${fontFaceCss()}\n${DOCUMENT_CSS}` }} />
}
