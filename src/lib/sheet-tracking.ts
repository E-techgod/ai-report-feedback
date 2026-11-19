import { questionIds } from './questions';
import { submissionFingerprint } from './final-report';
import { parseSheetSchema, type SheetSchema } from './sheet-schema';
import { cleanText, escapeCell, normalizeEmail, wallClock, type SheetsGateway } from './sheets';
import type { EmailStatus, ReportRecord, ReportStore } from './store';

const EMAIL_LABELS: Record<EmailStatus, string> = {
  disabled: 'Desactivado',
  pending: 'Pendiente',
  sending: 'Enviando',
  accepted: 'Aceptado',
  delivered: 'Entregado',
  failed: 'Error temporal',
  failed_final: 'Error final',
  bounced: 'Rebotado',
  complained: 'Queja',
};

function foldAnswer(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function trackingCells(record: ReportRecord, schema: SheetSchema, timeZone: string) {
  const cells: Array<{ index: number; value: string | number }> = [];
  const put = (field: keyof SheetSchema['tracking'], value: string | number) => {
    const index = schema.tracking[field];
    if (index !== undefined) cells.push({ index, value });
  };
  const date = (value: Date | null) => (value ? wallClock(value, timeZone).text : '');
  put('reportStatus', 'Generado');
  put('emailStatus', EMAIL_LABELS[record.emailStatus]);
  put('pdfStatus', record.pdfDownloadedAt ? 'Descarga iniciada' : 'Pendiente');
  put('generatedAt', date(new Date(record.report.generatedAt)));
  put('sentAt', date(record.emailAcceptedAt));
  put('pdfDownloadedAt', date(record.pdfDownloadedAt));
  put('lastError', escapeCell(cleanText(record.emailLastError ?? '', 200)));
  put('reportId', record.id);
  put('emailAttempts', record.emailAttempts);
  return cells;
}

async function reportRowNumber(
  gateway: SheetsGateway,
  reportIdColumn: number,
  record: ReportRecord,
  timeoutMs?: number,
): Promise<number> {
  const ids = await gateway.readColumn(reportIdColumn, timeoutMs);
  const reportRows: number[] = [];
  const submissionRows: number[] = [];
  ids.forEach((value, index) => {
    if (index === 0) return;
    if (value === record.id) reportRows.push(index + 1);
    if (value === `submission:${record.submissionId}`) submissionRows.push(index + 1);
  });
  if (
    reportRows.length > 1 ||
    submissionRows.length > 1 ||
    (reportRows.length && submissionRows.length)
  )
    throw new Error('Duplicate spreadsheet report identity');
  const found = reportRows[0] ?? submissionRows[0];
  if (!found) throw new Error('Spreadsheet report identity not found');
  return found;
}

/** Read-only proof of a report's current Sheet row, shared by sync and cutover audit. */
export async function findVerifiedReportRow(
  gateway: SheetsGateway,
  schema: SheetSchema,
  record: ReportRecord,
  timeLeft: () => number | undefined = () => undefined,
): Promise<number> {
  if (schema.tracking.reportId === undefined)
    throw new Error('Required report ID header is missing');
  const rowNumber = await reportRowNumber(gateway, schema.tracking.reportId, record, timeLeft());
  const row = (await gateway.readRows([rowNumber], schema.headers.length, timeLeft()))[0];
  if (!row || normalizeEmail(String(row[schema.email] ?? '')) !== normalizeEmail(record.email))
    throw new Error('Spreadsheet row email does not match the persisted report');
  const answers = Object.fromEntries(
    questionIds.map((id) => [id, foldAnswer(row[schema.questions[id]]) === 'si']),
  );
  if (
    questionIds.some((id) => !['si', 'no'].includes(foldAnswer(row[schema.questions[id]]))) ||
    submissionFingerprint(record.email, answers) !== record.fingerprint
  )
    throw new Error('Spreadsheet row answers do not match the persisted report');
  const currentId = String(row[schema.tracking.reportId] ?? '').trim();
  if (currentId !== record.id && currentId !== `submission:${record.submissionId}`)
    throw new Error('Spreadsheet row belongs to a different report');
  return rowNumber;
}

/** Sync one persisted report without touching answers, historical rows, or CSV fields. */
export async function syncReportTracking(
  store: ReportStore,
  gateway: SheetsGateway,
  reportId: string,
  budgetMs?: number,
): Promise<boolean> {
  const deadline = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
  const timeLeft = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Spreadsheet sync budget exhausted');
    return Number.isFinite(remaining) ? remaining : undefined;
  };
  const claimed = await store.claimSheetSync(reportId, new Date());
  if (!claimed) return false;
  try {
    const schema = parseSheetSchema(await gateway.readHeaders(timeLeft()));
    if (
      schema.tracking.reportId === undefined ||
      schema.tracking.reportStatus === undefined ||
      schema.tracking.emailStatus === undefined
    )
      throw new Error('Required report tracking headers are missing');
    const timeZone = await gateway.getTimeZone(timeLeft());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await store.getById(reportId);
      if (!record) return false;
      if (record.trackingVersion <= record.sheetSyncedVersion) return false;
      const rowNumber = await findVerifiedReportRow(gateway, schema, record, timeLeft);
      const cells = trackingCells(record, schema, timeZone);
      if (rowNumber !== record.sheetRowNumber) {
        await store.relinkSheetRow(record.id, record.sheetRowNumber, rowNumber);
        continue;
      }
      if ((await gateway.writeCells(rowNumber, cells, timeLeft())) !== cells.length)
        throw new Error('Google Sheets did not confirm the tracking write');
      if (await store.markSheetSynced(record.id, record.trackingVersion)) return true;
    }
    return false;
  } catch (error) {
    await store.deferSheetSync(reportId, claimed.sheetSyncLeaseUntil!, new Date());
    throw error;
  } finally {
    await store.releaseSheetSync(reportId, claimed.sheetSyncLeaseUntil!);
  }
}
