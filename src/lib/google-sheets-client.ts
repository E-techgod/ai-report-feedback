import { google } from 'googleapis';
import type { LedgerGateway } from './download-ledger';
import { columnLetter } from './sheet-schema';
import {
  SHEET_TAB,
  appendedRowNumber,
  type SheetCell,
  type SheetRange,
  type SheetsGateway,
} from './sheets';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The Google client retries GET/PUT requests 3 times by default, including on 429 (quota). Quotas are
 * per minute, so a retry 100-400 ms later cannot succeed; it only multiplies the load (a failed read
 * becomes 4 requests) while the quota is exhausted. 429 is therefore NOT retried: the app fails fast
 * (503 + Retry-After) and the person retries. Timeouts and 5xx keep the default retries.
 */
const RETRY: { retryConfig: { statusCodesToRetry: number[][] } } = {
  retryConfig: {
    statusCodesToRetry: [
      [100, 199],
      [408, 408],
      [500, 599],
    ],
  },
};
const tab = `'${SHEET_TAB}'`;

/** Env files often store the key quoted and with literal "\n" sequences. */
export function normalizePrivateKey(raw: string): string {
  return raw.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
}

export type GoogleSheetsClient = NonNullable<ReturnType<typeof googleSheetsClient>>;

export function googleSheetsClient() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) return null;

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: normalizePrivateKey(privateKey),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return { spreadsheetId, sheets: google.sheets({ version: 'v4', auth }) };
}

export { appendedRowNumber };

/** A1 notation of one batched range in the response tab. */
export function rangeA1(range: SheetRange): string {
  if (range.kind === 'headers') return `${tab}!1:1`;
  if (range.kind === 'column') {
    const letter = columnLetter(range.index);
    return `${tab}!${letter}:${letter}`;
  }
  return range.width
    ? `${tab}!A${range.row}:${columnLetter(range.width - 1)}${range.row}`
    : `${tab}!${range.row}:${range.row}`;
}

/** Name of the ledger tab that counts delivered PDF downloads (see download-ledger.ts). */
export const LEDGER_TAB = 'Control de descargas';
const ledgerTab = `'${LEDGER_TAB}'`;

/**
 * Google implementation of the download ledger. The tab is created on first use if it does not
 * exist (idempotent); it holds only a UTC timestamp and an opaque keyed hash per delivered PDF.
 */
export function createGoogleLedgerGateway(): LedgerGateway | null {
  const client = googleSheetsClient();
  if (!client) return null;
  const { spreadsheetId, sheets } = client;
  const options = { timeout: REQUEST_TIMEOUT_MS, ...RETRY };

  const titleExists = async () => {
    const { data } = await sheets.spreadsheets.get(
      { spreadsheetId, fields: 'sheets.properties.title' },
      options,
    );
    return (data.sheets ?? []).some((sheet) => sheet.properties?.title === LEDGER_TAB);
  };

  let ready: Promise<void> | undefined;
  const ensureTab = () => {
    ready ??= (async () => {
      if (await titleExists()) return;
      try {
        await sheets.spreadsheets.batchUpdate(
          {
            spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title: LEDGER_TAB } } }] },
          },
          options,
        );
        await sheets.spreadsheets.values.update(
          {
            spreadsheetId,
            range: `${ledgerTab}!A1:B1`,
            valueInputOption: 'RAW',
            requestBody: { values: [['Fecha (UTC)', 'Concesión de descarga']] },
          },
          options,
        );
      } catch (error) {
        // Another instance may have created it a moment ago: that is fine.
        if (!(await titleExists())) throw error;
      }
    })().catch((error) => {
      ready = undefined; // retry on the next request
      throw error;
    });
    return ready;
  };

  return {
    async append(row) {
      await ensureTab();
      const { data } = await sheets.spreadsheets.values.append(
        {
          spreadsheetId,
          range: `${ledgerTab}!A:B`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [row] },
        },
        options,
      );
      // e.g. 'Control de descargas'!A42:B42 -> 42
      const rowNumber = appendedRowNumber(data.updates?.updatedRange);
      if (!rowNumber) throw new Error('Download ledger did not report the appended row');
      return rowNumber;
    },

    async readKeys(upToRow) {
      const { data } = await sheets.spreadsheets.values.get(
        { spreadsheetId, range: `${ledgerTab}!B1:B${upToRow}` },
        options,
      );
      return (data.values ?? []).map((row) => String(row[0] ?? ''));
    },
  };
}

/** `client` can be injected (tests point it at a local server to count real HTTP requests). */
export function createGoogleSheetsGateway(
  client: GoogleSheetsClient | null = googleSheetsClient(),
): SheetsGateway | null {
  if (!client) return null;
  const { spreadsheetId, sheets } = client;
  const options = { timeout: REQUEST_TIMEOUT_MS, ...RETRY };
  const timed = (timeoutMs?: number) => ({
    timeout: Math.min(REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs ?? REQUEST_TIMEOUT_MS))),
    ...RETRY,
  });
  let timeZone: string | undefined;

  return {
    async getTimeZone(timeoutMs) {
      if (timeZone) return timeZone;
      const { data } = await sheets.spreadsheets.get(
        { spreadsheetId, fields: 'properties.timeZone' },
        timed(timeoutMs),
      );
      timeZone = data.properties?.timeZone ?? undefined;
      if (!timeZone) throw new Error('Spreadsheet time zone unavailable');
      return timeZone;
    },

    async readHeaders(timeoutMs) {
      const { data } = await sheets.spreadsheets.values.get(
        { spreadsheetId, range: `${tab}!1:1` },
        timed(timeoutMs),
      );
      return (data.values?.[0] ?? []).map((value) => String(value ?? ''));
    },

    async readColumn(index, timeoutMs) {
      const letter = columnLetter(index);
      const { data } = await sheets.spreadsheets.values.get(
        { spreadsheetId, range: `${tab}!${letter}:${letter}` },
        timed(timeoutMs),
      );
      return (data.values ?? []).map((row) => String(row[0] ?? ''));
    },

    async batchRead(ranges, timeoutMs) {
      // ONE values.batchGet request for every range: Google counts requests, not ranges.
      const { data } = await sheets.spreadsheets.values.batchGet(
        {
          spreadsheetId,
          ranges: ranges.map(rangeA1),
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER',
        },
        timed(timeoutMs),
      );
      const valueRanges = data.valueRanges ?? [];
      if (valueRanges.length !== ranges.length)
        throw new Error('Google Sheets returned fewer ranges');
      return valueRanges.map((range) => (range.values ?? []) as SheetCell[][]);
    },

    async readRows(rowNumbers, width, timeoutMs) {
      const { data } = await sheets.spreadsheets.values.batchGet(
        {
          spreadsheetId,
          ranges: rowNumbers.map((n) => `${tab}!A${n}:${columnLetter(width - 1)}${n}`),
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER',
        },
        timed(timeoutMs),
      );
      return (data.valueRanges ?? []).map((range) => (range.values?.[0] ?? []) as SheetCell[]);
    },

    async appendRow(row) {
      const { data } = await sheets.spreadsheets.values.append(
        {
          spreadsheetId,
          range: `${tab}!A:${columnLetter(row.length - 1)}`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [row] },
        },
        options,
      );
      return {
        updatedRows: data.updates?.updatedRows ?? 0,
        updatedCells: data.updates?.updatedCells ?? 0,
        updatedRange: data.updates?.updatedRange ?? '',
      };
    },

    async writeCells(rowNumber, cells, timeoutMs) {
      const { data } = await sheets.spreadsheets.values.batchUpdate(
        {
          spreadsheetId,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: cells.map(({ index, value }) => ({
              range: `${tab}!${columnLetter(index)}${rowNumber}`,
              values: [[value]],
            })),
          },
        },
        timed(timeoutMs),
      );
      return data.totalUpdatedCells ?? 0;
    },
  };
}
