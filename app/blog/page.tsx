import Link from 'next/link'
import type { Metadata } from 'next'
import { getAllPosts } from '@/lib/blog'
import BlogShell from '@/components/BlogShell'

const SITE = 'https://www.crnaprephub.com'

export const metadata: Metadata = {
  title: 'CRNA School Admissions Guides | CRNA Prep Hub',
  description:
    'In-depth guides for ICU nurses applying to CRNA school — requirements, ICU experience, GPA, interviews, personal statements, resumes and application timelines.',
  alternates: { canonical: `${SITE}/blog` },
  openGraph: {
    title: 'CRNA School Admissions Guides',
    description: 'In-depth guides for ICU nurses applying to CRNA school.',
    url: `${SITE}/blog`,
    siteName: 'CRNA Prep Hub',
    type: 'website',
  },
}

export default function BlogIndex() {
  const posts = getAllPosts()
  const pillar = posts.find((p) => p.isPillar)
  const rest = posts.filter((p) => !p.isPillar)

  return (
    <div className="min-h-screen bg-[#F7F8FC]">
      <BlogShell>
        <div className="mx-auto w-full max-w-5xl px-4 pb-20 pt-10 sm:px-6 lg:px-8">
          <header className="mb-10">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-600">Guides</p>
            <h1 className="mt-3 text-[34px] font-bold leading-tight tracking-tight text-slate-900 sm:text-[42px]">
              CRNA school admissions, explained properly
            </h1>
            <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-slate-500">
              Written for ICU nurses who are actually applying — what programs require, where they
              differ, and what to do about the parts of your application you can still change.
            </p>
          </header>

          {pillar && (
            <Link
              href={`/blog/${pillar.slug}`}
              className="mb-8 block rounded-2xl border border-violet-200 bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition hover:border-violet-400 hover:shadow-md sm:p-8"
            >
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-violet-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
                  Start here
                </span>
                <span className="text-xs text-slate-400">{pillar.readingMinutes} min read</span>
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-[28px]">
                {pillar.title}
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-slate-600">{pillar.excerpt}</p>
              <span className="mt-4 inline-block text-sm font-semibold text-violet-600">
                Read the guide &rarr;
              </span>
            </Link>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {rest.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition hover:border-violet-400 hover:shadow-md"
              >
                <span className="text-xs text-slate-400">{post.readingMinutes} min read</span>
                <h2 className="mt-2 text-lg font-bold leading-snug tracking-tight text-slate-900">
                  {post.title}
                </h2>
                <p className="mt-2 flex-1 text-[14.5px] leading-relaxed text-slate-500">
                  {post.excerpt.length > 165 ? post.excerpt.slice(0, 165).trimEnd() + '…' : post.excerpt}
                </p>
                <span className="mt-4 text-sm font-semibold text-violet-600">Read &rarr;</span>
              </Link>
            ))}
          </div>
        </div>
      </BlogShell>
    </div>
  )
}
