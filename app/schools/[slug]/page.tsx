import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import {
  buildSlugMap,
  getPublicSchools,
  getSchoolBySlug,
  type PublicSchool,
} from '@/lib/schools'
import BlogShell from '@/components/BlogShell'

export const revalidate = 3600

export async function generateStaticParams() {
  const schools = await getPublicSchools()
  return Array.from(buildSlugMap(schools).keys()).map((slug) => ({ slug }))
}

function locationLine(school: PublicSchool): string | null {
  const parts = [school.location_city, school.location_state].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params
  const school = await getSchoolBySlug(slug)
  if (!school) return { title: 'School not found' }

  const where = locationLine(school)
  const bits = [
    school.program_type ? `${school.program_type} program` : 'CRNA program',
    where ? `in ${where}` : null,
  ]
    .filter(Boolean)
    .join(' ')

  return {
    title: `${school.name} CRNA Program`,
    description: `${school.name} nurse anesthesia ${bits}. Program details, admission requirements and tuition for CRNA applicants.`,
  }
}

/** Only renders a row when the database actually holds a value — nothing invented. */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="border-b border-slate-100 py-3 last:border-b-0 sm:grid sm:grid-cols-[210px_1fr] sm:gap-4">
      <dt className="text-[13px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-[15px] text-slate-900 sm:mt-0">{value}</dd>
    </div>
  )
}

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export default async function SchoolPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const school = await getSchoolBySlug(slug)
  if (!school) notFound()

  const where = locationLine(school)
  const months = school.program_length_months

  // Every sentence below is assembled from database values only; each clause is
  // dropped when its field is empty rather than guessed at.
  const introBits: string[] = []
  introBits.push(
    `${school.name} offers a nurse anesthesia program${
      school.program_type ? ` awarding a ${school.program_type}` : ''
    }${where ? `, based in ${where}` : ''}.`
  )
  if (months) {
    introBits.push(
      `The program runs ${months} months${
        months % 12 === 0 ? ` (${months / 12} years)` : ''
      }${school.format ? ` and is delivered in a ${school.format.toLowerCase()} format` : ''}.`
    )
  } else if (school.format) {
    introBits.push(`It is delivered in a ${school.format.toLowerCase()} format.`)
  }
  if (school.gpa_requirement || school.icu_experience_months) {
    const reqs: string[] = []
    if (school.gpa_requirement) reqs.push(`a minimum GPA of ${school.gpa_requirement}`)
    if (school.icu_experience_months)
      reqs.push(`${school.icu_experience_months} months of critical care experience`)
    introBits.push(`Published admission requirements include ${reqs.join(' and ')}.`)
  }

  return (
    <div className="min-h-screen bg-[#F7F8FC]">
      <BlogShell>
        <div className="mx-auto w-full max-w-3xl px-4 pb-20 pt-8 sm:px-6 lg:pt-12">
          <nav aria-label="Breadcrumb" className="mb-6 text-xs text-slate-400">
            <Link href="/schools" className="font-semibold text-violet-600 hover:text-violet-700">
              CRNA Schools
            </Link>
            <span className="mx-2">/</span>
            <span>{school.name}</span>
          </nav>

          <header className="mb-8">
            <h1 className="text-[30px] font-bold leading-tight tracking-tight text-slate-900 sm:text-[38px]">
              {school.name} CRNA Program
            </h1>
            {where && (
              <p className="mt-2 text-[15px] font-medium text-slate-500">{where}</p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {school.program_type && (
                <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
                  {school.program_type}
                </span>
              )}
              {school.format && (
                <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700">
                  {school.format}
                </span>
              )}
              {school.front_loaded && (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                  Front-loaded
                </span>
              )}
            </div>
          </header>

          <section className="mb-8">
            <h2 className="mb-3 text-xl font-bold tracking-tight text-slate-900">Program overview</h2>
            <div className="space-y-3 text-[16px] leading-relaxed text-slate-700">
              {introBits.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </section>

          <section className="mb-8 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
            <h2 className="mb-1 text-xl font-bold tracking-tight text-slate-900">
              Program details
            </h2>
            <p className="mb-4 text-[13px] text-slate-400">
              As recorded in the CRNA Prep Hub directory. Always confirm against the program.
            </p>
            <dl>
              <Fact label="Location" value={where} />
              <Fact label="Program type" value={school.program_type} />
              <Fact label="Program format" value={school.format} />
              <Fact
                label="Program length"
                value={months ? `${months} months` : null}
              />
              <Fact
                label="Minimum GPA"
                value={school.gpa_requirement ? String(school.gpa_requirement) : null}
              />
              <Fact
                label="ICU experience required"
                value={
                  school.icu_experience_months
                    ? `${school.icu_experience_months} months`
                    : null
                }
              />
              <Fact
                label="Accepts new-grad ICU"
                value={
                  school.accepts_new_grad_icu === null
                    ? null
                    : school.accepts_new_grad_icu
                      ? 'Yes'
                      : 'No'
                }
              />
              <Fact
                label="Total tuition"
                value={school.tuition_total ? usd(school.tuition_total) : null}
              />
              <Fact
                label="Yearly tuition"
                value={school.tuition_yearly ? usd(school.tuition_yearly) : null}
              />
              <Fact label="Application opens" value={school.application_opens_month} />
              <Fact label="Prerequisites required" value={school.prerequisites_required} />
              <Fact
                label="Prerequisites not required"
                value={school.prerequisites_not_required}
              />
            </dl>
          </section>

          <section className="mb-8 rounded-2xl border border-violet-200 bg-white p-5 sm:p-6">
            <h2 className="text-lg font-bold tracking-tight text-slate-900">
              Preparing to interview at {school.name}?
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-slate-600">
              School Interview Styles collects program-specific interview format details, and the AI
              Mock Interview lets you practise clinical and behavioural questions with adaptive
              follow-ups.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href="/interview-prep"
                className="rounded-xl bg-gradient-to-r from-violet-600 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:from-violet-700 hover:to-indigo-600"
              >
                School Interview Styles
              </Link>
              <Link
                href="/interview"
                className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-violet-400"
              >
                Practise a mock interview
              </Link>
            </div>
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
