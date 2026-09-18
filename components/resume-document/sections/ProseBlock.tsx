import type { DocumentBlock } from '@/lib/resume/document/plan'
import { isLongHeading } from '@/lib/resume/document/templates'

/** A run of paragraphs under a heading. The professional summary, today. */
export default function ProseBlock({
  block,
  readingRank,
}: {
  block: Extract<DocumentBlock, { kind: 'prose' }>
  /** Position in reading order, independent of the column this block is drawn in. */
  readingRank: number
}) {
  return (
    <section
      className="rd-section"
      aria-labelledby={`h-${block.sectionId}`}
      data-section-type={block.sectionType}
      data-long-heading={isLongHeading(block.heading) ? 'true' : 'false'}
      data-reading-order={readingRank}
      style={{ '--rd-reading-order': readingRank } as React.CSSProperties}
    >
      <h2 className="rd-heading" id={`h-${block.sectionId}`}>{block.heading}</h2>
      <div>
        {block.paragraphs.map((paragraph, i) => (
          <p className="rd-paragraph" key={`${block.sectionId}-p${i}`}>{paragraph}</p>
        ))}
      </div>
    </section>
  )
}
