'use client'

import { useId } from 'react'
import type { KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import { TEMPLATES, TEMPLATE_LIST } from '@/lib/resume/document/templates'
import type { TemplateDefinition } from '@/lib/resume/document/templates'
import type { ResumeTemplate } from '@/lib/resume/model/types'
import { cx, focusRing } from '../ui'

/**
 * A schematic page drawn from a template's structural axes: header alignment,
 * heading style, columns, entry layout and density. No applicant data and no
 * renderer call -- it shows what a template IS, cheaply, anywhere.
 */

const SCALE = { sm: 'text-[5px]', md: 'text-[7px]' } as const
const BLOCK_GAP = { roomy: 'space-y-[1.3em]', normal: 'space-y-[1.05em]', tight: 'space-y-[0.8em]' } as const
const LINE_GAP = { roomy: 'space-y-[0.55em]', normal: 'space-y-[0.45em]', tight: 'space-y-[0.35em]' } as const
const LINE_WIDTHS = [100, 92, 84, 96]

export function asTemplate(value: string): ResumeTemplate {
  return value === 'modern' || value === 'compact' ? value : 'classic'
}

export function TemplateThumb({ template, size = 'md' }: { template: ResumeTemplate; size?: keyof typeof SCALE }) {
  const def = TEMPLATES[template]
  return (
    <div
      aria-hidden="true"
      className={cx(
        'aspect-[17/22] w-full overflow-hidden rounded-[0.35em] bg-white p-[1.4em] shadow-[0_1px_3px_rgba(15,23,42,0.12)] ring-1 ring-slate-200',
        SCALE[size]
      )}
    >
      <Header def={def} />
      {def.layout === 'sidebar' ? (
        <div className="mt-[1.4em] grid grid-cols-[1fr_2.3fr] gap-[1.1em]">
          <div className={BLOCK_GAP[def.density]}>
            {[2, 3, 2].map((lines, i) => <Block key={i} def={def} lines={lines} narrow />)}
          </div>
          <div className={BLOCK_GAP[def.density]}>
            {[3, 4, 3].map((lines, i) => <Block key={i} def={def} lines={lines} />)}
          </div>
        </div>
      ) : (
        <div className={cx('mt-[1.4em]', BLOCK_GAP[def.density])}>
          {[3, 4, 2, 3].map((lines, i) => <Block key={i} def={def} lines={lines} />)}
        </div>
      )}
    </div>
  )
}

function Header({ def }: { def: TemplateDefinition }) {
  return (
    <div className={cx('space-y-[0.5em]', def.headerAlign === 'center' && 'flex flex-col items-center')}>
      <div className="h-[1em] w-[48%] rounded-full bg-slate-800" />
      <div className="h-[0.45em] w-[70%] rounded-full bg-slate-300" />
    </div>
  )
}

function Block({ def, lines, narrow = false }: { def: TemplateDefinition; lines: number; narrow?: boolean }) {
  const body = (
    <div className={LINE_GAP[def.density]}>
      {def.entryLayout === 'opposed' ? (
        <div className="flex items-center justify-between gap-[1em]">
          <div className="h-[0.5em] w-[45%] rounded-full bg-slate-400" />
          <div className="h-[0.45em] w-[18%] rounded-full bg-slate-300" />
        </div>
      ) : (
        <div className="space-y-[0.35em]">
          <div className="h-[0.5em] w-[45%] rounded-full bg-slate-400" />
          <div className="h-[0.45em] w-[25%] rounded-full bg-slate-300" />
        </div>
      )}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-[0.4em] rounded-full bg-slate-200" style={{ width: `${LINE_WIDTHS[i % LINE_WIDTHS.length]}%` }} />
      ))}
    </div>
  )

  if (def.headingStyle === 'inline' && !narrow) {
    return (
      <div className="flex gap-[0.9em]">
        <div className="mt-[0.1em] h-[0.6em] w-[22%] shrink-0 rounded-full bg-slate-700" />
        <div className="min-w-0 flex-1">{body}</div>
      </div>
    )
  }

  return (
    <div className="space-y-[0.55em]">
      {def.headingStyle === 'ruled' ? (
        <div className="space-y-[0.35em]">
          <div className="h-[0.6em] w-[34%] rounded-full bg-slate-700" />
          <div className="h-px w-full bg-slate-300" />
        </div>
      ) : (
        <div className={cx('h-[0.5em] rounded-full', def.headingStyle === 'caps' ? 'w-[28%] bg-slate-500' : 'w-[30%] bg-slate-700')} />
      )}
      {body}
    </div>
  )
}

/**
 * Classic / Modern / Compact as pictures. A real radio group: one tab stop,
 * arrow keys move the selection, and each option's one-line summary is its
 * description for screen readers.
 */
export function TemplatePicker({
  value,
  onChange,
}: {
  value: ResumeTemplate
  onChange: (template: ResumeTemplate) => void
}) {
  const idBase = useId()

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const at = TEMPLATE_LIST.findIndex((t) => t.id === value)
    const next = TEMPLATE_LIST[(at + step + TEMPLATE_LIST.length) % TEMPLATE_LIST.length]
    onChange(next.id)
    const group = event.currentTarget
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-option="${next.id}"]`)?.focus())
  }

  return (
    <div role="radiogroup" aria-label="Template" onKeyDown={onKeyDown} className="flex items-start gap-1">
      {TEMPLATE_LIST.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-describedby={`${idBase}-${t.id}`}
            tabIndex={active ? 0 : -1}
            data-option={t.id}
            title={t.summary}
            onClick={() => onChange(t.id)}
            className={cx('flex flex-col items-center gap-1 rounded-lg px-1.5 pb-1 pt-1.5 transition-colors hover:bg-slate-100', focusRing)}
          >
            <span
              className={cx(
                'relative block w-9 rounded-[5px] ring-offset-2 ring-offset-white transition',
                active ? 'ring-2 ring-violet-600' : 'ring-1 ring-transparent'
              )}
            >
              <TemplateThumb template={t.id} size="sm" />
              {active && (
                <span className="absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-violet-600 text-white ring-2 ring-white">
                  <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden="true" />
                </span>
              )}
            </span>
            <span className={cx('text-[11px] leading-none', active ? 'font-semibold text-slate-900' : 'text-slate-600')}>
              {t.name}
            </span>
            <span id={`${idBase}-${t.id}`} className="sr-only">{t.summary}</span>
          </button>
        )
      })}
    </div>
  )
}
