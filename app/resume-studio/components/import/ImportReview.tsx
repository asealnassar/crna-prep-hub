'use client'

import { Button, Card, cx, text } from '../ui'

/**
 * What the import found, before anything is created.
 *
 * NOTHING EXISTS YET when this renders. No resume, no slot consumed, nothing to
 * clean up if the applicant walks away — which is the point of reviewing first.
 *
 * THREE HONEST CATEGORIES, all shown in full rather than counted. Placed, for
 * what traced to their document. Needs checking, for what we recognised but
 * could not place with confidence. Imported items to review, for every line
 * nothing was made of -- which is exactly the list the editor shows under the
 * same name once the resume exists, word for word, never printed until the
 * applicant places it.
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
    <Card as="section" className="p-5">
      <h3 className="text-base font-semibold text-slate-900">Here is what we found</h3>
      <p className={cx('mt-1 text-sm', text.secondary)}>
        Nothing has been created yet. Everything below came from your document — nothing was added
        to it. Have a look, then choose whether to build a resume from it.
      </p>

      <Group
        title={`Will be filled in (${review.mapped.length})`}
        tone="border-emerald-200 bg-emerald-50/60"
      >
        {review.mapped.length === 0 ? (
          <p className={cx('text-xs', text.muted)}>Nothing could be matched to a section.</p>
        ) : (
          <ul className="space-y-1">
            {review.mapped.map((m, i) => (
              <li key={`${m.path}-${i}`} className="flex flex-wrap gap-x-2 text-xs">
                <span className="shrink-0 text-slate-500">{describePath(m.path)}</span>
                <span className="text-slate-900">{m.value}</span>
              </li>
            ))}
          </ul>
        )}
      </Group>

      {review.uncertain.length > 0 && (
        <Group
          title={`Needs your eye (${review.uncertain.length})`}
          tone="border-amber-200 bg-amber-50/70"
        >
          <p className="mb-2 text-xs text-amber-800">
            We recognised these from your document but could not place them confidently, so they
            will not be filled in automatically. The lines they came from are listed under
            “Imported items to review”, exactly as written, for you to place or remove.
          </p>
          <ul className="space-y-1">
            {review.uncertain.map((m, i) => (
              <li key={`${m.path}-${i}`} className="flex flex-wrap gap-x-2 text-xs">
                <span className="shrink-0 text-amber-800">{describePath(m.path)}?</span>
                <span className="text-slate-900">{m.value}</span>
              </li>
            ))}
          </ul>
        </Group>
      )}

      {review.unmapped.length > 0 && (
        <Group title={`Imported items to review (${review.unmapped.length})`} tone="border-slate-200 bg-slate-50">
          <p className={cx('mb-2 text-xs', text.secondary)}>
            Lines from your document that were not placed automatically. After you create the resume,
            they wait at the top of the editor under this heading, exactly as written. They will not
            appear on your resume or in downloads until you place them.
          </p>
          <ul className="space-y-1">
            {review.unmapped.map((line, i) => (
              <li key={i} className="text-xs text-slate-800">{line}</li>
            ))}
          </ul>
        </Group>
      )}

      {review.discarded > 0 && (
        <p className={cx('mt-3 text-xs', text.muted)}>
          {review.discarded} suggested {review.discarded === 1 ? 'value was' : 'values were'}{' '}
          discarded for not appearing in your document, and are not shown.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={onCreate}
          disabled={busy || review.mapped.length === 0}
          aria-busy={busy}
        >
          {busy ? 'Creating...' : 'Create this resume'}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {needsChecking > 0 && (
          <p className={cx('text-xs', text.muted)}>
            Cancelling creates nothing and uses none of your resume allowance.
          </p>
        )}
      </div>
    </Card>
  )
}

function Group({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) {
  return (
    <div className={cx('mt-4 rounded-lg border p-3', tone)}>
      <h4 className="mb-2 text-xs font-semibold text-slate-700">{title}</h4>
      {children}
    </div>
  )
}
