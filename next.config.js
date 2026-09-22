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
  //
  // @sparticuz/chromium ships its Chromium binary as non-JS files under its
  // own bin/ directory. Bundled instead of externalized, the build relocates
  // the package's JS without that directory, so the deployed function throws
  // `The input directory ".../@sparticuz/chromium/bin" does not exist` the
  // moment PDF export tries to launch Chromium. Externalizing it makes Next
  // trace and ship the package as-is instead of bundling it.
  serverExternalPackages: ['pdfjs-dist', '@sparticuz/chromium'],
  // Draft lesson HTML is read at request time, so it must be traced into the
  // serverless bundle — it lives outside public/ and won't be included otherwise.
  //
  // Externalizing @sparticuz/chromium above is not sufficient on its own: this
  // project's production build uses Turbopack, and Turbopack's tracing does not
  // pick up the package's bin/ directory (the actual Chromium binary) even when
  // it is marked external -- confirmed locally, 0 @sparticuz/chromium files
  // land in route.js.nft.json without this. Forcing it in here, the same way
  // lesson content is forced in, is what actually gets it into the deployed
  // function.
  outputFileTracingIncludes: {
    '/lessons/[slug]': ['./content/lessons/**'],
    '/api/resume-v2/export/pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
  },
  turbopack: {},  // Add this to silence the warning
  images: {
    domains: ['your-supabase-project.supabase.co'],
  },
})
