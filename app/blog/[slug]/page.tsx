import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getAllPosts, getPost, extractFaqs } from '@/lib/blog'
import BlogShell from '@/components/BlogShell'

const SITE = 'https://www.crnaprephub.com'

export function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }))
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) return { title: 'Not found' }

  const url = `${SITE}/blog/${post.slug}`
  return {
    title: post.seoTitle,
    description: post.metaDescription,
    keywords: [post.primaryKeyword, ...post.secondaryKeywords],
    alternates: { canonical: url },
    openGraph: {
      title: post.seoTitle,
      description: post.metaDescription,
      url,
      siteName: 'CRNA Prep Hub',
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
      title: post.seoTitle,
      description: post.metaDescription,
    },
  }
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) notFound()

  const all = getAllPosts()
  const related = all.filter((p) => p.slug !== post.slug).slice(0, 3)
  const faqs = extractFaqs(post.html)
  const url = `${SITE}/blog/${post.slug}`

  const schema: Record<string, unknown>[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: post.title,
      description: post.metaDescription,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      publisher: {
        '@type': 'Organization',
        name: 'CRNA Prep Hub',
        url: SITE,
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
        { '@type': 'ListItem', position: 2, name: 'Guides', item: `${SITE}/blog` },
        { '@type': 'ListItem', position: 3, name: post.title, item: url },
      ],
    },
  ]

  if (faqs.length > 0) {
    schema.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    })
  }

  return (
    <div className="min-h-screen bg-[#F7F8FC]">
      <BlogShell>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
        />

        <div className="mx-auto w-full max-w-3xl px-4 pb-20 pt-8 sm:px-6 lg:pt-12">
          <nav aria-label="Breadcrumb" className="mb-8 text-xs text-slate-400">
            <Link href="/blog" className="font-semibold text-violet-600 hover:text-violet-700">
              Guides
            </Link>
            <span className="mx-2">/</span>
            <span>{post.readingMinutes} min read</span>
          </nav>

          <article className="blog-prose" dangerouslySetInnerHTML={{ __html: post.html }} />

          <aside className="mt-14 border-t border-slate-200 pt-8">
            <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
              Keep reading
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/blog/${r.slug}`}
                  className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-violet-400"
                >
                  <span className="text-[15px] font-semibold leading-snug text-slate-900">
                    {r.title}
                  </span>
                </Link>
              ))}
            </div>
          </aside>
        </div>
      </BlogShell>
    </div>
  )
}
