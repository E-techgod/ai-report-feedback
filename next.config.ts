import type { NextConfig } from 'next';

/**
 * Files the PDF renderer reads at runtime that Next's file tracer cannot discover, so they would
 * be missing from the deployed serverless function:
 *  - the logo is read from disk with fs;
 *  - pdfkit loads its built-in fonts (Helvetica, Helvetica-Bold, ...) with createRequire through
 *    the package alias `#standard-fonts/*`. Without them every render fails with
 *    "Cannot find module .../pdfkit/js/standard-fonts/Helvetica.cjs" and the PDF route returns an
 *    empty HTTP 500. tests/pdf-bundle.test.mjs guards this list.
 */
const PDF_RUNTIME_FILES = [
  './public/images/quiron-logo.png',
  // Recursive: each font requires a shared hashed chunk from ./chunks/.
  './node_modules/pdfkit/js/standard-fonts/**/*.cjs',
];

const nextConfig: NextConfig = {
  // ESM-only PDF renderer: load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ['@react-pdf/renderer'],
  // The only function that renders the PDF is the download route.
  outputFileTracingIncludes: {
    '/api/report/pdf': PDF_RUNTIME_FILES,
  },
};

export default nextConfig;
