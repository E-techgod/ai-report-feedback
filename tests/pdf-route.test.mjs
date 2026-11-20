import test from 'node:test';
import assert from 'node:assert/strict';
import { issueDownloadGrant } from '../src/lib/download-grant.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { renderReportPdf } from '../src/lib/pdf/ReportPdf.tsx';
import { sampleReport } from './helpers/fixtures.mjs';
import { T0 } from './helpers/flow-harness.mjs';
import { freshLimiter } from './helpers/ledger.mjs';

const SECRET = 's'.repeat(32);
const at = (ms) => () => new Date(T0 + ms);

function setup() {
  const rendered = [];
  const { limiter, gateway } = freshLimiter();
  return {
    rendered,
    limiter,
    ledger: gateway,
    renderPdf: async (report) => {
      rendered.push(report);
      return Buffer.from('%PDF-fake');
    },
  };
}

const post = (report, token, { raw } = {}) =>
  new Request('https://example.com/api/report/pdf', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-download-token': token } : {}),
    },
    body: raw ?? JSON.stringify(report),
  });

const download = (s, report, token, offsetMs = 1_000, extra) =>
  handlePdfDownload(post(report, token, extra), {
    secret: SECRET,
    renderPdf: s.renderPdf,
    limiter: s.limiter,
    now: at(offsetMs),
  });

test('a valid grant downloads the PDF, repeatedly, until the five minutes are over', async () => {
  const s = setup();
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  for (const offset of [1_000, 90_000, 299_999]) {
    const response = await download(s, report, token, offset);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.match(
      response.headers.get('content-disposition') ?? '',
      /Diagnostico-Patrimonial-Quiron-Prueba\.pdf/,
    );
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '%PDF-fake');
  }
  assert.equal(s.rendered.length, 3);
  assert.deepEqual(s.rendered[0], report, 'the PDF is rendered from the presented report');
});

test('after five minutes the same previously valid token is refused and nothing is rendered', async () => {
  const s = setup();
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  assert.equal((await download(s, report, token, 299_000)).status, 200);
  for (const offset of [300_000, 301_000, 3_600_000]) {
    const response = await download(s, report, token, offset);
    assert.equal(response.status, 410);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal((await response.json()).error, 'Tu sesión de descarga ha expirado.');
  }
  assert.equal(s.rendered.length, 1);
});

test('invalid or tampered tokens are rejected', async () => {
  const s = setup();
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  const [exp, sig] = token.split('.');
  const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
  for (const bad of [
    undefined,
    '',
    'garbage',
    `${exp}.${flipped}`,
    `${Number(exp) + 600_000}.${sig}`,
  ])
    assert.equal((await download(s, report, bad)).status, 401, String(bad));
  const otherSecret = issueDownloadGrant(report, 'x'.repeat(32), new Date(T0)).token;
  assert.equal((await download(s, report, otherSecret)).status, 401);
  assert.equal(s.rendered.length, 0);
});

test("a different submission's token cannot download another client's report", async () => {
  const s = setup();
  const mine = sampleReport();
  const theirs = sampleReport();
  const mineToken = issueDownloadGrant(mine, SECRET, new Date(T0)).token;
  const theirToken = issueDownloadGrant(theirs, SECRET, new Date(T0)).token;
  assert.equal((await download(s, theirs, mineToken)).status, 401);
  assert.equal((await download(s, mine, theirToken)).status, 401);
  assert.equal(s.rendered.length, 0);
  assert.equal((await download(s, theirs, theirToken)).status, 200);
});

test('a report edited after issue (answers-derived data or AI text) is refused', async () => {
  const s = setup();
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  const edited = { ...report, narrative: { ...report.narrative, executiveSummary: 'Otro texto.' } };
  const rescored = { ...report, model: { ...report.model, level: 'Excelente' } };
  assert.equal((await download(s, edited, token)).status, 401);
  assert.equal((await download(s, rescored, token)).status, 401);
  assert.equal(s.rendered.length, 0);
});

test('malformed or oversized bodies are rejected before any rendering', async () => {
  const s = setup();
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  assert.equal((await download(s, null, token, 1_000, { raw: '{nope' })).status, 400);
  assert.equal((await download(s, { hello: 'world' }, token)).status, 400);
  assert.equal((await download(s, null, token, 1_000, { raw: 'x'.repeat(100_001) })).status, 413);
  assert.equal(s.rendered.length, 0);
});

test('a failed render is logged as a structured event, returns a no-store 500 and leaks no report content', async () => {
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  let response;
  try {
    response = await handlePdfDownload(post(report, token), {
      secret: SECRET,
      limiter: freshLimiter().limiter,
      now: at(1_000),
      renderPdf: async () => {
        throw new Error("Cannot find module 'pdfkit/js/standard-fonts/Helvetica.cjs'");
      },
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(response.status, 500);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  // Structured, diagnosable by reason and error class, and without the error text.
  const event = JSON.parse(logged.find((line) => line.includes('pdf_render_failed')));
  assert.deepEqual(
    [event.event, event.reason, event.cause],
    ['pdf_render_failed', 'missing_asset', 'Error'],
  );
  assert.ok(!logged.join(' ').includes('pdfkit'), 'the error text is not logged');
  assert.ok(!logged.join(' ').includes(report.firstName));
});

test('the real renderer produces a PDF from a report that went through JSON', async () => {
  const report = sampleReport({ source: 'ai' });
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  const received = JSON.parse(JSON.stringify(report));
  const response = await handlePdfDownload(post(received, token), {
    secret: SECRET,
    renderPdf: renderReportPdf,
    limiter: freshLimiter().limiter,
    now: at(1_000),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
});
