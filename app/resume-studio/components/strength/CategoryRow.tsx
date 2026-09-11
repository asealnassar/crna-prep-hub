'use client'

import { CATEGORY_BY_ID } from '@/lib/resume/score/types'
import type { CategoryResult } from '@/lib/resume/score/types'

/**
 * One category: its score, and the four things it must always explain.
 *
 * A category with nothing to assess shows that instead of a number, and says
 * plainly that it is not counted against the applicant. A zero there would be
 * the credential penalty the whole design exists to avoid.
 */
export default function CategoryRow({ result }: { result: CategoryResult }) {
  const definition = CATEGORY_BY_ID[result.id]
  const assessed = result.earned !== null
  const ratio = assessed ? (result.earned as number) / result.max : 0

  return (
    <details className="border-b border-white/10 last:border-b-0 py-2 group">
      <summary className="flex items-baseline justify-between gap-3 cursor-pointer list-none">
        <span className="text-sm text-white">
          <span aria-hidden="true" className="inline-block w-4 text-indigo-300 group-open:rotate-90 transition-transform">
            ▸
          </span>
          {definition.label}
        </span>
        {assessed ? (
          <span className={`text-sm font-semibold shrink-0 ${ratio >= 0.85 ? 'text-emerald-200' : ratio >= 0.6 ? 'text-indigo-100' : 'text-amber-200'}`}>
            {formatPoints(result.earned as number)}<span className="text-indigo-300 font-normal">/{result.max}</span>
          </span>
        ) : (
          <span className="text-xs text-indigo-300 shrink-0">Not assessed</span>
        )}
      </summary>

      <div className="pl-4 pt-2 space-y-2">
        <p className="text-xs text-indigo-300">{definition.measures}</p>

        {!assessed && result.notAssessed && (
          <p className="text-xs text-indigo-200">{result.notAssessed}</p>
        )}

        <Lines title="What is working" tone="text-emerald-200" items={result.strengths} />
        <Lines title="What is holding it back" tone="text-amber-200" items={result.weaknesses} />
        <Lines title="How to improve it" tone="text-indigo-100" items={result.improvements} />
      </div>
    </details>
  )
}

function Lines({ title, tone, items }: { title: string; tone: string; items: readonly string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-300">{title}</p>
      <ul className="mt-1 space-y-1">
        {items.map((item, i) => (
          <li key={i} className={`text-xs ${tone}`}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

/** Whole numbers where possible; a half point is still a real difference. */
function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
