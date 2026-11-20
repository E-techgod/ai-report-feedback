import test from 'node:test';
import assert from 'node:assert/strict';
import { errorFacts, sanitizeFields } from '../src/lib/security-log.ts';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { issueDownloadGrant } from '../src/lib/download-grant.ts';
import { sampleReport } from './helpers/fixtures.mjs';
import { T0, submission } from './helpers/flow-harness.mjs';
import { freshLimiter } from './helpers/ledger.mjs';
import { SECRET, post, questionnaireContext } from './helpers/sheet-gateway.mjs';

const EMAIL = 'persona.sensible@example.test';
const NAME = 'Zoilo';
const LAST = 'Quintanilla';
// An error message that embeds everything an operator must never see in a log.
const poisoned = (extra = {}) =>
  Object.assign(
    new Error(
      `Invalid value '${EMAIL}' at range 'Respuestas'!A9 for ${NAME} ${LAST} token=abc.def`,
    ),
    extra,
  );

async function everyLog(fn) {
  const lines = [];
  const saved = ['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, console[k]]);
  for (const [k] of saved) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) console[k] = v;
  }
  return lines;
}
const noLeak = (lines, label) => {
  const text = lines.join('\n');
  for (const secret of [EMAIL, 'sensible', NAME, LAST, 'Respuestas', 'token=abc', 'Invalid value'])
    assert.ok(!text.includes(secret), `${label}: leaked "${secret}"`);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `${label}: not structured`);
};
const events = (lines) => lines.map((l) => JSON.parse(l));
const input = () => submission({ email: EMAIL, firstName: NAME, lastName: LAST });

test('errorFacts keeps the class and code of an error and never its text', () => {
  assert.deepEqual(errorFacts(poisoned({ code: 429 })), { cause: 'Error', code: 429 });
  assert.deepEqual(errorFacts({ name: 'GaxiosError', response: { status: 403 } }), {
    cause: 'GaxiosError',
    code: 403,
  });
  assert.deepEqual(errorFacts('just a string'), {});
  assert.deepEqual(errorFacts(null), {});
  // Even if a hostile name or code reaches the logger, the allow-list redacts it.
  assert.equal(sanitizeFields({ cause: `Error ${EMAIL}` }).cause, '[redacted]');
  assert.equal(sanitizeFields({ code: EMAIL }).code, '[redacted]');
});

test('a failed Sheets write logs reason, class and code only (no error text)', async () => {
  for (const code of [429, 404, 'ETIMEDOUT', undefined]) {
    const { sheet, ctx } = questionnaireContext();
    sheet.batchRead = async () => {
      throw poisoned({ code });
    };
    const lines = await everyLog(() => handleQuestionnaire(post(input()), ctx));
    noLeak(lines, `write failed (${code})`);
    const event = events(lines).find((e) => e.event === 'sheets_unavailable');
    assert.equal(event.cause, 'Error');
    if (code !== undefined) assert.equal(String(event.code), String(code));
  }
});

test('saved-but-unconfirmed logs the cause class and code only', async () => {
  const { sheet, ctx } = questionnaireContext();
  const realAppend = sheet.appendRow.bind(sheet);
  const realRead = sheet.batchRead.bind(sheet);
  let armed = false;
  sheet.appendRow = async (row) => {
    const result = await realAppend(row);
    armed = true;
    return result;
  };
  sheet.batchRead = async (ranges) => {
    if (armed) throw poisoned({ code: 'ECONNRESET' });
    return realRead(ranges);
  };
  const lines = await everyLog(() => handleQuestionnaire(post(input()), ctx));
  noLeak(lines, 'saved_unconfirmed');
  const event = events(lines).find((e) => e.outcome === 'saved_unconfirmed');
  assert.deepEqual([event.reason, event.code], ['timeout', 'ECONNRESET']);
});

test('a failed report generation logs a structured error event without its message', async () => {
  const { ctx } = questionnaireContext({
    narrative: async () => {
      throw poisoned();
    },
  });
  const lines = await everyLog(() => handleQuestionnaire(post(input()), ctx));
  noLeak(lines, 'generation failed');
  const event = events(lines).find((e) => e.event === 'report_generation_failed');
  assert.match(event.subject, /^[0-9a-f]{10}$/);
  assert.equal(event.cause, 'Error');
});

test('a failed "Generado" update and a failed scheduler log structured events only', async () => {
  const failing = questionnaireContext();
  failing.sheet.writeCells = async () => {
    throw poisoned({ code: 429 });
  };
  let lines = await everyLog(async () => {
    await handleQuestionnaire(post(input()), failing.ctx);
    await failing.flush();
  });
  noLeak(lines, 'status update');
  assert.equal(events(lines).find((e) => e.event === 'status_update_failed').reason, 'quota');

  const noScheduler = questionnaireContext();
  noScheduler.ctx.schedule = () => {
    throw poisoned();
  };
  lines = await everyLog(() => handleQuestionnaire(post(input()), noScheduler.ctx));
  noLeak(lines, 'scheduler');
  assert.equal(
    events(lines).find((e) => e.event === 'status_update_failed').reason,
    'schedule_failed',
  );
});

test('a failed PDF render logs a coarse reason and class, never the message or the report', async () => {
  for (const [message, reason] of [
    [`Cannot find module 'x' while rendering ${NAME}`, 'missing_asset'],
    [`bad value ${EMAIL} ${LAST}`, 'render_error'],
  ]) {
    const report = sampleReport();
    const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
    const lines = await everyLog(() =>
      handlePdfDownload(
        new Request('https://x.test/api/report/pdf', {
          method: 'POST',
          headers: { 'x-download-token': token },
          body: JSON.stringify(report),
        }),
        {
          secret: SECRET,
          limiter: freshLimiter().limiter,
          now: () => new Date(T0 + 1_000),
          renderPdf: async () => {
            throw new Error(message);
          },
        },
      ),
    );
    const text = lines.join('\n');
    assert.ok(!text.includes(EMAIL) && !text.includes(NAME) && !text.includes(LAST), message);
    assert.ok(!text.includes(report.firstName));
    const event = events(lines).find((e) => e.event === 'pdf_render_failed');
    assert.deepEqual([event.reason, event.cause], [reason, 'Error']);
  }
});

test('no unstructured console call in src prints an error message', async () => {
  const { execFileSync } = await import('node:child_process');
  const found = execFileSync(
    'git',
    ['grep', '-nE', 'console\\.(log|info|warn|error)', '--', 'src'],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  // Allowed: the structured logger, the fixed configuration message, the AI client's categorical
  // failure reason, and its privacy-safe metadata diagnostic. Other calls use logSecurityEvent.
  const unexpected = found.filter(
    (line) =>
      !/src\/lib\/security-log\.ts/.test(line) &&
      !/missing configuration \(report secret or Google Sheets\)/.test(line) &&
      !/\[narrative\] AI share above limit/.test(line) &&
      !/\[narrative\] attempt \$\{n\}\/\$\{maxAttempts\} failed: \$\{reason\}/.test(line) &&
      !/src\/lib\/narrative\.ts:.*console\.info\(/.test(line),
  );
  assert.deepEqual(unexpected, []);
});
