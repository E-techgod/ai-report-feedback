import { questionIds } from './questions';

/** Header names observed in the live response tab on 2026-11-18. Never infer positions from them. */
export const TRACKING_HEADERS = {
  reportStatus: 'Estado Reporte',
  emailStatus: 'Estado Email',
  pdfStatus: 'Estado Descarga PDF',
  csvStatus: 'Estado Descarga CSV',
  generatedAt: 'Fecha Generación',
  sentAt: 'Fecha Envío',
  pdfDownloadedAt: 'Fecha Descarga PDF',
  csvDownloadedAt: 'Fecha Descarga CSV',
  lastError: 'Último Error',
  reportId: 'ID Reporte',
  emailAttempts: 'Intentos Email',
  // Optional future columns: absent from the live header row at audit time.
  totalReports: 'Total Reportes',
  totalEmails: 'Total Emails',
} as const;

export type SheetSchema = {
  headers: string[];
  timestamp: number;
  firstName: number;
  lastName: number;
  email: number;
  questions: Record<string, number>;
  tracking: Partial<Record<keyof typeof TRACKING_HEADERS, number>>;
};

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function columnLetter(index: number): string {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/** Fail closed if a required field is absent or ambiguous; writing to a shifted column is worse. */
export function parseSheetSchema(headers: string[]): SheetSchema {
  const byName = new Map<string, number>();
  headers.forEach((header, index) => {
    const key = fold(header);
    if (!key) return;
    if (byName.has(key)) throw new Error(`Duplicate spreadsheet header: ${header}`);
    byName.set(key, index);
  });
  const required = (name: string) => {
    const index = byName.get(fold(name));
    if (index === undefined) throw new Error(`Missing spreadsheet header: ${name}`);
    return index;
  };
  const questions: Record<string, number> = {};
  headers.forEach((header, index) => {
    const match = header.match(/^\s*([AB])\)\s*(\d{1,2})\s*[.:-]/i);
    if (!match) return;
    const id = `${match[1].toUpperCase()}${Number(match[2])}`;
    if (!questionIds.includes(id)) return;
    if (questions[id] !== undefined) throw new Error(`Duplicate question header: ${id}`);
    questions[id] = index;
  });
  for (const id of questionIds) {
    if (questions[id] === undefined) throw new Error(`Missing question header: ${id}`);
  }
  const tracking: SheetSchema['tracking'] = {};
  for (const [key, name] of Object.entries(TRACKING_HEADERS)) {
    const index = byName.get(fold(name));
    if (index !== undefined) tracking[key as keyof typeof TRACKING_HEADERS] = index;
  }
  return {
    headers,
    timestamp: required('Marca temporal'),
    firstName: required('Nombre'),
    lastName: required('Apellido*'),
    email: required('Correo*'),
    questions,
    tracking,
  };
}
