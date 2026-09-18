'use client'

import { ArrowRight, ChevronRight, CircleCheck, TriangleAlert } from 'lucide-react'
import { CATEGORY_BY_ID } from '@/lib/resume/score/types'
import type { CategoryResult } from '@/lib/resume/score/types'
import { cx, focusRing, text } from '../ui'
import type { IconType } from '../ui'

/**
 * One category: its score, and the four things it must always explain.
 *
 * A category with nothing to assess shows that instead of a number, and says
 * plainly that it is not counted against the applicant. A zero there would be
 * the credential penalty the whole design exists to avoid.
 */
export default function CategoryRow({ result, dim = false }: { result: CategoryResult; dim?: boolean }) {
  const definition = CATEGORY_BY_ID[result.id]
  const assessed = result.earned !== null
  const ratio = assessed ? (result.earned as number) / result.max : 0

  return (
    <details className="group py-0.5">
      <summary
        className={cx(
          'flex cursor-pointer list-none items-center gap-2 rounded-md py-1.5 text-[13px] text-slate-800 [&::-webkit-details-marker]:hidden',
          focusRing
        )}
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className="min-w-0 flex-1">{definition.label}</span>
        {assessed ? (
          <span
            className={cx(
              'shrink-0 font-semibold tabular-nums',
              dim ? 'text-slate-400' : ratio >= 0.85 ? 'text-emerald-700' : ratio >= 0.6 ? 'text-slate-700' : 'text-amber-700'
            )}
          >
            {formatPoints(result.earned as number)}
            <span className="font-normal text-slate-400">/{result.max}</span>
          </span>
        ) : (
          <span className={cx('shrink-0 text-xs', text.muted)}>Not assessed</span>
        )}
      </summary>

      <div className="space-y-2.5 pb-2 pl-5 pt-1">
        <p className={cx('text-xs leading-relaxed', text.muted)}>{definition.measures}</p>

        {!assessed && result.notAssessed && (
          <p className={cx('text-xs', text.secondary)}>{result.notAssessed}</p>
        )}

        <Lines icon={CircleCheck} tone="text-emerald-600" title="What is working" items={result.strengths} />
        <Lines icon={TriangleAlert} tone="text-amber-600" title="What is holding it back" items={result.weaknesses} />
        <Lines icon={ArrowRight} tone="text-violet-600" title="How to improve it" items={result.improvements} />
      </div>
    </details>
  )
}

function Lines({ icon: Icon, tone, title, items }: { icon: IconType; tone: string; title: string; items: readonly string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-[11px] font-medium text-slate-500">{title}</p>
      <ul className="mt-1 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex gap-1.5 text-xs leading-relaxed text-slate-700">
            <Icon className={cx('mt-0.5 h-3 w-3 shrink-0', tone)} aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Whole numbers where possible; a half point is still a real difference. */
function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
