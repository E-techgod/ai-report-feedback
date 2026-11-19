# Sheet tracking and legacy email cutover (prepared, not activated)

This branch is based on `main`. Draft PR #6, including commit `83e55cc`, remains open and supplies
the concise Resend email and the full legacy migration analysis in `docs/report-email.md`. Merge or
rebase that PR separately; this branch does not copy its email content changes.

## Live header audit (read-only, 18 November 2026)

The spreadsheet `Check up "Descubre si estás Protegido ABRIL 2026 (Respuestas)` has response tab
`Respuestas de formulario 1` (`sheetId` 1107862417). Its first row has:

| Group                 | Exact headers, in observed order                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity              | `Marca temporal`, `Nombre`, `Apellido*`, `Correo*`                                                                                                                                                            |
| Report/email tracking | `Estado Reporte`, `Estado Email`, `Estado Descarga PDF`, `Estado Descarga CSV`, `Fecha Generación`, `Fecha Envío`, `Fecha Descarga PDF`, `Fecha Descarga CSV`, `Último Error`, `ID Reporte`, `Intentos Email` |
| Questionnaire         | Ten `A)` headers followed by ten `B)` headers; the first question is now column P                                                                                                                             |

`Total Reportes` and `Total Emails` were **not** present in that header row. The code writes those
as idempotent per-report values (1 after creation; 1 after provider acceptance) only when the
headers exist. It does not add columns to the live Sheet. Confirm the intended names and placement
before expecting counters to appear there. `Estado Descarga CSV` and its date remain untouched
because the app has no CSV download route.

The app reads headers for every append and tracking sync. Missing or duplicate required headers
stop the write. It appends a full row with blank tracking cells, then links the confirmed row number
to the report in Neon. A sync checks the row's email, all 20 answers via the persisted fingerprint,
and any existing `ID Reporte` before writing tracking cells. It never rewrites answers. Neon is the
source of truth; web report, PDF download, and email attachment all read the same hashed, stored
`FinalReport`. The Sheet is a projection of status, not a second report store.

Tracking updates use a per-report database lease and a version. Failed projections remain unsynced
and the daily cron retries up to 25 rows within a 12-second budget. Each Sheet counter is assigned
from persisted state, never incremented. `Fecha Envío` means Resend accepted the message, while
`Estado Email=Entregado` requires its signed webhook. `Descarga iniciada` means the PDF was rendered
for an authorized HTTP response; the server cannot prove the browser saved the file.

## Migration artifacts and order

**Nothing here has been applied to Apps Script, Neon production, Google Sheets, Resend, or Vercel.**
`REPORT_EMAIL_ENABLED=false` remains in `.env.example`; no customer email was sent.

1. Review the installed Apps Script triggers and executions, and determine whether the Google Form
   still accepts submissions. Form-only respondents have no Neon report; turning off legacy email
   without a replacement would leave them without mail. Record the existing Dashboard sent flags,
   including pre-marked rows 14–18 described in PR #6.
2. After human approval, paste the three lines in
   `scripts/legacy-email-kill-switch.gs` immediately inside the existing
   `enviarCorreosPendientes()` function. It is default-off unless the Script Property
   `LEGACY_EMAIL_ENABLED` is exactly `true`. Do not install
   `scripts/apps-script-safe-email-trigger.gs`; it is a dangerous trigger draft.
3. Run the idempotent `db/schema.sql` migration on an isolated Neon branch and verify the app there.
   Production migration is a separate manual action. Existing reports have no linked Sheet row and
   are **not** automatically backfilled or re-queued; guessing a historical row could overwrite data.
4. In a quiet, approved cutover window, set `LEGACY_EMAIL_ENABLED` off first. Only after the legacy
   path is confirmed stopped, set `REPORT_EMAIL_ENABLED=true` in production. The master switch now
   also blocks queued sends and the cron while false.
5. Review every disabled Neon report created during the gap against legacy delivery records. Put
   **only** approved, never-emailed report UUIDs in a newline-delimited IDs file. Run
   `scripts/requeue-disabled-reports.ts --ids-file <file> --since <ISO> --until <ISO>` as a dry run.
   It rejects unlinked, attempted, accepted, expired, or out-of-window records and changes nothing.
   Following explicit production approval, add `--apply --legacy-off-confirmed
--legacy-delivery-audited`. The script only changes `disabled` to `pending`; delivery uses the
   existing atomic claim and `report-email/<id>` idempotency key. A repeated run skips already
   queued IDs. Reports older than 47 hours require a separate reviewed plan.
6. Verify a preview send to a controlled address using a copied Sheet and Neon branch, then verify
   the webhook and attached PDF. No such send was run here. For rollback, turn Resend off first,
   mark legacy Dashboard rows already accepted by Resend as sent, and only then re-enable legacy.

## Remaining risks and manual review

- The live header row lacks both total counters. Their spelling and meaning need confirmation before
  a production Sheet edit. The implementation tolerates their absence.
- `sheet_row_number` can become stale if someone sorts, deletes, or inserts response rows. The sync
  refuses a mismatched row and stays pending; an operator must relink it after review.
- Google Sheets is not transactional with Neon. A successfully persisted report may appear late in
  Sheets if the API is unavailable; the cron reconciles it later. A missed daily cron can delay it.
- Reports created before this change have no safe row link. No automatic historical backfill is
  attempted. The one historical pending Form row is left alone.
- The legacy function's installed triggers and actual execution type remain unverified. Duplicate
  delivery cannot be ruled out until the manual audit and kill switch are complete.
- Run the database migration before deploying this branch; the new store queries require the added
  columns. No migration or production deployment was performed here.
