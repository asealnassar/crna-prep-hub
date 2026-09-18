'use client'

import { useEffect, useRef, useState } from 'react'
import { FileText, Lock, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import {
  PAGE_WIDTH_PX, describePageSpan, pageCountFromFlowWidth, pageSpanFromPageCount, pageSpanNotice,
} from '@/lib/resume/document/pages'
import type { PageSpan } from '@/lib/resume/document/pages'
import type { ResumeTemplate, ResumeV2 } from '@/lib/resume/model/types'
import { OUTPUT_LOCK_COPY } from '@/lib/resume/studio/outputLock'
import { UPGRADE_HREF } from '@/lib/resume/upgrade'
import { Button, IconButton, buttonClass, cx, surface, text } from '../ui'
import { TemplatePicker } from './TemplatePicker'
import PaginatedDocument from './PaginatedDocument'

const MIN_ZOOM = 0.3
const MAX_ZOOM = 1.5

/** Copy, cut, drag and the context menu, on the composed document only. */
const block = (event: { preventDefault: () => void }) => event.preventDefault()

/**
 * What printing a gated preview produces: the page it was printed from, with
 * the resume itself withheld. Print -> Save as PDF is the same bypass as the
 * download, and the download is what Ultimate is for.
 */
const PROTECTED_PRINT_CSS = `
@media print {
  [data-composed-output="protected"] { display: none !important; }
  [data-preview-locked]::after {
    content: "Upgrade to Ultimate to download your finished resume.";
    display: block;
    padding: 24px;
    font: 14px system-ui, sans-serif;
    color: #334155;
    text-align: center;
  }
}`

/**
 * The live preview: the pages the PDF will have, on a neutral canvas, with the
 * template choice and zoom above them.
 *
 * It mounts the SAME document the export prints. The pages are the browser's
 * own: the document is laid out in columns one printed page tall, and the
 * browser breaks it into them under the same rules it breaks a printed page by.
 * See PaginatedDocument. Zoom scales the sheets and never the layout inside
 * them, so line breaks and page breaks are the real ones at every size.
 *
 * NOTHING IS REQUESTED TO DRAW THIS. Counting pages is reading how wide the
 * browser laid the columns out -- no export, no Chromium, no round trip.
 */
export default function PreviewPane({
  resume,
  locked = false,
  protectCopy = false,
  onTemplateChange,
  onPageSpanChange,
  compact = false,
}: {
  resume: ResumeV2
  /**
   * The applicant answered "Not now" at the upgrade modal and cannot download.
   * The finished document is blurred behind an overlay; the editor beside it is
   * untouched. See lib/resume/studio/outputLock.ts.
   */
  locked?: boolean
  /**
   * This tier cannot take the file away, so the composed document does not
   * select, copy or print. Their own fields in the editor are unaffected.
   */
  protectCopy?: boolean
  onTemplateChange: (template: ResumeTemplate) => void
  /** Reports one-page-or-more upward, so the download control can say it too. */
  onPageSpanChange?: (span: PageSpan | null) => void
  /** Phone layout: the pages scroll with the screen instead of inside a fixed canvas. */
  compact?: boolean
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const flow = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(560)
  const [pages, setPages] = useState(1)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')

  // Fit follows the space the pane has.
  useEffect(() => {
    const box = viewport.current
    if (!box) return
    const measure = () => {
      const style = getComputedStyle(box)
      setAvailable(box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  // Pages follow the document. Read after every commit, because any edit, a
  // template change or a column move can add or remove one, and reading a width
  // the browser has already laid out is cheap. An unchanged count is not a
  // state change, so this settles in one pass.
  useEffect(() => {
    const count = flow.current ? pageCountFromFlowWidth(flow.current.scrollWidth) : null
    if (count !== null) setPages(count)
  })

  // The document's fonts change its metrics when they arrive, after the first
  // layout. Count again once they have.
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts) return
    const recount = () => {
      const count = flow.current ? pageCountFromFlowWidth(flow.current.scrollWidth) : null
      if (count !== null) setPages(count)
    }
    void fonts.ready.then(recount)
    fonts.addEventListener('loadingdone', recount)
    return () => fonts.removeEventListener('loadingdone', recount)
  }, [])

  const fit = Math.min(1, Math.max(MIN_ZOOM, available / PAGE_WIDTH_PX))
  const scale = zoom === 'fit' ? fit : zoom
  const step = (delta: number) =>
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((scale + delta) * 10) / 10)))

  // The same count the sheets are drawn from, so the status can never say one
  // page above two sheets. It says one page or more, never a number: see pages.ts.
  const span = pageSpanFromPageCount(pages)
  const notice = pageSpanNotice(span)

  useEffect(() => {
    onPageSpanChange?.(span)
  }, [span, onPageSpanChange])

  return (
    <div className={cx('flex min-h-0 flex-col', !compact && 'h-full', surface.canvas)}>
      <div className={cx('flex items-center justify-between gap-2 border-b border-slate-200 bg-white py-1.5', compact ? 'px-2' : 'px-4')}>
        <TemplatePicker value={resume.template} onChange={onTemplateChange} />
        <div className="flex items-center gap-2">
          {/* Before the download, not after it. */}
          {span && (
            <span
              className={cx('inline-flex items-center gap-1 whitespace-nowrap text-xs', text.secondary)}
              aria-live="polite"
            >
              <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {describePageSpan(span)}
            </span>
          )}
          <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
            <IconButton icon={ZoomOut} label="Zoom out" size="sm" disabled={scale <= MIN_ZOOM} onClick={() => step(-0.1)} />
            <span className={cx('w-10 text-center text-xs font-medium tabular-nums', text.secondary)} aria-live="polite">
              {Math.round(scale * 100)}%
            </span>
            <IconButton icon={ZoomIn} label="Zoom in" size="sm" disabled={scale >= MAX_ZOOM} onClick={() => step(0.1)} />
            {compact ? (
              <IconButton icon={Maximize2} label="Fit to width" size="sm" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')} />
            ) : (
              <Button
                size="sm"
                variant={zoom === 'fit' ? 'secondary' : 'tertiary'}
                icon={Maximize2}
                aria-pressed={zoom === 'fit'}
                className="ml-1"
                onClick={() => setZoom('fit')}
              >
                Fit
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Said plainly, and nothing is done about it: two pages is a legitimate
          CRNA resume. What was missing was knowing before the download. */}
      {notice && (
        <p
          role="status"
          className={cx('border-b border-slate-200 bg-white px-4 py-1.5 text-xs', text.secondary)}
        >
          {notice}
        </p>
      )}


      <div
        ref={viewport}
        role="region"
        aria-label="Resume preview"
        data-preview-locked={locked ? 'true' : 'false'}
        className={cx('relative min-h-0 overflow-auto', compact ? 'px-3 py-4' : 'flex-1 px-10 py-10')}
      >
        {/* Complete and clean while it is being built. Blurred only once a
            download was attempted and answered with "Not now". */}
        <div
          data-composed-output={protectCopy ? 'protected' : 'open'}
          onCopy={protectCopy ? block : undefined}
          onCut={protectCopy ? block : undefined}
          onContextMenu={protectCopy ? block : undefined}
          onDragStart={protectCopy ? block : undefined}
          className={cx(
            protectCopy && 'select-none',
            locked && 'pointer-events-none blur-[7px] saturate-50'
          )}
        >
          <PaginatedDocument
            resume={resume}
            template={resume.template}
            pages={pages}
            scale={scale}
            flowRef={flow}
          />
        </div>

        {locked && (
          <div className="sticky inset-x-0 bottom-6 top-6 z-10 mx-auto flex max-w-sm flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 px-6 py-6 text-center shadow-xl backdrop-blur">
            <Lock className="h-5 w-5 text-violet-600" aria-hidden="true" />
            <h3 className="text-base font-semibold text-slate-900">{OUTPUT_LOCK_COPY.title}</h3>
            <p className={cx('text-sm leading-relaxed', text.secondary)}>{OUTPUT_LOCK_COPY.body}</p>
            <a href={UPGRADE_HREF} className={cx(buttonClass('primary'), 'mt-2')}>
              {OUTPUT_LOCK_COPY.action}
            </a>
          </div>
        )}
      </div>

      {/* Print reaches the document directly, so the rule that holds it back
          has to live in the page's own stylesheet rather than in the export's.
          Only the resume is hidden; the rest of the page prints as it would. */}
      {protectCopy && (
        <style dangerouslySetInnerHTML={{ __html: PROTECTED_PRINT_CSS }} />
      )}
    </div>
  )
}
