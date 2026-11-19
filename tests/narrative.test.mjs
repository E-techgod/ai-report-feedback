import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNarrative, TOOL_NAME, toolDefinition } from '../src/lib/narrative.ts';
import { buildReportModel } from '../src/lib/report.ts';
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
const cfg = (fetchImpl, extra = {}) => ({ apiKey: 'k', modelId: 'm', fetchImpl, ...extra });

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
  assert.ok(!JSON.stringify(body.messages).includes('@'), 'no personal data is sent to the model');
  assert.equal(toolDefinition(0).input_schema.properties.priorityContexts.maxItems, 0);
});

test('not configured: explicit template outcome, no network call', async () => {
  let called = false;
  const out = await generateNarrative(model, {
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
