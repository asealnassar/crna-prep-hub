import type { DocumentBlock, DocumentEntry } from '@/lib/resume/document/plan'

/**
 * Titled items under a heading: jobs, degrees, certifications, awards.
 *
 * Every field is optional at render time — the plan has already removed the
 * blanks, so an absent subtitle simply produces no element rather than an empty
 * one that still occupies a line.
 */
function Entry({ entry }: { entry: DocumentEntry }) {
  return (
    <div className="rd-entry">
      <div className="rd-entry-head">
        <div>
          {entry.title && <span className="rd-title">{entry.title}</span>}
          {entry.title && entry.subtitle && <span aria-hidden="true">{' — '}</span>}
          {entry.subtitle && <span className="rd-subtitle">{entry.subtitle}</span>}
        </div>
        {entry.meta && <span className="rd-meta">{entry.meta}</span>}
      </div>

      {entry.location && <div className="rd-location">{entry.location}</div>}

      {entry.notes.length > 0 && (
        <ul className="rd-notes">
          {entry.notes.map((note, i) => <li key={`${entry.id}-n${i}`}>{note}</li>)}
        </ul>
      )}

      {entry.detail.length > 0 && (
        <ul className="rd-bullets">
          {entry.detail.map((line, i) => <li key={`${entry.id}-d${i}`}>{line}</li>)}
        </ul>
      )}
    </div>
  )
}

export default function EntriesBlock({ block }: { block: Extract<DocumentBlock, { kind: 'entries' }> }) {
  return (
    <section className="rd-section" aria-labelledby={`h-${block.sectionId}`}>
      <h2 className="rd-heading" id={`h-${block.sectionId}`}>{block.heading}</h2>
      <div>
        {block.entries.map((entry) => <Entry entry={entry} key={entry.id} />)}
      </div>
    </section>
  )
}
