import { DOCUMENT_CSS, cssVariablesFor } from '@/lib/resume/document/css'
import { fontFaceCss } from '@/lib/resume/document/fonts'
import { planDocument } from '@/lib/resume/document/plan'
import type { DocumentBlock, DocumentPlan } from '@/lib/resume/document/plan'
import { splitPlan, templateFor } from '@/lib/resume/document/templates'
import type { TemplateDefinition } from '@/lib/resume/document/templates'
import type { ResumeV2 } from '@/lib/resume/model/types'
import DocumentHeader from './DocumentHeader'
import EntriesBlock from './sections/EntriesBlock'
import ProseBlock from './sections/ProseBlock'

/**
 * The shared resume document. Preview and export both mount THIS.
 *
 * A pure function of canonical data: give it the same resume twice and you get
 * the same markup twice. It reads no context, holds no state, fetches nothing,
 * and knows nothing about editing, routing or Supabase. That is what lets the
 * export path use it without a browser session and what lets it be reasoned
 * about in tests without a DOM.
 *
 * Everything it decides has already been decided: `planDocument` says what the
 * resume says, `splitPlan` says which column each block belongs to, and the
 * stylesheet's data attributes say how a template differs. What is left here is
 * assembly, which is why there is no per-section and no per-template component.
 *
 * `includeStyles` exists for the export path: a page that mounts several
 * documents wants one copy of the stylesheet, not one per document.
 */
export default function ResumeDocument({
  resume,
  plan,
  template,
  includeStyles = true,
  fontCss,
  watermark,
}: {
  /** The resume to render. Ignored when `plan` is supplied. */
  resume?: ResumeV2
  /** A pre-computed plan, for a caller that already built one. */
  plan?: DocumentPlan
  /** Template id or definition. Anything unrecognised falls back to Classic. */
  template?: string | TemplateDefinition | null
  includeStyles?: boolean
  /**
   * The @font-face block. Defaults to referencing `/fonts/*.woff2`, which is
   * right for the preview. The export path passes the same files inlined as
   * data URIs, because Chromium is given HTML with no origin to resolve a URL
   * against. Same files either way -- only the delivery differs.
   */
  fontCss?: string
  /**
   * Marks the preview for a tier that may not export.
   *
   * The document underneath is complete and unmodified -- the mark is an
   * overlay, not a redaction. Absent for Ultimate, and absent on the export
   * path, which only Ultimate can reach. See lib/resume/entitlement.ts.
   */
  watermark?: string | null
}) {
  const definition = resolveTemplate(template, resume)
  const document = plan ?? (resume ? planDocument(resume) : EMPTY_PLAN)
  const { main, sidebar } = splitPlan(document, definition)

  return (
    <div
      className="rd-root"
      data-layout={definition.layout}
      data-header-align={definition.headerAlign}
      data-heading-style={definition.headingStyle}
      data-entry-layout={definition.entryLayout}
      data-density={definition.density}
      data-template={definition.id}
      data-watermarked={watermark ? 'true' : 'false'}
      style={cssVariablesFor(definition) as React.CSSProperties}
    >
      {includeStyles && (
        <style dangerouslySetInnerHTML={{ __html: `${fontCss ?? fontFaceCss()}\n${DOCUMENT_CSS}` }} />
      )}
      <article className="rd-page">
        {watermark && (
          <div className="rd-watermark" aria-hidden="true" data-testid="rd-watermark">
            {/* Repeated rather than tiled with a background image: a background
                is the first thing a browser drops when printing. */}
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <span key={row}>{watermark}</span>
            ))}
          </div>
        )}
        <DocumentHeader plan={document} />
        {/* Main column FIRST in the DOM. The stylesheet places the sidebar to
            its left with explicit grid coordinates, so what an ATS extracts
            reads as a resume rather than opening with licence numbers. See
            `readingOrder` in lib/resume/document/templates.ts. */}
        <div className="rd-columns">
          <div className="rd-main">{main.map(renderBlock)}</div>
          {sidebar.length > 0 && (
            <aside className="rd-aside">{sidebar.map(renderBlock)}</aside>
          )}
        </div>
      </article>
    </div>
  )
}

const EMPTY_PLAN: DocumentPlan = { name: '', contact: [], blocks: [] }

/** An explicit template wins; otherwise the resume's own; otherwise Classic. */
function resolveTemplate(
  template: string | TemplateDefinition | null | undefined,
  resume: ResumeV2 | undefined
): TemplateDefinition {
  if (template && typeof template === 'object') return template
  if (typeof template === 'string') return templateFor(template)
  return templateFor(resume?.template)
}

/**
 * Two primitives, so this is the whole dispatch. A new section type needs a
 * mapper in plan.ts and nothing here — which is why "all three templates render
 * every section type" is a property rather than a checklist.
 */
function renderBlock(block: DocumentBlock) {
  return block.kind === 'prose'
    ? <ProseBlock block={block} key={block.sectionId} />
    : <EntriesBlock block={block} key={block.sectionId} />
}
