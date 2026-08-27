import type { MetadataRoute } from 'next'

const SITE = 'https://www.crnaprephub.com'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Gated, personal, or transactional surfaces — nothing here belongs in an index.
      disallow: [
        '/api/',
        '/admin/',
        '/dashboard',
        '/lessons',
        '/success',
        '/authprobe',
        '/login',
        '/signup',
        '/reset-password',
        '/forgot-password',
      ],
    },
    sitemap: `${SITE}/sitemap.xml`,
  }
}
