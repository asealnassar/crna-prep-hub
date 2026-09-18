'use client'

import type { StrengthResult } from '@/lib/resume/score/types'

/**
 * The shortest path to a better resume: every improvement, in one list,
 * heaviest category first.
 *
 * The per-category detail is there for someone who wants to understand the
 * number. This is for someone who just wants to know what to do next.
 */
export default function ImprovementList({ result }: { result: StrengthResult }) {
  const items = [result.dataQuality, result.writingQuality]
    .flatMap((sub) => sub.categories)
    .filter((c) => c.improvements.length > 0)
    // A category with more points on the table is worth doing first.
    .sort((a, b) => (b.max - (b.earned ?? b.max)) - (a.max - (a.earned ?? a.max)))
    .flatMap((c) => c.improvements)

  if (items.length === 0) {
    return (
      <p className="text-xs text-emerald-700">
        Nothing outstanding — every category that could be assessed came back clean.
      </p>
    )
  }

  return (
    <ol className="space-y-2">
      {items.slice(0, 8).map((item, i) => (
        <li key={i} className="flex gap-2.5 text-[13px] leading-snug text-slate-700">
          <span
            aria-hidden="true"
            className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-600"
          >
            {i + 1}
          </span>
          {item}
        </li>
      ))}
    </ol>
  )
}
