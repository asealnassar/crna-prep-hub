'use client'

import type { ReactNode } from 'react'
import { rawDateText } from '@/lib/resume/model/dates'
import type { ResumeDate, ResumeDateRange } from '@/lib/resume/model/dates'
import type { AuthoredText } from '@/lib/resume/model/authoredText'
import type { GpaValue } from '@/lib/resume/model/types'
import type { FieldDescriptor } from '@/lib/resume/studio/fields'
import type { FieldValue } from '@/lib/resume/studio/patch'
import { CheckboxField, TextAreaField, TextField, cx, field as fieldStyle } from '../ui'

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
export default function FieldInput({
  descriptor,
  value,
  id,
  onChange,
  footer,
}: {
  descriptor: FieldDescriptor
  value: unknown
  id: string
  onChange: (value: FieldValue) => void
  /** Authored prose only: a toolbar inside the field, where its AI actions live. */
  footer?: ReactNode
}) {
  switch (descriptor.kind) {
    case 'text':
      return (
        <TextField
          id={id}
          label={descriptor.label}
          value={String(value ?? '')}
          placeholder={descriptor.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )

    case 'date':
      return (
        <TextField
          id={id}
          label={descriptor.label}
          value={rawDateText((value ?? { kind: 'absent' }) as ResumeDate)}
          placeholder="2024-05 or Spring 2024"
          onChange={(e) => onChange(e.target.value)}
        />
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
          <span className={fieldStyle.label}>{descriptor.label}</span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`${id}-start`}>{descriptor.label} start</label>
            <input
              id={`${id}-start`}
              className={cx(fieldStyle.control, 'min-w-[7rem] flex-1')}
              value={rawDateText(range.start)}
              placeholder="Start"
              onChange={(e) => emit({ start: e.target.value })}
            />
            <label className="sr-only" htmlFor={`${id}-end`}>{descriptor.label} end</label>
            <input
              id={`${id}-end`}
              className={cx(fieldStyle.control, 'min-w-[7rem] flex-1')}
              value={range.isCurrent ? '' : rawDateText(range.end)}
              placeholder={range.isCurrent ? 'Present' : 'End'}
              disabled={range.isCurrent}
              onChange={(e) => emit({ end: e.target.value })}
            />
          </div>
          <CheckboxField
            id={`${id}-current`}
            label="Still in this role"
            className="mt-2"
            checked={range.isCurrent}
            onChange={(e) => emit({ isCurrent: e.target.checked })}
          />
        </div>
      )
    }

    case 'gpa': {
      const gpa = (value ?? { raw: '', value: null, showOnResume: false }) as GpaValue
      return (
        <div>
          <TextField
            id={id}
            label={descriptor.label}
            value={gpa.raw}
            placeholder="3.85"
            onChange={(e) => onChange({ raw: e.target.value, showOnResume: gpa.showOnResume })}
          />
          {/* Off by default. V1 printed whatever was entered, with no way to
              withhold a GPA a programme had not asked for. */}
          <CheckboxField
            id={`${id}-show`}
            label="Show on resume"
            className="mt-2"
            checked={gpa.showOnResume}
            onChange={(e) => onChange({ raw: gpa.raw, showOnResume: e.target.checked })}
          />
        </div>
      )
    }

    case 'boolean':
      return (
        <CheckboxField
          id={id}
          label={descriptor.label}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      )

    case 'authored': {
      const text = (value ?? null) as AuthoredText | null
      return (
        <TextAreaField
          id={id}
          label={descriptor.label}
          value={text?.accepted ?? ''}
          placeholder={descriptor.placeholder}
          footer={footer}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    }
  }
}
