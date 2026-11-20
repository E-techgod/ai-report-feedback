import test from 'node:test';
import assert from 'node:assert/strict';
import { aiWordLimits } from '../src/lib/ai-share.ts';
import {
  promptWordTargets,
  systemPrompt,
  toolDefinition,
  TOOL_NAME,
} from '../src/lib/narrative.ts';
import { generateReport } from '../src/lib/generate-report.ts';
import { questionIds } from '../src/lib/questions.ts';
import {
  MAX_SUMMARY_WORDS,
  buildAiInput,
  buildReportModel,
  narrativeSchema,
  validateNarrative,
} from '../src/lib/report.ts';
import { getReportDeps } from '../src/lib/services.ts';
import { submissionSchema } from '../src/lib/validation.ts';
import { answersOf, SAMPLE_YES } from './helpers/fixtures.mjs';

const words = (count) => Array(count).fill('palabra').join(' ');
const summaryCounts = [35, 40, 49, 50, 51];

test('the questionnaire report path uses provider environment and the same model input', async () => {
  const before = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    fetch: globalThis.fetch,
  };
  let request;
  process.env.AI_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'test-only-key';
  process.env.ANTHROPIC_MODEL = 'claude-haiku-5-5';
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            name: TOOL_NAME,
            input: {
              executiveSummary: 'Resumen de prueba.',
              priorityContexts: ['Contexto uno.', 'Contexto dos.', 'Contexto tres.'],
            },
          },
        ],
      }),
    );
  };
  try {
    const submission = submissionSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      firstName: 'Prueba',
      lastName: 'Sintética',
      email: 'test@example.invalid',
      privacyAccepted: true,
      answers: answersOf(SAMPLE_YES),
    });
    const report = await generateReport(getReportDeps(), submission);
    assert.equal(report.narrativeSource, 'ai');
    assert.equal(request.model, 'claude-haiku-5-5');
    assert.deepEqual(JSON.parse(request.messages[0].content), buildAiInput(report.model));
    assert.equal(request.tools[0].input_schema.properties.priorityContexts.minItems, 3);
  } finally {
    globalThis.fetch = before.fetch;
    for (const key of ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

for (const [shape, yesIds, count] of [
  ['all yes', questionIds, 0],
  ['one personal no', questionIds.filter((id) => id !== 'A1'), 1],
  ['one business no', questionIds.filter((id) => id !== 'B1'), 1],
  ['personal yes', questionIds.filter((id) => id.startsWith('A')), 2],
  ['all no', [], 3],
  ['sample', SAMPLE_YES, 3],
  ['one yes', ['A1'], 3],
]) {
  test(`${shape}: computed input, priority count, and exact word boundaries agree`, () => {
    const model = buildReportModel(answersOf(yesIds));
    const limits = aiWordLimits(model);
    const input = buildAiInput(model);
    const schema = narrativeSchema(count, limits);
    assert.equal(model.priorities.length, count);
    assert.equal(input.prioridades.length, count);
    assert.equal(MAX_SUMMARY_WORDS, 50);
    assert.equal(limits.summary, 50);
    assert.ok(limits.total >= 50);
    assert.deepEqual(Object.keys(input).sort(), [
      'areasPorFortalecer',
      'focoPrincipal',
      'nivel',
      'prioridades',
      'score',
    ]);
    const tool = toolDefinition(count, limits);
    assert.equal(tool.input_schema.properties.priorityContexts.minItems, count);
    assert.equal(tool.input_schema.properties.priorityContexts.maxItems, count);
    assert.match(
      tool.input_schema.properties.executiveSummary.description,
      new RegExp(`${limits.summary} palabras`),
    );
    assert.match(tool.description, new RegExp(`${limits.total} palabras`));
    const prompt = systemPrompt(count, 'tool', limits);
    assert.match(prompt, new RegExp(`máximo ${limits.summary} palabras`));
    assert.match(prompt, new RegExp(`no deben superar ${limits.total} palabras`));
    const targets = promptWordTargets(count, limits);
    assert.ok(targets.summary + count * targets.context <= limits.total);
    assert.match(prompt, new RegExp(`procura ${targets.summary}`));
    if (count === 0) {
      assert.equal(limits.context, 0);
      assert.match(prompt, /priorityContexts debe ser un arreglo vacío/);
    } else {
      assert.equal(limits.context, 25);
      assert.match(prompt, new RegExp(`máximo ${limits.context} palabras`));
      assert.match(
        tool.input_schema.properties.priorityContexts.items.description,
        new RegExp(`${limits.context} palabras`),
      );
    }

    for (const summaryWords of summaryCounts) {
      const contextWords =
        count === 0
          ? 0
          : Math.min(limits.context, Math.floor((limits.total - summaryWords) / count));
      const candidate = {
        executiveSummary: words(summaryWords),
        priorityContexts: Array.from({ length: count }, () => words(contextWords)),
      };
      assert.equal(
        validateNarrative(candidate, count, limits) !== null,
        summaryWords <= 50 && (count === 0 || contextWords > 0),
        `${shape}: ${summaryWords} summary words with ${count} priorities`,
      );
    }

    const summaryWords = 40;
    const contextWords =
      count === 0 ? 0 : Math.min(limits.context, Math.floor((limits.total - summaryWords) / count));
    const valid = {
      executiveSummary: words(summaryWords),
      priorityContexts: Array.from({ length: count }, () => words(contextWords)),
    };
    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(schema.safeParse({ ...valid, executiveSummary: words(51) }).success, false);
    assert.equal(
      schema.safeParse({ ...valid, priorityContexts: [...valid.priorityContexts, 'extra'] })
        .success,
      false,
    );
    if (count > 0) {
      assert.equal(
        schema.safeParse({
          ...valid,
          priorityContexts: [words(26), ...valid.priorityContexts.slice(1)],
        }).success,
        false,
      );
      assert.equal(
        schema.safeParse({
          executiveSummary: words(50),
          priorityContexts: Array.from({ length: count }, () => words(25)),
        }).success,
        false,
      );
    }
  });
}

test('one business priority accepts the observed Anthropic outputs and a 25-word context', () => {
  const yesIds = questionIds.filter((id) => id !== 'B1');
  const model = buildReportModel(answersOf(yesIds));
  const limits = aiWordLimits(model);
  assert.equal(model.priorities.length, 1);
  assert.equal(limits.total, 69);
  for (const [summary, context] of [
    [38, 23],
    [36, 22],
    [44, 25],
  ]) {
    assert.ok(
      validateNarrative(
        { executiveSummary: words(summary), priorityContexts: [words(context)] },
        1,
        limits,
      ),
      `${summary} + ${context} must fit the 69-word budget`,
    );
  }
  for (const [summary, context] of [
    [45, 25],
    [50, 25],
    [38, 26],
  ]) {
    assert.equal(
      validateNarrative(
        { executiveSummary: words(summary), priorityContexts: [words(context)] },
        1,
        limits,
      ),
      null,
    );
  }
});
