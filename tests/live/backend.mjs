import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fakeLedgerGateway } from '../helpers/ledger.mjs';
import { fakeSheet, headers } from '../helpers/sheet-gateway.mjs';

/**
 * Two interchangeable backends for the abuse-protection scenarios (tests/live/scenarios.mjs):
 *  - fake: in-memory sheet + ledger (runs inside `npm test`, proves the scenarios themselves);
 *  - live: a REAL, isolated Google spreadsheet (opt-in: `npm run test:live`, see docs/live-testing.md).
 * Both expose the same shape and count Sheets calls so quota use can be measured.
 */
const READS = new Set(['getTimeZone', 'readHeaders', 'readColumn', 'readRows', 'readKeys']);

function counted(gateway, stats, throttle) {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      if (!READS.has(prop) && !['appendRow', 'append', 'writeCells'].includes(prop))
        return value.bind(target);
      return async (...args) => {
        if (throttle) await throttle();
        stats[READS.has(prop) ? 'reads' : 'writes'] += 1;
        return value.apply(target, args);
      };
    },
  });
}

export function createFakeBackend() {
  const stats = { reads: 0, writes: 0 };
  const sheet = fakeSheet({ interleave: true });
  const ledger = fakeLedgerGateway();
  return {
    label: 'fake (in-memory)',
    live: false,
    stats,
    sheet: counted(sheet, stats),
    newLedgerGateway: () => counted(ledger, stats),
    async ledgerRows() {
      return ledger.rows;
    },
    async tabExists() {
      return true; // the fake ledger always "exists"
    },
    async setup() {},
    async teardown() {},
  };
}

/** Reads only the two Google credentials from an env file, never printing them. */
function credentialsFrom(file) {
  const wanted = ['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'];
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && wanted.includes(match[1])) out[match[1]] = match[2];
  }
  return out;
}

export async function createLiveBackend() {
  const log = (...a) => console.error('[live]', ...a);
  // 1) Credentials: from the environment, or the two keys of an env file. Everything else in that
  //    file (including the PRODUCTION spreadsheet id and any AI keys) is deliberately ignored.
  const file = process.env.LIVE_TEST_ENV_FILE;
  const creds = file ? credentialsFrom(file) : {};
  process.env.GOOGLE_CLIENT_EMAIL = creds.GOOGLE_CLIENT_EMAIL ?? process.env.GOOGLE_CLIENT_EMAIL;
  process.env.GOOGLE_PRIVATE_KEY = creds.GOOGLE_PRIVATE_KEY ?? process.env.GOOGLE_PRIVATE_KEY;
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY)
    throw new Error(
      'Live tests need GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY (see docs/live-testing.md)',
    );
  // The app reads GOOGLE_SHEET_ID: never let a production id leak in from the shell or an env file.
  delete process.env.GOOGLE_SHEET_ID;

  const { google } = await import('googleapis');
  const { normalizePrivateKey } = await import('../../src/lib/google-sheets-client.ts');
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheetsApi = google.sheets({ version: 'v4', auth });
  const TAB = 'Respuestas de formulario 1';

  let spreadsheetId = process.env.LIVE_TEST_SHEET_ID;
  const creating = !spreadsheetId;
  if (creating) {
    const { data } = await sheetsApi.spreadsheets.create({
      requestBody: {
        properties: {
          title: `[TEST] bp-questionnaire abuse protection ${new Date().toISOString()}`,
        },
        sheets: [{ properties: { title: TAB } }],
      },
    });
    spreadsheetId = data.spreadsheetId;
    log('created isolated test spreadsheet', spreadsheetId);
  }

  // 2) HARD GUARD: only ever run against a spreadsheet explicitly titled "[TEST] ...".
  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: 'properties(title,timeZone),sheets.properties.title',
  });
  const title = meta.data.properties?.title ?? '';
  if (!title.startsWith('[TEST]'))
    throw new Error(`REFUSING to run: spreadsheet title "${title}" does not start with "[TEST]"`);
  process.env.GOOGLE_SHEET_ID = spreadsheetId;
  log('using', JSON.stringify(title), 'timeZone', meta.data.properties?.timeZone);

  if (!meta.data.sheets?.some((s) => s.properties?.title === TAB))
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TAB}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });

  // 3) Quota protection. The service account and Cloud project are shared with Production (Sheets
  //    allows ~60 reads/min per user per project), so every call goes through one global throttle.
  const perMinute = Number(process.env.LIVE_MAX_CALLS_PER_MIN ?? 30);
  const interval = 60_000 / perMinute;
  let next = 0;
  const throttle = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + interval;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
  const stats = { reads: 0, writes: 0 };
  const { createGoogleSheetsGateway, createGoogleLedgerGateway } =
    await import('../../src/lib/google-sheets-client.ts');
  log(`throttled to ${perMinute} Sheets calls/min`);

  return {
    label: `LIVE Google Sheets (${title})`,
    live: true,
    spreadsheetId,
    stats,
    sheet: counted(createGoogleSheetsGateway(), stats, throttle),
    newLedgerGateway: () => counted(createGoogleLedgerGateway(), stats, throttle),
    async ledgerRows() {
      const { data } = await sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: "'Control de descargas'!A:B",
      });
      return data.values ?? [];
    },
    async tabExists(name) {
      const { data } = await sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.title',
      });
      return (data.sheets ?? []).some((s) => s.properties?.title === name);
    },
    async setup() {},
    async teardown() {},
    secret: randomBytes(24).toString('hex'),
  };
}
