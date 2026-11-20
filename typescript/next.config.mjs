/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ['postgres', 'kafkajs', 'nodemailer'],
  },
  async rewrites() {
    return [
      { source: '/ingest/:source', destination: '/api/ingest/:source' },
      { source: '/metrics', destination: '/api/metrics' },
    ]
  },
}

export default nextConfig
