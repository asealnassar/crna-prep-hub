'use client'

import { useState } from 'react'
import { Search } from 'lucide-react'
import {
  alreadyHasFact, filterCategories,
} from '@/lib/resume/studio/icuCatalogue'
import type { IcuFactField, IcuSelection } from '@/lib/resume/studio/icuCatalogue'
import type { ClinicalFacts } from '@/lib/resume/model/types'
import { Button, CheckboxField, TextField, cardClass, cx, text } from '../ui'

/**
 * "Select your ICU experience" — the step before bullets are written.
 *
 * WHAT THIS IS FOR. A model asked to write bullets from an employer, a role and
 * a date range has nothing true and specific to say. It is being asked to
 * describe work it knows nothing about, and the only ways out are vagueness or
 * invention. So the applicant is asked first, in the vocabulary of their own
 * speciality, and every tick becomes a fact they supplied.
 *
 * NOTHING IS TICKED FOR THEM. Not from the unit type, not from the job title,
 * not from what an ICU nurse "usually" does. An unticked box is not a fact that
 * something did not happen; it is the absence of a fact, and a bullet cannot be
 * built on it.
 *
 * WHAT IS ALREADY THEIRS is shown ticked and fixed, because this list is
 * additive: it is how facts are added to a position, never how they are
 * quietly dropped from one.
 */
export default function IcuExperiencePicker({
  id,
  facts,
  busy,
  onConfirm,
  onCancel,
}: {
  id: string
  facts: ClinicalFacts
  busy: boolean
  onConfirm: (selections: IcuSelection[]) => void
  onCancel: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<readonly IcuSelection[]>([])
  const [custom, setCustom] = useState<Record<string, string>>({})

  const stored = (field: IcuFactField): readonly string[] =>
    ((facts as unknown as Record<string, unknown>)[field] as string[] | undefined) ?? []

  const isTicked = (field: IcuFactField, value: string) =>
    selected.some((s) => s.field === field && s.value === value)

  const toggle = (field: IcuFactField, value: string) =>
    setSelected((current) =>
      current.some((s) => s.field === field && s.value === value)
        ? current.filter((s) => !(s.field === field && s.value === value))
        : [...current, { field, value }]
    )

  const customSelections: IcuSelection[] = Object.entries(custom)
    .map(([categoryId, value]) => {
      const category = filterCategories('').find((c) => c.id === categoryId)
      return category && value.trim() !== '' ? { field: category.field, value: value.trim() } : null
    })
    .filter((entry): entry is IcuSelection => entry !== null)

  const groups = filterCategories(query)
  const count = selected.length + customSelections.length

  return (
    <div id={id} className={cx(cardClass('muted'), 'p-3')}>
      <p className={cx('mb-1', text.heading)}>Select your ICU experience</p>
      <p className={cx('mb-3 text-xs', text.muted)}>
        Tick only what you have done yourself. Everything you tick becomes a fact the
        assistant may use; anything you leave unticked, it may not.
      </p>

      <TextField
        id={`${id}-search`}
        label="Search"
        value={query}
        placeholder="Search devices, drips, conditions..."
        onChange={(e) => setQuery(e.target.value)}
        action={<Search className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />}
      />

      <div className="mt-3 max-h-80 space-y-4 overflow-y-auto pr-1">
        {groups.length === 0 && (
          <p className={cx('text-xs', text.muted)}>
            Nothing matches “{query.trim()}”. Clear the search, or add it as your own below.
          </p>
        )}

        {groups.map((category) => (
          <fieldset key={category.id}>
            <legend className={text.overline}>{category.title}</legend>
            <p className={cx('mb-1.5 text-xs', text.muted)}>{category.help}</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {category.options.map((option) => {
                const already = alreadyHasFact(stored(category.field), option)
                return (
                  <CheckboxField
                    key={option}
                    id={`${id}-${category.id}-${option.replace(/\W+/g, '-')}`}
                    label={already ? `${option} — already added` : option}
                    checked={already || isTicked(category.field, option)}
                    disabled={already}
                    onChange={() => toggle(category.field, option)}
                  />
                )
              })}
            </div>
            <TextField
              id={`${id}-${category.id}-custom`}
              label="Something else"
              className="mt-2"
              value={custom[category.id] ?? ''}
              placeholder="In your own words"
              onChange={(e) => setCustom((c) => ({ ...c, [category.id]: e.target.value }))}
            />
          </fieldset>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => onConfirm([...selected, ...customSelections])}
        >
          {busy ? 'Working...' : 'Generate bullet options'}
        </Button>
        <Button size="sm" variant="tertiary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={cx('text-xs tabular-nums', text.muted)} role="status">
          {count} selected
        </span>
      </div>
    </div>
  )
}
