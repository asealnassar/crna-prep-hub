'use client'

import { useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import {
  importItemsOf, placementFor, placementGroups, suggestedPlacement,
} from '@/lib/resume/studio/importItems'
import type { PlacementGroup } from '@/lib/resume/studio/importItems'
import type { CustomEntry, ResumeV2 } from '@/lib/resume/model/types'
import { Badge, Button, Card, SelectField, cx, focusRing, text } from '../ui'

/**
 * "Imported items to review": what an import could not place, in the editor.
 *
 * THERE ONLY WHILE THERE IS SOMETHING TO REVIEW, and never on the resume: the
 * document plan skips the list outright, so nothing here prints, exports or
 * counts toward Resume Strength until the applicant places it.
 *
 * NOTHING LEAVES WITHOUT A DECISION. Each line shows exactly as it was
 * imported. It goes where the applicant chooses -- a suggestion is only a
 * pre-selection -- or it is dismissed after a second, explicit confirmation.
 * Both save at once, so a reload finds the list as it was left.
 */
export default function ImportReviewPanel({
  resume,
  newId,
  emit,
  onFlush,
  compact = false,
}: {
  resume: ResumeV2
  newId: () => string
  emit: (patch: StudioPatch) => void
  /** Saves the queue now rather than at the end of the debounce. */
  onFlush: () => void
  /** Phone layout. Presentation only. */
  compact?: boolean
}) {
  const [open, setOpen] = useState(true)
  const [status, setStatus] = useState('')
  const toggle = useRef<HTMLButtonElement>(null)

  const found = importItemsOf(resume)
  if (!found) return null
  const { reviewId, items } = found
  const groups = placementGroups(resume)

  /** Focus would otherwise fall to the page when the item it was on goes. */
  const settle = (message: string) => {
    setStatus(message)
    onFlush()
    requestAnimationFrame(() => toggle.current?.focus())
  }

  return (
    <Card as="section" aria-labelledby="import-review-title" className="border-amber-300 bg-amber-50/50">
      <button
        ref={toggle}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="import-review-items"
        className={cx('flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left', focusRing)}
      >
        <ChevronRight
          className={cx('h-4 w-4 shrink-0 text-amber-700 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        <span id="import-review-title" className={text.heading}>
          Imported items to review ({items.length})
        </span>
        {!compact && <Badge tone="warning" className="ml-auto">Not on your resume yet</Badge>}
      </button>

      {open && (
        <div id="import-review-items" className="border-t border-amber-200 px-4 pb-4 pt-3">
          <p className={cx('text-xs leading-relaxed', text.secondary)}>
            These lines from your uploaded resume were not placed automatically. They are kept here
            exactly as written, and they will not appear on your resume or in downloads until you
            place them.
          </p>
          <ul className="mt-3 space-y-2">
            {items.map((item) => (
              <ImportItem
                key={item.id}
                item={item}
                resume={resume}
                groups={groups}
                compact={compact}
                onPlace={(value, label) => {
                  const target = placementFor(value, resume, newId)
                  if (!target) return
                  emit({ op: 'import-item-place', sectionId: reviewId, entryId: item.id, target })
                  settle(`Placed in ${label}.`)
                }}
                onDismiss={() => {
                  emit({ op: 'import-item-dismiss', sectionId: reviewId, entryId: item.id })
                  settle('Item removed.')
                }}
              />
            ))}
          </ul>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
    </Card>
  )
}

function ImportItem({
  item,
  resume,
  groups,
  compact,
  onPlace,
  onDismiss,
}: {
  item: CustomEntry
  resume: ResumeV2
  groups: readonly PlacementGroup[]
  compact: boolean
  onPlace: (value: string, label: string) => void
  onDismiss: () => void
}) {
  const suggested = suggestedPlacement(item, resume)
  const [choice, setChoice] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const value = choice ?? suggested
  const option = groups.flatMap((group) => group.options).find((o) => o.value === value)
  const selectId = `import-item-${item.id}`

  return (
    <li className="rounded-lg border border-amber-200 bg-white p-3">
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-900">
        {item.detail.accepted}
      </p>

      <div className={cx('mt-2.5 flex gap-2', compact ? 'flex-col' : 'flex-wrap items-end')}>
        <SelectField
          id={selectId}
          label="Place it in"
          value={option ? value : ''}
          onChange={(e) => setChoice(e.target.value)}
          className="min-w-0 flex-1 sm:min-w-[14rem]"
        >
          <option value="">Choose where it belongs…</option>
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </optgroup>
          ))}
        </SelectField>
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!option}
            onClick={() => option && onPlace(option.value, option.label)}
          >
            Place
          </Button>
          {!confirming && (
            <Button variant="tertiary" size="sm" onClick={() => setConfirming(true)}>
              Dismiss
            </Button>
          )}
        </div>
      </div>

      {option && value === suggested && (
        <p className={cx('mt-1.5 text-xs', text.muted)}>Suggested from where it sat in your document.</p>
      )}

      {confirming && (
        <div
          role="group"
          aria-label="Confirm removing this item"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-red-50 px-2.5 py-2"
        >
          <span className="text-xs text-red-800">
            Remove this line? It will not be added to your resume.
          </span>
          <Button variant="danger" size="sm" onClick={onDismiss}>
            Remove
          </Button>
          <Button variant="tertiary" size="sm" autoFocus onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      )}
    </li>
  )
}
