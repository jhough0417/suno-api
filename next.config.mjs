/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(ttf|html)$/i,
      type: 'asset/resource'
    });
    return config;
  },
  experimental: {
    serverMinification: false,
    serverComponentsExternalPackages: [
      'rebrowser-playwright-core',
      'playwright-core',
      '@playwright/browser-chromium',
      'ghost-cursor-playwright',
    ],
  },
};  

export default nextConfig;
