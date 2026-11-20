import test from 'node:test';
import assert from 'node:assert/strict';
import nextEnv from '@next/env';
import { aiShare, aiWordLimits, MAX_AI_SHARE } from '../../src/lib/ai-share.ts';
import { generateReport } from '../../src/lib/generate-report.ts';
import { questionIds } from '../../src/lib/questions.ts';
import { buildReportModel, narrativeSchema } from '../../src/lib/report.ts';
import { getReportDeps } from '../../src/lib/services.ts';
import { submissionSchema } from '../../src/lib/validation.ts';
import { answersOf, SAMPLE_YES } from '../helpers/fixtures.mjs';

// Opt-in real-provider checks. Every answer set and identity below is synthetic.
// Run: LIVE_PROVIDER_TEST=1 node --import tsx --test tests/live/provider-narrative.test.mjs
nextEnv.loadEnvConfig(process.cwd());

async function checkProvider(provider, yesIds, expectedPriorities) {
  const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GROQ_API_KEY';
  const modelName = provider === 'anthropic' ? 'ANTHROPIC_MODEL' : 'GROQ_MODEL';
  assert.ok(process.env[keyName], `${keyName} is not configured`);
  if (provider === 'anthropic') assert.ok(process.env[modelName], `${modelName} is not configured`);

  const submission = submissionSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    firstName: 'Prueba',
    lastName: 'Sintética',
    email: 'test@example.invalid',
    privacyAccepted: true,
    answers: answersOf(yesIds),
  });
  const model = buildReportModel(submission.answers);
  const limits = aiWordLimits(model);
  assert.equal(model.priorities.length, expectedPriorities);
  assert.ok(limits.summary > 0);
  assert.ok(expectedPriorities === 0 ? limits.context === 0 : limits.context > 0);

  // The endpoint passes getReportDeps() into generateReport(); select a provider only for
  // this test process so both services can be checked without changing any env file.
  const previous = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = provider;
  try {
    const deps = getReportDeps();
    const report = await generateReport(deps, submission);
    assert.equal(report.narrativeSource, 'ai', `provider failed: ${report.aiFailureReason}`);
    assert.equal(report.narrative.priorityContexts.length, expectedPriorities);
    assert.ok(narrativeSchema(expectedPriorities, limits).safeParse(report.narrative).success);
    assert.ok(aiShare(report) <= MAX_AI_SHARE);
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous;
  }
}

test(
  'anthropic produces a valid synthetic report through the endpoint report path',
  { skip: process.env.LIVE_PROVIDER_TEST !== '1', timeout: 50_000 },
  () => checkProvider('anthropic', SAMPLE_YES, 3),
);
test(
  'groq produces a valid synthetic report through the endpoint report path',
  { skip: process.env.LIVE_PROVIDER_TEST !== '1', timeout: 50_000 },
  () => checkProvider('groq', SAMPLE_YES, 3),
);

// Optional matrix for priority-count boundaries and different priority combinations.
// Set LIVE_PROVIDER_MATRIX=1 with LIVE_PROVIDER_TEST=1 to make these additional calls.
if (process.env.LIVE_PROVIDER_TEST === '1' && process.env.LIVE_PROVIDER_MATRIX === '1') {
  for (const [shape, yesIds, count] of [
    ['all-yes', questionIds, 0],
    ['one-personal-no', questionIds.filter((id) => id !== 'A1'), 1],
    ['one-business-no', questionIds.filter((id) => id !== 'B1'), 1],
    ['personal-yes', questionIds.filter((id) => id.startsWith('A')), 2],
    ['all-no', [], 3],
    ['one-yes', ['A1'], 3],
  ]) {
    test(`anthropic accepts the synthetic ${shape} report`, { timeout: 50_000 }, () =>
      checkProvider('anthropic', yesIds, count),
    );
  }
}
