import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import {
  buildSlugMap,
  getPublicSchools,
  getSchoolBySlug,
  slugForSchool,
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

const SITE = 'https://www.crnaprephub.com'

/**
 * Full descriptive title where it fits; for the handful of very long program
 * names it steps down through shorter variants. The school name, "CRNA" and
 * the brand are preserved at every step — only the descriptive part is cut.
 */
function buildTitle(name: string): string {
  const variants = [
    `${name} CRNA Program: Requirements & Tuition | CRNA Prep Hub`,
    `${name} CRNA Program | CRNA Prep Hub`,
    `${name} CRNA | CRNA Prep Hub`,
  ]
  return variants.find((t) => t.length <= 95) ?? variants[variants.length - 1]
}

/**
 * Description assembled from public database values only. Every clause is
 * dropped when its field is empty, so no school is described with data it
 * does not have.
 */
function buildDescription(school: PublicSchool): string {
  const possessive = school.name.endsWith('s') ? `${school.name}'` : `${school.name}'s`
  const where = locationLine(school)

  // The degree sits in the lead rather than the detail list — more specific,
  // and it keeps the sentence shorter.
  const lead = [
    'Explore',
    possessive,
    school.program_length_months ? `${school.program_length_months}-month` : null,
    school.program_type || null,
    'CRNA program',
    where ? `in ${where}` : null,
  ]
    .filter(Boolean)
    .join(' ')

  const details: string[] = []
  if (school.gpa_requirement) details.push('minimum GPA')
  if (school.tuition_total || school.tuition_yearly) details.push('tuition')
  if (school.icu_experience_months) details.push('ICU experience requirements')
  if (school.format) details.push('program format')

  const compose = (items: string[]) => {
    if (items.length === 0) return `${lead}. Program details for CRNA applicants.`
    const rest = items.slice(0, -1)
    const last = items[items.length - 1]
    const list = rest.length ? `${rest.join(', ')} and ${last}` : last
    return `${lead}, including ${list}.`
  }

  // Drop the least important details rather than hard-truncating mid-word, so
  // the sentence always ends cleanly within snippet length.
  let candidate = compose(details)
  while (candidate.length > 158 && details.length > 0) {
    details.pop()
    candidate = compose(details)
  }
  return candidate
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params
  const school = await getSchoolBySlug(slug)

  // Unknown slug: return minimal metadata and let the page component call
  // notFound(). Metadata never affects the response status.
  if (!school) return { title: 'School not found | CRNA Prep Hub' }

  const title = buildTitle(school.name)
  const description = buildDescription(school)
  // `slug` is only non-null here because it resolved through buildSlugMap, so
  // the canonical cannot drift from the route that actually exists.
  const url = `${SITE}/schools/${slug}`

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: 'CRNA Prep Hub',
      type: 'website',
    },
    // `summary` rather than `summary_large_image`: there is no social image
    // asset on the site, and this step does not create one.
    twitter: {
      card: 'summary',
      title,
      description,
    },
  }
}

/**
 * Values in these free-text columns are frequently placeholders rather than
 * data. Rendering them verbatim produced rows reading "Not specified" on more
 * than a hundred pages, so anything matching this is treated as absent.
 */
const PLACEHOLDER =
  /^(not specified|not published|not applicable|n\/?a|none|none noted|none listed|tbd|unknown|varies|-+)$/i

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text || PLACEHOLDER.test(text)) return null
  return text
}

/**
 * A GPA stored as 3.0 arrives as the number 3, which renders as "minimum GPA
 * of 3". Always show at least one decimal place, and a second only when the
 * stored value actually has one (3.25).
 */
function gpaText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n.toFixed((n * 100) % 10 === 0 ? 1 : 2)
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

/**
 * application_opens_month is not a month column in practice: alongside real
 * values it holds placeholders, vague seasons ("Fall", "Late Winter"),
 * deadlines and free-text notes. Only two shapes can be stated accurately as
 * application timing, so everything else omits the section rather than
 * guessing at what the stored text meant.
 *
 *   "September" / "September 1" / "February 28th"  ->  a real opening date
 *   "Rolling"                                      ->  rolling admissions
 */
function applicationOpening(
  value: unknown
): { kind: 'month'; text: string } | { kind: 'day'; text: string } | { kind: 'rolling' } | null {
  const text = clean(value)
  if (!text) return null
  if (/^rolling$/i.test(text)) return { kind: 'rolling' }

  const match = text.match(/^([A-Za-z]+)(?:\s+(\d{1,2})(?:st|nd|rd|th)?)?$/)
  if (!match) return null
  const month = match[1].toLowerCase()
  if (!MONTHS.includes(month)) return null

  const proper = match[1][0].toUpperCase() + month.slice(1)

  // A bare month reads as a period and is stated as an opening. A specific
  // day is reported neutrally: the column name is the only thing suggesting
  // these are opening dates, and a mid-month date is equally the shape a
  // deadline takes. Nothing in the stored value settles it, so the page does
  // not claim to know.
  return match[2] ? { kind: 'day', text: `${proper} ${match[2]}` } : { kind: 'month', text: proper }
}

/**
 * prerequisites_not_required is the least reliable column on the table: most
 * rows are placeholders, several hold markdown notes, and a handful contain
 * deadline or GRE information — both of which are paid fields elsewhere. Only
 * text that reads as an actual list of coursework is shown.
 */
function usableNotRequired(value: unknown): string | null {
  const text = clean(value)
  if (!text || text.length < 8) return null
  if (text.includes('**') || /^note\b/i.test(text)) return null
  if (/\bdeadline\b|\bGRE\b/i.test(text)) return null
  return text
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

  /**
   * Other programs in the same state.
   *
   * Every school page was previously a dead end: reachable only from the
   * /schools hub and linking to no other school. These links come entirely
   * from verified fields — name, location_state and the slug the route itself
   * resolves through — so nothing is inferred or ranked. The list shares the
   * cached fetch the page already performs, so it costs no extra query.
   */
  const allSchools = await getPublicSchools()
  const slugMap = buildSlugMap(allSchools)
  const siblings = school.location_state
    ? allSchools
        .filter((s) => s.id !== school.id && s.location_state === school.location_state)
        .map((s) => ({ school: s, slug: slugForSchool(s, slugMap) }))
        // A school without a resolvable slug has no public page to link to.
        .filter((s) => Boolean(s.slug) && slugMap.has(s.slug))
        .sort((a, b) => a.school.name.localeCompare(b.school.name))
    : []

  const where = locationLine(school)
  const months = school.program_length_months

  /**
   * BreadcrumbList reflecting the page's position in the site hierarchy.
   *
   * The URL for the final item is built from the same `slug` the route
   * resolved through buildSlugMap, so it is the canonical generateMetadata
   * emits — one canonical, no second or conflicting declaration.
   *
   * Home is position 1 even though the visible trail starts at "CRNA Schools":
   * the header logo links home on every page, and this matches the pattern
   * already used by /blog/[slug].
   */
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'CRNA Schools', item: `${SITE}/schools` },
      {
        '@type': 'ListItem',
        position: 3,
        name: school.name,
        item: `${SITE}/schools/${slug}`,
      },
    ],
  }

  // Every sentence below is assembled from database values that actually
  // exist. Rather than one template with blanks, each section picks a
  // construction based on which fields are present, so a school with three
  // recorded fields does not read like a school with eight, redacted.
  const tuitionTotal = school.tuition_total
  const tuitionYearly = school.tuition_yearly
  const frontLoaded = /^yes$/i.test(String(school.front_loaded ?? ''))
  const prereqs = clean(school.prerequisites_required)
  const notRequired = usableNotRequired(school.prerequisites_not_required)
  const opening = applicationOpening(school.application_opens_month)

  const lead = `${school.name} offers a nurse anesthesia program${
    school.program_type ? ` awarding a ${school.program_type}` : ''
  }${where ? `, based in ${where}` : ''}.`

  const costSentences: string[] = []
  if (tuitionTotal) {
    // tuition_yearly is printed only where the column holds a value. It is
    // never derived from tuition_total divided by program length -- that
    // arithmetic would invent a figure the program never published.
    if (tuitionYearly && months) {
      costSentences.push(
        `Total tuition is listed at ${usd(tuitionTotal)}, or ${usd(tuitionYearly)} per year across the ${months}-month program.`
      )
    } else if (tuitionYearly) {
      costSentences.push(
        `Total tuition is listed at ${usd(tuitionTotal)}, with yearly tuition of ${usd(tuitionYearly)}.`
      )
    } else if (months) {
      costSentences.push(
        `Total tuition is listed at ${usd(tuitionTotal)} for the ${months}-month program.`
      )
    } else {
      costSentences.push(`Total tuition is listed at ${usd(tuitionTotal)}.`)
    }
  } else if (months) {
    costSentences.push(
      `The program runs ${months} months${months % 12 === 0 ? ` (${months / 12} years)` : ''}. Tuition is not recorded in this directory.`
    )
  }
  if (frontLoaded) {
    costSentences.push(
      `${school.name} runs a front-loaded curriculum, with didactic coursework concentrated before clinical rotations begin.`
    )
  }

  const gpa = gpaText(school.gpa_requirement)
  const admissionSentences: string[] = []
  if (gpa && school.icu_experience_months) {
    admissionSentences.push(
      `${school.name} publishes a minimum GPA of ${gpa} and requires ${school.icu_experience_months} months of critical care experience.`
    )
  } else if (gpa) {
    admissionSentences.push(`${school.name} publishes a minimum GPA of ${gpa}.`)
  } else if (school.icu_experience_months) {
    admissionSentences.push(
      `${school.name} requires ${school.icu_experience_months} months of critical care experience.`
    )
  }
  if (prereqs) {
    admissionSentences.push(
      /^none\b/i.test(prereqs)
        ? 'No specific prerequisite coursework is listed beyond the standard entry requirements.'
        : `Listed prerequisite coursework: ${prereqs}.`
    )
  }
  if (notRequired) admissionSentences.push(`Not required: ${notRequired}.`)

  return (
    <div className="min-h-screen bg-[#F7F8FC]">
      <BlogShell>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
        />

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
            <p className="text-[16px] leading-relaxed text-slate-700">{lead}</p>
          </section>

          {/* Compact facts. Deliberately limited to the four scannable
              attributes; GPA, ICU, tuition and prerequisites are covered in
              the sections below rather than duplicated here. */}
          <section className="mb-8 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
            <h2 className="mb-1 text-xl font-bold tracking-tight text-slate-900">
              Program details
            </h2>
            <p className="mb-4 text-[13px] text-slate-400">
              As recorded in the CRNA Prep Hub directory — always confirm against the program.
            </p>
            <dl>
              <Fact label="Location" value={where} />
              <Fact label="Program type" value={school.program_type} />
              <Fact label="Program format" value={clean(school.format)} />
              <Fact label="Program length" value={months ? `${months} months` : null} />
            </dl>
          </section>

          {costSentences.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 text-xl font-bold tracking-tight text-slate-900">
                Cost and program length
              </h2>
              <div className="space-y-3 text-[16px] leading-relaxed text-slate-700">
                {costSentences.map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </section>
          )}

          {admissionSentences.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 text-xl font-bold tracking-tight text-slate-900">
                Admission requirements
              </h2>
              <div className="space-y-3 text-[16px] leading-relaxed text-slate-700">
                {admissionSentences.map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
                <p>
                  Programs weigh cumulative, science and last-60-credit GPAs differently — the{' '}
                  <Link href="/gpa-calculator" className="font-semibold text-violet-600 hover:text-violet-700">
                    CRNA GPA calculator
                  </Link>{' '}
                  works out all four, and{' '}
                  <Link href="/blog/how-crna-schools-calculate-gpa" className="font-semibold text-violet-600 hover:text-violet-700">
                    how CRNA schools calculate GPA
                  </Link>{' '}
                  explains why the same transcript produces different numbers.
                  {school.icu_experience_months ? (
                    <>
                      {' '}If you are unsure whether your unit counts,{' '}
                      <Link href="/blog/icu-experience-for-crna-school" className="font-semibold text-violet-600 hover:text-violet-700">
                        what ICU experience counts for CRNA school
                      </Link>{' '}
                      covers how programs assess it.
                    </>
                  ) : null}
                </p>
              </div>
            </section>
          )}

          {opening && (
            <section className="mb-8">
              <h2 className="mb-3 text-xl font-bold tracking-tight text-slate-900">
                Applying to {school.name}
              </h2>
              <div className="space-y-3 text-[16px] leading-relaxed text-slate-700">
                {opening.kind === 'day' ? (
                  <p>
                    Application date listed: {opening.text}. Confirm the current application
                    opening and deadline directly with the program.
                  </p>
                ) : (
                  <p>
                    {opening.kind === 'rolling'
                      ? `${school.name} accepts applications on a rolling basis.`
                      : `Applications open in ${opening.text}.`}{' '}
                    Building backwards from that is the point of the{' '}
                    <Link href="/blog/crna-application-timeline" className="font-semibold text-violet-600 hover:text-violet-700">
                      CRNA application timeline
                    </Link>
                    .
                  </p>
                )}
              </div>
            </section>
          )}


          {/* Omitted entirely when the state has no other program, rather than
              rendering an empty box. */}
          {siblings.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-1 text-xl font-bold tracking-tight text-slate-900">
                Other CRNA programs in {school.location_state}
              </h2>
              <p className="mb-4 text-[13px] text-slate-400">
                {siblings.length === 1
                  ? 'One other nurse anesthesia program in this state.'
                  : `${siblings.length} other nurse anesthesia programs in this state.`}
              </p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {siblings.map(({ school: sibling, slug: siblingSlug }) => (
                  <li key={sibling.id}>
                    <Link
                      href={`/schools/${siblingSlug}`}
                      className="block rounded-xl border border-slate-200 bg-white px-4 py-3 text-[15px] font-semibold leading-snug text-slate-900 transition hover:border-violet-400"
                    >
                      {sibling.name} CRNA Program
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Replaces the old "Preparing to interview at {school}?" block, which
              was identical on all 135 pages and whose primary link pointed at
              /interview-prep — a noindex route. These point at indexable pages
              and read as next steps rather than a link list. */}
          <section className="mb-8 rounded-2xl border border-violet-200 bg-white p-5 sm:p-6">
            <h2 className="text-lg font-bold tracking-tight text-slate-900">
              Prepare for your CRNA application
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-slate-600">
              Once a program is on your list, the work is your own application. The{' '}
              <Link href="/interview" className="font-semibold text-violet-600 hover:text-violet-700">
                AI mock interview
              </Link>{' '}
              runs adaptive clinical and behavioural questions with follow-ups, and the{' '}
              <Link href="/personal-statement" className="font-semibold text-violet-600 hover:text-violet-700">
                personal statement analyzer
              </Link>{' '}
              scores a draft before an admissions committee reads it.
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
