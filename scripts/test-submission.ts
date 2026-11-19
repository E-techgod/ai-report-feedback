/**
 * Controlled test submission for the Google Sheets integration.
 *
 * DRY RUN by default: reads live headers, builds and prints the mapped row, writes nothing.
 * To write ONE row to the real "Respuestas de formulario 1" tab you must pass --confirm.
 *
 *   node --env-file=.env --import tsx scripts/test-submission.ts --email test@example.com
 *   node --env-file=.env --import tsx scripts/test-submission.ts --email test@example.com --confirm
 *
 * Known answer set: A1–A6 = Si, A7–A10 = No, B1–B5 = Si, B6–B10 = No
 *   -> 11 Si / 9 No, protection 55% (Dashboard level "Bajo"), personal 60%, business 50%.
 *
 * WARNING: if a time-driven/onFormSubmit email workflow is active, the new row may trigger a
 * real email to --email. Use an address you control and pause the trigger first.
 */
import { randomUUID } from 'node:crypto';
import { questionIds } from '../src/lib/questions';
import { scoreAnswers } from '../src/lib/scoring';
import { submissionSchema } from '../src/lib/validation';
import { buildRow, saveSubmissionWithRow, wallClock, FALLBACK_TIME_ZONE } from '../src/lib/sheets';
import { columnLetter, parseSheetSchema } from '../src/lib/sheet-schema';
import { createGoogleSheetsGateway } from '../src/lib/google-sheets-client';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const email = value('email');
if (!email) {
  console.error('Missing --email <test address you control>');
  process.exit(1);
}

const yes = new Set(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5']);
const answers = Object.fromEntries(questionIds.map((id) => [id, yes.has(id)]));
const parsed = submissionSchema.safeParse({
  id: randomUUID(),
  firstName: 'PRUEBA',
  lastName: 'INTEGRACION',
  email,
  privacyAccepted: true,
  answers,
});
if (!parsed.success) {
  console.error('Invalid test submission:', parsed.error.issues.map((i) => i.message).join('; '));
  process.exit(1);
}
const testSubmission = parsed.data;

const gateway = createGoogleSheetsGateway();
if (!gateway) {
  console.error('Google credentials are not configured.');
  process.exit(1);
}
async function main() {
  const schema = parseSheetSchema(await gateway!.readHeaders());
  const score = scoreAnswers(testSubmission.answers);
  const row = buildRow(testSubmission, wallClock(new Date(), FALLBACK_TIME_ZONE).text, schema);
  console.log('Expected score:', {
    yes: score.yes,
    no: score.no,
    protection: score.protection,
    personal: score.personalPercent,
    business: score.businessPercent,
    category: score.category,
  });
  console.log('Row to append:');
  console.log(row.map((v, i) => `${columnLetter(i)}=${v}`).join(' | '));
  if (!flag('confirm')) {
    console.log('\nDRY RUN — nothing was written. Re-run with --confirm to append this one row.');
    return;
  }
  const result = await saveSubmissionWithRow(gateway!, testSubmission);
  console.log(`\nResult: ${result.status}, row ${result.rowNumber}`);
}
main()
  .catch((error: unknown) => {
    console.error('Write failed:', error instanceof Error ? error.message.slice(0, 200) : 'unknown');
    process.exit(1);
  });
