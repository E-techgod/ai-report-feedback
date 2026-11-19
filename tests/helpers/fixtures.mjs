import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { questionIds } from '../../src/lib/questions.ts';
import { buildFinalReport, submissionFingerprint } from '../../src/lib/final-report.ts';
import { fallbackNarrative, buildReportModel } from '../../src/lib/report.ts';
import { createStore } from '../../src/lib/store.ts';

export const answersOf = (yesIds) =>
  Object.fromEntries(questionIds.map((id) => [id, yesIds.includes(id)]));
export const SAMPLE_YES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5'];

export async function freshStore() {
  const db = new PGlite();
  await db.exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  const store = createStore(async (text, params = []) => (await db.query(text, params)).rows);
  return Object.assign(store, { raw: (text, params = []) => db.query(text, params) });
}

export function sampleReport({
  yes = SAMPLE_YES,
  source = 'template',
  bookingUrl = 'https://example.com/cita',
  now = new Date('2026-11-18T15:00:00Z'),
} = {}) {
  const answers = answersOf(yes);
  const model = buildReportModel(answers);
  return buildFinalReport({
    reportId: randomUUID(),
    submissionId: randomUUID(),
    firstName: 'Prueba',
    answers,
    outcome: {
      narrative: fallbackNarrative(model),
      source,
      failureReason: source === 'ai' ? null : 'timeout',
    },
    bookingUrl,
    now,
  });
}

export const fingerprintOf = (email, yes = SAMPLE_YES) =>
  submissionFingerprint(email, answersOf(yes));
