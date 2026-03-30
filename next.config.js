// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverComponentsExternalPackages: ['@prisma/client', 'prisma'] },
  webpack: (config) => {
    config.externals.push({ 'pino-pretty': 'pino-pretty' });
    return config;
  },
};

module.exports = nextConfig;
