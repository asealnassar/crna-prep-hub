import type { MetadataRoute } from 'next'
import { getAllPosts } from '@/lib/blog'
import { buildSlugMap, getPublicSchools } from '@/lib/schools'

const SITE = 'https://www.crnaprephub.com'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  // Public, crawlable pages only. Anything gated or user-specific is excluded.
  const staticPages = [
    { path: '', priority: 1.0 },
    { path: '/blog', priority: 0.9 },
    { path: '/schools', priority: 0.9 },
    { path: '/interview', priority: 0.8 },
    { path: '/interview-prep', priority: 0.8 },
    { path: '/gpa-calculator', priority: 0.8 },
    { path: '/personal-statement', priority: 0.7 },
    { path: '/resume-builder', priority: 0.7 },
    { path: '/pricing', priority: 0.6 },
  ].map((p) => ({
    url: `${SITE}${p.path}`,
    lastModified: now,
    changeFrequency: 'weekly' as const,
    priority: p.priority,
  }))

  const posts = getAllPosts().map((post) => ({
    url: `${SITE}/blog/${post.slug}`,
    lastModified: now,
    changeFrequency: 'monthly' as const,
    priority: post.isPillar ? 0.9 : 0.8,
  }))

  // Individual school pages. Slugs come from the same buildSlugMap the route
  // uses in generateStaticParams, so sitemap URLs cannot drift from real ones.
  //
  // No lastModified: the schools table has created_at but no updated_at, so
  // there is no accurate modification date to report. Stamping today's date on
  // every request would be a false freshness signal.
  const schoolSlugs = Array.from(buildSlugMap(await getPublicSchools()).keys()).sort()
  const schoolPages = schoolSlugs.map((slug) => ({
    url: `${SITE}/schools/${slug}`,
  }))

  return [...staticPages, ...posts, ...schoolPages]
}
