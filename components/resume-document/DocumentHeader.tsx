import type { DocumentPlan } from '@/lib/resume/document/plan'

/**
 * Name, credentials and contact details. Renders nothing at all when the
 * applicant has filled in neither — an empty bordered block at the top of a
 * blank preview looks like a bug.
 */
export default function DocumentHeader({ plan }: { plan: DocumentPlan }) {
  if (!plan.name && plan.contact.length === 0) return null
  return (
    <header className="rd-header">
      {plan.name && <h1 className="rd-name">{plan.name}</h1>}
      {plan.contact.length > 0 && (
        <ul className="rd-contact">
          {plan.contact.map((piece, i) => <li key={`c${i}`}>{piece}</li>)}
        </ul>
      )}
    </header>
  )
}
