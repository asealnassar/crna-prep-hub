import { Check } from 'lucide-react'

type Cell = boolean | string

interface ComparisonRow {
  feature: string
  free: Cell
  premium: Cell
  ultimate: Cell
}

/**
 * Every row here reflects the app's actual entitlement logic, not shorter
 * marketing bullets -- see lib/plans.ts, lib/apiAuth.ts (isUltimate),
 * app/api/interview/route.ts (the interview allowance gate) and
 * lib/resume/entitlement.ts (resume count, finalize and export gates).
 *
 * Two things worth knowing when editing this list: resume templates, AI
 * bullet points and Resume Strength scoring are all available on every
 * tier today per lib/resume/entitlement.ts -- only the resume COUNT and
 * finalize+export are Ultimate-gated -- and Premium's mock-interview
 * allowance is the same 3 as Free, not unlimited.
 */
const ROWS: ComparisonRow[] = [
  { feature: 'CRNA school directory (130+ programs)', free: true, premium: true, ultimate: true },
  { feature: 'Basic GPA calculator', free: true, premium: true, ultimate: true },
  { feature: 'Personal statement analyzer', free: 'Basic', premium: 'Basic', ultimate: 'Advanced + AI rewrites' },
  { feature: 'Resume Builder', free: '1 resume', premium: '1 resume', ultimate: 'Unlimited resumes' },
  { feature: 'Resume templates', free: true, premium: true, ultimate: true },
  { feature: 'AI resume bullet points', free: true, premium: true, ultimate: true },
  { feature: 'Resume scoring (Resume Strength)', free: true, premium: true, ultimate: true },
  { feature: 'Finalize & export resume (PDF/DOCX)', free: false, premium: false, ultimate: true },
  { feature: 'AI mock interviews', free: '3', premium: '3', ultimate: 'Unlimited' },
  { feature: 'Advanced school filters (state, GRE, prerequisites)', free: false, premium: true, ultimate: true },
  { feature: 'Deadline & application-method filters', free: false, premium: true, ultimate: true },
  { feature: 'Direct school website links', free: false, premium: true, ultimate: true },
  { feature: 'School-specific interview prep', free: false, premium: false, ultimate: true },
  { feature: 'Advanced GPA analytics', free: false, premium: false, ultimate: true },
  { feature: 'AI personal statement rewrites', free: false, premium: false, ultimate: true },
  { feature: 'Priority support', free: false, premium: false, ultimate: true },
]

const PLAN_HEADERS = [
  { key: 'free' as const, label: 'Free' },
  { key: 'premium' as const, label: 'Premium' },
  { key: 'ultimate' as const, label: 'Ultimate' },
]

function Cell({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center justify-center">
        <Check className="h-5 w-5 text-purple-600" aria-label="Included" />
      </span>
    )
  }
  if (value === false) {
    return <span className="text-gray-300" aria-label="Not included">—</span>
  }
  return <span className="text-sm text-gray-700 font-medium">{value}</span>
}

export default function ComparisonTable() {
  return (
    <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-left">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-gray-50 py-4 pr-4 text-sm font-semibold text-gray-900 rounded-tl-xl">
              Feature
            </th>
            {PLAN_HEADERS.map((plan, idx) => (
              <th
                key={plan.key}
                scope="col"
                className={`py-4 px-4 text-sm font-semibold text-center min-w-[110px] ${
                  plan.key === 'ultimate' ? 'text-purple-700 bg-purple-50' : 'text-gray-900 bg-gray-50'
                } ${idx === PLAN_HEADERS.length - 1 ? 'rounded-tr-xl' : ''}`}
              >
                {plan.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row, rowIdx) => (
            <tr key={row.feature} className={rowIdx % 2 === 1 ? 'bg-gray-50/60' : 'bg-white'}>
              <th
                scope="row"
                className={`sticky left-0 z-10 py-3.5 pr-4 text-sm text-gray-700 font-normal text-left ${
                  rowIdx % 2 === 1 ? 'bg-gray-50/60' : 'bg-white'
                } ${rowIdx === ROWS.length - 1 ? 'rounded-bl-xl' : ''}`}
              >
                {row.feature}
              </th>
              <td className="py-3.5 px-4 text-center">
                <Cell value={row.free} />
              </td>
              <td className="py-3.5 px-4 text-center">
                <Cell value={row.premium} />
              </td>
              <td
                className={`py-3.5 px-4 text-center bg-purple-50/40 ${
                  rowIdx === ROWS.length - 1 ? 'rounded-br-xl' : ''
                }`}
              >
                <Cell value={row.ultimate} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
