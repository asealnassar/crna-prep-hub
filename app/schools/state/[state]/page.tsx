import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import {
  buildSlugMap,
  getPublicSchools,
  slugForSchool,
  type PublicSchool,
} from '@/lib/schools'
import { eligibleStates, type StateGroup } from '@/lib/states'
import BlogShell from '@/components/BlogShell'

export const revalidate = 3600

const SITE = 'https://www.crnaprephub.com'

export async function generateStaticParams() {
  const groups = eligibleStates(await getPublicSchools())
  return groups.map((g) => ({ state: g.jurisdiction.slug }))
}

/** Only eligible states resolve; anything else falls through to a real 404. */
async function findState(slug: string): Promise<StateGroup | null> {
  const groups = eligibleStates(await getPublicSchools())
  return groups.find((g) => g.jurisdiction.slug === slug) ?? null
}

const PLACEHOLDER =
  /^(not specified|not published|not applicable|n\/?a|none|none noted|none listed|tbd|unknown|varies|-+)$/i

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text || PLACEHOLDER.test(text)) return null
  return text
}

/** 3.0 arrives as the number 3; always show at least one decimal place. */
function gpaText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n.toFixed((n * 100) % 10 === 0 ? 1 : 2)
}

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** Degree mix, e.g. "9 DNP" or "6 DNP and 3 DNAP" — counted, never assumed. */
function degreeMix(schools: PublicSchool[]): string | null {
  const counts = new Map<string, number>()
  for (const s of schools) {
    const type = clean(s.program_type)
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}`)
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function tuitionRange(schools: PublicSchool[]): { low: number; high: number } | null {
  const values = schools.map((s) => s.tuition_total).filter((v): v is number => Boolean(v))
  // A range needs two figures. One value is a single data point, not a range.
  if (values.length < 2) return null
  const low = Math.min(...values)
  const high = Math.max(...values)
  return low === high ? null : { low, high }
}

/** Distinct sorted numeric values, used to decide whether a range sentence
 *  is worth writing at all. */
function spread(schools: PublicSchool[], field: 'gpa_requirement' | 'icu_experience_months'): number[] {
  const set = new Set<number>()
  for (const s of schools) {
    const n = Number(s[field])
    if (Number.isFinite(n) && n > 0) set.add(n)
  }
  return Array.from(set).sort((a, b) => a - b)
}

export async function generateMetadata(
  { params }: { params: Promise<{ state: string }> }
): Promise<Metadata> {
  const { state } = await params
  const group = await findState(state)
  if (!group) return { title: 'State not found | CRNA Prep Hub' }

  const name = group.jurisdiction.name
  const count = group.schools.length
  const url = `${SITE}/schools/state/${group.jurisdiction.slug}`

  const full = `CRNA Schools in ${name}: ${count} Nurse Anesthesia Programs | CRNA Prep Hub`
  const title = full.length <= 95 ? full : `CRNA Schools in ${name} | CRNA Prep Hub`

  // Description assembled from computed values only; each clause is dropped
  // when the underlying data does not support it.
  const range = tuitionRange(group.schools)
  const mix = degreeMix(group.schools)
  const bits = [`Compare ${count} CRNA programs in ${name}`]
  if (mix) bits.push(`(${mix})`)
  const lead = bits.join(' ')
  const description = range
    ? `${lead} by GPA requirement, ICU experience, program format and tuition from ${usd(range.low)} to ${usd(range.high)}.`
    : `${lead} by GPA requirement, ICU experience, program length and format.`

  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: { title, description, url, siteName: 'CRNA Prep Hub', type: 'website' },
    twitter: { card: 'summary', title, description },
  }
}

export default async function StatePage({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params
  const group = await findState(state)
  if (!group) notFound()

  const { jurisdiction, schools } = group
  const allSchools = await getPublicSchools()
  const slugMap = buildSlugMap(allSchools)

  const count = schools.length
  const mix = degreeMix(schools)
  const range = tuitionRange(schools)
  const gpas = spread(schools, 'gpa_requirement')
  const icus = spread(schools, 'icu_experience_months')
  const url = `${SITE}/schools/state/${jurisdiction.slug}`

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'CRNA Schools', item: `${SITE}/schools` },
      { '@type': 'ListItem', position: 3, name: jurisdiction.name, item: url },
    ],
  }

  // Comparison sentences are written only where the values actually differ.
  // A state where every program requires a 3.0 gets no GPA sentence — stating
  // a "range" of one number would be noise on every page that shares it.
  const comparisons: string[] = []
  if (gpas.length > 1) {
    comparisons.push(
      `Minimum GPA requirements among the programs listed range from ${gpaText(gpas[0])} to ${gpaText(gpas[gpas.length - 1])}.`
    )
  }
  if (icus.length > 1) {
    comparisons.push(
      `Required critical care experience ranges from ${icus[0]} to ${icus[icus.length - 1]} months.`
    )
  }
  if (range) {
    comparisons.push(
      `Total tuition recorded for these programs runs from ${usd(range.low)} to ${usd(range.high)}.`
    )
  }

  return (
    <div className="min-h-screen bg-[#F7F8FC]">
      <BlogShell>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
        />

        <div className="mx-auto w-full max-w-4xl px-4 pb-20 pt-8 sm:px-6 lg:pt-12">
          <nav aria-label="Breadcrumb" className="mb-6 text-xs text-slate-400">
            <Link href="/schools" className="font-semibold text-violet-600 hover:text-violet-700">
              CRNA Schools
            </Link>
            <span className="mx-2">/</span>
            <span>{jurisdiction.name}</span>
          </nav>

          <header className="mb-8">
            <h1 className="text-[30px] font-bold leading-tight tracking-tight text-slate-900 sm:text-[38px]">
              CRNA Schools in {jurisdiction.name}
            </h1>
            <p className="mt-3 text-[16px] leading-relaxed text-slate-700">
              {`The CRNA Prep Hub directory lists ${count} nurse anesthesia ${
                count === 1 ? 'program' : 'programs'
              } in ${jurisdiction.name}`}
              {mix ? ` — ${mix}` : ''}.
            </p>
          </header>

          <section className="mb-8">
            <h2 className="mb-4 text-xl font-bold tracking-tight text-slate-900">
              Compare {jurisdiction.name} CRNA programs
            </h2>
            <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <table className="w-full min-w-[720px] text-left text-[14px]">
                <thead>
                  <tr className="border-b border-slate-200 text-[12px] uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 font-semibold">Program</th>
                    <th className="px-4 py-3 font-semibold">City</th>
                    <th className="px-4 py-3 font-semibold">Degree</th>
                    <th className="px-4 py-3 font-semibold">Length</th>
                    <th className="px-4 py-3 font-semibold">Min GPA</th>
                    <th className="px-4 py-3 font-semibold">ICU</th>
                    <th className="px-4 py-3 font-semibold">Tuition</th>
                    <th className="px-4 py-3 font-semibold">Format</th>
                  </tr>
                </thead>
                <tbody>
                  {schools.map((school) => {
                    const slug = slugForSchool(school, slugMap)
                    return (
                      <tr key={school.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-4 py-3">
                          <Link
                            href={`/schools/${slug}`}
                            className="font-semibold text-violet-600 hover:text-violet-700"
                          >
                            {school.name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{clean(school.location_city) ?? '—'}</td>
                        <td className="px-4 py-3 text-slate-700">{clean(school.program_type) ?? '—'}</td>
                        <td className="px-4 py-3 text-slate-700">
                          {school.program_length_months ? `${school.program_length_months} mo` : '—'}
                        </td>
                        <td className="px-4 py-3 text-slate-700">{gpaText(school.gpa_requirement) ?? '—'}</td>
                        <td className="px-4 py-3 text-slate-700">
                          {school.icu_experience_months ? `${school.icu_experience_months} mo` : '—'}
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {school.tuition_total ? usd(school.tuition_total) : '—'}
                        </td>
                        <td className="px-4 py-3 text-slate-700">{clean(school.format) ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[13px] text-slate-400">
              As recorded in the CRNA Prep Hub directory — always confirm against the program.
            </p>
          </section>

          {comparisons.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 text-xl font-bold tracking-tight text-slate-900">
                How {jurisdiction.name} programs differ
              </h2>
              <div className="space-y-3 text-[16px] leading-relaxed text-slate-700">
                {comparisons.map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </section>
          )}

          <section className="mb-8 rounded-2xl border border-violet-200 bg-white p-5 sm:p-6">
            <h2 className="text-lg font-bold tracking-tight text-slate-900">
              Prepare for your CRNA application
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-slate-600">
              Programs weigh cumulative, science and last-60-credit GPAs differently — the{' '}
              <Link href="/gpa-calculator" className="font-semibold text-violet-600 hover:text-violet-700">
                CRNA GPA calculator
              </Link>{' '}
              works out all four, and{' '}
              <Link href="/blog/how-crna-schools-calculate-gpa" className="font-semibold text-violet-600 hover:text-violet-700">
                how CRNA schools calculate GPA
              </Link>{' '}
              explains why the same transcript produces different numbers. If you are unsure whether
              your unit counts,{' '}
              <Link href="/blog/icu-experience-for-crna-school" className="font-semibold text-violet-600 hover:text-violet-700">
                what ICU experience counts for CRNA school
              </Link>{' '}
              covers how programs assess it.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
              When the application itself is next, the{' '}
              <Link href="/personal-statement" className="font-semibold text-violet-600 hover:text-violet-700">
                personal statement analyzer
              </Link>{' '}
              scores a draft before an admissions committee reads it, and the{' '}
              <Link href="/interview" className="font-semibold text-violet-600 hover:text-violet-700">
                AI mock interview
              </Link>{' '}
              runs adaptive clinical and behavioural questions with follow-ups.
            </p>
          </section>

          <Link
            href="/schools"
            className="inline-flex items-center gap-2 text-sm font-semibold text-violet-600 hover:text-violet-700"
          >
            &larr; Browse all CRNA schools
          </Link>
        </div>
      </BlogShell>
    </div>
  )
}
