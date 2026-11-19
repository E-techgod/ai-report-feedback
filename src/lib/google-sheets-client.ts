import { google } from 'googleapis';
import type { LedgerGateway } from './download-ledger';
import { columnLetter } from './sheet-schema';
import { SHEET_TAB, type SheetCell, type SheetsGateway } from './sheets';

const REQUEST_TIMEOUT_MS = 10_000;
const tab = `'${SHEET_TAB}'`;

/** Env files often store the key quoted and with literal "\n" sequences. */
export function normalizePrivateKey(raw: string): string {
  return raw.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
}

function googleSheetsClient() {
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

/**
 * Row number of an append, from the A1 range Google reports, e.g. `'Control de descargas'!A42:B42`
 * (or `Sheet1!A7` for a single cell). 0 when the range cannot be understood.
 */
export function appendedRowNumber(range: string | null | undefined): number {
  const match = /!\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?$/.exec(range ?? '');
  return match ? Number(match[2] ?? match[1]) : 0;
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
  const options = { timeout: REQUEST_TIMEOUT_MS };

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

export function createGoogleSheetsGateway(): SheetsGateway | null {
  const client = googleSheetsClient();
  if (!client) return null;
  const { spreadsheetId, sheets } = client;
  const options = { timeout: REQUEST_TIMEOUT_MS };
  const timed = (timeoutMs?: number) => ({
    timeout: Math.min(REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs ?? REQUEST_TIMEOUT_MS))),
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
