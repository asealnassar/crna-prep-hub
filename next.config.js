/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  experimental: {
    turbo: {
      resolveAlias: {
        canvas: false,
      },
    },
  },
}

module.exports = nextConfig

