import { google } from 'googleapis';
import { columnLetter } from './sheet-schema';
import { SHEET_TAB, type SheetCell, type SheetsGateway } from './sheets';

const REQUEST_TIMEOUT_MS = 10_000;
const tab = `'${SHEET_TAB}'`;

/** Env files often store the key quoted and with literal "\n" sequences. */
export function normalizePrivateKey(raw: string): string {
  return raw.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
}

export function createGoogleSheetsGateway(): SheetsGateway | null {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) return null;

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: normalizePrivateKey(privateKey),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
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

    async readDashboardEmailState(rowNumber) {
      const { data } = await sheets.spreadsheets.values.get(
        {
          spreadsheetId,
          range: `'Dashboard'!B${rowNumber}:H${rowNumber}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        },
        options,
      );
      const row = data.values?.[0] ?? [];
      return { email: String(row[0] ?? ''), status: String(row[6] ?? '') };
    },
  };
}
