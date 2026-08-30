import type { MetadataRoute } from 'next'

const SITE = 'https://www.crnaprephub.com'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Only what cannot carry its own directive.
      //
      // /dashboard, /login, /signup, /success, /forgot-password,
      // /reset-password and /admin/* used to be listed here. They now set
      // `robots: { index: false, follow: true }` at the route level, which is
      // strictly stronger: a Disallow blocks crawling but not indexing, so a
      // disallowed URL can still be listed as a bare link found elsewhere —
      // and it prevented Google from ever fetching the page to read the
      // noindex. Removing the rules lets crawlers see the directive and drop
      // those URLs properly.
      disallow: [
        // Route handlers. They return JSON and have no <head> to carry a meta
        // tag, so a Disallow is the only mechanism available.
        '/api/',
        '/authprobe',
        // Currently 404s; nothing to crawl, and no useful crawl budget spent.
        '/lessons',
      ],
    },
    sitemap: `${SITE}/sitemap.xml`,
  }
}
