import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MAX_AI_SHARE,
  aiShare,
  aiWordCount,
  aiWordLimits,
  exceedsAiShare,
} from '../src/lib/ai-share.ts';
import { buildFinalReport } from '../src/lib/final-report.ts';
import { generateNarrative, promptWordTargets } from '../src/lib/narrative.ts';
import { generateReport } from '../src/lib/generate-report.ts';
import {
  MAX_CONTEXT_WORDS,
  MAX_SUMMARY_WORDS,
  buildReportModel,
  fallbackNarrative,
} from '../src/lib/report.ts';
import { questionIds } from '../src/lib/questions.ts';
import { reportDeps, submission } from './helpers/flow-harness.mjs';

/** Answers with exactly `noCount` "No" answers, spread to give 0..3 priorities. */
const answersWith = (noCount) => Object.fromEntries(questionIds.map((id, i) => [id, i >= noCount]));
const SCENARIOS = [0, 1, 2, 3, 6, 20];
const words = (n) => Array(n).fill('palabra').join(' ');
const narrativeOf = (model, summary, context) => ({
  executiveSummary: words(summary),
  priorityContexts: model.priorities.map(() => words(context)),
});
const fittingNarrative = (model, limits, summary = Math.min(40, limits.summary)) =>
  narrativeOf(
    model,
    summary,
    model.priorities.length === 0
      ? 0
      : Math.min(limits.context, Math.floor((limits.total - summary) / model.priorities.length)),
  );
const reportWith = ({ answers, narrative, source = 'ai', firstName = 'Ana', bookingUrl = null }) =>
  buildFinalReport({
    reportId: randomUUID(),
    submissionId: randomUUID(),
    firstName,
    answers,
    outcome: { narrative, source, failureReason: source === 'ai' ? null : 'timeout' },
    bookingUrl,
    now: new Date('2026-11-18T15:00:00Z'),
  });

test('text within the combined budget stays within 15% for every report shape and name', () => {
  for (const noCount of SCENARIOS) {
    const answers = answersWith(noCount);
    const model = buildReportModel(answers);
    const limits = aiWordLimits(model);
    assert.ok(limits.summary <= MAX_SUMMARY_WORDS && limits.context <= MAX_CONTEXT_WORDS);
    assert.ok(limits.summary >= 20, 'the limit leaves room for a useful summary');
    const narrative = fittingNarrative(model, limits);
    for (const firstName of ['', 'Ana', 'María de los Ángeles Fernández']) {
      for (const bookingUrl of [null, 'https://example.com/cita']) {
        const report = reportWith({ answers, narrative, firstName, bookingUrl });
        assert.ok(
          aiShare(report) <= MAX_AI_SHARE,
          `${noCount} No / "${firstName}" / ${bookingUrl}: ${aiShare(report)}`,
        );
        assert.equal(exceedsAiShare(report), false);
      }
    }
  }
});

test('50 summary words plus 25 in every context would exceed 15%, so they are rejected', () => {
  const answers = answersWith(6);
  const model = buildReportModel(answers);
  const report = reportWith({
    answers,
    narrative: narrativeOf(model, MAX_SUMMARY_WORDS, MAX_CONTEXT_WORDS),
  });
  assert.ok(aiShare(report) > MAX_AI_SHARE);
  assert.equal(exceedsAiShare(report), true);
});

test('template text is never counted as AI text', () => {
  const answers = answersWith(6);
  const model = buildReportModel(answers);
  const report = reportWith({ answers, narrative: fallbackNarrative(model), source: 'template' });
  assert.equal(aiWordCount(report), 0);
  assert.equal(aiShare(report), 0);
  assert.equal(exceedsAiShare(report), false);
});

test('an oversized AI narrative is replaced by template text', async () => {
  const h = reportDeps({
    narrative: async (model) => ({
      narrative: narrativeOf(model, MAX_SUMMARY_WORDS, MAX_CONTEXT_WORDS),
      source: 'ai',
      failureReason: null,
    }),
  });
  const report = await generateReport(h.deps, submission({ answers: answersWith(6) }));
  const model = buildReportModel(answersWith(6));
  assert.equal(report.narrativeSource, 'template');
  assert.equal(report.aiFailureReason, 'ai-share-exceeded');
  assert.deepEqual(report.narrative, fallbackNarrative(model));
});

test('a narrative within the combined budget is kept as AI text', async () => {
  const answers = answersWith(6);
  const h = reportDeps({
    narrative: async (model) => {
      const limits = aiWordLimits(model);
      return {
        narrative: fittingNarrative(model, limits),
        source: 'ai',
        failureReason: null,
      };
    },
  });
  const report = await generateReport(h.deps, submission({ answers }));
  assert.equal(report.narrativeSource, 'ai');
  assert.equal(report.aiFailureReason, null);
  assert.ok(aiShare(report) <= MAX_AI_SHARE);
});

test('the provider is told the derived limit and an answer inside it is accepted end to end', async () => {
  const model = buildReportModel(answersWith(6));
  const limits = aiWordLimits(model);
  let system = '';
  const reply = (content) =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  const ok = await generateNarrative(model, {
    apiKey: 'k',
    fetchImpl: async (_u, init) => {
      system = JSON.parse(init.body).messages[0].content;
      return reply(fittingNarrative(model, limits));
    },
  });
  assert.equal(ok.source, 'ai');
  assert.match(system, new RegExp(`máximo ${limits.summary} palabras`));
  assert.match(system, new RegExp(`máximo ${limits.context} palabras`));
  assert.match(system, new RegExp(`no deben superar ${limits.total} palabras`));
  const targets = promptWordTargets(model.priorities.length, limits);
  assert.match(system, new RegExp(`procura ${targets.summary}`));
  assert.match(system, new RegExp(`procura ${targets.context}`));

  // Every field is within its own cap, but their sum exceeds this report's 15% budget.
  const long = await generateNarrative(model, {
    apiKey: 'k',
    maxAttempts: 1,
    fetchImpl: async () => reply(narrativeOf(model, limits.summary, limits.context)),
  });
  assert.equal(long.source, 'template');
  assert.equal(long.failureReason, 'invalid-output');
});
