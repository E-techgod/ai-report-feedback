import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractText, getDocumentProxy } from 'unpdf';
import { renderReportPdf } from '../src/lib/pdf/ReportPdf.tsx';
import { buildReportContent, flattenContent } from '../src/lib/report-content.ts';
import { questionIds } from '../src/lib/questions.ts';
import { sampleReport, SAMPLE_YES } from './helpers/fixtures.mjs';

/**
 * The client-facing report (web, PDF) has no "Cómo se elaboró este reporte" section, no
 * AI-allocation percentages and no provider names. The legal disclaimer stays exactly as approved.
 * (The internal team view, mode="team", keeps its review annotations: it is not client-facing.)
 */
const LEGAL =
  'Este reporte es una herramienta informativa preliminar basada en respuestas autodeclaradas; no constituye ni sustituye asesoría legal, fiscal, financiera ni de seguros personalizada, ni certificación de cobertura. Algunas preguntas pueden no aplicar a todas las personas. Para un diagnóstico integral, consulta con especialistas.';

const FORBIDDEN = [
  /c[oó]mo se elabor[oó]/i,
  /reglas y plantillas validadas/i,
  /redacci[oó]n (asistida )?(con|por) (ia|inteligencia artificial)/i,
  /\b(65|85|20|15)\s*%\s*(de este reporte|reglas|interfaz|ia\b|redacci)/i,
  /interfaz fija/i,
  /claude|groq|anthropic|openai|gpt-oss|llama/i,
];

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const plain = (html) =>
  squash(
    html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"'),
  );
const assertClean = (text, where) => {
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${where}: ${pattern}`);
};

const require = createRequire(import.meta.url);
async function renderWeb(report, mode) {
  // ReportView imports a CSS module; stub it so the real component renders in Node.
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
  return plain(renderToStaticMarkup(globalThis.React.createElement(ReportView, { report, mode })));
}

const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
async function pdfText(report) {
  const pdf = await getDocumentProxy(new Uint8Array(await renderReportPdf(report)));
  return (await extractText(pdf, { mergePages: true })).text;
}

const variants = {
  'AI text': { yes: SAMPLE_YES, source: 'ai' },
  'template text': { yes: SAMPLE_YES, source: 'template' },
  'all yes': { yes: questionIds, source: 'ai' },
  'no booking url': { yes: SAMPLE_YES, source: 'ai', bookingUrl: null },
};

for (const [name, opts] of Object.entries(variants)) {
  test(`no methodology section in the content, web or PDF (${name})`, async () => {
    const report = sampleReport(opts);
    const content = buildReportContent(report);

    assert.ok(!('transparency' in content), 'the content model has no transparency section');
    assertClean(flattenContent(content).join('\n'), 'content');

    const web = await renderWeb(report, 'client');
    assertClean(web, 'web client view');
    assert.ok(web.includes(LEGAL), 'web keeps the legal disclaimer exactly');

    const pdf = await pdfText(report);
    assertClean(pdf, 'pdf');
    assert.ok(norm(pdf).includes(norm(LEGAL)), 'pdf keeps the legal disclaimer exactly');
  });
}

test('the legal disclaimer is unchanged and is the last text of the report content', () => {
  const content = buildReportContent(sampleReport({ source: 'ai' }));
  assert.equal(content.legal, LEGAL);
  const flat = flattenContent(content);
  assert.equal(
    flat[flat.length - 1],
    LEGAL,
    'nothing is rendered between the CTA and the disclaimer',
  );
});

test('the internal team view is unaffected and is the only place with review annotations', async () => {
  const report = sampleReport({ source: 'ai' });
  const team = await renderWeb(report, 'team');
  assert.match(team, /Mapa de responsabilidad/);
  assert.match(team, /65%/);
  assert.ok(team.includes(LEGAL));
  assert.doesNotMatch(
    await renderWeb(report, 'client'),
    /Mapa de responsabilidad|Distribución de contenido/,
  );
});

test('the section cannot come back through the source files', () => {
  for (const file of [
    '../src/components/ReportView.tsx',
    '../src/components/ReportView.module.css',
    '../src/lib/pdf/ReportPdf.tsx',
    '../src/lib/report-content.ts',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /transparency|Cómo se elaboró|mixLegend/i, file);
  }
});
