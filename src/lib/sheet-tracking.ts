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
  put('generatedAt', date(record.createdAt));
  put('sentAt', date(record.emailAcceptedAt));
  put('pdfDownloadedAt', date(record.pdfDownloadedAt));
  put('lastError', escapeCell(cleanText(record.emailLastError ?? '', 200)));
  put('reportId', record.id);
  put('emailAttempts', record.emailAttempts);
  // Per-report facts, not increments. Retried synchronization cannot inflate counters.
  put('totalReports', 1);
  put('totalEmails', record.emailAcceptedAt ? 1 : 0);
  return cells;
}

/** Sync one persisted report without touching answers, historical rows, or CSV fields. */
export async function syncReportTracking(
  store: ReportStore,
  gateway: SheetsGateway,
  reportId: string,
): Promise<boolean> {
  const claimed = await store.claimSheetSync(reportId, new Date());
  if (!claimed) return false;
  try {
    const schema = parseSheetSchema(await gateway.readHeaders());
    if (
      schema.tracking.reportId === undefined ||
      schema.tracking.reportStatus === undefined ||
      schema.tracking.emailStatus === undefined
    )
      throw new Error('Required report tracking headers are missing');
    const timeZone = await gateway.getTimeZone();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await store.getById(reportId);
      if (!record?.sheetRowNumber) return false;
      if (record.trackingVersion <= record.sheetSyncedVersion) return false;
      const row = (await gateway.readRows([record.sheetRowNumber], schema.headers.length))[0];
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
      if (currentId && currentId !== record.id)
        throw new Error('Spreadsheet row belongs to a different report');
      const cells = trackingCells(record, schema, timeZone);
      if ((await gateway.writeCells(record.sheetRowNumber, cells)) !== cells.length)
        throw new Error('Google Sheets did not confirm the tracking write');
      if (await store.markSheetSynced(record.id, record.trackingVersion)) return true;
    }
    return false;
  } finally {
    await store.releaseSheetSync(reportId, claimed.sheetSyncLeaseUntil!);
  }
}
