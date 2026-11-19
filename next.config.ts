import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // ESM-only PDF renderer: load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ['@react-pdf/renderer'],
  // The PDF reads the logo from disk; static files in /public are not in the function bundle by default.
  outputFileTracingIncludes: {
    '/api/questionnaire': ['./public/images/quiron-logo.png'],
    '/api/cron/retry-emails': ['./public/images/quiron-logo.png'],
    '/api/report/[id]/pdf': ['./public/images/quiron-logo.png'],
  },
};

export default nextConfig;
