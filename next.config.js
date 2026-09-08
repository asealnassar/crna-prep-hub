const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
})

module.exports = withPWA({
  reactStrictMode: true,
  // pdfjs-dist optionally requires the native `canvas` package for RENDERING.
  // The transcript path only extracts text, so canvas is never loaded -- but
  // the bundler still tries to resolve it. Keeping pdfjs external means it is
  // resolved from node_modules at runtime rather than bundled.
  serverExternalPackages: ['pdfjs-dist'],
  // Draft lesson HTML is read at request time, so it must be traced into the
  // serverless bundle — it lives outside public/ and won't be included otherwise.
  outputFileTracingIncludes: {
    '/lessons/[slug]': ['./content/lessons/**'],
  },
  turbopack: {},  // Add this to silence the warning
  images: {
    domains: ['your-supabase-project.supabase.co'],
  },
})
