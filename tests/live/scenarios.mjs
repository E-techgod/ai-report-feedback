import assert from 'node:assert/strict';
import { createDownloadLimiter, createSheetLedger } from '../../src/lib/download-ledger.ts';
import { handleQuestionnaire } from '../../src/lib/questionnaire-handler.ts';
import { createReportCache } from '../../src/lib/report-cache.ts';
import { handlePdfDownload } from '../../src/lib/report-pdf-handler.ts';
import { reportDeps, submission } from '../helpers/flow-harness.mjs';
import { answersPattern, post } from '../helpers/sheet-gateway.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
let counter = 0;
const uniqueEmail = () => `abuse-test-${Date.now()}-${++counter}@example.test`;

/** Silences the structured security logs and console.error while `fn` runs. */
async function quiet(fn) {
  const { info, warn, error } = console;
  console.info = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { info, warn, error });
  }
}

/**
 * The abuse-protection scenarios, backend-agnostic. `backend` is either the in-memory fake or a
 * real, isolated Google spreadsheet (tests/live/backend.mjs). Time is virtual (a fixed clock we
 * advance), so the 24-hour window can be exercised without waiting; the Sheet stores whatever
 * timestamp the app writes.
 */
export function defineScenarios(test, getBackend) {
  const secret = () => getBackend().secret ?? 's'.repeat(32);

  function context() {
    const backend = getBackend();
    const h = reportDeps();
    h.clock.t = Date.now();
    const tasks = [];
    const flush = async () => {
      while (tasks.length) await tasks.shift()();
    };
    return {
      h,
      flush,
      ctx: {
        deps: h.deps,
        secret: secret(),
        gateway: backend.sheet,
        schedule: (task) => tasks.push(task),
        reportCache: createReportCache(),
      },
    };
  }

  const send = (ctx, input) => quiet(() => handleQuestionnaire(post(input), ctx));
  const limiterFor = () =>
    createDownloadLimiter(createSheetLedger(getBackend().newLedgerGateway()));
  const download = (h, limiter, body, offsetMs = 1_000) =>
    quiet(() =>
      handlePdfDownload(
        new Request('https://example.com/api/report/pdf', {
          method: 'POST',
          headers: { 'x-download-token': body.download.token },
          body: JSON.stringify(body.report),
        }),
        {
          secret: secret(),
          limiter,
          renderPdf: async () => Buffer.from('%PDF-1.4 abuse-test'),
          now: () => new Date(h.clock.t + offsetMs),
        },
      ),
    );
  const measure = async (fn) => {
    const { stats } = getBackend();
    const before = { ...stats };
    const started = Date.now();
    const result = await fn();
    return {
      result,
      reads: stats.reads - before.reads,
      writes: stats.writes - before.writes,
      ms: Date.now() - started,
    };
  };
  const rowsFor = async (email) => {
    const { sheet } = getBackend();
    const headersRow = await sheet.readHeaders();
    const col = headersRow.findIndex((h) => /^Correo/.test(h));
    const emails = await sheet.readColumn(col);
    const numbers = emails.flatMap((value, i) => (i > 0 && value === email ? [i + 1] : []));
    return numbers.length ? sheet.readRows(numbers, headersRow.length) : [];
  };
  const opts = { timeout: 15 * MIN };

  test(
    'SCENARIO 1: the 6th submission from one email is refused with a friendly 429, before any AI call',
    opts,
    async (t) => {
      const { h, ctx, flush } = context();
      const email = uniqueEmail();
      const costs = [];
      for (let n = 0; n < 5; n++) {
        h.clock.t += 11 * MIN; // outside the 10-minute duplicate window
        // Includes the post-response "Generado" status update, so the call count is complete.
        const m = await measure(async () => {
          const response = await send(ctx, submission({ email, answers: answersPattern(n) }));
          await flush();
          return response;
        });
        assert.equal(m.result.status, 200, `submission ${n + 1}`);
        costs.push(`${m.reads}r/${m.writes}w ${m.ms}ms`);
      }
      h.clock.t += 11 * MIN;
      const m6 = await measure(() => send(ctx, submission({ email, answers: answersPattern(9) })));
      const body = await m6.result.json();
      assert.equal(m6.result.status, 429);
      assert.equal(body.code, 'rate_limited');
      assert.match(body.error, /límite de 5 diagnósticos en 24 horas/);
      assert.equal(m6.result.headers.get('retry-after'), String(body.retryAfterSeconds));
      assert.match(m6.result.headers.get('cache-control') ?? '', /no-store/);
      assert.ok(!('report' in body) && !('download' in body));
      assert.equal(h.narrativeCalls.length, 5, 'the AI was never called for the 6th');
      assert.equal((await rowsFor(email)).length, 5, 'the 6th wrote no row');
      t.diagnostic(
        `Sheets calls per accepted submission: ${costs.join(' | ')}; refused 6th: ${m6.reads}r/${m6.writes}w ${m6.ms}ms`,
      );
      t.diagnostic(`429 message: "${body.error}"`);
    },
  );

  test(
    'SCENARIO 2: the window is rolling (a slot frees 24 hours after the oldest submission)',
    opts,
    async () => {
      const { h, ctx } = context();
      const email = uniqueEmail();
      const start = h.clock.t;
      for (let n = 0; n < 5; n++) {
        h.clock.t = start + n * 11 * MIN;
        assert.equal(
          (await send(ctx, submission({ email, answers: answersPattern(n) }))).status,
          200,
        );
      }
      h.clock.t = start + 24 * HOUR - 30_000;
      assert.equal(
        (await send(ctx, submission({ email, answers: answersPattern(9) }))).status,
        429,
      );
      h.clock.t = start + 24 * HOUR + 30_000;
      assert.equal(
        (await send(ctx, submission({ email, answers: answersPattern(9) }))).status,
        200,
      );
    },
  );

  test(
    'SCENARIO 3: concurrent submissions that race are ranked, exactly 5 succeed',
    opts,
    async (t) => {
      const { h, ctx } = context();
      const email = uniqueEmail();
      const attempts = Array.from({ length: 8 }, (_, n) =>
        submission({ email, answers: answersPattern(n + 20) }),
      );
      const m = await measure(() => Promise.all(attempts.map((a) => send(ctx, a))));
      const statuses = m.result.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
      assert.equal(h.narrativeCalls.length, 5, 'the AI ran only for the 5 winners');
      const rows = await rowsFor(email);
      assert.equal(rows.length, 8, 'every attempt left a row (nothing silently lost)');
      assert.equal(rows.filter((r) => r[4] === 'Rechazado por límite').length, 3);
      // A loser retrying its own id, or a new id with its answers, is still refused.
      const loser = attempts[m.result.findIndex((r) => r.status === 429)];
      assert.equal((await send(ctx, loser)).status, 429);
      h.clock.t += 60_000;
      assert.equal((await send(ctx, { ...loser, id: crypto.randomUUID() })).status, 429);
      t.diagnostic(`8 concurrent submissions: ${m.reads}r/${m.writes}w in ${m.ms}ms`);
    },
  );

  test(
    'SCENARIO 4: duplicates never call the AI, never get a different report and never extend the window',
    opts,
    async (t) => {
      const { h, flush, ctx } = context();
      const email = uniqueEmail();
      const input = submission({ email });
      const original = await (await send(ctx, input)).json();
      await flush();
      assert.equal(original.report.narrativeSource, 'ai');

      // (a) same instance: the identical report and grant, nothing regenerated.
      h.clock.t += 60_000;
      const retry = await (await send(ctx, input)).json();
      assert.equal(retry.duplicate, true);
      assert.deepEqual(retry.report, original.report);
      assert.equal(retry.download.token, original.download.token);
      assert.equal(retry.download.expiresInMs, original.download.expiresInMs - 60_000);

      // (b) a page refresh (new id, same answers) on an instance without the report: clear 409.
      const other = { ...ctx, reportCache: createReportCache() };
      const refreshed = await send(other, { ...input, id: crypto.randomUUID() });
      const refreshedBody = await refreshed.json();
      assert.equal(refreshed.status, 409);
      assert.equal(refreshedBody.code, 'duplicate_report_unavailable');
      assert.ok(!('report' in refreshedBody) && !('download' in refreshedBody));
      t.diagnostic(`409 (no report on this instance): "${refreshedBody.error}"`);

      // (c) after the 5-minute window: refused for everyone, cache or not.
      h.clock.t += 5 * MIN;
      const late = await send(ctx, { ...input, id: crypto.randomUUID() });
      assert.equal(late.status, 409);
      assert.equal((await late.json()).code, 'duplicate_window_over');

      // (d) after the 10-minute duplicate window it is a new submission.
      h.clock.t += 6 * MIN;
      const fresh = await send(ctx, { ...input, id: crypto.randomUUID() });
      assert.equal(fresh.status, 200);
      assert.equal((await fresh.json()).duplicate, false);

      assert.equal(
        h.narrativeCalls.length,
        2,
        'AI calls: the original and the genuinely new submission',
      );
      assert.equal((await rowsFor(email)).length, 2, 'no row was added by the duplicates');
    },
  );

  test(
    'SCENARIO 5: the 6th download of one report is refused; the spent budget then costs no Google call',
    opts,
    async (t) => {
      const { h, flush, ctx } = context();
      const body = await (await send(ctx, submission({ email: uniqueEmail() }))).json();
      await flush();
      const limiter = limiterFor();
      const costs = [];
      for (let i = 0; i < 5; i++) {
        const m = await measure(() => download(h, limiter, body, 1_000 + i));
        assert.equal(m.result.status, 200, `download ${i + 1}`);
        assert.equal(
          Buffer.from(await m.result.arrayBuffer())
            .subarray(0, 5)
            .toString(),
          '%PDF-',
        );
        costs.push(`${m.reads}r/${m.writes}w ${m.ms}ms`);
      }
      const m6 = await measure(() => download(h, limiter, body, 2_000));
      const err = await m6.result.json();
      assert.equal(m6.result.status, 429);
      assert.match(err.error, /límite de 5 descargas/);
      assert.match(m6.result.headers.get('cache-control') ?? '', /no-store/);
      assert.equal(m6.reads + m6.writes, 0, 'refused from memory: no Google call');
      // A different instance (cold) learns from the ledger, still refuses and renders nothing.
      const cold = await download(h, limiterFor(), body, 2_500);
      assert.equal(cold.status, 429);
      // The five-minute expiry still applies independently.
      assert.equal((await download(h, limiterFor(), body, 5 * MIN)).status, 410);

      const { tabExists, ledgerRows } = getBackend();
      assert.ok(
        await tabExists('Control de descargas'),
        'the ledger tab was created automatically',
      );
      const rows = await ledgerRows();
      const text = JSON.stringify(rows);
      assert.deepEqual(rows[0], ['Fecha (UTC)', 'Concesión de descarga']);
      assert.ok(rows.slice(1).every((r) => r.length === 2 && /^dl_[0-9a-f]{32}$/.test(r[1])));
      assert.ok(!text.includes(body.report.firstName) && !text.includes(body.download.token));
      t.diagnostic(
        `Sheets calls per delivered download: ${costs.join(' | ')}; 6th refused: ${m6.reads}r/${m6.writes}w`,
      );
      t.diagnostic(`429 message: "${err.error}"`);
    },
  );

  test(
    'SCENARIO 6: concurrent downloads across several instances deliver exactly 5',
    opts,
    async (t) => {
      const { h, flush, ctx } = context();
      const body = await (await send(ctx, submission({ email: uniqueEmail() }))).json();
      await flush();
      const instances = Array.from({ length: 3 }, limiterFor); // each with its own Google client
      const m = await measure(() =>
        Promise.all(Array.from({ length: 10 }, (_, i) => download(h, instances[i % 3], body))),
      );
      const statuses = m.result.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 200).length, 5, JSON.stringify(statuses));
      assert.equal(statuses.filter((s) => s === 429).length, 5);
      t.diagnostic(`10 parallel downloads over 3 instances: ${m.reads}r/${m.writes}w in ${m.ms}ms`);
    },
  );

  test(
    'SCENARIO 7: ambiguous write: Google saved the row, the client was told it failed (injected fault), the retry is a clean 409',
    opts,
    async (t) => {
      const { h, ctx } = context();
      const real = ctx.gateway;
      let injected = false;
      // Real storage, injected fault: the append REALLY happens, then the caller sees a quota error.
      ctx.gateway = new Proxy(real, {
        get(target, prop) {
          if (prop !== 'appendRow') return Reflect.get(target, prop, target)?.bind?.(target);
          return async (row) => {
            const result = await target.appendRow(row);
            if (!injected) {
              injected = true;
              const error = new Error('Quota exceeded (injected after a real append)');
              error.code = 429;
              throw error;
            }
            return result;
          };
        },
      });
      const email = uniqueEmail();
      const input = submission({ email });
      const first = await send(ctx, input);
      const firstBody = await first.json();
      assert.equal(first.status, 503);
      assert.equal(first.headers.get('retry-after'), '60');
      assert.equal(firstBody.code, 'service_busy');
      assert.equal(
        (await rowsFor(email)).length,
        1,
        'the row exists although the client saw an error',
      );
      assert.equal(h.narrativeCalls.length, 0, 'no report was generated');

      // Immediate retry with the same id, then a fresh attempt with the same answers.
      h.clock.t += 30_000;
      const retry = await send(ctx, input);
      const retryBody = await retry.json();
      assert.equal(retry.status, 409);
      assert.equal(retryBody.code, 'duplicate_report_unavailable');
      const refreshed = await send(ctx, { ...input, id: crypto.randomUUID() });
      assert.equal(refreshed.status, 409);
      assert.equal((await rowsFor(email)).length, 1, 'neither retry added a row');
      assert.equal(h.narrativeCalls.length, 0, 'and neither called the AI');

      // After the 10-minute duplicate window the person can resubmit: a new row, a new report.
      h.clock.t += 10 * MIN;
      const again = await send(ctx, { ...input, id: crypto.randomUUID() });
      assert.equal(again.status, 200);
      assert.equal((await rowsFor(email)).length, 2);
      t.diagnostic(`first: ${first.status} "${firstBody.error}"`);
      t.diagnostic(`retry: ${retry.status} "${retryBody.error}"`);
    },
  );
}
