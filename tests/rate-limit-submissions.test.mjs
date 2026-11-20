import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { MAX_SUBMISSIONS_PER_EMAIL, REJECTED_BY_LIMIT_LABEL } from '../src/lib/sheets.ts';
import { submission } from './helpers/flow-harness.mjs';
import { STATUS, answersPattern, post, questionnaireContext } from './helpers/sheet-gateway.mjs';

const HOUR = 3_600_000;
const send = (ctx, input) => handleQuestionnaire(post(input), ctx);
const quiet = async (fn) => {
  const { info, warn } = console;
  console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { info, warn });
  }
};

test('the limit is five submissions per email; the sixth gets a friendly 429 before any AI call', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  for (let n = 0; n < MAX_SUBMISSIONS_PER_EMAIL; n++) {
    h.clock.t += 20 * 60_000; // distinct, well apart: none of them is a duplicate
    const response = await send(ctx, submission({ answers: answersPattern(n) }));
    assert.equal(response.status, 200, `submission ${n + 1}`);
  }
  assert.equal(h.narrativeCalls.length, 5);
  assert.equal(sheet.appends, 5);

  h.clock.t += 20 * 60_000;
  const response = await quiet(() => send(ctx, submission({ answers: answersPattern(7) })));
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'rate_limited');
  assert.match(body.error, /límite de 5 diagnósticos en 24 horas/);
  assert.match(body.error, /inténtalo de nuevo en aproximadamente \d+ horas?/i);
  assert.equal(response.headers.get('retry-after'), String(body.retryAfterSeconds));
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.ok(!('report' in body) && !('download' in body), 'no report, no grant');
  // Nothing expensive ran: no AI call, no report, no new Sheet row.
  assert.equal(h.narrativeCalls.length, 5);
  assert.equal(sheet.appends, 5);
});

test('the window is rolling: it frees up exactly 24 hours after the oldest counted submission', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  const start = h.clock.t;
  const send1 = async (n, at) => {
    h.clock.t = at;
    return quiet(() => send(ctx, submission({ answers: answersPattern(n) })));
  };
  // Three at the start, two twelve hours later.
  for (const [n, at] of [
    [0, start],
    [1, start + 20 * 60_000],
    [2, start + 40 * 60_000],
    [3, start + 12 * HOUR],
    [4, start + 12 * HOUR + 20 * 60_000],
  ])
    assert.equal((await send1(n, at)).status, 200);

  // Just before the oldest leaves the window: refused, and told how long to wait (about a second).
  const early = await send1(5, start + 24 * HOUR - 1_000);
  assert.equal(early.status, 429);
  assert.equal((await early.json()).retryAfterSeconds, 1);

  // Just after: exactly one slot is free (the 2nd-oldest is still inside the window).
  assert.equal((await send1(6, start + 24 * HOUR + 1_000)).status, 200);
  assert.equal((await send1(7, start + 24 * HOUR + 30 * 60_000)).status, 200); // 2nd oldest left too
  assert.equal((await send1(8, start + 24 * HOUR + 50 * 60_000)).status, 200);
  assert.equal((await send1(9, start + 24 * HOUR + 70 * 60_000)).status, 429); // 3rd..5th still count
  assert.equal(sheet.appends, 8);
});

test('duplicates never count toward the limit and are never blocked by it', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  for (let n = 0; n < MAX_SUBMISSIONS_PER_EMAIL; n++) {
    h.clock.t += 20 * 60_000;
    assert.equal((await send(ctx, submission({ answers: answersPattern(n) }))).status, 200);
  }
  // The same person with the same answers as the latest one, seconds later: a duplicate, not a 429.
  h.clock.t += 30_000;
  const repeat = await quiet(() =>
    send(ctx, submission({ answers: answersPattern(MAX_SUBMISSIONS_PER_EMAIL - 1) })),
  );
  const body = await repeat.json();
  assert.equal(repeat.status, 200);
  assert.equal(body.duplicate, true);
  assert.equal(sheet.appends, 5, 'a duplicate adds no row, so it cannot consume the limit');
});

test('emails are limited independently, and letter case does not evade the limit', async () => {
  const { h, ctx } = questionnaireContext();
  for (let n = 0; n < MAX_SUBMISSIONS_PER_EMAIL; n++) {
    h.clock.t += 20 * 60_000;
    const email = n % 2 ? 'ANA.Perez@Example.com' : 'ana.perez@example.com';
    assert.equal((await send(ctx, submission({ email, answers: answersPattern(n) }))).status, 200);
  }
  h.clock.t += 20 * 60_000;
  const sixth = await quiet(() =>
    send(ctx, submission({ email: 'ANA.PEREZ@EXAMPLE.COM', answers: answersPattern(9) })),
  );
  assert.equal(sixth.status, 429);
  const other = await send(
    ctx,
    submission({ email: 'otra@example.com', answers: answersPattern(9) }),
  );
  assert.equal(other.status, 200);
});

test('concurrent submissions that race past the pre-check are ranked: exactly five succeed', async () => {
  const { h, sheet, ctx } = questionnaireContext({ interleave: true });
  const attempts = Array.from({ length: 10 }, (_, n) =>
    submission({ answers: answersPattern(n + 20) }),
  );
  const responses = await quiet(() => Promise.all(attempts.map((input) => send(ctx, input))));
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429, 429, 429]);
  // The AI was only ever reached for the five that won a slot.
  assert.equal(h.narrativeCalls.length, 5);
  // The losers' rows are kept (the lead is not lost) but labelled, not left as "Pendiente".
  const labelled = sheet.rows.slice(1).filter((row) => row[STATUS] === REJECTED_BY_LIMIT_LABEL);
  assert.equal(labelled.length, 5);
});

test('a request that lost the race cannot be turned into a "duplicate" by retrying its id', async () => {
  const { sheet, ctx } = questionnaireContext({ interleave: true });
  const attempts = Array.from({ length: 7 }, (_, n) =>
    submission({ answers: answersPattern(n + 40) }),
  );
  const responses = await quiet(() => Promise.all(attempts.map((input) => send(ctx, input))));
  const loser = attempts[responses.findIndex((r) => r.status === 429)];
  assert.ok(loser, 'one of the racers was refused');
  const rowsBefore = sheet.rows.length;

  const retry = await quiet(() => send(ctx, loser));
  assert.equal(retry.status, 429, 'the retry is judged by its position, not served as a duplicate');
  assert.equal(sheet.rows.length, rowsBefore, 'and adds no row');
});

test('the refusal log is structured and carries no email, name or answers', async () => {
  const { h, ctx } = questionnaireContext();
  const lines = [];
  const { info, warn } = console;
  console.info = console.warn = (line) => lines.push(String(line));
  try {
    for (let n = 0; n < MAX_SUBMISSIONS_PER_EMAIL; n++) {
      h.clock.t += 20 * 60_000;
      await send(ctx, submission({ answers: answersPattern(n) }));
    }
    h.clock.t += 20 * 60_000;
    await send(ctx, submission({ firstName: 'Zoila', answers: answersPattern(9) }));
  } finally {
    Object.assign(console, { info, warn });
  }
  const events = lines.map((line) => JSON.parse(line));
  const limited = events.filter((e) => e.event === 'submission_rate_limited');
  assert.equal(limited.length, 1);
  assert.equal(limited[0].reason, 'email_24h');
  assert.match(limited[0].subject, /^[0-9a-f]{10}$/, 'a keyed fingerprint, not the address');
  const text = lines.join('\n');
  assert.ok(!/example\.com|ana\.perez|Zoila|Ana|Pérez/i.test(text), 'no personal data in logs');
});
