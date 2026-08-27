import type { MetadataRoute } from 'next'
import { getAllPosts } from '@/lib/blog'

const SITE = 'https://www.crnaprephub.com'

export default function sitemap(): MetadataRoute.Sitemap {
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

  return [...staticPages, ...posts]
}
