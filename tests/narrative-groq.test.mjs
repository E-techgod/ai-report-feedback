import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GROQ_MODEL,
  generateNarrative,
  groqResponseSchema,
  TOOL_NAME,
} from '../src/lib/narrative.ts';
import { buildReportModel } from '../src/lib/report.ts';
import { answersOf, SAMPLE_YES } from './helpers/fixtures.mjs';

const model = buildReportModel(answersOf(SAMPLE_YES));
const n = model.priorities.length;
const good = {
  executiveSummary: 'Resumen breve y claro.',
  priorityContexts: Array.from({ length: n }, (_, i) => `Contexto ${i + 1}.`),
};
const groqReply = (content, status = 200) =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content: typeof content === 'string' ? content : JSON.stringify(content) } },
      ],
    }),
    { status },
  );
const cfg = (fetchImpl, extra = {}) => ({ apiKey: 'gsk_test', fetchImpl, ...extra });

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('Groq is the default provider: strict json_schema request, default model, no personal data', async () => {
  let url;
  let init;
  const out = await withEnv({ AI_PROVIDER: undefined, GROQ_MODEL: undefined }, () =>
    generateNarrative(
      model,
      cfg(async (u, i) => ((url = u), (init = i), groqReply(good))),
    ),
  );
  assert.equal(out.source, 'ai');
  assert.deepEqual(out.narrative, good);
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer gsk_test');
  const body = JSON.parse(init.body);
  assert.equal(body.model, DEFAULT_GROQ_MODEL);
  assert.equal(body.model, 'openai/gpt-oss-20b');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.include_reasoning, false);
  assert.ok(!('reasoning_format' in body), 'reasoning_format is unsupported on gpt-oss');
  assert.ok(!('tools' in body));
  assert.ok(!JSON.stringify(body.messages).includes('@'), 'no personal data is sent');
  assert.ok(!JSON.stringify(body).includes(TOOL_NAME), 'the Groq prompt does not mention tools');
});

test('the strict schema only uses constructs Groq documents for strict mode', () => {
  const walk = (node) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(node.required.sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    }
    if (node.type === 'array') walk(node.items);
    for (const keyword of ['minItems', 'maxItems', 'minLength', 'maxLength', 'pattern'])
      assert.ok(!(keyword in node), `${keyword} is not documented for strict mode`);
  };
  walk(groqResponseSchema());
});

test('GROQ_MODEL overrides the default model; the key is read from GROQ_API_KEY', async () => {
  let body;
  let auth;
  await withEnv(
    { AI_PROVIDER: undefined, GROQ_MODEL: 'openai/gpt-oss-120b', GROQ_API_KEY: 'gsk_env' },
    () =>
      generateNarrative(model, {
        fetchImpl: async (_u, i) => (
          (body = JSON.parse(i.body)),
          (auth = i.headers.authorization),
          groqReply(good)
        ),
      }),
  );
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.equal(auth, 'Bearer gsk_env');
});

test('AI_PROVIDER=anthropic selects Anthropic explicitly; an unknown name uses the template', async () => {
  let url;
  const out = await withEnv({ AI_PROVIDER: 'anthropic' }, () =>
    generateNarrative(model, {
      apiKey: 'k',
      modelId: 'm',
      fetchImpl: async (u) => (
        (url = u),
        new Response(
          JSON.stringify({ content: [{ type: 'tool_use', name: TOOL_NAME, input: good }] }),
        )
      ),
    }),
  );
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(out.source, 'ai');

  let called = false;
  const typo = await withEnv({ AI_PROVIDER: 'grok' }, () =>
    generateNarrative(
      model,
      cfg(async () => ((called = true), groqReply(good))),
    ),
  );
  assert.equal(typo.source, 'template');
  assert.equal(typo.failureReason, 'unknown-provider');
  assert.equal(called, false);
});

test('no Groq key: explicit template outcome and no network call', async () => {
  let called = false;
  const out = await withEnv({ AI_PROVIDER: undefined, GROQ_API_KEY: undefined }, () =>
    generateNarrative(model, { fetchImpl: async () => ((called = true), groqReply(good)) }),
  );
  assert.equal(out.source, 'template');
  assert.equal(out.failureReason, 'not-configured');
  assert.equal(called, false);
});

test('unusable Groq output is never trusted: bad JSON, extra keys, wrong count, no content', async () => {
  const bad = [
    'not json at all',
    { ...good, diagnostico: 'extra' },
    { ...good, priorityContexts: ['solo uno', 'dos', 'tres', 'cuatro'] },
    { executiveSummary: good.executiveSummary },
    {
      executiveSummary: Array(200).fill('palabra').join(' '),
      priorityContexts: good.priorityContexts,
    },
  ];
  for (const content of bad) {
    const out = await generateNarrative(
      model,
      cfg(async () => groqReply(content), { maxAttempts: 1 }),
    );
    assert.equal(out.source, 'template', JSON.stringify(content));
    assert.equal(out.failureReason, 'invalid-output');
  }
  const empty = await generateNarrative(
    model,
    cfg(async () => new Response(JSON.stringify({ choices: [] })), { maxAttempts: 1 }),
  );
  assert.equal(empty.failureReason, 'invalid-output');
});

const rateLimited = (retryAfter) =>
  new Response('{"error":{"message":"secret-ish provider detail"}}', {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
  });

test('429 with a short Retry-After waits that long once, then succeeds', async () => {
  let calls = 0;
  const pauses = [];
  const out = await generateNarrative(
    model,
    cfg(async () => (calls++ === 0 ? rateLimited(2) : groqReply(good)), {
      sleep: async (ms) => void pauses.push(ms),
    }),
  );
  assert.equal(calls, 2);
  assert.deepEqual(pauses, [2000]);
  assert.equal(out.source, 'ai');
});

test('429 without Retry-After pauses briefly; a persistent 429 ends as a rate-limited template', async () => {
  const pauses = [];
  let calls = 0;
  const out = await generateNarrative(
    model,
    cfg(async () => (calls++, rateLimited()), { sleep: async (ms) => void pauses.push(ms) }),
  );
  assert.equal(calls, 2);
  assert.deepEqual(pauses, [1000]);
  assert.equal(out.source, 'template');
  assert.equal(out.failureReason, 'rate-limited');
  assert.ok(!JSON.stringify(out).includes('secret-ish'), 'provider bodies are never kept');
});

test('a long Retry-After or an exhausted budget is not waited for', async () => {
  let calls = 0;
  const pauses = [];
  const sleep = async (ms) => void pauses.push(ms);
  const long = await generateNarrative(
    model,
    cfg(async () => (calls++, rateLimited(60)), { sleep }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(pauses, []);
  assert.equal(long.failureReason, 'rate-limited');

  calls = 0;
  const tight = await generateNarrative(
    model,
    cfg(async () => (calls++, rateLimited(5)), { sleep, totalBudgetMs: 6000 }),
  );
  assert.equal(calls, 1, 'a retry that cannot fit the budget is skipped');
  assert.deepEqual(pauses, []);
  assert.equal(tight.failureReason, 'rate-limited');
});

test('Groq timeouts are reported as timeout and fall back to the template', async () => {
  const hang = (_u, init) =>
    new Promise((_res, rej) =>
      init.signal.addEventListener('abort', () =>
        rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      ),
    );
  const out = await generateNarrative(
    model,
    cfg(hang, { attemptTimeoutMs: 50, totalBudgetMs: 3000 }),
  );
  assert.equal(out.source, 'template');
  assert.equal(out.failureReason, 'timeout');
});

test('Groq auth errors are not retried', async () => {
  let calls = 0;
  const out = await generateNarrative(
    model,
    cfg(async () => (calls++, new Response('{}', { status: 401 }))),
  );
  assert.equal(calls, 1);
  assert.equal(out.failureReason, 'http-401');
});
