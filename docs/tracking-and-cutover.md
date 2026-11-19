# Sheet tracking and legacy email cutover (prepared, not activated)

PR #6 (including commit `83e55cc`) merged into `main` first. PR #7 now incorporates that merged
email summary and its tests while keeping the Sheet tracking and cutover safeguards. The recommended
code merge order is satisfied: #6, then #7 after the release gates below. Neither PR's merge
activates the legacy migration by itself; `REPORT_EMAIL_ENABLED=false` remains the default.

## Live header audit (read-only, 18 November 2026)

The spreadsheet `Check up "Descubre si estás Protegido ABRIL 2026 (Respuestas)` has response tab
`Respuestas de formulario 1` (`sheetId` 1107862417). Its first row has:

| Group                 | Exact headers, in observed order                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity              | `Marca temporal`, `Nombre`, `Apellido*`, `Correo*`                                                                                                                                                            |
| Report/email tracking | `Estado Reporte`, `Estado Email`, `Estado Descarga PDF`, `Estado Descarga CSV`, `Fecha Generación`, `Fecha Envío`, `Fecha Descarga PDF`, `Fecha Descarga CSV`, `Último Error`, `ID Reporte`, `Intentos Email` |
| Questionnaire         | Ten `A)` headers followed by ten `B)` headers; the first question is now column P                                                                                                                             |

`Total Reportes` and `Total Emails` were **not** present in that header row. Their definitions are
unknown, so the app does not write them even if those headers are added later. Define their scope,
formula, and ownership before implementing counters. The app does not add columns to the live Sheet.
`Estado Descarga CSV` and its date remain untouched because the app has no CSV download route.

The Dashboard score formula now references `P:AI`, so it follows the shifted questions. **Deployment
risk:** current `main` (merge commit `51ea080`, retaining the writer from `b9a99c5`) still appends
exactly 24 values into `A:X`, with answers
starting at `E`. Against the observed live 35-column Sheet, that places answer values in report/email
tracking fields `E:O`, only partially fills the real questions `P:AI`, and reads the wrong cells for
duplicate detection. This is a code and schema mismatch, not proof of a particular production
deployment or of affected rows. Audit the deployed commit and response rows before any release;
do not repair historical rows by positional guesswork. The reconstructed one-row legacy test helper
now resolves question headers, but the **installed** `enviarCorreosPendientes()` source and triggers
remain unavailable and must be audited separately.

The app reads headers for every append and tracking sync. Missing or duplicate required headers
stop the write. It appends a full row with `Estado Reporte=Pendiente` and a temporary
`submission:<uuid>` marker in `ID Reporte`; a retry can find that row even after the ten-minute
answer dedupe window. Once the report is stored, the app links the confirmed row number in Neon and
replaces the marker with the final report UUID. A sync checks the row's email, all 20 answers via the persisted fingerprint,
and any existing `ID Reporte` before writing tracking cells. It never rewrites answers. Neon is the
source of truth; web report, PDF download, and email attachment all read the same hashed, stored
`FinalReport`. The Sheet is a projection of status, not a second report store.

Google's `updatedCells` response counts cells updated; a row containing empty tracking placeholders
does not make equality with the header width a reliable success condition. The app confirms the
append by reading back its unique submission marker, email, and all answers. If Google wrote a row
but its response failed, a retry finds the marker instead of appending again.

Before append, a 90-second Neon lease keyed by the answer fingerprint lets only one serverless
request write the row. A concurrent request gets a retry response; after the lease is released it
finds the original row. This closes the cross-instance gap left by a process-local dedupe map.

Tracking updates resolve the unique `ID Reporte` value (or the initial `submission:<id>` marker),
verify email and all answers, and then refresh the row-number hint in Neon if the row moved. A reused
number cannot identify a different report. The database does not require row numbers to be unique.
Updates use a per-report lease and version. Failed projections receive exponential retry backoff,
and never-failed reports are scheduled before retries, so stale records do not repeatedly occupy the
first cron batch. The daily cron retries up to 25 due rows within a 12-second budget. The initial
Sheet projection runs after the HTTP response with an eight-second request budget.
`Fecha Envío` means Resend accepted the message, while
`Estado Email=Entregado` requires its signed webhook. `Descarga iniciada` means the PDF was rendered
for an authorized HTTP response; the server cannot prove the browser saved the file.
PDF download tracking is persisted in Neon before the PDF response; its Sheet projection runs after
the response. Resend webhook events are persisted before acknowledgment, and their Sheet projection
runs after acknowledgment. The daily cron sends within a 25-second email budget without per-email
Sheet calls, then uses a separate tracking window capped by an absolute 52-second work deadline.
The 60-second route leaves eight seconds for cleanup and response, though one slow in-flight send
can overrun its soft email budget. Throughput under real PDF/Resend latency has not been measured.

## Migration artifacts and order

**Nothing here has been applied to Apps Script, Neon production, Google Sheets, Resend, or Vercel.**
`REPORT_EMAIL_ENABLED=false` remains in `.env.example`; no customer email was sent.

1. Audit the deployed production commit before accepting more app submissions. `main`'s old `A:X`
   writer cannot match the live shifted Sheet. Confirm whether production currently runs that code;
   if it does, stop or reroute the app's submission traffic through an approved process until the
   header-mapped writer is deployed. Inspect recent rows for misalignment without altering them.
2. On a **copy** of the response Sheet and an isolated Neon branch, verify the Sheets API
   `updatedCells` response for a row with blank tracking fields. Confirm append placement,
   Dashboard formulas, status projection, PDF parity, duplicate retries, and existing nonempty cells.
   Relax only checks that the copy proves invalid; never relax the report ID/email/answer guard.
   This test was not performed here and is a production release gate.
3. Review installed Apps Script triggers and executions and determine whether the Google Form still
   accepts submissions. Form-only respondents have no Neon report; a global legacy shutdown would
   leave them without mail. Record Dashboard sent flags, including pre-marked rows 14–18 described
   in PR #6. If Forms remains active, keep its legacy mail path and add a tested exclusion for app
   rows before enabling Resend. The global kill sequence below applies only once Form-only delivery
   has a replacement or the Form is retired.
4. After human approval, add `scripts/legacy-email-kill-switch.gs` to the installed Apps Script
   project and paste `if (!legacyEmailEnabled_()) return;` at the start of the existing
   `enviarCorreosPendientes()`. Set `LEGACY_EMAIL_ENABLED=true` **before** installing the guard if
   existing legacy delivery must continue up to cutover. Review and adapt the prepared
   `scripts/legacy-questionnaire-header-patch.gs` to replace the legacy `E:X` read by header; its
   function also verifies the response email. Do not install
   `scripts/apps-script-safe-email-trigger.gs`; it is a dangerous trigger draft.
5. Run the idempotent `db/schema.sql` migration on an isolated Neon branch and verify the app there.
   Production migration is a separate manual action. Existing reports have no linked Sheet row and
   are **not** automatically backfilled or re-queued; guessing a historical row could overwrite data.
6. In a quiet, approved cutover window, set `LEGACY_EMAIL_ENABLED` off first. Only after the legacy
   path is confirmed stopped, set `REPORT_EMAIL_ENABLED=true` in production. The master switch now
   also blocks queued sends and the cron while false.
7. Review every disabled Neon report created during the gap against legacy delivery records. Put
   **only** approved, never-emailed report UUIDs in a newline-delimited IDs file. Run
   `scripts/requeue-disabled-reports.ts --ids-file <file> --since <ISO> --until <ISO>` as a dry run.
   It resolves each report by its Sheet ID/marker and rejects a nonblank Dashboard H or mismatched
   Dashboard B, as well as attempted, accepted, expired, or out-of-window records. It changes nothing.
   Following explicit production approval, add `--apply --legacy-off-confirmed
--legacy-delivery-audited`. The script only changes `disabled` to `pending`; delivery uses the
   existing atomic claim and `report-email/<id>` idempotency key. A repeated run skips already
   queued IDs. Reports older than 47 hours require a separate reviewed plan.
8. Verify a preview send to a controlled address using a copied Sheet and Neon branch, then verify
   the webhook and attached PDF. No such send was run here. For rollback, turn Resend off first,
   mark legacy Dashboard rows already accepted by Resend as sent, and only then re-enable legacy.

## Remaining risks and manual review

- The live header row lacks both total counters. Their meaning and ownership need confirmation before
  implementing or editing them.
- A Sheet row can move between identity lookup and write because Google Sheets does not provide a
  conditional cell update by value. Restrict manual sorting during active writes; review any failed
  projection and its marker before operator repair. A missing or duplicated marker fails closed and
  backs off rather than writing a guessed row.
- Google Sheets is not transactional with Neon. A successfully persisted report may appear late in
  Sheets if the API is unavailable; the cron reconciles it later. A missed daily cron can delay it.
- Reports created before this change have no safe row link. No automatic historical backfill is
  attempted. The one historical pending Form row is left alone.
- The legacy function's installed triggers and actual execution type remain unverified. Duplicate
  delivery cannot be ruled out until the manual audit and kill switch are complete.
- Run the database migration before deploying this branch; the new store queries require the added
  columns. No migration or production deployment was performed here.
- Verify whether merging to `main` automatically deploys production. If it does, approve and run the
  idempotent production database migration before merging PR #7, then confirm the deployment and
  header-mapped writer. The old `main` writer remains a live misalignment risk until deployment is
  verified; pause or reroute submissions through an approved process if it is active.
- The live Sheet copy check was not run. Automatic approval review rejected copying the production
  response Sheet because it would replicate respondent data into a new Drive file. Use an explicitly
  approved isolated dataset for the real Sheets API `updatedCells` check before release.
