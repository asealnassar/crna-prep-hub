const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
})

module.exports = withPWA({
  reactStrictMode: true,
  turbopack: {},  // Add this to silence the warning
  images: {
    domains: ['your-supabase-project.supabase.co'],
  },
})
