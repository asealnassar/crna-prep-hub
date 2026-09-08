'use client'

/**
 * Shared surface primitives for the GPA workspace.
 *
 * The page used to be a stack of large white panels on a saturated purple
 * gradient, which gave every section the same weight no matter how much it
 * mattered. These pieces establish one calm neutral workspace where purple is
 * an accent, and let hierarchy come from size and placement instead of from
 * giving everything its own card.
 */

import { useId, useRef, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronDown, Loader2, RefreshCw } from 'lucide-react'

/** One surface treatment, used everywhere, so nothing nests card-in-card. */
export const CARD =
  'rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]'

export const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 ' +
  'to-indigo-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:from-violet-700 ' +
  'hover:to-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ' +
  'focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40'

export const BTN_SECONDARY =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white ' +
  'px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300 ' +
  'hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ' +
  'focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40'

export const BTN_GHOST =
  'inline-flex items-center justify-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium ' +
  'text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-violet-400'

export const FIELD =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none ' +
  'transition placeholder:text-slate-400 focus:border-violet-400 focus:ring-2 focus:ring-violet-100'

export const LABEL = 'mb-1.5 block text-xs font-medium text-slate-600'

/** Section heading inside a tab panel. */
export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-bold tracking-tight text-slate-900">{children}</h2>
      {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
    </div>
  )
}

export type NoticeTone = 'warn' | 'danger' | 'info'

const TONES: Record<NoticeTone, { wrap: string; icon: string; title: string }> = {
  warn:   { wrap: 'border-amber-200 bg-amber-50/70',  icon: 'text-amber-600',  title: 'text-amber-900' },
  danger: { wrap: 'border-rose-200 bg-rose-50/70',    icon: 'text-rose-600',   title: 'text-rose-900' },
  info:   { wrap: 'border-slate-200 bg-slate-50',     icon: 'text-slate-500',  title: 'text-slate-900' },
}

/**
 * A compact notice. The old page gave each of these a full-width bordered
 * panel with a 30px emoji, which pushed the actual coursework below the fold.
 */
export function Notice({
  tone = 'warn', title, children, actions,
}: { tone?: NoticeTone; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const t = TONES[tone]
  return (
    <div className={`rounded-xl border ${t.wrap} px-3.5 py-3`}>
      <div className="flex items-start gap-2.5">
        <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${t.icon}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${t.title}`}>{title}</p>
          {children && <div className="mt-1 text-sm text-slate-600">{children}</div>}
          {actions && <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div>}
        </div>
      </div>
    </div>
  )
}

/**
 * Autosave state. Deliberately worded so it can never be confused with the
 * snapshot action: this says "Saved", that one says "Save Snapshot".
 */
export function SaveStatus({
  state, onRetry,
}: { state: string; onRetry: () => void }) {
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Saving…
      </span>
    )
  }
  if (state === 'saved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600">
        <Check className="h-3.5 w-3.5" aria-hidden />Saved
      </span>
    )
  }
  if (state === 'merged') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />Merged changes from another tab
      </span>
    )
  }
  if (state === 'needs-resolution') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />Conflict — needs your choice
      </span>
    )
  }
  if (state === 'error') {
    return (
      <button onClick={onRetry}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-600 underline underline-offset-2">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />Save failed — retry
      </button>
    )
  }
  return null
}

export interface TabSpec {
  id: string
  label: string
  icon: ReactNode
  /** Rendered as a count/attention badge beside the label. */
  badge?: number
  badgeTone?: 'neutral' | 'warn' | 'danger'
}

/**
 * Roving-focus tablist. Arrow keys move between tabs and Home/End jump to the
 * ends, which is what assistive tech expects from role="tablist".
 */
export function Tabs({
  tabs, active, onChange,
}: { tabs: TabSpec[]; active: string; onChange: (id: string) => void }) {
  const baseId = useId()
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex(t => t.id === active)
    let next = i
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    e.preventDefault()
    onChange(tabs[next].id)
    refs.current[tabs[next].id]?.focus()
  }

  return (
    <div role="tablist" aria-label="GPA workspace sections" onKeyDown={onKeyDown}
      className="-mb-px flex gap-1 overflow-x-auto border-b border-slate-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map(t => {
        const selected = t.id === active
        return (
          <button key={t.id} role="tab" id={`${baseId}-${t.id}`}
            ref={el => { refs.current[t.id] = el }}
            aria-selected={selected} aria-controls={`${baseId}-${t.id}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg px-3.5 py-2.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 sm:px-4 ${
              selected
                ? 'text-violet-700 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-violet-600'
                : 'text-slate-500 hover:text-slate-800'}`}>
            <span className={selected ? 'text-violet-600' : 'text-slate-400'} aria-hidden>{t.icon}</span>
            {t.label}
            {typeof t.badge === 'number' && t.badge > 0 && (
              /* 'danger' matches the required-setup card, so the tab and the
                 card are visibly the same problem. */
              <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                t.badgeTone === 'danger' ? 'bg-rose-600 text-white'
                : t.badgeTone === 'warn' ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-600'}`}>
                {t.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ id, active, children }: { id: string; active: string; children: ReactNode }) {
  if (id !== active) return null
  return <div role="tabpanel" tabIndex={-1} className="pt-5 focus-visible:outline-none">{children}</div>
}

/** Small chevron for native selects styled as workspace controls. */
export function SelectChevron() {
  return <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
}
