import type { CSSProperties, Ref } from 'react'
import ResumeDocument, { DocumentWatermark } from '@/components/resume-document/ResumeDocument'
import { cssVariablesFor } from '@/lib/resume/document/css'
import { templateFor } from '@/lib/resume/document/templates'
import {
  PAGE_CONTENT_HEIGHT_PX, PAGE_CONTENT_WIDTH_PX, PAGE_HEIGHT_PX, PAGE_MARGIN_PX, PAGE_WIDTH_PX,
  pageOffsetPx,
} from '@/lib/resume/document/pages'
import type { ResumeV2 } from '@/lib/resume/model/types'

/**
 * The preview as the pages the PDF will have.
 *
 * A PRESENTATION LAYER, NOT A SECOND RENDERER. Every sheet mounts the same
 * ResumeDocument the export prints. What differs is only the frame around it:
 * the document is laid out in a multi-column flow whose column is one printed
 * page's content box, so the BROWSER breaks it into pages -- under the same
 * break rules, in the same engine, that Chromium uses when it prints. Sheet k
 * then shows column k. No content is cut at a pixel height, and nothing about
 * the resume is changed to make it fit.
 *
 * WHY ONE COPY PER SHEET. A column cannot be moved on its own; the flow can. So
 * each sheet holds the same flow shifted so that its column is the one in view.
 * Only the first is exposed to assistive technology -- it holds the whole
 * document, across all of its columns -- and only the first carries the
 * stylesheet.
 *
 * Geometry is inline rather than utility classes: it is what makes the pages
 * line up, and it must not depend on anything outside the document stylesheet.
 *
 * Pure: no state and no effects. The pane that mounts it measures how many
 * columns the browser made and passes that back in as `pages`.
 */
export default function PaginatedDocument({
  resume,
  template,
  pages,
  scale = 1,
  watermark,
  fontCss,
  flowRef,
}: {
  resume: ResumeV2
  /** Template id; falls back to the resume's own. */
  template?: string
  /** How many sheets to draw -- the number of columns the flow was measured to have. */
  pages: number
  /** Zoom. The sheets scale; the layout inside them never does. */
  scale?: number
  /** The preview mark for a tier that cannot export, drawn across every sheet. */
  watermark?: string | null
  /** The @font-face block, for a caller that has no origin to load fonts from. */
  fontCss?: string
  /** The first sheet's flow, which the pane measures. */
  flowRef?: Ref<HTMLDivElement>
}) {
  const definition = templateFor(template ?? resume.template)
  const count = Math.max(1, Math.trunc(pages))

  return (
    <div className="flex flex-col items-center gap-6" data-paginated-preview="">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} data-sheet={index + 1} className="flex flex-col items-center gap-1.5">
          {count > 1 && (
            <p aria-hidden="true" className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Page {index + 1}
            </p>
          )}
          <div
            className="shadow-[0_1px_3px_rgba(15,23,42,0.08),0_12px_32px_-8px_rgba(15,23,42,0.18)]"
            style={{ width: PAGE_WIDTH_PX * scale, height: PAGE_HEIGHT_PX * scale, overflow: 'hidden', background: '#ffffff' }}
          >
            <div
              style={{
                position: 'relative',
                width: PAGE_WIDTH_PX,
                height: PAGE_HEIGHT_PX,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                background: '#ffffff',
                ...(cssVariablesFor(definition) as CSSProperties),
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: PAGE_MARGIN_PX,
                  top: PAGE_MARGIN_PX,
                  width: PAGE_CONTENT_WIDTH_PX,
                  height: PAGE_CONTENT_HEIGHT_PX,
                  overflow: 'hidden',
                }}
              >
                <div
                  ref={index === 0 ? flowRef : undefined}
                  className="rd-flow"
                  aria-hidden={index === 0 ? undefined : true}
                  style={index === 0 ? undefined : { transform: `translateX(-${pageOffsetPx(index)}px)` }}
                >
                  <div className="rd-flow-body">
                    <ResumeDocument
                      resume={resume}
                      template={definition}
                      paginated
                      includeStyles={index === 0}
                      fontCss={fontCss}
                    />
                  </div>
                </div>
              </div>
              {/* On every sheet, over the whole paper: a mark on page one alone
                  would leave the rest of the resume clean. */}
              {watermark && <DocumentWatermark text={watermark} />}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
