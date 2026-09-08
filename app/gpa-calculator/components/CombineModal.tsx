'use client'

/**
 * D47 - picking analyses to combine, and picking how a new analysis starts.
 *
 * Two related dialogs share the shell because they ask the same shape of
 * question. Neither touches a transcript: everything they offer is coursework
 * the user already has.
 *
 * Both combine modes produce a NEW analysis and leave every source untouched,
 * so both say so above the picker rather than only in the confirmation
 * afterwards -- the point of the sentence is to be read before the click.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FilePlus2, Layers, Upload, X } from 'lucide-react'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from './workspace'
import { shortenAnalysisName } from '@/lib/gpa/uploadDestination'
import type { GpaAnalysis } from '@/lib/gpa/analyses'
import type { Institution } from '@/lib/gpa'

/** Escape, focus trap and focus restore, shared by both dialogs. */
function Shell({
  titleId, onClose, children,
}: { titleId: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLElement>('button, input')?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key !== 'Tab') return
      const f = panel.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
      if (!f || f.length === 0) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prev
      opener.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:rounded-2xl">
        {children}
      </div>
    </div>
  )
}

/** One row in the picker: name plus the facts needed to tell them apart. */
function AnalysisRow({
  analysis, institutions, checked, disabled, onToggle,
}: {
  analysis: GpaAnalysis
  institutions: readonly Institution[]
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  const used = [...new Set(analysis.courses.map(c => c.institutionId).filter(Boolean))]
    .map(id => institutions.find(i => i.id === id)?.name)
    .filter(Boolean) as string[]
  const schools = used.length === 0 ? 'No school assigned'
    : used.length <= 2 ? used.map(n => shortenAnalysisName(n, 22)).join(', ')
    : `${shortenAnalysisName(used[0], 18)} +${used.length - 1} more`

  return (
    <label className={`flex cursor-pointer items-start gap-3 px-4 py-3 transition ${
      disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-slate-50'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle}
        className="mt-0.5 h-4 w-4 shrink-0 accent-violet-600" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-900">{analysis.name}</span>
        <span className="block text-xs text-slate-500">
          {analysis.courses.length} course{analysis.courses.length === 1 ? '' : 's'} · {schools}
        </span>
      </span>
    </label>
  )
}

/** How a brand-new analysis should start. */
export type NewAnalysisKind = 'blank' | 'upload' | 'combine'

export function NewAnalysisModal({
  canCombine, onChoose,
}: { canCombine: boolean; onChoose: (kind: NewAnalysisKind | null) => void }) {
  const decided = useRef(false)
  const pick = (k: NewAnalysisKind | null) => {
    if (decided.current) return
    decided.current = true
    onChoose(k)
  }
  const item = 'w-full !justify-start !px-4 !py-3.5 text-left'
  return (
    <Shell titleId="new-title" onClose={() => pick(null)}>
      <div className="flex items-start justify-between gap-3 p-5 sm:p-6 sm:pb-4">
        <div className="min-w-0">
          <h2 id="new-title" className="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
            Start a new analysis
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Each analysis keeps its own coursework and calculation settings.
          </p>
        </div>
        <button onClick={() => pick(null)} aria-label="Cancel"
          className={`${BTN_GHOST} -mr-1 -mt-1 h-8 w-8 shrink-0 !px-0`}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="space-y-3 px-5 pb-2 sm:px-6">
        <button onClick={() => pick('blank')} className={`${BTN_SECONDARY} ${item}`}>
          <FilePlus2 className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span className="min-w-0">
            <span className="block font-semibold">Blank Analysis</span>
            <span className="block text-xs font-normal text-slate-500">Start manually.</span>
          </span>
        </button>
        <button onClick={() => pick('upload')} className={`${BTN_SECONDARY} ${item}`}>
          <Upload className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span className="min-w-0">
            <span className="block font-semibold">Upload Transcript</span>
            <span className="block text-xs font-normal text-slate-500">Analyze a new transcript.</span>
          </span>
        </button>
        <button onClick={() => pick('combine')} disabled={!canCombine}
          className={`${BTN_SECONDARY} ${item} disabled:cursor-not-allowed disabled:opacity-50`}>
          <Layers className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span className="min-w-0">
            <span className="block font-semibold">Combine Existing Analyses</span>
            <span className="block text-xs font-normal text-slate-500">
              {canCombine
                ? 'Create an analysis from coursework you’ve already saved.'
                : 'Needs at least two saved analyses.'}
            </span>
          </span>
        </button>
      </div>

      <div className="p-4 text-center sm:p-5">
        <button onClick={() => pick(null)} className={`${BTN_GHOST} !text-sm`}>Cancel</button>
      </div>
    </Shell>
  )
}

export function CombineModal({
  mode, analyses, institutions, currentName, error, errorTitle, busy, onCancel, onConfirm,
}: {
  /**
   * 'new' combines analyses the user picks; 'with' combines the open analysis
   * with the ones they pick. Both create a new analysis: neither writes into
   * anything that already exists.
   */
  mode: 'new' | 'with'
  /** Selectable sources. The active analysis is already excluded for 'with'. */
  analyses: GpaAnalysis[]
  institutions: readonly Institution[]
  currentName?: string
  /** Why the last attempt was refused. Shown here, never as a browser dialog. */
  error?: string | null
  errorTitle?: string | null
  busy?: boolean
  onCancel: () => void
  onConfirm: (ids: string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const submitting = useRef(false)

  // 'with' already counts the open analysis as one of the two.
  const minimum = mode === 'new' ? 2 : 1
  const ready = selected.length >= minimum

  const confirm = () => {
    if (!ready || submitting.current || busy) return
    submitting.current = true
    onConfirm(selected)
  }
  // A refusal leaves the dialog open so the choice can be changed.
  useEffect(() => { if (error) submitting.current = false }, [error])

  const toggle = (id: string) =>
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  return (
    <Shell titleId="combine-title" onClose={onCancel}>
      <div className="flex items-start justify-between gap-3 p-5 sm:p-6 sm:pb-4">
        <div className="min-w-0">
          <h2 id="combine-title" className="text-base font-bold tracking-tight text-slate-900 sm:text-lg">
            {mode === 'new'
              ? 'Combine existing analyses'
              : `Combine “${shortenAnalysisName(currentName, 24)}” with…`}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'new'
              ? 'Select the analyses you want to use together.'
              : `“${shortenAnalysisName(currentName, 24)}” will be combined with the analyses you choose here.`}
          </p>
        </div>
        <button onClick={onCancel} aria-label="Cancel"
          className={`${BTN_GHOST} -mr-1 -mt-1 h-8 w-8 shrink-0 !px-0`}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <p className="mx-5 mb-4 flex items-start gap-2 rounded-xl bg-violet-50 px-3 py-2 text-xs font-medium text-violet-800 sm:mx-6">
        <Layers className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        A new analysis will be created. Every analysis it draws from stays exactly as it is.
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto border-y border-slate-100">
        {analyses.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">
            There are no other analyses to use here yet.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {analyses.map(a => (
              <AnalysisRow key={a.id} analysis={a} institutions={institutions}
                checked={selected.includes(a.id)} onToggle={() => toggle(a.id)} />
            ))}
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="border-b border-amber-200 bg-amber-50/70 px-4 py-3 sm:px-5">
          {errorTitle && (
            <p className="text-sm font-bold text-amber-900">{errorTitle}</p>
          )}
          <p className="text-sm text-amber-900">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-2 p-4 sm:flex-row-reverse sm:p-5">
        <button onClick={confirm} disabled={!ready || !!busy} className={`${BTN_PRIMARY} sm:w-auto`}>
          Create Combined Analysis
        </button>
        <button onClick={onCancel} className={`${BTN_SECONDARY} sm:w-auto`}>Cancel</button>
        {!ready && (
          <p className="self-center text-xs text-slate-500 sm:mr-auto">
            {mode === 'new' ? 'Choose at least two analyses.' : 'Choose at least one analysis.'}
          </p>
        )}
      </div>
    </Shell>
  )
}
