'use client'

/**
 * Policies and Saved snapshots - Level 3. Both matter, neither needs to hold
 * permanent vertical space above the coursework the user came here to look at.
 */

import { ArrowUpToLine, FileDown, Save } from 'lucide-react'
import type { GpaPolicies } from '@/lib/gpa'
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from './workspace'

function Choice({
  value, current, needsChoice, onSelect, children,
}: {
  value: string; current: string | null; needsChoice: boolean
  onSelect: () => void; children: React.ReactNode
}) {
  const selected = current === value
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${
        selected ? 'border-violet-600 bg-violet-600 text-white'
          : needsChoice ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
      {children}
    </button>
  )
}

export function PoliciesPanel({
  policies, setPolicies, retakeUnresolved,
}: {
  policies: GpaPolicies
  setPolicies: (p: GpaPolicies) => void
  retakeUnresolved: number
}) {
  const retakeNeeds = policies.retake === null && retakeUnresolved > 0
  return (
    <div className={`${CARD} p-4 sm:p-6`}>
      <h2 className="text-base font-bold tracking-tight text-slate-900">Calculation policy</h2>
      <p className="mt-0.5 text-sm text-slate-500">
        Programs differ. Change these to model how a specific school recalculates.
      </p>

      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-semibold text-slate-800">
            Transferred coursework
            {policies.transfer === null && (
              <span className="ml-2 text-xs font-semibold text-amber-600">Choose one</span>
            )}
          </p>
          <div className="flex gap-2">
            <Choice value="include" current={policies.transfer} needsChoice={policies.transfer === null}
              onSelect={() => setPolicies({ ...policies, transfer: 'include' })}>Include</Choice>
            <Choice value="exclude" current={policies.transfer} needsChoice={policies.transfer === null}
              onSelect={() => setPolicies({ ...policies, transfer: 'exclude' })}>Exclude</Choice>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {policies.transfer === null
              ? 'CRNA programs treat transferred coursework differently, so there is no default here. Until you choose, transferred courses are held out of every GPA.'
              : 'Rows marked “Notation” are never counted either way — they duplicate the original graded course.'}
          </p>
        </div>

        <div>
          <p className="mb-2 text-sm font-semibold text-slate-800">
            Repeated coursework
            {retakeNeeds && <span className="ml-2 text-xs font-semibold text-amber-600">Choose one</span>}
          </p>
          <div className="flex gap-2">
            <Choice value="both" current={policies.retake} needsChoice={retakeNeeds}
              onSelect={() => setPolicies({ ...policies, retake: 'both' })}>Count both attempts</Choice>
            <Choice value="latest" current={policies.retake} needsChoice={retakeNeeds}
              onSelect={() => setPolicies({ ...policies, retake: 'latest' })}>Count latest only</Choice>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {retakeNeeds
              ? `CRNA programs may handle repeated courses differently, so there is no default. ${retakeUnresolved} repeated course(s) are held out until you choose.`
              : 'Retakes are matched only on institution + course code — never on similar names.'}
          </p>
        </div>
      </div>
    </div>
  )
}

export function SavedPanel({
  savedCalculations, viewingCalc, viewCalculation, loadCalculationIntoDraft,
  calculationName, setCalculationName, saveCalculation, exportToPDF, saving, isLoggedIn,
  canSnapshot,
}: {
  savedCalculations: any[]
  viewingCalc: any
  viewCalculation: (c: any) => void
  loadCalculationIntoDraft: (c: any) => void
  calculationName: string
  setCalculationName: (v: string) => void
  saveCalculation: () => void
  exportToPDF: () => void
  saving: boolean
  isLoggedIn: boolean
  canSnapshot: boolean
}) {
  return (
    <div className="space-y-4">
      <div className={`${CARD} p-4 sm:p-6`}>
        <h2 className="text-base font-bold tracking-tight text-slate-900">Save a snapshot</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Your working analysis saves itself continuously. A snapshot freezes today&apos;s numbers under a
          name so you can compare them later — it is never recalculated.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input type="text" value={calculationName} aria-label="Snapshot name"
            onChange={e => setCalculationName(e.target.value)}
            placeholder="Name this snapshot (e.g. “Fall 2024”)"
            className={`${FIELD} flex-1`} />
          <button onClick={saveCalculation} disabled={!isLoggedIn || saving || !canSnapshot}
            className={BTN_PRIMARY}>
            <Save className="h-4 w-4" aria-hidden />{saving ? 'Saving…' : 'Save Snapshot'}
          </button>
          <button onClick={exportToPDF} disabled={!canSnapshot} className={BTN_SECONDARY}>
            <FileDown className="h-4 w-4" aria-hidden />Export PDF
          </button>
        </div>
        {!isLoggedIn && (
          <p className="mt-2 text-xs text-slate-500">Log in to save snapshots to your profile.</p>
        )}
      </div>

      {savedCalculations.length === 0 ? (
        <p className={`${CARD} px-5 py-12 text-center text-sm text-slate-500`}>
          No saved snapshots yet.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {savedCalculations.map(calc => {
            const open = viewingCalc?.id === calc.id
            const older = (calc.engine_version ?? 1) < 2
            return (
              <div key={calc.id}
                className={`${CARD} cursor-pointer p-4 transition ${
                  open ? 'ring-2 ring-violet-300' : 'hover:border-slate-300'}`}
                onClick={() => viewCalculation(calc)}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-900">{calc.calculation_name}</h3>
                  <span className="shrink-0 text-xs text-slate-400">
                    {new Date(calc.created_at).toLocaleDateString()}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-4 gap-2">
                  {([['Overall', calc.overall_gpa], ['Science', calc.science_gpa],
                     ['Nursing', calc.nursing_gpa], ['Last 60', calc.last60_gpa]] as const).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-[11px] font-medium text-slate-500">{k}</dt>
                      <dd className="text-sm font-bold tabular-nums text-slate-900">{v ?? '—'}</dd>
                    </div>
                  ))}
                </dl>
                {older && (
                  <p className="mt-2 inline-flex rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                    Older calculation
                  </p>
                )}
                {open && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="text-xs leading-relaxed text-slate-500">
                      <strong className="font-semibold text-slate-700">Saved snapshot</strong> —
                      {' '}{calc.courses?.length ?? 0} course(s). The values above are the numbers stored when
                      you saved it; they are shown as-is and are not recalculated. Viewing does not change
                      your active analysis.
                      {older && (
                        <> These were produced by an earlier version of the calculator, so loading them
                        into the analyzer may give a different result.</>
                      )}
                    </p>
                    <button onClick={e => { e.stopPropagation(); loadCalculationIntoDraft(calc) }}
                      className={`${BTN_SECONDARY} mt-3 w-full`}>
                      <ArrowUpToLine className="h-4 w-4" aria-hidden />Load into GPA Analyzer
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
