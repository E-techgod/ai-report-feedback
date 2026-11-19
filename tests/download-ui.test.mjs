import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sampleReport } from './helpers/fixtures.mjs';

const require = createRequire(import.meta.url);

async function render(props) {
  require.extensions['.css'] = (m) => {
    m.exports = new Proxy(
      {},
      { get: (_, k) => (typeof k === 'string' && k !== '__esModule' ? k : undefined) },
    );
  };
  globalThis.React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const mod = await import('../src/components/ReportView.tsx');
  const ReportView = mod.default?.default ?? mod.default;
  return renderToStaticMarkup(
    globalThis.React.createElement(ReportView, { report: sampleReport(), ...props }),
  );
}

test('after submission the download button is enabled and the 5-minute window is shown', async () => {
  const html = await render({ pdf: { token: 't', expiresInMs: 300_000 } });
  assert.match(html, /durante 5 minutos/);
  assert.match(html, /Tiempo restante: 5:00/);
  assert.match(html, /Descargar PDF/);
  assert.doesNotMatch(html, /<button[^>]*pdfButton[^>]*disabled/);
  assert.doesNotMatch(html, /sesión de descarga ha expirado/);
});

test('the report view no longer renders any email status or retrieval action', async () => {
  const html = await render({ pdf: { token: 't', expiresInMs: 300_000 } });
  assert.doesNotMatch(html, /correo|Enviando tu informe|Informe enviado/i);
});

test('the browser never persists the grant or the report', () => {
  for (const file of ['../src/app/page.tsx', '../src/components/ReportView.tsx']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\b(localStorage|sessionStorage|indexedDB)\s*[.[]/, file);
  }
});

test('the expired state copy is exactly the specified message', () => {
  const text = readFileSync(new URL('../src/components/ReportView.tsx', import.meta.url), 'utf8');
  assert.ok(text.includes("expired: 'Tu sesión de descarga ha expirado.'"));
  assert.match(text, /disabled=\{pdfBusy \|\| expired\}/);
});

test('the dev preview download picker cannot bypass the Production restriction', async () => {
  // 1) The preview page is not served in production builds (Vercel Preview and Production both).
  const page = readFileSync(new URL('../src/app/report-preview/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /process\.env\.NODE_ENV === 'production'\) notFound\(\)/);
  // 2) Even if it were reachable, its placeholder token is worthless to the real server.
  const client = readFileSync(
    new URL('../src/app/report-preview/PreviewClient.tsx', import.meta.url),
    'utf8',
  );
  assert.match(client, /token: 'preview'/);
  const { verifyDownloadGrant } = await import('../src/lib/download-grant.ts');
  const report = sampleReport();
  for (const offset of [0, 1_000])
    assert.equal(
      verifyDownloadGrant(report, 'preview', 's'.repeat(32), new Date(Date.now() + offset)),
      'invalid',
    );
});
