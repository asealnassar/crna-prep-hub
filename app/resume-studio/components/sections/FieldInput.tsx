'use client'

import { rawDateText } from '@/lib/resume/model/dates'
import type { ResumeDate, ResumeDateRange } from '@/lib/resume/model/dates'
import type { AuthoredText } from '@/lib/resume/model/authoredText'
import type { GpaValue } from '@/lib/resume/model/types'
import type { FieldDescriptor } from '@/lib/resume/studio/fields'
import type { FieldValue } from '@/lib/resume/studio/patch'

/**
 * One field, rendered from its descriptor.
 *
 * Every input carries an associated <label> -- not a placeholder standing in
 * for one. A placeholder disappears the moment someone types, which is exactly
 * when a person filling in eight similar boxes needs to know which is which,
 * and a screen reader never sees it as a name at all.
 *
 * Dates are plain text inputs, deliberately. The model accepts "Spring 2024"
 * and "expected 2026" and keeps them intact; a native date picker would force a
 * day-precision value nobody has and reject the honest answer.
 */
const INPUT =
  'w-full bg-white/10 border border-white/25 rounded-lg px-3 py-2 text-white placeholder-indigo-300/50 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-300'
const LABEL = 'block text-xs font-semibold text-indigo-200 mb-1'

export default function FieldInput({
  descriptor,
  value,
  id,
  onChange,
}: {
  descriptor: FieldDescriptor
  value: unknown
  id: string
  onChange: (value: FieldValue) => void
}) {
  switch (descriptor.kind) {
    case 'text':
      return (
        <div>
          <label className={LABEL} htmlFor={id}>{descriptor.label}</label>
          <input
            id={id}
            className={INPUT}
            value={String(value ?? '')}
            placeholder={descriptor.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )

    case 'date':
      return (
        <div>
          <label className={LABEL} htmlFor={id}>{descriptor.label}</label>
          <input
            id={id}
            className={INPUT}
            value={rawDateText((value ?? { kind: 'absent' }) as ResumeDate)}
            placeholder="2024-05 or Spring 2024"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )

    case 'daterange': {
      const range = (value ?? { start: { kind: 'absent' }, end: { kind: 'absent' }, isCurrent: false }) as ResumeDateRange
      const emit = (over: Partial<{ start: string; end: string; isCurrent: boolean }>) =>
        onChange({
          start: rawDateText(range.start),
          end: rawDateText(range.end),
          isCurrent: range.isCurrent,
          ...over,
        })
      return (
        <div>
          <span className={LABEL}>{descriptor.label}</span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`${id}-start`}>{descriptor.label} start</label>
            <input
              id={`${id}-start`}
              className={`${INPUT} flex-1 min-w-[7rem]`}
              value={rawDateText(range.start)}
              placeholder="Start"
              onChange={(e) => emit({ start: e.target.value })}
            />
            <label className="sr-only" htmlFor={`${id}-end`}>{descriptor.label} end</label>
            <input
              id={`${id}-end`}
              className={`${INPUT} flex-1 min-w-[7rem]`}
              value={range.isCurrent ? '' : rawDateText(range.end)}
              placeholder={range.isCurrent ? 'Present' : 'End'}
              disabled={range.isCurrent}
              onChange={(e) => emit({ end: e.target.value })}
            />
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm text-indigo-100">
            <input
              type="checkbox"
              checked={range.isCurrent}
              onChange={(e) => emit({ isCurrent: e.target.checked })}
            />
            Still in this role
          </label>
        </div>
      )
    }

    case 'gpa': {
      const gpa = (value ?? { raw: '', value: null, showOnResume: false }) as GpaValue
      return (
        <div>
          <label className={LABEL} htmlFor={id}>{descriptor.label}</label>
          <input
            id={id}
            className={INPUT}
            value={gpa.raw}
            placeholder="3.85"
            onChange={(e) => onChange({ raw: e.target.value, showOnResume: gpa.showOnResume })}
          />
          {/* Off by default. V1 printed whatever was entered, with no way to
              withhold a GPA a programme had not asked for. */}
          <label className="mt-2 flex items-center gap-2 text-sm text-indigo-100">
            <input
              type="checkbox"
              checked={gpa.showOnResume}
              onChange={(e) => onChange({ raw: gpa.raw, showOnResume: e.target.checked })}
            />
            Show on resume
          </label>
        </div>
      )
    }

    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-sm text-indigo-100">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {descriptor.label}
        </label>
      )

    case 'authored': {
      const text = (value ?? null) as AuthoredText | null
      return (
        <div>
          <label className={LABEL} htmlFor={id}>{descriptor.label}</label>
          <textarea
            id={id}
            className={`${INPUT} min-h-[5rem]`}
            value={text?.accepted ?? ''}
            placeholder={descriptor.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )
    }
  }
}
