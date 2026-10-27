/**
 * The one place a stated requirement becomes a chip.
 *
 * ---------------------------------------------------------------------------
 * EACH REQUIREMENT APPEARS EXACTLY ONCE, AND SAYS WHOSE JOB IT IS
 * ---------------------------------------------------------------------------
 * The checklist card and the editor's prompt panel both show the same list,
 * and both used to show it twice: an outlined chip reading "APA citation and
 * reference formatting", and directly underneath a sentence reading "Check in
 * your final document: APA citation and reference formatting." Two renderings
 * of one fact, stacked.
 *
 * The chip stays and the sentence is gone. What the sentence carried -- that
 * nobody here is checking this one -- is carried by the GROUP a chip sits in,
 * so it is said once per card no matter how many such requirements there are.
 *
 * THREE REGISTERS, BECAUSE THREE THINGS HAPPEN (see ConstraintRegister):
 *   counted   solid, because a live figure is watching it
 *   applied   soft, because the editor already did it by rendering the page
 *   manual    outlined and grouped, because it is the applicant's to apply
 *
 * The old boolean made 'applied' and 'manual' look identical, which told
 * eleven schools' applicants that a type size the Studio typesets exactly was
 * something they had to go and handle themselves.
 *
 * SHARED BY BOTH SURFACES ON PURPOSE. A chip that means one thing on the
 * checklist and another in the editor is worse than no chip.
 */
import type {
  ConstraintRegister, LabelledConstraint,
} from '@/lib/statement/requirements/constraintText'

export const CHIP_CLASS: Readonly<Record<ConstraintRegister, string>> = {
  counted: 'rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white',
  applied: 'rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700',
  manual: 'rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-600',
}

/**
 * The label on the manual group.
 *
 * NAMES NO REQUIREMENT. That is the whole point: it explains the group, and
 * the chips inside it are the only place the requirements themselves appear.
 * It is also read in order by a screen reader, which an outline is not.
 */
export const MANUAL_GROUP_LABEL = 'Yours to apply in the final document:'

/** Whether anything on this list is the applicant's to apply. */
export function hasManualConstraints(limits: readonly LabelledConstraint[]): boolean {
  return limits.some((limit) => limit.register === 'manual')
}

export function ConstraintChips({ limits }: { limits: readonly LabelledConstraint[] }) {
  if (limits.length === 0) return null
  const handled = limits.filter((limit) => limit.register !== 'manual')
  const manual = limits.filter((limit) => limit.register === 'manual')
  return (
    <>
      {handled.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {handled.map((limit) => (
            <span key={`${limit.kind}-${limit.text}`} className={CHIP_CLASS[limit.register]}>
              {limit.text}
            </span>
          ))}
        </div>
      )}
      {manual.length > 0 && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
          <span className="text-[11px] font-medium text-slate-500">{MANUAL_GROUP_LABEL}</span>
          {manual.map((limit) => (
            <span key={`${limit.kind}-${limit.text}`} className={CHIP_CLASS[limit.register]}>
              {limit.text}
            </span>
          ))}
        </div>
      )}
    </>
  )
}
