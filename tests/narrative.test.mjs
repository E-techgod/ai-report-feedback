import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNarrative, TOOL_NAME, toolDefinition } from '../src/lib/narrative.ts';
import { aiWordLimits } from '../src/lib/ai-share.ts';
import { buildReportModel, narrativeSchema } from '../src/lib/report.ts';
import { questionIds } from '../src/lib/questions.ts';
import { answersOf, SAMPLE_YES } from './helpers/fixtures.mjs';

const model = buildReportModel(answersOf(SAMPLE_YES));
const n = model.priorities.length;
const good = {
  executiveSummary: 'Resumen breve y claro.',
  priorityContexts: Array.from({ length: n }, (_, i) => `Contexto ${i + 1}.`),
};
const reply = (input, status = 200) =>
  new Response(JSON.stringify({ content: [{ type: 'tool_use', name: TOOL_NAME, input }] }), {
    status,
  });
const cfg = (fetchImpl, extra = {}) => ({
  provider: 'anthropic',
  apiKey: 'k',
  modelId: 'm',
  fetchImpl,
  ...extra,
});

test('valid tool output becomes an AI narrative and the request forces the schema tool', async () => {
  let body;
  const out = await generateNarrative(
    model,
    cfg(async (_u, init) => ((body = JSON.parse(init.body)), reply(good))),
  );
  assert.equal(out.source, 'ai');
  assert.equal(out.failureReason, null);
  assert.deepEqual(out.narrative, good);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: TOOL_NAME });
  assert.equal(body.tools[0].input_schema.properties.priorityContexts.minItems, n);
  const limits = aiWordLimits(model);
  assert.match(body.system, new RegExp(`máximo ${limits.summary} palabras`));
  assert.match(body.system, new RegExp(`máximo ${limits.context} palabras`));
  assert.match(body.system, new RegExp(`no deben superar ${limits.total} palabras`));
  assert.match(body.system, new RegExp(`límite total exacto es ${limits.total} palabras`));
  assert.match(body.system, new RegExp(`apunta a ${limits.total - 5} palabras o menos`));
  assert.match(body.tools[0].description, new RegExp(`${limits.total} palabras`));
  assert.match(
    body.tools[0].input_schema.properties.executiveSummary.description,
    new RegExp(`${limits.summary} palabras`),
  );
  assert.match(
    body.tools[0].input_schema.properties.priorityContexts.items.description,
    new RegExp(`${limits.context} palabras`),
  );
  assert.ok(!JSON.stringify(body.messages).includes('@'), 'no personal data is sent to the model');
  assert.equal(toolDefinition(0).input_schema.properties.priorityContexts.maxItems, 0);
});

test('Anthropic retries a three-priority answer over the combined budget', async () => {
  const limits = aiWordLimits(model);
  assert.equal(limits.total, 78);
  const narrativeWithWords = (summary, contexts) => ({
    executiveSummary: Array(summary).fill('palabra').join(' '),
    priorityContexts: contexts.map((count) => Array(count).fill('palabra').join(' ')),
  });
  const over = narrativeWithWords(39, [14, 14, 13]); // 80 total
  const within = narrativeWithWords(37, [13, 13, 12]); // 75 total
  const issues = narrativeSchema(n, limits).safeParse(over);
  assert.equal(issues.success, false);
  assert.deepEqual(
    issues.error.issues.map(({ path, code }) => ({ path, code })),
    [{ path: [], code: 'custom' }],
  );
  assert.equal(narrativeSchema(n, limits).safeParse(within).success, true);

  let calls = 0;
  const outcome = await generateNarrative(
    model,
    cfg(async () => reply(calls++ === 0 ? over : within)),
  );
  assert.equal(calls, 2);
  assert.equal(outcome.source, 'ai');
  assert.equal(outcome.failureReason, null);
  assert.deepEqual(outcome.narrative, within);
});

test('one business priority accepts the observed Anthropic word counts without fallback', async () => {
  const oneBusinessNo = buildReportModel(answersOf(questionIds.filter((id) => id !== 'B1')));
  assert.equal(aiWordLimits(oneBusinessNo).total, 69);
  let calls = 0;
  const narrative = {
    executiveSummary: Array(38).fill('palabra').join(' '),
    priorityContexts: [Array(23).fill('palabra').join(' ')],
  };
  const outcome = await generateNarrative(
    oneBusinessNo,
    cfg(async () => {
      calls += 1;
      return reply(narrative);
    }),
  );
  assert.equal(calls, 1);
  assert.equal(outcome.source, 'ai');
  assert.equal(outcome.failureReason, null);
  assert.deepEqual(outcome.narrative, narrative);
});

const oneYes = buildReportModel(answersOf(['A1']));
const oneYesDraft = (counts) => ({
  executiveSummary: Array(31).fill('resumen').join(' '),
  priorityContexts: counts.map((count) => Array(count).fill('contexto').join(' ')),
});

for (const [label, retryCounts, expectedSource] of [
  ['accepts a valid repair', [16, 16, 16], 'ai'],
  ['falls back after an unsuccessful repair', [19, 15, 17], 'template'],
]) {
  test(`one yes: Anthropic ${label}`, async () => {
    const limits = aiWordLimits(oneYes);
    assert.deepEqual(limits, { summary: 50, context: 25, total: 79 });
    const first = oneYesDraft([19, 17, 20]);
    const retry = oneYesDraft(retryCounts);
    const schema = narrativeSchema(3, limits);
    for (const draft of expectedSource === 'ai' ? [first] : [first, retry]) {
      const result = schema.safeParse(draft);
      assert.equal(result.success, false);
      assert.deepEqual(result.error.issues, [
        { code: 'custom', path: [], message: 'AI word budget exceeded' },
      ]);
    }
    const requests = [];
    const outcome = await generateNarrative(
      oneYes,
      cfg(
        async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return reply(requests.length === 1 ? first : retry);
        },
        { maxAttempts: 3 },
      ),
    );
    assert.equal(requests.length, 2);
    assert.match(requests[0].system, /una sola oración corta/);
    assert.doesNotMatch(requests[0].system, /intento anterior/);
    assert.match(requests[1].system, /límite total exacto es 79 palabras/);
    assert.match(requests[1].system, /87 palabras.*al menos 8 palabras menos/);
    assert.deepEqual(requests[1].messages, requests[0].messages);
    assert.ok(!JSON.stringify(requests[1]).includes(first.executiveSummary));
    assert.equal(outcome.source, expectedSource);
    if (expectedSource === 'ai') {
      assert.equal(outcome.failureReason, null);
      assert.deepEqual(outcome.narrative, retry);
    } else {
      assert.equal(outcome.failureReason, 'invalid-output');
      assert.notDeepEqual(outcome.narrative, retry);
    }
  });
}

test('Anthropic sends no count repair for malformed JSON or a structurally invalid tool input', async () => {
  for (const [response, reason] of [
    [() => new Response('{'), 'error'],
    [() => reply(oneYesDraft([19, 17, 20, 4])), 'invalid-output'],
  ]) {
    const requests = [];
    const outcome = await generateNarrative(
      oneYes,
      cfg(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return response();
      }),
    );
    assert.equal(requests.length, 2);
    assert.doesNotMatch(requests[0].system, /intento anterior/);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(outcome.source, 'template');
    assert.equal(outcome.failureReason, reason);
  }
});

test('not configured: explicit template outcome, no network call', async () => {
  let called = false;
  const out = await generateNarrative(model, {
    provider: 'anthropic',
    apiKey: '',
    modelId: '',
    fetchImpl: async () => ((called = true), reply(good)),
  });
  assert.equal(out.source, 'template');
  assert.equal(out.failureReason, 'not-configured');
  assert.equal(called, false);
});

test('invalid output (wrong count / too long) is rejected, retried once, then labelled template', async () => {
  let calls = 0;
  const long = { ...good, executiveSummary: Array(200).fill('palabra').join(' ') };
  const out = await generateNarrative(
    model,
    cfg(async () => (calls++, reply(long))),
  );
  assert.equal(calls, 2);
  assert.equal(out.source, 'template');
  assert.equal(out.failureReason, 'invalid-output');
  const wrongCount = await generateNarrative(
    model,
    cfg(async () => reply({ ...good, priorityContexts: ['solo uno'] }), { maxAttempts: 1 }),
  );
  assert.equal(wrongCount.failureReason, 'invalid-output');
});

test('transient failure then success: the retry produces an AI narrative', async () => {
  let calls = 0;
  const out = await generateNarrative(
    model,
    cfg(async () => (calls++ === 0 ? new Response('{}', { status: 529 }) : reply(good))),
  );
  assert.equal(calls, 2);
  assert.equal(out.source, 'ai');
});

test('permanent HTTP errors are not retried; timeouts are reported as timeout', async () => {
  let calls = 0;
  const denied = await generateNarrative(
    model,
    cfg(async () => (calls++, new Response('{}', { status: 401 }))),
  );
  assert.equal(calls, 1);
  assert.equal(denied.failureReason, 'http-401');

  const hang = (_u, init) =>
    new Promise((_res, rej) =>
      init.signal.addEventListener('abort', () =>
        rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      ),
    );
  const slow = await generateNarrative(
    model,
    cfg(hang, { attemptTimeoutMs: 50, totalBudgetMs: 3000 }),
  );
  assert.equal(slow.source, 'template');
  assert.equal(slow.failureReason, 'timeout');
});

test('text-only responses (no tool call) are rejected, never trusted', async () => {
  const text = new Response(
    JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(good) }] }),
  );
  const out = await generateNarrative(
    model,
    cfg(async () => text.clone(), { maxAttempts: 1 }),
  );
  assert.equal(out.failureReason, 'invalid-output');
});

test('diagnostics identify validation failures without logging response content or credentials', async () => {
  const secret = 'sk-ant-private-test-credential';
  const privateText = 'Private response content must never appear in logs';
  const invalid = {
    executiveSummary: privateText,
    priorityContexts: Array.from({ length: n }, () => Array(30).fill('word').join(' ')),
    [privateText]: secret,
  };
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const lines = [];
  console.info = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    const out = await generateNarrative(
      model,
      cfg(
        async () =>
          new Response(
            JSON.stringify({
              stop_reason: 'tool_use',
              usage: { input_tokens: 123, output_tokens: 456 },
              content: [{ type: 'tool_use', name: TOOL_NAME, input: invalid }],
            }),
            { status: 200 },
          ),
        { apiKey: secret, maxAttempts: 1 },
      ),
    );
    assert.equal(out.failureReason, 'invalid-output');
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  const log = lines.join('\n');
  assert.ok(!log.includes(secret));
  assert.ok(!log.includes(privateText));
  const entry = JSON.parse(
    lines
      .find((line) => line.startsWith('[narrative] diagnostic '))
      .replace('[narrative] diagnostic ', ''),
  );
  assert.equal(entry.provider, 'anthropic');
  assert.equal(entry.httpStatus, 200);
  assert.equal(entry.stopReason, 'tool_use');
  assert.deepEqual(entry.contentBlockTypes, ['tool_use']);
  assert.equal(entry.namedToolUseFound, true);
  assert.deepEqual([entry.inputTokens, entry.outputTokens, entry.retry], [123, 456, 1]);
  assert.deepEqual(entry.outputFields.names, ['executiveSummary', 'priorityContexts', '[other]']);
  assert.ok(entry.zodIssues.some((issue) => issue.code === 'custom'));
  assert.ok(entry.zodIssues.some((issue) => issue.code === 'unrecognized_keys'));
});
