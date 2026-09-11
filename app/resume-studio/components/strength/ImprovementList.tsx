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
      <p className="text-xs text-emerald-200">
        Nothing outstanding — every category that could be assessed came back clean.
      </p>
    )
  }

  return (
    <ol className="space-y-1.5 list-decimal list-inside">
      {items.slice(0, 8).map((item, i) => (
        <li key={i} className="text-xs text-indigo-100">{item}</li>
      ))}
    </ol>
  )
}
