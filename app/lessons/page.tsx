import Link from 'next/link'
import { notFound } from 'next/navigation'
import { canViewDrafts, DRAFT_LESSONS } from '@/lib/lessonAccess'

export const dynamic = 'force-dynamic'
export const metadata = { robots: { index: false, follow: false } }

export default async function DraftLessonsPage() {
  // Unpublished work: anyone who isn't the author gets the same 404 the route
  // handler gives, so the page's existence isn't advertised.
  if (!(await canViewDrafts())) notFound()

  return (
    <div className="min-h-screen bg-[#F7F8FC]">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-xs font-bold uppercase tracking-[0.16em] text-violet-600">
            Draft
          </span>
          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
            Visible only to you
          </span>
        </div>

        <h1 className="text-4xl font-bold tracking-tight text-slate-900">Vasopressors</h1>
        <p className="mt-2 text-[17px] text-slate-500">
          {DRAFT_LESSONS.length} of 6 lessons built.
        </p>

        <div className="mt-9 space-y-3">
          {DRAFT_LESSONS.map((lesson) => (
            <a
              key={lesson.slug}
              href={`/lessons/${lesson.slug}`}
              className="block rounded-xl border border-slate-200 bg-white px-6 py-5 transition hover:border-violet-400 hover:shadow-sm"
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-violet-600">
                Lesson {lesson.number}
              </div>
              <div className="mt-1 text-xl font-bold text-slate-900">{lesson.title}</div>
              <p className="mt-1 text-[15px] text-slate-500">{lesson.blurb}</p>
            </a>
          ))}
        </div>

        <p className="mt-8 border-t border-slate-200 pt-5 text-sm leading-relaxed text-slate-500">
          These lessons are served only to your account and are excluded from search
          engines. Nothing here is linked from the sidebar or visible to members.
        </p>

        <Link
          href="/dashboard"
          className="mt-6 inline-block text-sm font-semibold text-violet-600 hover:text-violet-700"
        >
          &larr; Back to dashboard
        </Link>
      </div>
    </div>
  )
}
