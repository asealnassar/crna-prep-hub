'use client'

/**
 * What the import found, before anything is created.
 *
 * NOTHING EXISTS YET when this renders. No resume, no slot consumed, nothing to
 * clean up if the applicant walks away — which is the point of reviewing first.
 *
 * THREE HONEST CATEGORIES, all shown in full rather than counted. Placed, for
 * what traced verbatim to their document. Needs checking, for what we
 * recognised but could not place with confidence. Not placed, for lines nothing
 * was made of. The last two do not go into the resume's visible content; they
 * are kept in a hidden section so nothing unreviewed prints and nothing of
 * theirs is lost.
 *
 * Discarded values are COUNTED AND NEVER SHOWN. A discarded value is one the
 * organiser asserted and their document did not contain — rendering it here
 * would be the one place in this feature where a fabrication reaches a person.
 */

export interface ReviewMapping {
  readonly path: string
  readonly value: string
  readonly sourceLine?: number | null
}

export interface ImportReviewData {
  readonly importId: string
  readonly mapped: readonly ReviewMapping[]
  readonly uncertain: readonly ReviewMapping[]
  readonly unmapped: readonly string[]
  readonly discarded: number
  readonly organised: unknown
  readonly source: { readonly text: string; readonly format: string; readonly fingerprint: string }
}

/** "positions[0].employer" is not a thing to show a nurse. */
const SECTION_LABELS: Record<string, string> = {
  contact: 'Your details',
  summary: 'Professional summary',
  positions: 'Clinical experience',
  education: 'Education',
  certifications: 'Certifications',
  licenses: 'Licensure',
  entries: 'Other sections',
}

const FIELD_LABELS: Record<string, string> = {
  fullName: 'Name', credentials: 'Credentials', email: 'Email', phone: 'Phone',
  city: 'City', state: 'State', employer: 'Employer', role: 'Role', unit: 'Unit',
  location: 'Location', dates: 'Dates', bullets: 'Bullet', degree: 'Degree',
  field: 'Field', institution: 'Institution', graduated: 'Graduated',
  name: 'Name', issuer: 'Issuer', licenseType: 'Licence', title: 'Title',
  organization: 'Organisation', detail: 'Detail',
}

export function describePath(path: string): string {
  const [head, ...rest] = path.split(/[.[]/)
  const section = SECTION_LABELS[head] ?? head
  const field = rest.map((p) => p.replace(/\]$/, '')).filter((p) => !/^\d+$/.test(p)).pop()
  return field ? `${section} · ${FIELD_LABELS[field] ?? field}` : section
}

export default function ImportReview({
  review,
  busy,
  onCancel,
  onCreate,
}: {
  review: ImportReviewData
  busy: boolean
  onCancel: () => void
  onCreate: () => void
}) {
  const needsChecking = review.uncertain.length + review.unmapped.length

  return (
    <section className="border border-white/20 bg-white/5 rounded-2xl p-5">
      <h2 className="text-white font-semibold">Here is what we found</h2>
      <p className="text-xs text-indigo-300 mt-1">
        Nothing has been created yet. Everything below came from your document — nothing was added
        to it. Have a look, then choose whether to build a resume from it.
      </p>

      <Group
        title={`Will be filled in (${review.mapped.length})`}
        tone="border-emerald-300/30 bg-emerald-400/5"
      >
        {review.mapped.length === 0 ? (
          <p className="text-xs text-indigo-300">Nothing could be matched to a section.</p>
        ) : (
          <ul className="space-y-1">
            {review.mapped.map((m, i) => (
              <li key={`${m.path}-${i}`} className="text-xs text-indigo-100 flex flex-wrap gap-x-2">
                <span className="text-indigo-300 shrink-0">{describePath(m.path)}</span>
                <span className="text-white">{m.value}</span>
              </li>
            ))}
          </ul>
        )}
      </Group>

      {review.uncertain.length > 0 && (
        <Group
          title={`Needs your eye (${review.uncertain.length})`}
          tone="border-amber-300/40 bg-amber-400/5"
        >
          <p className="text-xs text-amber-100/90 mb-2">
            We recognised these from your document but could not place them confidently, so they
            will not be filled in automatically. They will be waiting in a hidden section for you to
            move where they belong.
          </p>
          <ul className="space-y-1">
            {review.uncertain.map((m, i) => (
              <li key={`${m.path}-${i}`} className="text-xs flex flex-wrap gap-x-2">
                <span className="text-amber-200/80 shrink-0">{describePath(m.path)}?</span>
                <span className="text-amber-50">{m.value}</span>
              </li>
            ))}
          </ul>
        </Group>
      )}

      {review.unmapped.length > 0 && (
        <Group title={`Not placed (${review.unmapped.length})`} tone="border-white/15 bg-white/5">
          <p className="text-xs text-indigo-300 mb-2">
            Lines from your document we could not match to any section. They are kept, hidden, for
            you to place or delete.
          </p>
          <ul className="space-y-1">
            {review.unmapped.map((line, i) => (
              <li key={i} className="text-xs text-indigo-100">{line}</li>
            ))}
          </ul>
        </Group>
      )}

      {review.discarded > 0 && (
        <p className="mt-3 text-xs text-indigo-300">
          {review.discarded} suggested {review.discarded === 1 ? 'value was' : 'values were'}{' '}
          discarded for not appearing in your document, and are not shown.
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onCreate}
          disabled={busy || review.mapped.length === 0}
          aria-busy={busy}
          className="px-5 py-2.5 bg-white text-indigo-900 font-semibold rounded-xl hover:bg-indigo-50 transition disabled:opacity-60"
        >
          {busy ? 'Creating...' : 'Create this resume'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-5 py-2.5 border border-white/30 text-white font-semibold rounded-xl hover:bg-white/10 transition disabled:opacity-60"
        >
          Cancel
        </button>
        {needsChecking > 0 && (
          <p className="text-xs text-indigo-300 self-center">
            Cancelling creates nothing and uses none of your resume allowance.
          </p>
        )}
      </div>
    </section>
  )
}

function Group({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) {
  return (
    <div className={`mt-4 rounded-xl border p-3 ${tone}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-200 mb-2">{title}</h3>
      {children}
    </div>
  )
}
