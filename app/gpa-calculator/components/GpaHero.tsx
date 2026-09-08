'use client'

/**
 * The result area, and the page's Level 1.
 *
 * Previously four (sometimes five) identical bordered cards, each with a large
 * emoji, which said "these are all equally important" when Overall is the
 * number applicants actually quote. Overall now gets the large figure and its
 * own panel; the supporting GPAs sit beside it at a smaller size.
 */

import type { ReactNode } from 'react'
import { AlertTriangle, Clock, FlaskConical, GraduationCap, Stethoscope } from 'lucide-react'
import type { GpaResult } from '@/lib/gpa'

export interface HeroResults {
  overall: GpaResult
  science: GpaResult
  nursing: GpaResult
  last60: GpaResult
  graduate: GpaResult
}

function Metric({
  icon, label, value, meta, pending,
}: { icon: ReactNode; label: string; value: string; meta: string; pending: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-slate-400">
        <span aria-hidden>{icon}</span>
        <span className="text-xs font-medium text-slate-600">{label}</span>
      </div>
      {pending ? (
        // "0 counted" reads as "your transcript had nothing in it", which is
        // untrue while the only problem is an unanswered setup question.
        <p className="mt-1.5 text-lg font-semibold tracking-tight text-slate-400">Pending</p>
      ) : (
        <>
          <p className="mt-1.5 text-2xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</p>
          <p className="mt-0.5 text-xs text-slate-500">{meta}</p>
        </>
      )}
    </div>
  )
}

export function GpaHero({
  results, hasGraduate, blocked, pending, requiredCount,
}: {
  results: HeroResults; hasGraduate: boolean; blocked: number
  /** Setup is incomplete AND no Overall number can be produced yet. */
  pending: boolean
  requiredCount: number
}) {
  const show = (v: string | null) => v ?? '—'

  return (
    <section aria-label="GPA results" className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      {/* Overall: the hero. Gradient is reserved for this one moment. */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-500 px-5 py-5 text-white shadow-lg shadow-violet-500/15 sm:px-6">
        <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-white/10 blur-2xl" aria-hidden />
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/70">Overall GPA</p>
        {pending ? (
          <>
            <p className="mt-2 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">Pending setup</p>
            <p className="mt-2 text-sm text-white/80">
              Complete {requiredCount} required item{requiredCount === 1 ? '' : 's'} below to calculate.
            </p>
          </>
        ) : (
          <>
            <p className="mt-1.5 text-5xl font-bold leading-none tracking-tight tabular-nums sm:text-6xl">
              {show(results.overall.display)}
            </p>
            <p className="mt-2.5 text-sm text-white/80">
              {results.overall.creditsCounted} graded credit{results.overall.creditsCounted === 1 ? '' : 's'}
              {' · '}{results.overall.coursesCounted} course{results.overall.coursesCounted === 1 ? '' : 's'}
            </p>
            {blocked > 0 && (
              /* "more awaiting review" read like extra courses waiting in a
                 queue. They are held OUT of the number above -- temporarily,
                 until a setup decision is made, which is what "pending" says
                 without implying anything permanent. */
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white/20 px-2.5 py-1 text-xs font-semibold text-white">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                {blocked} course{blocked === 1 ? '' : 's'} held out pending review
              </p>
            )}
          </>
        )}
      </div>

      <div className={`grid gap-3 sm:grid-cols-2 ${hasGraduate ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
        <Metric pending={pending} icon={<FlaskConical className="h-4 w-4" />} label="Science"
          value={show(results.science.display)} meta={`${results.science.coursesCounted} counted`} />
        <Metric pending={pending} icon={<Stethoscope className="h-4 w-4" />} label="Nursing"
          value={show(results.nursing.display)} meta={`${results.nursing.coursesCounted} counted`} />
        <Metric pending={pending} icon={<Clock className="h-4 w-4" />} label="Last 60"
          value={show(results.last60.display)} meta={`${results.last60.creditsCounted} credits`} />
        {hasGraduate && (
          <Metric pending={pending} icon={<GraduationCap className="h-4 w-4" />} label="Graduate"
            value={show(results.graduate.display)} meta={`${results.graduate.coursesCounted} counted`} />
        )}
      </div>
    </section>
  )
}
