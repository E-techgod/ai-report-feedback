import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildEmail, pdfFilename } from '../src/lib/email.ts';
import { reportAccessToken } from '../src/lib/final-report.ts';
import { createReport, deliverReportEmail } from '../src/lib/pipeline.ts';
import { buildReportContent } from '../src/lib/report-content.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { harness, submission } from './helpers/pipeline-harness.mjs';

test('web, PDF and email all read the one persisted report; the provider is called once', async () => {
  const h = harness();
  const { store, deps } = await h.build();
  const rendered = [];
  deps.renderPdf = async (report) => (rendered.push(report), Buffer.from('%PDF-fake'));
  const s = submission();
  const { record } = await createReport(deps, s);
  await createReport(deps, s); // same submission id
  await createReport(deps, { ...s, id: crypto.randomUUID() }); // same person + answers, new id
  assert.equal(h.narrativeCalls.length, 1, 'duplicates never regenerate the report');

  await deliverReportEmail(deps, record.id);
  const stored = (await store.getById(record.id)).report;
  assert.deepEqual(stored, record.report);
  assert.deepEqual(rendered, [stored], 'the PDF is rendered from the stored report');
  const expected = buildEmail(stored, {
    siteUrl: null,
    attachmentName: pdfFilename(stored.firstName),
  });
  assert.equal(h.sent[0].html, expected.html, 'the email is built from the stored report');
  assert.equal(buildReportContent(stored).executive.summaryText, stored.narrative.executiveSummary);
});

test('a rate-limited run persists template text once: no regeneration, one email', async () => {
  const h = harness({
    narrative: async (model) => {
      const { fallbackNarrative } = await import('../src/lib/report.ts');
      return {
        narrative: fallbackNarrative(model),
        source: 'template',
        failureReason: 'rate-limited',
      };
    },
  });
  const { deps } = await h.build();
  const s = submission();
  let calls = 0;
  const inner = deps.generateNarrative;
  deps.generateNarrative = async (model) => (calls++, inner(model));
  const first = await createReport(deps, s);
  assert.equal(first.record.report.narrativeSource, 'template');
  assert.equal(first.record.report.aiFailureReason, 'rate-limited');
  const again = await createReport(deps, s);
  assert.equal(again.created, false);
  assert.deepEqual(again.record.report, first.record.report);
  assert.equal(calls, 1);
  await deliverReportEmail(deps, first.record.id);
  await deliverReportEmail(deps, first.record.id);
  assert.equal(h.sent.length, 1);
});

test('downloading the PDF never calls the AI provider', async () => {
  const h = harness({ emailEnabled: false });
  const { deps } = await h.build();
  const { record } = await createReport(deps, submission());
  deps.generateNarrative = async () => {
    throw new Error('the AI must not be called when reading a stored report');
  };
  const secret = 's'.repeat(32);
  const response = await handlePdfDownload(
    new Request('https://example.com/api/report/x/pdf', {
      headers: { 'x-report-token': reportAccessToken(record.id, secret) },
    }),
    record.id,
    deps,
    secret,
    () => {},
  );
  assert.equal(response.status, 200);
});

test('AI provider keys and settings never reach the browser', () => {
  const root = new URL('../src', import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  const server = new Set(['narrative.ts']);
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    assert.ok(!/NEXT_PUBLIC_(GROQ|ANTHROPIC|AI_)/.test(text), `${path} exposes a key`);
    if (/^['"]use client['"]/m.test(text))
      assert.ok(!/GROQ_|ANTHROPIC_|AI_PROVIDER/.test(text), `${path} is a client component`);
    if (/GROQ_API_KEY/.test(text))
      assert.ok(
        server.has(path.split('/').pop()),
        `${path} reads the Groq key outside narrative.ts`,
      );
  }
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.ok(!/NEXT_PUBLIC_(GROQ|AI_)/.test(example));
});
