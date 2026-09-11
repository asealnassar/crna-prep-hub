import type { DocumentBlock } from '@/lib/resume/document/plan'

/** A run of paragraphs under a heading. The professional summary, today. */
export default function ProseBlock({ block }: { block: Extract<DocumentBlock, { kind: 'prose' }> }) {
  return (
    <section className="rd-section" aria-labelledby={`h-${block.sectionId}`}>
      <h2 className="rd-heading" id={`h-${block.sectionId}`}>{block.heading}</h2>
      <div>
        {block.paragraphs.map((paragraph, i) => (
          <p className="rd-paragraph" key={`${block.sectionId}-p${i}`}>{paragraph}</p>
        ))}
      </div>
    </section>
  )
}
