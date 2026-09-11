'use client'

import ResumeDocument from '@/components/resume-document/ResumeDocument'
import type { ResumeV2 } from '@/lib/resume/model/types'

/**
 * The live preview. Nothing but the shared document, scaled to fit.
 *
 * It mounts the SAME component the export path will, so what is on screen is
 * the document, not an approximation of it. The scaling is a CSS transform on a
 * full-size page rather than a smaller re-layout, so line breaks and page
 * breaks are the real ones.
 */
export default function PreviewPane({
  resume,
  watermark,
}: {
  resume: ResumeV2
  /** Set for any tier that may not export. See lib/resume/entitlement.ts. */
  watermark?: string | null
}) {
  return (
    <div className="bg-white/5 border border-white/15 rounded-2xl p-4 overflow-auto" aria-label="Resume preview">
      <div className="origin-top mx-auto" style={{ transform: 'scale(0.62)', width: '8.5in', height: '11in' }}>
        <ResumeDocument resume={resume} template={resume.template} watermark={watermark} />
      </div>
    </div>
  )
}
