import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText, getDocumentProxy } from 'unpdf';
import { renderReportPdf } from '../src/lib/pdf/ReportPdf.tsx';
import { buildReportContent, flattenContent } from '../src/lib/report-content.ts';
import { sampleReport, SAMPLE_YES } from './helpers/fixtures.mjs';
import { questionIds } from '../src/lib/questions.ts';

// Compared ignoring case and whitespace: letter-spaced uppercase labels extract as "D I A G...".
const norm = (s) => s.replace(/\s+/g, '').toLowerCase();

async function pdfText(report) {
  const buffer = await renderReportPdf(report);
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return { text: norm(text), pages: pdf.numPages };
}

const variants = {
  'mixed answers, AI text': { yes: SAMPLE_YES, source: 'ai' },
  'mixed answers, template text': { yes: SAMPLE_YES, source: 'template' },
  'all yes': { yes: questionIds, source: 'template' },
  'all no': { yes: [], source: 'ai' },
  'no booking url': { yes: SAMPLE_YES, bookingUrl: null },
};

for (const [name, opts] of Object.entries(variants)) {
  test(`PDF contains exactly the content shown on the web (${name})`, async () => {
    const report = sampleReport(opts);
    const { text } = await pdfText(report);
    const missing = flattenContent(buildReportContent(report)).filter(
      (s) => !text.includes(norm(s)),
    );
    assert.deepEqual(missing, []);
  });
}

test('PDF stays short for AI-written and template reports', async () => {
  for (const source of ['ai', 'template']) {
    const { pages } = await pdfText(sampleReport({ source }));
    assert.ok(pages >= 1 && pages <= 6, `${source}: ${pages} pages`);
  }
});

test('booking URL is identical in the web content and the PDF link', async () => {
  const url = 'https://www.quirongroup.com/calendario-jag';
  const report = sampleReport({ bookingUrl: url });
  assert.equal(buildReportContent(report).cta.url, url);

  const pdf = await getDocumentProxy(new Uint8Array(await renderReportPdf(report)));
  const links = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    for (const a of await page.getAnnotations()) if (a.url) links.push(a.url);
  }
  assert.deepEqual(links, [url]);
});
